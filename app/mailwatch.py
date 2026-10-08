"""Gmail watcher: reads one Gmail label over IMAP and updates job statuses from rejection emails.

Runs as its own process (the hirelighter-mail service), so the Gmail password never reaches the web app:
    python -m app.mailwatch

The mailbox is opened read-only (EXAMINE) and messages are fetched with BODY.PEEK, so nothing in Gmail
changes: no deletes, no moves, no "mark as read". Only a short excerpt of each relevant email is stored.
"""
import email
import email.policy
import imaplib
import json
import logging
import os
import re
import ssl
import sys
import time
from datetime import date, datetime, timedelta, timezone
from email.utils import parseaddr, parsedate_to_datetime
from html.parser import HTMLParser

from . import db, mailmatch

log = logging.getLogger("mailwatch")

MAX_SIZE = 2 * 1024 * 1024     # skip anything bigger (attachments); rejections are small
FIRST_RUN_MAX_DAYS = 90
POLL_SECONDS = 30              # how often to look for the "Check now" flag
MAX_BACKOFF_MINUTES = 6 * 60


class MailError(Exception):
    """A problem worth showing in the Jobs tab. Never contains the password."""


def config():
    pw = os.environ.get("GMAIL_APP_PASSWORD", "")
    pw_file = os.environ.get("GMAIL_APP_PASSWORD_FILE", "")
    if pw_file:
        try:
            with open(pw_file) as f:
                pw = f.read().strip()
        except OSError as e:
            raise MailError(f"Can't read GMAIL_APP_PASSWORD_FILE ({e.strerror}).") from None
    return {
        "user": os.environ.get("GMAIL_USER", "").strip(),
        "password": pw.replace(" ", ""),  # Google shows app passwords in groups of four
        "label": os.environ.get("GMAIL_LABEL", "Jobs").strip() or "Jobs",
        "host": os.environ.get("IMAP_HOST", "imap.gmail.com"),
        "minutes": max(1, int(os.environ.get("MAIL_CHECK_MINUTES", "15") or 15)),
        "auto_apply": os.environ.get("MAIL_AUTO_APPLY", "1").strip().lower() not in ("0", "false", "no", "off"),
    }


# ---------- IMAP ----------

def _quote(mailbox):
    return '"' + mailbox.replace("\\", "\\\\").replace('"', '\\"') + '"'


class Mailbox:
    """The few IMAP calls the watcher needs. Tests swap in a fake with the same methods."""

    def __init__(self, cfg):
        try:
            self.imap = imaplib.IMAP4_SSL(cfg["host"], 993, ssl_context=ssl.create_default_context(), timeout=30)
        except (OSError, ssl.SSLError) as e:
            raise MailError(f"Can't reach {cfg['host']}: {e}") from None
        try:
            self.imap.login(cfg["user"], cfg["password"])
        except imaplib.IMAP4.error:
            raise MailError("Gmail rejected the login. Check GMAIL_USER and the app password "
                            "(Google Account > Security > App passwords).") from None
        typ, _ = self.imap.select(_quote(cfg["label"]), readonly=True)  # EXAMINE: read-only
        if typ != "OK":
            self.close()
            raise MailError(f'Gmail label "{cfg["label"]}" not found. Create it, or set GMAIL_LABEL.')
        vals = self.imap.response("UIDVALIDITY")[1]
        self.uidvalidity = vals[0].decode() if vals and vals[0] else ""

    def uids_after(self, last_uid):
        _, data = self.imap.uid("SEARCH", None, f"UID {last_uid + 1}:*")
        return [u for u in parse_uids(data) if u > last_uid]  # "N:*" always returns the newest, even if seen

    def uids_since(self, day):
        _, data = self.imap.uid("SEARCH", None, "SINCE", day.strftime("%d-%b-%Y"))
        return parse_uids(data)

    def sizes(self, uids):
        if not uids:
            return {}
        _, data = self.imap.uid("FETCH", ",".join(map(str, uids)), "(RFC822.SIZE)")
        return parse_sizes(data)

    def fetch(self, uid):
        _, data = self.imap.uid("FETCH", str(uid), "(BODY.PEEK[])")  # PEEK: doesn't mark it read
        for part in data or []:
            if isinstance(part, tuple) and len(part) == 2:
                return part[1]
        return None

    def close(self):
        try:
            self.imap.logout()
        except Exception:  # noqa: BLE001 - best effort
            pass


def parse_uids(data):
    return sorted({int(x) for chunk in data or [] if chunk for x in chunk.split()})


def parse_sizes(data):
    out = {}
    for part in data or []:
        line = part[0] if isinstance(part, tuple) else part
        if not isinstance(line, bytes):
            continue
        uid, size = re.search(rb"UID (\d+)", line), re.search(rb"RFC822\.SIZE (\d+)", line)
        if uid and size:
            out[int(uid.group(1))] = int(size.group(1))
    return out


# ---------- parsing ----------

class _Text(HTMLParser):
    SKIP = {"script", "style", "head", "title"}
    BREAK = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "table"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out, self.skip = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip += 1
        elif tag in self.BREAK:
            self.out.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self.skip:
            self.skip -= 1

    def handle_data(self, data):
        if not self.skip:
            self.out.append(data)


def html_to_text(html):
    p = _Text()
    p.feed(html)
    p.close()
    return "".join(p.out)


def parse(raw, fallback_id=""):
    """Raw RFC 822 bytes -> the few fields the watcher uses."""
    msg = email.message_from_bytes(raw, policy=email.policy.default)
    from_name, from_addr = parseaddr(str(msg.get("From", "")))
    try:
        when = parsedate_to_datetime(str(msg.get("Date", ""))).astimezone(timezone.utc)
    except (TypeError, ValueError):
        when = datetime.now(timezone.utc)
    body = ""
    part = msg.get_body(preferencelist=("plain", "html"))
    if part is not None:
        try:
            body = part.get_content()
        except (LookupError, ValueError):
            body = part.get_payload(decode=True).decode("utf-8", "replace") if part.get_payload(decode=True) else ""
        if part.get_content_type() == "text/html":
            body = html_to_text(body)
    return {
        "message_id": str(msg.get("Message-ID", "")).strip() or fallback_id,
        "received": when,
        "from_name": from_name.strip(),
        "from_addr": from_addr.strip().lower(),
        "subject": re.sub(r"\s+", " ", str(msg.get("Subject", ""))).strip(),
        "body": body[:20000],
    }


# ---------- processing ----------

def process(m, auto_apply=True):
    """Classify one parsed email, match it to a job and act on it. Returns the outcome (None if seen before)."""
    if db.row("SELECT id FROM mail_messages WHERE message_id = ?", (m["message_id"],)):
        return None
    received_at = m["received"].strftime("%Y-%m-%d %H:%M:%S")
    category, confidence, phrase = mailmatch.classify(m["subject"], m["body"])
    if category == "other":
        # keep only the id, so it's skipped next time; nothing about unrelated mail is stored
        db.execute("INSERT INTO mail_messages (message_id, received_at, category, outcome) VALUES (?, ?, 'other', 'ignored')",
                   (m["message_id"], received_at))
        return "ignored"

    jobs = db.rows("SELECT * FROM jobs")
    job, confident, candidates = mailmatch.match(jobs, m["from_name"], m["from_addr"], m["subject"], m["body"],
                                                 m["received"].date())
    outcome, to_status = mailmatch.decide(category, confidence, job, confident, auto_apply)
    if category == "ack" and outcome == "ignored":
        # an ack we couldn't tie to a job: nothing to do, nothing worth keeping
        db.execute("INSERT INTO mail_messages (message_id, received_at, category, outcome) VALUES (?, ?, 'ack', 'ignored')",
                   (m["message_id"], received_at))
        return "ignored"

    cur = db.execute(
        """INSERT INTO mail_messages (message_id, received_at, from_name, from_addr, subject, snippet, category,
               confidence, reason, job_id, candidates, outcome, from_status, to_status, resolved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (m["message_id"], received_at, m["from_name"], m["from_addr"], m["subject"][:300],
         mailmatch.snippet(m["body"], phrase), category, confidence, phrase, job["id"] if job else None,
         json.dumps([j["id"] for j in candidates]), outcome, job["status"] if job else None, to_status,
         None if outcome == "review" else datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")))
    mail_id = cur.lastrowid
    if outcome == "auto":
        db.set_job_status(job["id"], to_status, source="email", mail_id=mail_id)
    elif outcome == "linked" and not job.get("expect_from"):
        sender = f'{m["from_name"]} <{m["from_addr"]}>' if m["from_name"] else m["from_addr"]
        db.execute("UPDATE jobs SET expect_from = ? WHERE id = ?", (sender, job["id"]))
    log.info("%s: %s (%s) -> %s", m["received"].date(), category, confidence, outcome)
    return outcome


def first_run_since():
    """How far back to look the first time: the oldest active application, capped."""
    r = db.row("SELECT MIN(applied_date) AS d FROM jobs WHERE status IN ('applied', 'interviewing', 'offered')")
    floor = date.today() - timedelta(days=FIRST_RUN_MAX_DAYS)
    try:
        return max(date.fromisoformat(r["d"]), floor) if r and r["d"] else date.today() - timedelta(days=14)
    except ValueError:
        return floor


def run_once(cfg, open_mailbox=Mailbox):
    """One check: read new mail in the label and act on it. Returns how many emails were looked at."""
    box = open_mailbox(cfg)
    try:
        st = db.mail_state()
        last_uid = int(st.get("last_uid") or 0)
        if st.get("uidvalidity") != box.uidvalidity:
            last_uid = 0  # Gmail renumbered the label; Message-IDs still stop duplicates
        uids = box.uids_after(last_uid) if last_uid else box.uids_since(first_run_since())
        sizes = box.sizes(uids)
        seen = 0
        for uid in uids:
            if sizes.get(uid, 0) <= MAX_SIZE:
                raw = box.fetch(uid)
                if raw:
                    process(parse(raw, fallback_id=f"uid:{box.uidvalidity}:{uid}"), cfg["auto_apply"])
                    seen += 1
            db.set_mail_state(uidvalidity=box.uidvalidity, last_uid=uid)
        if not uids:
            db.set_mail_state(uidvalidity=box.uidvalidity, last_uid=last_uid)
        return seen
    finally:
        box.close()


def now_str():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s mailwatch %(message)s")
    while not db.schema_current():  # the web app owns migrations; wait for it
        log.info("waiting for the database to be set up by the web app")
        db.close()
        time.sleep(5)

    try:
        cfg = config()
    except MailError as e:
        cfg, err = None, str(e)
    else:
        err = None if cfg["user"] and cfg["password"] else "GMAIL_USER and GMAIL_APP_PASSWORD aren't set."
    if err:
        db.set_mail_state(account="", last_error=err)
        log.error("%s Idling.", err)
        while True:  # stay up quietly so `restart: unless-stopped` doesn't loop
            time.sleep(3600)

    db.set_mail_state(account=cfg["user"], label=cfg["label"], auto_apply=int(cfg["auto_apply"]),
                      interval=cfg["minutes"], last_error="")
    log.info("watching label %r for %s every %d min", cfg["label"], cfg["user"], cfg["minutes"])
    failures, next_at = 0, 0.0
    while True:
        if time.time() >= next_at or db.mail_state().get("check_requested") == "1":
            db.set_mail_state(check_requested=0)
            try:
                n = run_once(cfg)
                failures = 0
                db.set_mail_state(last_check_at=now_str(), last_error="")
                log.info("checked: %d new", n)
            except MailError as e:
                failures += 1
                db.set_mail_state(last_check_at=now_str(), last_error=str(e))
                log.error("%s", e)
            except (imaplib.IMAP4.error, OSError, ssl.SSLError) as e:
                failures += 1
                db.set_mail_state(last_check_at=now_str(), last_error=f"Mail check failed: {e}")
                log.error("mail check failed: %s", e)
            wait = min(cfg["minutes"] * (2 ** min(failures, 5)), MAX_BACKOFF_MINUTES) if failures else cfg["minutes"]
            next_at = time.time() + wait * 60
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    sys.exit(main())
