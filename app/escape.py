"""Escape user text for LaTeX. Only markup allowed: **bold**."""
import re

_TEX_MAP = {
    "\\": r"\textbackslash{}",
    "&": r"\&",
    "%": r"\%",
    "$": r"\$",
    "#": r"\#",
    "_": r"\_",
    "{": r"\{",
    "}": r"\}",
    "~": r"\textasciitilde{}",
    "^": r"\textasciicircum{}",
    "<": r"\textless{}",
    ">": r"\textgreater{}",
}
_TEX_RE = re.compile("|".join(re.escape(k) for k in _TEX_MAP))
_BOLD_RE = re.compile(r"\*\*(.+?)\*\*")


def _plain(s: str) -> str:
    return _TEX_RE.sub(lambda m: _TEX_MAP[m.group(0)], s)


def tex(s) -> str:
    """Escape a string for LaTeX, turning **bold** into \\textbf{bold}."""
    if s is None:
        return ""
    s = str(s).replace("\r", " ").replace("\n", " ")
    out, pos = [], 0
    for m in _BOLD_RE.finditer(s):
        out.append(_plain(s[pos:m.start()]))
        out.append(r"\textbf{" + _plain(m.group(1)) + "}")
        pos = m.end()
    out.append(_plain(s[pos:]))
    return "".join(out)


def bold_runs(s):
    """Split text into (text, is_bold) runs for DOCX. Also turns -- into an en dash."""
    s = (s or "").replace("--", "–")
    runs, pos = [], 0
    for m in _BOLD_RE.finditer(s):
        if m.start() > pos:
            runs.append((s[pos:m.start()], False))
        runs.append((m.group(1), True))
        pos = m.end()
    if pos < len(s):
        runs.append((s[pos:], False))
    return runs


def visible_len(s: str) -> int:
    """Character count as it appears on the page (markup and -- collapsed)."""
    s = _BOLD_RE.sub(lambda m: m.group(1), s or "")
    return len(s.replace("--", "–"))
