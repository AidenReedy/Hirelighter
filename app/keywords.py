"""Find known keywords in a pasted job posting. No AI: a fixed list of terms plus the user's own skills.

Each term has a display name (how it reads inside a sentence) and the phrasings that count as it.
An alias written in capitals (e.g. "IR", "GRC") only matches in capitals, so "it" never counts as "IT".
"""
import re

# display name -> other ways postings say it (the display name itself always counts)
TERMS = {
    # security operations
    "incident response": ["incident handling", "incident management", "IR"],
    "threat hunting": ["threat hunt", "threat hunts"],
    "threat intelligence": ["threat intel", "CTI", "cyber threat intelligence"],
    "security monitoring": ["security operations monitoring", "event monitoring"],
    "SOC": ["security operations center", "security operations centre"],
    "SIEM": ["security information and event management"],
    "SOAR": ["security orchestration, automation and response", "security orchestration"],
    "EDR": ["endpoint detection and response", "XDR"],
    "digital forensics": ["forensics", "DFIR"],
    "malware analysis": ["reverse engineering malware"],
    "log analysis": ["log review", "log analytics"],
    "detection engineering": ["detection rules", "detection content", "use case development"],
    "IDS/IPS": ["IDS", "IPS", "intrusion detection", "intrusion prevention"],
    "phishing analysis": ["phishing"],
    # offensive / vuln
    "penetration testing": ["pentest", "pentesting", "pen test", "pen testing", "ethical hacking"],
    "red teaming": ["red team"],
    "vulnerability management": ["vulnerability scanning", "vulnerability assessment", "vulnerability assessments",
                                 "vuln management"],
    "web application security": ["application security", "AppSec", "OWASP"],
    "secure code review": ["code review"],
    # governance
    "GRC": ["governance, risk and compliance", "governance, risk, and compliance", "governance risk and compliance"],
    "risk assessment": ["risk assessments", "risk analysis", "risk management"],
    "compliance": ["regulatory compliance", "audit readiness"],
    "security auditing": ["security audits", "IT audit", "audits"],
    "security policy": ["security policies", "policies and procedures", "policy development"],
    "third-party risk": ["vendor risk", "TPRM", "third party risk", "supplier risk"],
    "business continuity": ["disaster recovery", "BCP", "DR planning"],
    "security awareness training": ["security awareness", "awareness training"],
    "NIST": ["NIST CSF", "NIST 800-53", "NIST SP 800-53", "NIST 800-171", "NIST Cybersecurity Framework", "RMF"],
    "ISO 27001": ["ISO/IEC 27001", "ISO27001"],
    "SOC 2": ["SOC2", "SOC II"],
    "PCI DSS": ["PCI", "PCI-DSS"],
    "HIPAA": [],
    "GDPR": [],
    "CMMC": [],
    "FedRAMP": [],
    "MITRE ATT&CK": ["ATT&CK", "MITRE"],
    "CIS Controls": ["CIS benchmarks", "CIS Benchmark"],
    # infrastructure
    "identity and access management": ["IAM", "access management", "identity management"],
    "Active Directory": ["AD", "Entra ID", "Azure AD"],
    "network security": ["firewalls", "firewall"],
    "cloud security": ["CSPM", "cloud security posture"],
    "AWS": ["Amazon Web Services"],
    "Azure": ["Microsoft Azure"],
    "GCP": ["Google Cloud"],
    "zero trust": [],
    "encryption": ["cryptography", "PKI"],
    "DLP": ["data loss prevention"],
    "Linux": [],
    "Windows": ["Windows Server"],
    "networking": ["TCP/IP", "network protocols"],
    "scripting": ["automation scripts"],
    # tools
    "Splunk": [],
    "Microsoft Sentinel": ["Sentinel", "Azure Sentinel"],
    "QRadar": [],
    "Elastic": ["ELK", "Elasticsearch", "Elastic Stack"],
    "CrowdStrike": ["Falcon"],
    "Wireshark": [],
    "Nmap": [],
    "Burp Suite": ["Burp"],
    "Metasploit": [],
    "Nessus": ["Tenable"],
    "Qualys": [],
    "Python": [],
    "PowerShell": [],
    "Bash": [],
    "SQL": [],
}

# A posting's requirements weigh more than its "about us" and benefits.
_REQ_HEAD = re.compile(r"require|qualification|what you('ll| will)? bring|must have|you have|skills|experience|"
                       r"responsibilit|what you('ll| will) do|nice to have|preferred", re.I)
_OTHER_HEAD = re.compile(r"benefit|perk|about (us|the company)|compensation|salary|pay range|equal opportunity|"
                         r"why join|our culture", re.I)


def _pattern(alias: str) -> re.Pattern:
    body = re.escape(alias).replace(r"\ ", r"[\s-]+").replace(r"\-", r"[\s-]+")
    flags = 0 if (alias.isupper() or len(alias) <= 3) else re.I
    return re.compile(rf"(?<![A-Za-z0-9]){body}(?![A-Za-z0-9])", flags)


class Vocab(dict):
    """{term: [compiled patterns]}, plus .lookup: any alias, lowercased -> term (for tags people type)."""
    lookup: dict


def vocabulary(bank_skills=()):
    """Built-in terms plus the user's skills. A skill that is already a built-in term (or alias) merges into it."""
    names = {name: [name, *aliases] for name, aliases in TERMS.items()}
    lookup = {a.lower(): name for name, al in names.items() for a in al}
    for s in bank_skills:
        s = (s or "").strip()
        if len(s) < 2 or s.lower() in lookup:
            continue
        names[s] = [s]
        lookup[s.lower()] = s
    vocab = Vocab({name: [_pattern(a) for a in aliases] for name, aliases in names.items()})
    vocab.lookup = lookup
    return vocab


def _weights(text: str):
    """Per-line weight: 2 inside a requirements-like section, 0.5 in benefits/about, 1 otherwise."""
    weight, out = 1.0, []
    for line in text.splitlines():
        short = len(line.strip()) <= 60
        if short and _OTHER_HEAD.search(line):
            weight = 0.5
        elif short and _REQ_HEAD.search(line):
            weight = 2.0
        out.append((line, weight))
    return out


def spans(line: str, vocab):
    """Non-overlapping (start, end, term) matches in one line. The longest phrase wins, so "SOC 2" isn't also "SOC"."""
    hits = [(m.start(), m.end(), name) for name, pats in vocab.items() for p in pats for m in p.finditer(line)]
    hits.sort(key=lambda h: (h[0] - h[1], h[0]))
    taken, out = [], []
    for s, e, name in hits:
        if all(e <= ts or s >= te for ts, te in taken):
            taken.append((s, e))
            out.append((s, e, name))
    return sorted(out)


def find(text: str, vocab) -> dict:
    """{term: score} for every term that appears in text."""
    scores = {}
    for line, w in _weights(text or ""):
        for _, _, name in spans(line, vocab):
            scores[name] = scores.get(name, 0) + w
    return scores


def match_tags(tags: str, vocab: Vocab) -> set:
    """Terms a comma-separated tag list refers to ("IR, grc" -> {"incident response", "GRC"})."""
    out = set()
    for tag in (tags or "").split(","):
        tag = tag.strip()
        if not tag:
            continue
        exact = vocab.lookup.get(tag.lower())
        hit = {exact} if exact else set(find(tag, vocab))
        out |= hit or {tag}
    return out


def analyze(posting: str, bank_skills, bank_text: str, blocks):
    """What a posting asks for, which of it you have, and which paragraphs fit.

    bank_text is everything you've written (bullets, skills, paragraphs). A term counts as yours if it shows up there.
    """
    vocab = vocabulary(bank_skills)
    wanted = find(posting, vocab)
    have = set(find(bank_text, vocab))
    terms = sorted(wanted, key=lambda t: (-wanted[t], t.lower()))
    lower = {t.lower() for t in terms}
    suggested = [b["id"] for b in blocks
                 if not b["archived"] and {t.lower() for t in match_tags(b["tags"], vocab)} & lower]
    marks, offset = [], 0
    for line in (posting or "").split("\n"):
        marks += [[offset + a, offset + b, name] for a, b, name in spans(line, vocab)]
        offset += len(line) + 1
    return {
        "terms": [{"term": t, "score": round(wanted[t], 1), "have": t in have} for t in terms],
        "marks": marks,
        "suggested_blocks": suggested,
    }
