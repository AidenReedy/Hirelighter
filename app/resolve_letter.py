"""Turn a letter config plus the paragraph bank into the concrete letter to render.

Config (stored in letters.config, and sent by the Cover Letter tab):
    company, role     -- fill {company} and {role}
    posting           -- pasted job posting (only used for keyword suggestions)
    why               -- the "why this company" paragraph, written fresh each time
    greeting, closing -- default "Dear {company} Hiring Team," and "Sincerely,"
    keywords          -- chosen keywords, in order: {keyword1}, {keyword2}, ... and {keywords} as a phrase
    blocks            -- [{"id": <paragraph id> | "why", "text": <optional edit for this letter only>,
                           "fill": false to leave {keyword...} placeholders alone (you write the keywords yourself)}]
"""
import re
from datetime import date

PLACEHOLDER = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")
DEFAULT_CLOSING = "Sincerely,"


def default_greeting(company: str) -> str:
    return f"Dear {company.strip()} Hiring Team," if (company or "").strip() else "Dear Hiring Team,"


def phrase(items) -> str:
    """["a"] -> "a"; ["a", "b"] -> "a and b"; ["a", "b", "c"] -> "a, b, and c"."""
    items = [i for i in items if i]
    if len(items) <= 2:
        return " and ".join(items)
    return ", ".join(items[:-1]) + ", and " + items[-1]


def fill(text: str, values: dict, unfilled: set) -> str:
    def sub(m):
        v = values.get(m.group(1).lower())
        if v:
            return v
        unfilled.add(m.group(0))
        return m.group(0)
    return PLACEHOLDER.sub(sub, text or "")


def long_date(d: date) -> str:
    return f"{d:%B} {d.day}, {d.year}"


def resolve_letter(profile: dict, blocks: list, config: dict, today: date | None = None):
    """Returns (doc, unfilled placeholders). The doc is what render_letter_tex / render_letter_docx take."""
    company = (config.get("company") or "").strip()
    role = (config.get("role") or "").strip()
    keywords = [k.strip() for k in config.get("keywords") or [] if k and k.strip()]
    basic = {"company": company, "role": role}
    values = {**basic, "keywords": phrase(keywords)}
    values.update({f"keyword{i}": k for i, k in enumerate(keywords, start=1)})

    bank = {b["id"]: b for b in blocks}
    unfilled = set()
    paragraphs = []
    for item in config.get("blocks") or []:
        bid = item.get("id")
        if bid == "why":
            text = config.get("why") or ""
        elif bid in bank and not bank[bid]["archived"]:
            text = item.get("text") if item.get("text") is not None else bank[bid]["text"]
        else:
            continue
        use = values if item.get("fill", True) is not False else basic
        for para in re.split(r"\n\s*\n", text or ""):
            para = " ".join(para.split())
            if para:
                paragraphs.append(fill(para, use, unfilled))

    greeting = (config.get("greeting") or "").strip() or default_greeting(company)
    doc = {
        "profile": profile,
        "date": long_date(today or date.today()),
        "company": company,
        "greeting": fill(greeting, values, unfilled),
        "paragraphs": paragraphs,
        "closing": (config.get("closing") or "").strip() or DEFAULT_CLOSING,
        "name": profile.get("name", ""),
    }
    return doc, sorted(unfilled)
