"""Fill the LaTeX template and compile it with pdflatex."""
import os
import re
import shutil
import subprocess
import tempfile
from io import BytesIO
from pathlib import Path

import jinja2

from .escape import tex

TEMPLATE_DIR = Path(__file__).resolve().parent / "templates"
COMPILE_TIMEOUT = int(os.environ.get("COMPILE_TIMEOUT", "20"))

_env = jinja2.Environment(
    loader=jinja2.FileSystemLoader(str(TEMPLATE_DIR)),
    block_start_string=r"\BLOCK{",
    block_end_string="}",
    variable_start_string=r"\VAR{",
    variable_end_string="}",
    comment_start_string=r"\#{",
    comment_end_string="}",
    trim_blocks=True,
    lstrip_blocks=True,
    autoescape=False,
    undefined=jinja2.StrictUndefined,
)


def _url(u: str) -> str:
    u = (u or "").strip()
    if not re.match(r"^(https?://|mailto:|tel:)", u, re.I):
        u = "https://" + u if u else ""
    u = re.sub(r"[\\{}\s]", "", u)
    return u.replace("%", r"\%").replace("#", r"\#")


_env.filters["tex"] = tex
_env.filters["url"] = _url


class LatexError(RuntimeError):
    def __init__(self, message, log=""):
        super().__init__(message)
        self.log = log


def render_tex(doc: dict) -> str:
    return _env.get_template("resume.tex.j2").render(**doc)


def find_pdflatex():
    exe = os.environ.get("PDFLATEX") or shutil.which("pdflatex")
    if exe:
        return exe
    for p in (  # common installs when running outside Docker
        "/Library/TeX/texbin/pdflatex",
        r"C:\Program Files\MiKTeX\miktex\bin\x64\pdflatex.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Programs\MiKTeX\miktex\bin\x64\pdflatex.exe"),
    ):
        if os.path.exists(p):
            return p
    return None


def compile_pdf(source: str) -> bytes:
    exe = find_pdflatex()
    if not exe:
        raise LatexError("pdflatex is not installed here. Run the app in Docker, or switch the format to DOCX.")
    with tempfile.TemporaryDirectory(prefix="hirelighter-") as tmp:
        (Path(tmp) / "resume.tex").write_text(source, encoding="utf-8")
        args = [exe, "-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error"]
        if "miktex" in exe.lower():
            args.append("--enable-installer")  # fetch missing packages instead of popping up a prompt
        try:
            proc = subprocess.run(
                [*args, "resume.tex"],
                cwd=tmp, capture_output=True, timeout=COMPILE_TIMEOUT,
                env={**os.environ, "HOME": tmp, "TEXMFVAR": os.path.join(tmp, "texmf-var")},
            )
        except subprocess.TimeoutExpired:
            raise LatexError(f"pdflatex timed out after {COMPILE_TIMEOUT}s")
        pdf = Path(tmp) / "resume.pdf"
        if proc.returncode != 0 or not pdf.exists():
            log = proc.stdout.decode("utf-8", "replace")
            errors = [ln for ln in log.splitlines() if ln.startswith("!")]
            raise LatexError(errors[0] if errors else "pdflatex failed", log[-4000:])
        return pdf.read_bytes()


def page_count(pdf: bytes) -> int:
    from pypdf import PdfReader
    return len(PdfReader(BytesIO(pdf)).pages)
