"""Build-time check: import the blank template, compile it, and fail loudly if LaTeX is broken.

Run with:  python -m app.selftest
Uses a throwaway data folder so nothing is written to the real DATA_DIR.
"""
import sys
import tempfile
from pathlib import Path

from . import create_app, db, seed


def main():
    tmp = Path(tempfile.mkdtemp(prefix="selftest-"))
    # `python -m app.selftest` imports the package (and db's paths) before this runs, so repoint them here
    db.close()
    db.DATA_DIR, db.DB_PATH, db.SENT_DIR = tmp, tmp / "app.db", tmp / "sent"
    client = create_app().test_client()
    seed.load(seed.parse_file("blank_template.tex", seed.BLANK_TEMPLATE.read_bytes()))
    general = client.get("/api/state").get_json()["resumes"][0]
    for fmt in ("pdf", "docx"):
        r = client.post("/api/render", json={"config": general["config"], "format": fmt})
        if r.status_code != 200:
            print(f"selftest: {fmt} render failed: {r.get_json()}", file=sys.stderr)
            sys.exit(1)
        extra = f", {r.headers['X-Page-Count']} page(s)" if fmt == "pdf" else ""
        print(f"selftest: {fmt} ok ({len(r.data)} bytes{extra})")
    client.post("/api/letter-blocks/starter")
    blocks = client.get("/api/state").get_json()["letter_blocks"]
    letter = {"company": "Example & Co", "role": "Analyst", "keywords": ["incident response"], "why": "Test.",
              "blocks": [{"id": blocks[0]["id"]}, {"id": "why"}, *[{"id": b["id"]} for b in blocks[1:]]]}
    for fmt in ("pdf", "docx"):
        r = client.post("/api/render-letter", json={"config": letter, "format": fmt})
        if r.status_code != 200:
            print(f"selftest: cover letter {fmt} render failed: {r.get_json()}", file=sys.stderr)
            sys.exit(1)
        print(f"selftest: cover letter {fmt} ok ({len(r.data)} bytes)")
    db.close()


if __name__ == "__main__":
    main()
