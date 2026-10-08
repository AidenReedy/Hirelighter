"""Gmail rejection tracking: classification, matching, decisions, processing, and the IMAP loop (with a fake)."""
from datetime import date, datetime, timezone
from pathlib import Path

import pytest

from app import mailmatch
from app.mailmatch import classify, decide, match

MAIL = Path(__file__).resolve().parent / "fixtures" / "mail"


# ---------- classification ----------

@pytest.mark.parametrize("subject, body, category, confidence", [
    # definite rejections
    ("Your application", "We have decided to move forward with other candidates.", "rejection", "high"),
    ("Update", "We will not be moving forward with your application at this time.", "rejection", "high"),
    ("Re: SOC Analyst", "We regret to inform you that the position has been filled.", "rejection", "high"),
    ("Application update", "Unfortunately, you were not selected for an interview.", "rejection", "high"),
    ("Thanks", "We’ve decided not to proceed with your application.", "rejection", "high"),
    ("Status", "Your application was unsuccessful on this occasion.", "rejection", "high"),
    ("Hi", "We chose other applicants whose background better matches. We have decided to go in a different direction.",
     "rejection", "high"),
    # ambiguous: raised for review
    ("Update", "Unfortunately, the role has been put on hold.", "rejection", "medium"),
    ("Thanks", "We'll keep your resume on file for future openings.", "rejection", "medium"),
    ("Req 1234", "This requisition is no longer accepting applications.", "rejection", "medium"),
    # rejection wording next to good news -> review, not automatic
    ("Next steps", "We regret to inform you the slot moved, but we'd love to schedule a call. Congratulations!",
     "rejection", "medium"),
    # not rejections
    ("Interview", "Unfortunately that time doesn't work. Could you share your availability for a phone screen?",
     "other", ""),
    ("Thank you for applying", "We've received your application and will be in touch.", "ack", "high"),
    ("Application received", "Unfortunately we can't reply to everyone, but we read every application.", "ack", "high"),
    ("Weekly newsletter", "Ten tips for your resume.", "other", ""),
])
def test_classify(subject, body, category, confidence):
    got = classify(subject, body)
    assert got[:2] == (category, confidence), got


def test_snippet_centers_on_phrase():
    body = "x " * 500 + "we regret to inform you that" + " y" * 500
    s = mailmatch.snippet(body, "regret to inform")
    assert "regret to inform" in s and s.startswith("…") and s.endswith("…") and len(s) <= 402


# ---------- matching ----------

def job(id, company, role="", status="applied", applied="2026-10-01", expect_from="", interviews=0):
    return {"id": id, "company": company, "role": role, "status": status, "applied_date": applied,
            "expect_from": expect_from, "interview_count": interviews}


D = date(2026, 10, 6)


def test_company_domain_match():
    jobs = [job(1, "Acme Inc."), job(2, "Globex Corporation")]
    best, confident, _ = match(jobs, "Recruiting", "talent@acme.com", "Your application", "Thanks", D)
    assert best["id"] == 1 and confident


def test_domain_handles_country_tlds_and_multiword_names():
    jobs = [job(1, "Palo Alto Networks"), job(2, "Monzo Bank Ltd")]
    assert match(jobs, "", "jobs@paloaltonetworks.com", "Hi", "", D)[0]["id"] == 1
    assert match(jobs, "", "no-reply@careers.monzo.co.uk", "Hi", "", D)[0]["id"] == 2


def test_ats_sender_matches_on_company_name():
    jobs = [job(1, "Acme"), job(2, "Globex")]
    best, confident, _ = match(jobs, "Globex Hiring Team", "no-reply@us.greenhouse-mail.io", "Update", "", D)
    assert best["id"] == 2 and confident
    # the ATS domain alone means nothing
    assert match(jobs, "", "no-reply@greenhouse-mail.io", "Update", "", D)[0] is None


def test_expected_sender_needs_name_for_shared_ats_addresses():
    ats = "no-reply@us.greenhouse-mail.io"
    j = job(1, "Initech", expect_from=f"Initech Careers <{ats}>")
    assert mailmatch.expected_matches(j["expect_from"], "Initech Careers", ats)
    assert not mailmatch.expected_matches(j["expect_from"], "Hooli Careers", ats)
    # own domain: any address there counts
    assert mailmatch.expected_matches("Recruiting <jobs@initech.com>", "", "people@initech.com")


def test_two_jobs_same_company_split_by_role():
    jobs = [job(1, "Acme", "SOC Analyst"), job(2, "Acme", "Cloud Security Engineer")]
    best, confident, cands = match(jobs, "Acme", "jobs@acme.com", "Your SOC Analyst application", "", D)
    assert best["id"] == 1 and confident and len(cands) == 2
    # nothing to tell them apart -> not confident
    _, confident, _ = match(jobs, "Acme", "jobs@acme.com", "Your application", "", D)
    assert not confident


def test_skips_unapplied_and_future_jobs():
    jobs = [job(1, "Acme", status="not_applied"), job(2, "Globex", applied="2026-12-01")]
    assert match(jobs, "", "jobs@acme.com", "", "", D)[0] is None
    assert match(jobs, "", "jobs@globex.com", "", "", D)[0] is None


def test_short_company_names_need_word_boundaries():
    jobs = [job(1, "HP")]
    assert match(jobs, "", "x@gmail.com", "Hi", "We shipped a new chip today", D)[0] is None
    assert match(jobs, "", "x@gmail.com", "Your application at HP", "", D)[0]["id"] == 1


# ---------- decisions ----------

@pytest.mark.parametrize("status, conf, confident, auto, expect", [
    ("applied", "high", True, True, ("auto", "rejected")),
    ("interviewing", "high", True, True, ("auto", "rejected_after_interview")),
    ("offered", "high", True, True, ("review", "rejected_after_interview")),
    ("accepted", "high", True, True, ("review", "rejected")),
    ("rejected", "high", True, True, ("ignored", None)),
    ("applied", "medium", True, True, ("review", "rejected")),
    ("applied", "high", False, True, ("review", "rejected")),
    ("applied", "high", True, False, ("review", "rejected")),
])
def test_decide(status, conf, confident, auto, expect):
    j = job(1, "Acme", status=status, interviews=1 if status == "offered" else 0)
    assert decide("rejection", conf, j, confident, auto) == expect


def test_decide_ack_and_other():
    j = job(1, "Acme")
    assert decide("ack", "high", j, True) == ("linked", None)
    assert decide("ack", "high", j, False) == ("ignored", None)
    assert decide("other", "", j, True) == ("ignored", None)
    assert decide("rejection", "high", None, False) == ("review", "rejected")


# ---------- processing against the database ----------

def parsed(name):
    from app import mailwatch
    return mailwatch.parse((MAIL / name).read_bytes())


def test_parse_html_email():
    m = parsed("greenhouse_rejection.eml")
    assert m["from_name"] == "Acme Hiring Team" and m["from_addr"] == "no-reply@us.greenhouse-mail.io"
    assert m["message_id"] == "<gh-reject-1@greenhouse-mail.io>"
    assert m["received"] == datetime(2026, 10, 6, 15, 4, tzinfo=timezone.utc)
    assert "move forward with other candidates" in m["body"] and "color:red" not in m["body"]
    assert "pixel" not in m["body"]


def add_job(client, **kw):
    j = client.post("/api/jobs", json={"applied": True, "applied_date": "2026-09-30", **kw}).get_json()
    return j


def test_ack_then_rejection_flow(client):
    from app import mailwatch
    acme = add_job(client, company="Acme", role="SOC Analyst")
    add_job(client, company="Globex", role="SOC Analyst")

    assert mailwatch.process(parsed("acme_ack.eml")) == "linked"
    j = client.get("/api/jobs").get_json()
    assert next(x for x in j if x["id"] == acme["id"])["expect_from"] == "Acme Hiring Team <no-reply@us.greenhouse-mail.io>"

    assert mailwatch.process(parsed("greenhouse_rejection.eml")) == "auto"
    assert mailwatch.process(parsed("greenhouse_rejection.eml")) is None  # same Message-ID: skipped
    j = next(x for x in client.get("/api/jobs").get_json() if x["id"] == acme["id"])
    assert j["status"] == "rejected"
    ev = client.get(f"/api/jobs/{acme['id']}/events").get_json()
    assert ev[-1]["source"] == "email" and ev[-1]["to_value"] == "rejected"

    mail = client.get("/api/mail").get_json()
    assert mail["review"] == [] and len(mail["recent"]) == 1
    rec = mail["recent"][0]
    assert rec["company"] == "Acme" and "move forward with other candidates" in rec["snippet"]

    # undo puts it back; a second undo has nothing to do
    assert client.post(f"/api/mail/{rec['id']}/undo").status_code == 200
    assert next(x for x in client.get("/api/jobs").get_json() if x["id"] == acme["id"])["status"] == "applied"
    assert client.post(f"/api/mail/{rec['id']}/undo").status_code == 409


def test_interviewing_becomes_rejected_after_interview(client):
    from app import mailwatch
    a = add_job(client, company="Acme", role="SOC Analyst")
    client.put(f"/api/jobs/{a['id']}", json={"status": "interviewing"})
    assert mailwatch.process(parsed("greenhouse_rejection.eml")) == "auto"
    assert next(x for x in client.get("/api/jobs").get_json() if x["id"] == a["id"])["status"] == "rejected_after_interview"


def test_undo_blocked_after_manual_change(client):
    from app import mailwatch
    a = add_job(client, company="Acme")
    mailwatch.process(parsed("greenhouse_rejection.eml"))
    client.put(f"/api/jobs/{a['id']}", json={"status": "offered"})
    rec = client.get("/api/mail").get_json()["recent"][0]
    assert client.post(f"/api/mail/{rec['id']}/undo").status_code == 409
    assert next(x for x in client.get("/api/jobs").get_json() if x["id"] == a["id"])["status"] == "offered"


def test_review_accept_and_dismiss(client):
    from app import mailwatch
    a1 = add_job(client, company="Acme", role="SOC Analyst")
    a2 = add_job(client, company="Acme", role="SOC Analyst")  # identical: can't tell them apart
    assert mailwatch.process(parsed("greenhouse_rejection.eml")) == "review"
    review = client.get("/api/mail").get_json()["review"]
    assert len(review) == 1 and set(review[0]["candidates"]) == {a1["id"], a2["id"]}

    r = client.post(f"/api/mail/{review[0]['id']}/accept", json={"job_id": a2["id"]})
    assert r.status_code == 200 and r.get_json()["outcome"] == "accepted"
    jobs = {x["id"]: x["status"] for x in client.get("/api/jobs").get_json()}
    assert jobs[a2["id"]] == "rejected" and jobs[a1["id"]] == "applied"
    assert client.post(f"/api/mail/{review[0]['id']}/dismiss").status_code == 409


def test_other_mail_keeps_nothing_but_the_id(client):
    from app import db, mailwatch
    add_job(client, company="Beta", role="SOC Analyst")
    assert mailwatch.process(parsed("interview_invite.eml")) == "ignored"
    r = db.row("SELECT * FROM mail_messages")
    assert r["category"] == "other" and r["subject"] == "" and r["snippet"] == "" and r["from_addr"] == ""


def test_jobs_keep_working_without_mail(client):
    m = client.get("/api/mail").get_json()
    assert m["enabled"] is False and m["review"] == [] and m["login_on"] is False
    assert client.post("/api/mail/check").status_code == 200
    from app import db
    assert db.mail_state()["check_requested"] == "1"


# ---------- IMAP loop (fake mailbox) ----------

class FakeBox:
    def __init__(self, messages, uidvalidity="7"):
        self.messages, self.uidvalidity, self.fetched, self.closed = messages, uidvalidity, [], False

    def uids_after(self, last):
        return [u for u in sorted(self.messages) if u > last]

    def uids_since(self, day):
        return sorted(self.messages)

    def sizes(self, uids):
        return {u: len(self.messages[u]) for u in uids}

    def fetch(self, uid):
        self.fetched.append(uid)
        return self.messages[uid]

    def close(self):
        self.closed = True


def test_run_once_resumes_and_skips_big_mail(client, monkeypatch):
    from app import db, mailwatch
    add_job(client, company="Acme", role="SOC Analyst")
    msgs = {3: (MAIL / "acme_ack.eml").read_bytes(), 5: b"x" * 10, 9: (MAIL / "greenhouse_rejection.eml").read_bytes()}
    monkeypatch.setattr(mailwatch, "MAX_SIZE", 5000)
    msgs[5] = b"Subject: huge\r\n\r\n" + b"x" * 6000
    cfg = {"auto_apply": True}
    box = FakeBox(msgs)
    assert mailwatch.run_once(cfg, lambda c: box) == 2
    assert box.fetched == [3, 9] and box.closed
    assert db.mail_state()["last_uid"] == "9"

    box2 = FakeBox({**msgs, 12: (MAIL / "interview_invite.eml").read_bytes()})
    mailwatch.run_once(cfg, lambda c: box2)
    assert box2.fetched == [12]

    # Gmail renumbered the label: start over, but Message-IDs stop repeats
    box3 = FakeBox(msgs, uidvalidity="8")
    mailwatch.run_once(cfg, lambda c: box3)
    assert box3.fetched == [3, 9]
    assert len(db.rows("SELECT * FROM job_events WHERE source = 'email'")) == 1


def test_imap_response_parsing():
    from app import mailwatch
    assert mailwatch.parse_uids([b"4 9 12"]) == [4, 9, 12]
    assert mailwatch.parse_uids([b""]) == []
    data = [b"1 (UID 4 RFC822.SIZE 1200)", b"2 (RFC822.SIZE 99 UID 9)"]
    assert mailwatch.parse_sizes(data) == {4: 1200, 9: 99}
    assert mailwatch._quote('Jobs/"Apps"') == '"Jobs/\\"Apps\\""'


def test_config_reads_password_file(tmp_path, monkeypatch):
    from app import mailwatch
    f = tmp_path / "pw"
    f.write_text("abcd efgh ijkl mnop\n")
    monkeypatch.setenv("GMAIL_APP_PASSWORD_FILE", str(f))
    monkeypatch.setenv("MAIL_AUTO_APPLY", "0")
    cfg = mailwatch.config()
    assert cfg["password"] == "abcdefghijklmnop" and cfg["auto_apply"] is False and cfg["label"] == "Jobs"
