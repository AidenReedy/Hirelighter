"""Load resume content into the database: from an uploaded .tex / .json file, or as an empty starter.

The app starts with nothing in it and shows a setup screen. You can also import from the command line:

    python -m app.seed path/to/resume.tex        # Jake's Resume template (or the blank template, filled in)
    python -m app.seed path/to/seed.json         # the app's own JSON format
    docker compose run --rm -v "$PWD/private:/import:ro" resume python -m app.seed /import/main.tex
"""
import json
import sys
from pathlib import Path

from . import db
from .import_tex import parse_resume

BLANK_TEMPLATE = Path(__file__).resolve().parent.parent / "seed" / "blank_template.tex"

STARTER = {
    "profile": {"name": "", "links": []},
    "sections": [
        {"title": "Experience", "kind": "entries", "entries": []},
        {"title": "Education", "kind": "entries", "entries": []},
        {"title": "Projects", "kind": "entries", "entries": []},
        {"title": "Technical Skills", "kind": "skills", "groups": []},
    ],
    "preset": {"name": "General", "format": "pdf"},
}


def is_empty():
    return db.row("SELECT id FROM sections LIMIT 1") is None


def parse_file(name: str, raw: bytes) -> dict:
    text = raw.decode("utf-8-sig", errors="replace")
    if name.lower().endswith(".json"):
        data = json.loads(text)
        data.setdefault("warnings", [])
        return data
    return parse_resume(text)


def clear_content():
    """Remove the content bank and presets. Jobs are kept (their resume link is unset)."""
    conn = db.connect()
    conn.execute("DELETE FROM resumes")
    conn.execute("DELETE FROM sections")  # cascades to entries, bullets, skill groups, skills
    conn.execute("DELETE FROM profile")
    conn.commit()


def load(data: dict):
    """Insert parsed content and a preset that includes all of it."""
    conn = db.connect()
    p = data.get("profile") or {}
    conn.execute("INSERT OR REPLACE INTO profile (id, name, links) VALUES (1, ?, ?)",
                 (p.get("name", ""), json.dumps(p.get("links", []))))

    pr = data.get("preset") or {"name": "General", "format": "pdf"}
    skip_entries = set(pr.get("exclude_entries", []))
    preset_sections = []
    for si, s in enumerate(data["sections"]):
        sid = conn.execute("INSERT INTO sections (title, kind, sort) VALUES (?, ?, ?)",
                           (s["title"], s.get("kind", "entries"), si)).lastrowid
        ps = {"id": sid, "entries": [], "skills": []}
        for ei, e in enumerate(s.get("entries", [])):
            eid = conn.execute(
                "INSERT INTO entries (section_id, kind, title, org, date, location, tech, sort)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (sid, e.get("kind", "job"), e.get("title", ""), e.get("org", ""), e.get("date", ""),
                 e.get("location", ""), e.get("tech", ""), ei)).lastrowid
            pe = {"id": eid, "bullets": []}
            for bi, b in enumerate(e.get("bullets", [])):
                b = {"text": b} if isinstance(b, str) else b
                bid = conn.execute(
                    "INSERT INTO bullets (entry_id, text, note, sort) VALUES (?, ?, ?, ?)",
                    (eid, b["text"], b.get("note", ""), bi)).lastrowid
                if not b.get("exclude"):
                    pe["bullets"].append(bid)
            if e.get("title") not in skip_entries:
                ps["entries"].append(pe)
        for gi, g in enumerate(s.get("groups", [])):
            gid = conn.execute("INSERT INTO skill_groups (section_id, name, sort) VALUES (?, ?, ?)",
                               (sid, g["name"], gi)).lastrowid
            for ki, k in enumerate(g["skills"]):
                kid = conn.execute("INSERT INTO skills (group_id, name, sort) VALUES (?, ?, ?)",
                                   (gid, k, ki)).lastrowid
                ps["skills"].append(kid)
        preset_sections.append(ps)

    cfg = {"sections": preset_sections, "skills_layout": "inline"}
    conn.execute("INSERT INTO resumes (name, format, config) VALUES (?, ?, ?)",
                 (pr.get("name", "General"), pr.get("format", "pdf"), json.dumps(cfg)))
    conn.commit()


def summary(data: dict) -> dict:
    entries = [e for s in data["sections"] for e in s.get("entries", [])]
    return {
        "name": (data.get("profile") or {}).get("name", ""),
        "sections": len(data["sections"]),
        "entries": len(entries),
        "bullets": sum(len(e.get("bullets", [])) for e in entries),
        "skills": sum(len(g["skills"]) for s in data["sections"] for g in s.get("groups", [])),
        "warnings": data.get("warnings", []),
    }


def main(argv):
    if len(argv) != 1:
        print(__doc__)
        return 2
    db.migrate()
    if not is_empty():
        print(f"{db.DB_PATH} already has content; nothing imported. Use the app's Import button to replace it.")
        return 1
    path = Path(argv[0])
    data = parse_file(path.name, path.read_bytes())
    load(data)
    s = summary(data)
    print(f"Imported {s['name'] or path.name}: {s['sections']} sections, {s['entries']} entries, "
          f"{s['bullets']} bullets, {s['skills']} skills into {db.DB_PATH}")
    for w in s["warnings"]:
        print("warning:", w)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
