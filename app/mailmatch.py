"""Decide what an email means for the job tracker: which job it's about, whether it's a rejection,
and whether to change the status automatically or raise it for review. Pure functions, no I/O."""
import re
from datetime import date, timedelta
from email.utils import parseaddr

# Senders shared by many companies: the domain says nothing about which company wrote.
ATS_DOMAINS = (
    "greenhouse.io", "greenhouse-mail.io", "lever.co", "hire.lever.co", "myworkday.com", "myworkdayjobs.com",
    "workday.com", "ashbyhq.com", "icims.com", "smartrecruiters.com", "smartrecruiters.net", "jobvite.com",
    "bamboohr.com", "taleo.net", "successfactors.com", "successfactors.eu", "workable.com", "recruitee.com",
    "breezy.hr", "jazzhr.com", "applytojob.com", "paylocity.com", "ultipro.com", "ukg.com", "adp.com",
    "oraclecloud.com", "linkedin.com", "indeed.com", "indeedemail.com", "ziprecruiter.com", "dice.com",
    "handshake.com", "joinhandshake.com", "wellfound.com", "rippling.com", "teamtailor.com", "pinpointhq.com",
)

COMPANY_SUFFIXES = {
    "inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "co", "company", "plc", "gmbh", "ag",
    "sa", "bv", "lp", "llp", "group", "holdings", "the",
}
ROLE_STOPWORDS = {"and", "the", "for", "with", "of", "in", "to", "a", "an", "i", "ii", "iii", "iv", "sr", "jr",
                  "senior", "junior", "remote", "hybrid", "onsite", "level"}

# ---------- classification ----------

# Wording that only shows up in rejections.
DEFINITE = [
    r"(decided|chosen|elected|opted|made the decision) (not )?to (move|go|proceed) forward with (other|another|a different|different) (candidate|applicant)",
    r"move forward with (other|another|different) (candidate|applicant)",
    r"(pursue|proceed with|continue with) (other|another|different) (candidate|applicant)",
    r"(not|won't|will not|unable to) (be )?(moving|move|proceed|proceeding|going) forward with your (application|candidacy)",
    r"(decided|decision) not to (proceed|move forward|continue|progress) with your (application|candidacy)",
    r"(not|won't|will not) (be )?(progressing|advancing) your (application|candidacy)",
    r"regret to (inform|let you know|advise)",
    r"(you were|you have|you've) not been (selected|shortlisted)|you were not selected|not (been )?selected (you )?for (an |the |this )?(interview|position|role)",
    r"(position|role|vacancy) has (now )?been filled",
    r"unable to offer you",
    r"(application|candidacy) (was|has been|is) unsuccessful|not (been )?successful (on|in) this (occasion|instance)",
    r"other (candidates|applicants) whose (qualifications|experience|background|skills)",
    r"decided to (go|move) (in )?(a )?(different|another) direction",
]

# Often in rejections, but also in perfectly friendly emails. Raised for review, never applied automatically.
AMBIGUOUS = [
    r"\bunfortunately\b",
    r"keep your (resume|cv|application|information|details|profile) on file",
    r"(position|role|requisition|opening|job) (is no longer|has been|was|is now|has now been) (available|closed|cancell?ed|put on hold|on hold|paused)",
    r"no longer (available|open|accepting|hiring|recruiting)",
    r"not (the right|a good|a strong|the best) (fit|match)",
    r"encourage you to (apply|keep an eye)",
    r"(best|luck|success) (of luck )?in your (job )?(search|future|career)",
    r"(highly )?competitive (applicant pool|pool of|process|field)",
    r"after careful (consideration|review|deliberation)",
    r"not (able|in a position) to (move|proceed|offer)",
]

# Signs the email is good news. These downgrade a rejection to "review" (e.g. "Unfortunately that time
# doesn't work, can we reschedule your interview?").
POSITIVE = [
    r"(like|love|excited|pleased|happy|delighted) to (invite|schedule|offer|extend|move forward with you|have you)",
    r"\bnext (step|round|stage)s? (is|are|will|would|in)\b",
    r"schedule (a|an|your|some) (call|interview|chat|time|meeting|conversation)",
    r"(phone|technical|video|onsite|on-site|final|panel) (screen|interview|round)",
    r"(share|send|let us know) your availability",
    r"offer letter|pleased to offer|extend (you )?an offer|congratulations",
]

ACK = [
    r"thank(s| you) for (applying|your application|submitting your application)",
    r"(we('ve| have)|has been|was) received your application|application (has been |was )?received|we received your application",
    r"application (submitted|confirmation)|confirm(ing)? (that )?we('ve| have)? received",
    r"successfully (applied|submitted)",
]


def _first(patterns, text):
    for p in patterns:
        m = re.search(p, text)
        if m:
            return m.group(0)
    return None


def normalize(text):
    text = (text or "").lower().replace("’", "'").replace("‘", "'").replace(" ", " ")
    return re.sub(r"\s+", " ", text).strip()


def classify(subject, body):
    """-> (category, confidence, phrase). category: rejection | ack | other; confidence: high | medium | ''."""
    text = normalize(f"{subject} . {body}")
    definite = _first(DEFINITE, text)
    ambiguous = [m.group(0) for p in AMBIGUOUS for m in [re.search(p, text)] if m]
    positive = _first(POSITIVE, text)
    ack = _first(ACK, text)
    if definite:
        return ("rejection", "medium" if positive else "high", definite)
    if ambiguous and not positive:
        # "Unfortunately we can't reply to everyone" alone in a thank-you-for-applying email is just an ack
        if ack and len(ambiguous) == 1 and ambiguous[0] == "unfortunately":
            return ("ack", "high", ack)
        return ("rejection", "medium", ambiguous[0])
    if ack:  # an ack only links the sender to the job, so good news in it does no harm
        return ("ack", "high", ack)
    return ("other", "", positive or "")


def snippet(body, phrase, size=400):
    """A short excerpt of the body around the deciding phrase."""
    text = re.sub(r"\s+", " ", body or "").strip()
    i = normalize(text).find(phrase) if phrase else -1
    start = max(0, i - size // 3) if i >= 0 else 0
    out = text[start:start + size]
    return ("…" if start else "") + out + ("…" if start + size < len(text) else "")


# ---------- matching ----------

def is_ats(domain):
    return any(domain == d or domain.endswith("." + d) for d in ATS_DOMAINS)


def domain_label(domain):
    """The name part of a domain: careers.acme.co.uk -> acme."""
    parts = domain.split(".")
    if len(parts) >= 3 and len(parts[-1]) == 2 and parts[-2] in ("co", "com", "org", "net", "ac", "gov"):
        return parts[-3]
    return parts[-2] if len(parts) >= 2 else domain


def company_words(name):
    words = re.findall(r"[a-z0-9]+", normalize(name).replace("&", " and "))
    while words and words[-1] in COMPANY_SUFFIXES:
        words.pop()
    while words and words[0] == "the":
        words.pop(0)
    return words


def mentions(text, words):
    return bool(words) and re.search(r"\b" + r"\W+".join(map(re.escape, words)) + r"\b", text) is not None


def role_words(role):
    return {w for w in re.findall(r"[a-z0-9+#]+", normalize(role)) if len(w) > 1 and w not in ROLE_STOPWORDS}


def expected_matches(expect_from, from_name, from_addr):
    """The job's expected sender ("Name <addr>") vs this email's sender. Shared ATS addresses need the name too."""
    if not expect_from:
        return False
    name, addr = parseaddr(expect_from)
    addr, from_addr = addr.lower(), from_addr.lower()
    if not addr or "@" not in from_addr:
        return False
    if is_ats(from_addr.rpartition("@")[2]):
        return addr == from_addr and normalize(name) == normalize(from_name)
    return addr.rpartition("@")[2] == from_addr.rpartition("@")[2]


def score(job, from_name, from_addr, subject, body, received):
    """How strongly this email points at this job, with the reasons."""
    domain = from_addr.lower().rpartition("@")[2]
    words = company_words(job["company"])
    pts, why = 0, []
    if expected_matches(job.get("expect_from", ""), from_name, from_addr):
        pts += 5
        why.append("expected sender")
    if domain and not is_ats(domain) and words:
        label, joined = domain_label(domain), "".join(words)
        if len(label) >= 3 and (label == joined or label == words[0] or (len(label) >= 4 and joined.startswith(label))):
            pts += 4
            why.append("company domain")
    name_pts = (3 if mentions(normalize(from_name), words) or mentions(normalize(subject), words)
                else 2 if mentions(normalize(body), words) else 0)
    if name_pts:
        pts += name_pts
        why.append("company name")
    rw = role_words(job.get("role", ""))
    if rw:
        seen = set(re.findall(r"[a-z0-9+#]+", normalize(f"{subject} {body}")))
        frac = len(rw & seen) / len(rw)
        if frac >= 0.6:
            pts += 2
            why.append("role")
        elif frac >= 0.3:
            pts += 1
    if job.get("applied_date") and received:
        try:
            applied = date.fromisoformat(job["applied_date"])
            if timedelta(0) <= received - applied <= timedelta(days=2):
                pts += 1
        except ValueError:
            pass
    return pts, why


def match(jobs, from_name, from_addr, subject, body, received):
    """-> (best job or None, confident: bool, candidate jobs best first).
    Only applied-to jobs whose application date isn't after the email are considered."""
    scored = []
    for j in jobs:
        if j["status"] == "not_applied":
            continue
        if j.get("applied_date") and received:
            try:
                if date.fromisoformat(j["applied_date"]) > received + timedelta(days=1):
                    continue
            except ValueError:
                pass
        pts, _ = score(j, from_name, from_addr, subject, body, received)
        if pts > 0:
            scored.append((pts, j))
    scored.sort(key=lambda x: -x[0])
    if not scored:
        return None, False, []
    best_pts, best = scored[0]
    runner = scored[1][0] if len(scored) > 1 else 0
    confident = best_pts >= 3 and best_pts - runner >= 2  # e.g. company in the sender name or subject, and no close second
    return best, confident, [j for _, j in scored[:5]]


# ---------- what to do ----------

REJECTED = ("rejected", "rejected_after_interview")


def rejection_status(job):
    return "rejected_after_interview" if job["status"] == "interviewing" or job.get("interview_count", 0) > 0 else "rejected"


def decide(category, confidence, job, confident, auto_apply=True):
    """-> (outcome, to_status). outcome: auto | review | ignored | linked."""
    if category == "ack":
        return ("linked", None) if job and confident else ("ignored", None)
    if category != "rejection":
        return ("ignored", None)
    if not job or not confident:
        return ("review", rejection_status(job) if job else "rejected")
    if job["status"] in REJECTED:
        return ("ignored", None)
    to = rejection_status(job)
    # only touch statuses you haven't moved on from: still "applied", or "interviewing"
    if auto_apply and confidence == "high" and job["status"] in ("applied", "interviewing"):
        return ("auto", "rejected_after_interview" if job["status"] == "interviewing" else "rejected")
    return ("review", to)
