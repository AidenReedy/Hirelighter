"""Parse a resume written in Jake's Resume LaTeX template into the app's seed format.

Understands the template's own macros: the centered header, \\section, \\resumeSubheading,
\\resumeProjectHeading, \\resumeItem, a one-line tabular (used for certifications), and the
Technical Skills block of \\textbf{Group}{: a, b, c}.
"""
import re

TEX_UNESCAPE = [
    (r"\textbackslash{}", "\\"), (r"\textasciitilde{}", "~"), (r"\textasciicircum{}", "^"),
    (r"\textless{}", "<"), (r"\textgreater{}", ">"),
    (r"\&", "&"), (r"\%", "%"), (r"\$", "$"), (r"\#", "#"), (r"\_", "_"), (r"\{", "{"), (r"\}", "}"),
]


class TexImportError(ValueError):
    pass


def strip_comments(src: str) -> str:
    return "\n".join(re.sub(r"(?<!\\)%.*", "", line) for line in src.splitlines())


def read_group(s: str, i: int):
    """Read one {balanced} group starting at or after i (skipping whitespace). Returns (content, end)."""
    while i < len(s) and s[i].isspace():
        i += 1
    if i >= len(s) or s[i] != "{":
        raise TexImportError(f"expected '{{' near: {s[i:i + 40]!r}")
    depth, j = 0, i
    while j < len(s):
        c = s[j]
        if c == "\\":
            j += 2
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return s[i + 1:j], j + 1
        j += 1
    raise TexImportError("unbalanced braces")


def read_groups(s: str, i: int, n: int):
    out = []
    for _ in range(n):
        g, i = read_group(s, i)
        out.append(g)
    return out, i


def _replace_cmd(s: str, cmd: str, fn):
    """Replace \\cmd{arg} (balanced) with fn(arg)."""
    out, i = [], 0
    pat = re.compile(r"\\" + cmd + r"(?![A-Za-z])\s*(?=\{)")
    while True:
        m = pat.search(s, i)
        if not m:
            out.append(s[i:])
            return "".join(out)
        out.append(s[i:m.start()])
        arg, i = read_group(s, m.end())
        out.append(fn(arg))


def to_text(s: str) -> str:
    """LaTeX fragment -> the app's plain text (bold kept as **x**, -- kept for dashes)."""
    s = _replace_cmd(s, "textbf", lambda a: "**" + to_text(a) + "**")
    for cmd in ("emph", "textit", "underline", "textsc", "small", "large", "Large", "Huge", "mbox", "text"):
        s = _replace_cmd(s, cmd, to_text)
    s = re.sub(r"\\href\s*\{[^}]*\}", "", s)
    s = re.sub(r"\\vspace\*?\s*\{[^}]*\}", "", s)
    s = s.replace("$|$", "|").replace("\\\\", " ")
    placeholders = {}
    for k, (esc, plain) in enumerate(TEX_UNESCAPE):
        token = f"\x00{k}\x00"
        placeholders[token] = plain
        s = s.replace(esc, token)
    s = re.sub(r"\\[A-Za-z]+\*?", "", s)          # drop any remaining commands (\small, \scshape, ...)
    s = s.replace("{", "").replace("}", "").replace("~", " ")
    for token, plain in placeholders.items():
        s = s.replace(token, plain)
    s = re.sub(r"\s+", " ", s).strip()
    return re.sub(r"\*\*\s*\*\*", "", s)


def _unbold(s: str) -> str:
    return re.sub(r"^\*\*(.*)\*\*$", r"\1", s.strip())


def split_bar(s: str):
    """Split on $|$ separators at the top level."""
    return [p.strip() for p in s.split("$|$")]


def parse_header(body: str):
    m = re.search(r"\\begin\{center\}(.*?)\\end\{center\}", body, re.S)
    if not m:
        return {"name": "", "links": []}
    block = m.group(1)
    name = ""
    nm = re.search(r"\\textbf\s*\{", block)
    if nm:
        inner, end = read_group(block, nm.end() - 1)
        name = _unbold(to_text(inner))
        block = block[end:]
    links = []
    for part in split_bar(block):
        hm = re.search(r"\\href\s*\{", part)
        if hm:
            (url, text), _ = read_groups(part, hm.end() - 1, 2)
            links.append({"text": to_text(text), "url": url.strip()})
        else:
            t = to_text(part)
            if t:
                links.append({"text": t, "url": ""})
    return {"name": name, "links": links}


ITEM_RE = re.compile(
    r"\\resumeSubheading(?![A-Za-z])|\\resumeProjectHeading(?![A-Za-z])|\\resumeItem(?![A-Za-z])"
    r"|\\begin\{tabular\*\}"
)


def parse_entries(title: str, content: str):
    entries, warnings = [], []
    is_edu = bool(re.search(r"educat", title, re.I))
    is_proj = bool(re.search(r"project", title, re.I))
    i = 0
    while True:
        m = ITEM_RE.search(content, i)
        if not m:
            break
        tok = m.group(0)
        if tok.startswith(r"\resumeSubheading"):
            (a, b, c, d), i = read_groups(content, m.end(), 4)
            a, b, c, d = (to_text(x) for x in (a, b, c, d))
            if is_edu:
                entries.append({"kind": "education", "org": a, "location": b, "title": c, "date": d, "bullets": []})
            else:
                entries.append({"kind": "job", "title": a, "date": b, "org": c, "location": d, "bullets": []})
        elif tok.startswith(r"\resumeProjectHeading"):
            (left, date), i = read_groups(content, m.end(), 2)
            parts = split_bar(left)
            entries.append({
                "kind": "project" if is_proj else "activity",
                "title": _unbold(to_text(parts[0])),
                "tech": to_text(" | ".join(parts[1:])) if len(parts) > 1 else "",
                "date": to_text(date), "bullets": [],
            })
        elif tok.startswith(r"\resumeItem"):
            (text,), i = read_groups(content, m.end(), 1)
            if not entries:
                warnings.append(f"{title}: bullet before any entry was skipped")
                continue
            t = to_text(text)
            if t:
                entries[-1]["bullets"].append({"text": t})
        else:  # \begin{tabular*}{width}[t]{cols} left & right \\ \end{tabular*}
            _, j = read_group(content, m.end())
            j = content.find("{", j)
            _, j = read_group(content, j)
            end = content.find(r"\end{tabular*}", j)
            row = content[j:end if end != -1 else len(content)]
            i = end + 1 if end != -1 else len(content)
            row = row.split("\\\\")[0]
            left, _, right = row.partition("&")
            entries.append({"kind": "cert", "title": _unbold(to_text(left)),
                            "date": to_text(right), "bullets": []})
    return entries, warnings


def parse_skills(content: str):
    groups = []
    for m in re.finditer(r"\\textbf\s*\{", content):
        name, j = read_group(content, m.end() - 1)
        k = j
        while k < len(content) and content[k].isspace():
            k += 1
        if k < len(content) and content[k] == "{":
            items, _ = read_group(content, k)
        else:  # \textbf{Languages}: Python, Bash   (no braces)
            items = re.split(r"\\quad|\\\\|\$\|\$|\}", content[j:], maxsplit=1)[0]
        items = to_text(items).lstrip(":").strip()
        skills = [x.strip() for x in items.split(",") if x.strip()]
        if skills:
            groups.append({"name": to_text(name).strip(":"), "skills": skills})
    return groups


def parse_resume(src: str) -> dict:
    """Return {"profile", "sections", "preset", "warnings"} from Jake's-template LaTeX source."""
    if r"\begin{document}" not in src:
        raise TexImportError("This doesn't look like a LaTeX resume (no \\begin{document}).")
    body = strip_comments(src.split(r"\begin{document}", 1)[1].split(r"\end{document}", 1)[0])
    profile = parse_header(body)
    sections, warnings = [], []
    parts = re.split(r"\\section\*?\s*\{", body)[1:]
    for part in parts:
        title_raw, end = read_group("{" + part, 0)
        title = to_text(title_raw)
        content = part[end - 1:]
        entries, w = parse_entries(title, content)
        warnings += w
        if entries:
            sections.append({"title": title, "kind": "entries", "entries": entries})
            continue
        groups = parse_skills(content)
        if groups:
            sections.append({"title": title, "kind": "skills", "groups": groups})
        else:
            warnings.append(f"Couldn't find any entries in section \"{title}\"; it was skipped.")
    if not sections:
        raise TexImportError("No sections found. Is this based on Jake's Resume template?")
    return {"profile": profile, "sections": sections, "preset": {"name": "General", "format": "pdf"},
            "warnings": warnings}
