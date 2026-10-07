"""REST API: content bank CRUD, presets, rendering, jobs, sankey, backup."""
import io
import json
import os
import re
import sqlite3
import uuid
import zipfile
from datetime import date, datetime

from flask import Blueprint, Response, abort, jsonify, request, send_file

from . import db, sankey, seed
from .import_tex import TexImportError
from .render_docx import render_docx
from .render_latex import LatexError, compile_pdf, page_count, render_tex
from .resolve import resolve

bp = Blueprint("api", __name__, url_prefix="/api")

# Longest bullet that still fits on one line in the default template (letter, 11pt, 0.5in margins).
MAX_BULLET_CHARS = int(os.environ.get("MAX_BULLET_CHARS", "107"))


def body():
    return request.get_json(silent=True) or {}


def pick(data, fields):
    return {k: data[k] for k in fields if k in data}


def update_row(table, rid, data, fields):
    vals = pick(data, fields)
    if not vals:
        return
    sets = ", ".join(f"{k} = ?" for k in vals)
    cur = db.execute(f"UPDATE {table} SET {sets} WHERE id = ?", (*vals.values(), rid))
    if cur.rowcount == 0:
        abort(404)


def reorder(table, ids, where_col=None, where_val=None):
    conn = db.connect()
    for i, rid in enumerate(ids):
        if where_col:
            conn.execute(f"UPDATE {table} SET sort = ? WHERE id = ? AND {where_col} = ?", (i, rid, where_val))
        else:
            conn.execute(f"UPDATE {table} SET sort = ? WHERE id = ?", (i, rid))
    conn.commit()


@bp.errorhandler(400)
@bp.errorhandler(404)
@bp.errorhandler(409)
def json_error(e):
    return jsonify(error=e.description), e.code


# ---------- whole state ----------

@bp.get("/state")
def state():
    return jsonify(bank=db.bank(), resumes=db.resumes(), statuses=db.STATUSES, entry_kinds=db.ENTRY_KINDS,
                   settings={"max_bullet_chars": MAX_BULLET_CHARS}, empty=seed.is_empty())


# ---------- setup / import ----------

@bp.get("/template")
def blank_template():
    return send_file(seed.BLANK_TEMPLATE, as_attachment=True, download_name="resume_template.tex",
                     mimetype="application/x-tex")


@bp.post("/import")
def import_resume():
    """Upload a .tex (Jake's template) or .json. ?preview=1 only parses; otherwise replaces the content bank."""
    f = request.files.get("file") or abort(400, "attach a .tex or .json file")
    try:
        data = seed.parse_file(f.filename or "", f.read())
    except (TexImportError, ValueError, KeyError) as e:
        return jsonify(error=f"Couldn't read that file: {e}"), 400
    info = seed.summary(data)
    if request.args.get("preview") == "1":
        return jsonify(info)
    seed.clear_content()
    seed.load(data)
    return jsonify(info)


@bp.post("/start-blank")
def start_blank():
    if not seed.is_empty():
        abort(409, "There's already content. Delete it in Content first.")
    seed.load(seed.STARTER)
    return jsonify(ok=True)


# ---------- profile ----------

@bp.put("/profile")
def put_profile():
    d = body()
    links = [{"text": str(l.get("text", "")), "url": str(l.get("url", ""))} for l in d.get("links", [])]
    db.execute("INSERT OR REPLACE INTO profile (id, name, links) VALUES (1, ?, ?)",
               (d.get("name", ""), json.dumps(links)))
    return jsonify(ok=True)


# ---------- sections ----------

@bp.post("/sections")
def add_section():
    d = body()
    title = (d.get("title") or "").strip() or abort(400, "title required")
    kind = d.get("kind", "entries")
    if kind not in ("entries", "skills"):
        abort(400, "bad kind")
    cur = db.execute("INSERT INTO sections (title, kind, sort) VALUES (?, ?, ?)",
                     (title, kind, db.next_sort("sections")))
    return jsonify(id=cur.lastrowid), 201


@bp.put("/sections/<int:sid>")
def put_section(sid):
    update_row("sections", sid, body(), ["title"])
    return jsonify(ok=True)


@bp.delete("/sections/<int:sid>")
def del_section(sid):
    db.execute("DELETE FROM sections WHERE id = ?", (sid,))
    db.prune_configs()
    return jsonify(ok=True)


@bp.post("/sections/reorder")
def reorder_sections():
    reorder("sections", body().get("ids", []))
    return jsonify(ok=True)


# ---------- entries ----------

ENTRY_FIELDS = ["kind", "title", "org", "date", "location", "tech"]


@bp.post("/entries")
def add_entry():
    d = body()
    sid = d.get("section_id")
    if not db.row("SELECT id FROM sections WHERE id = ? AND kind = 'entries'", (sid,)):
        abort(400, "unknown section")
    if d.get("kind", "job") not in db.ENTRY_KINDS:
        abort(400, "bad kind")
    vals = {k: d.get(k, "") for k in ENTRY_FIELDS}
    vals["kind"] = vals["kind"] or "job"
    cur = db.execute(
        "INSERT INTO entries (section_id, kind, title, org, date, location, tech, sort) VALUES (?,?,?,?,?,?,?,?)",
        (sid, *vals.values(), db.next_sort("entries", "section_id = ?", (sid,))))
    return jsonify(id=cur.lastrowid), 201


@bp.put("/entries/<int:eid>")
def put_entry(eid):
    d = body()
    if "kind" in d and d["kind"] not in db.ENTRY_KINDS:
        abort(400, "bad kind")
    update_row("entries", eid, d, ENTRY_FIELDS)
    return jsonify(ok=True)


@bp.delete("/entries/<int:eid>")
def del_entry(eid):
    db.execute("DELETE FROM entries WHERE id = ?", (eid,))
    db.prune_configs()
    return jsonify(ok=True)


@bp.post("/entries/reorder")
def reorder_entries():
    d = body()
    reorder("entries", d.get("ids", []), "section_id", d.get("section_id"))
    return jsonify(ok=True)


# ---------- bullets ----------

@bp.post("/bullets")
def add_bullet():
    d = body()
    eid = d.get("entry_id")
    if not db.row("SELECT id FROM entries WHERE id = ?", (eid,)):
        abort(400, "unknown entry")
    cur = db.execute("INSERT INTO bullets (entry_id, text, note, sort) VALUES (?, ?, ?, ?)",
                     (eid, d.get("text", ""), d.get("note", ""), db.next_sort("bullets", "entry_id = ?", (eid,))))
    return jsonify(id=cur.lastrowid), 201


@bp.put("/bullets/<int:bid>")
def put_bullet(bid):
    d = body()
    if "archived" in d:
        d["archived"] = 1 if d["archived"] else 0
    moving = "entry_id" in d
    if moving:
        if not db.row("SELECT id FROM entries WHERE id = ?", (d["entry_id"],)):
            abort(400, "unknown entry")
        d["sort"] = db.next_sort("bullets", "entry_id = ?", (d["entry_id"],))
    update_row("bullets", bid, d, ["text", "note", "archived", "entry_id", "sort"])
    if moving:
        _unlink_bullet(bid)
    return jsonify(ok=True)


def _unlink_bullet(bid):
    """A moved bullet no longer belongs to its old entry in any preset."""
    for r in db.resumes():
        cfg = r["config"]
        for s in cfg.get("sections", []):
            for e in s.get("entries", []):
                if bid in e.get("bullets", []):
                    e["bullets"].remove(bid)
        db.execute("UPDATE resumes SET config = ? WHERE id = ?", (json.dumps(cfg), r["id"]))


@bp.delete("/bullets/<int:bid>")
def del_bullet(bid):
    db.execute("DELETE FROM bullets WHERE id = ?", (bid,))
    db.prune_configs()
    return jsonify(ok=True)


@bp.post("/bullets/reorder")
def reorder_bullets():
    d = body()
    reorder("bullets", d.get("ids", []), "entry_id", d.get("entry_id"))
    return jsonify(ok=True)


# ---------- skills ----------

@bp.post("/skill-groups")
def add_group():
    d = body()
    sid = d.get("section_id")
    if not db.row("SELECT id FROM sections WHERE id = ? AND kind = 'skills'", (sid,)):
        abort(400, "unknown skills section")
    name = (d.get("name") or "").strip() or abort(400, "name required")
    cur = db.execute("INSERT INTO skill_groups (section_id, name, sort) VALUES (?, ?, ?)",
                     (sid, name, db.next_sort("skill_groups", "section_id = ?", (sid,))))
    return jsonify(id=cur.lastrowid), 201


@bp.put("/skill-groups/<int:gid>")
def put_group(gid):
    update_row("skill_groups", gid, body(), ["name"])
    return jsonify(ok=True)


@bp.delete("/skill-groups/<int:gid>")
def del_group(gid):
    db.execute("DELETE FROM skill_groups WHERE id = ?", (gid,))
    db.prune_configs()
    return jsonify(ok=True)


@bp.post("/skill-groups/reorder")
def reorder_groups():
    d = body()
    reorder("skill_groups", d.get("ids", []), "section_id", d.get("section_id"))
    return jsonify(ok=True)


@bp.post("/skills")
def add_skill():
    d = body()
    gid = d.get("group_id")
    if not db.row("SELECT id FROM skill_groups WHERE id = ?", (gid,)):
        abort(400, "unknown group")
    name = (d.get("name") or "").strip() or abort(400, "name required")
    cur = db.execute("INSERT INTO skills (group_id, name, sort) VALUES (?, ?, ?)",
                     (gid, name, db.next_sort("skills", "group_id = ?", (gid,))))
    return jsonify(id=cur.lastrowid), 201


@bp.put("/skills/<int:kid>")
def put_skill(kid):
    update_row("skills", kid, body(), ["name"])
    return jsonify(ok=True)


@bp.delete("/skills/<int:kid>")
def del_skill(kid):
    db.execute("DELETE FROM skills WHERE id = ?", (kid,))
    db.prune_configs()
    return jsonify(ok=True)


@bp.post("/skills/reorder")
def reorder_skills():
    d = body()
    reorder("skills", d.get("ids", []), "group_id", d.get("group_id"))
    return jsonify(ok=True)


# ---------- resumes (presets) ----------

def _check_name(name, rid=None):
    name = (name or "").strip()
    if not name:
        abort(400, "name required")
    clash = db.row("SELECT id FROM resumes WHERE name = ? COLLATE NOCASE", (name,))
    if clash and clash["id"] != rid:
        abort(409, f"a resume named '{name}' already exists")
    return name


@bp.post("/resumes")
def add_resume():
    d = body()
    name = _check_name(d.get("name"))
    fmt = d.get("format", "pdf") if d.get("format") in ("pdf", "docx") else "pdf"
    cur = db.execute("INSERT INTO resumes (name, format, config) VALUES (?, ?, ?)",
                     (name, fmt, json.dumps(d.get("config", {}))))
    return jsonify(id=cur.lastrowid), 201


@bp.put("/resumes/<int:rid>")
def put_resume(rid):
    d = body()
    vals = {}
    if "name" in d:
        vals["name"] = _check_name(d["name"], rid)
    if d.get("format") in ("pdf", "docx"):
        vals["format"] = d["format"]
    if "config" in d:
        vals["config"] = json.dumps(d["config"])
    if vals:
        update_row("resumes", rid, vals, list(vals))
        db.execute("UPDATE resumes SET updated_at = datetime('now') WHERE id = ?", (rid,))
    return jsonify(ok=True)


@bp.delete("/resumes/<int:rid>")
def del_resume(rid):
    db.execute("DELETE FROM resumes WHERE id = ?", (rid,))
    return jsonify(ok=True)


# ---------- rendering ----------

def resume_filename(ext):
    """Every resume downloads as First_Last.<ext>, whatever the preset is called."""
    return safe_filename(db.bank()["profile"].get("name") or "Resume") + ext


def safe_filename(*parts):
    return "_".join(re.sub(r"[^A-Za-z0-9.-]+", "_", p).strip("_") for p in parts if p)


@bp.post("/render")
def render():
    d = body()
    fmt = d.get("format", "pdf")
    doc = resolve(db.bank(), d.get("config", {}))
    if fmt == "docx":
        data = render_docx(doc)
        resp = Response(data, mimetype="application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        resp.headers["X-Filename"] = resume_filename(".docx")
        return resp
    if fmt == "tex":
        resp = Response(render_tex(doc), mimetype="application/x-tex")
        resp.headers["X-Filename"] = resume_filename(".tex")
        return resp
    try:
        pdf = compile_pdf(render_tex(doc))
    except LatexError as e:
        return jsonify(error=str(e), log=e.log), 422
    resp = Response(pdf, mimetype="application/pdf")
    resp.headers["X-Filename"] = resume_filename(".pdf")
    resp.headers["X-Page-Count"] = str(page_count(pdf))
    return resp


# ---------- jobs ----------

JOB_FIELDS = ["company", "role", "url", "status", "applied_date", "interview_count", "notes", "resume_id", "resume_name"]


def _event(job_id, kind, a, b):
    db.execute("INSERT INTO job_events (job_id, kind, from_value, to_value) VALUES (?, ?, ?, ?)",
               (job_id, kind, None if a is None else str(a), None if b is None else str(b)))


def _normalize_job(d, current=None):
    if "applied" in d and "status" not in d:
        if not d["applied"]:
            d["status"] = "not_applied"
        elif not current or current["status"] == "not_applied":
            d["status"] = "applied"
    if "status" in d and d["status"] not in db.STATUSES:
        abort(400, "bad status")
    if "interview_count" in d:
        d["interview_count"] = max(0, int(d["interview_count"] or 0))
    status = d.get("status", current["status"] if current else "applied")
    count = d.get("interview_count", current["interview_count"] if current else 0)
    if status == "interviewing" and count == 0:
        d["interview_count"] = 1
    if status != "not_applied" and not d.get("applied_date") and not (current and current["applied_date"]):
        d["applied_date"] = date.today().isoformat()
    return d


@bp.get("/jobs")
def list_jobs():
    return jsonify(db.rows("SELECT * FROM jobs ORDER BY COALESCE(applied_date, created_at) DESC, id DESC"))


@bp.post("/jobs")
def add_job():
    if request.mimetype == "multipart/form-data":
        d = json.loads(request.form.get("job", "{}"))
        upload = request.files.get("resume")
    else:
        d, upload = body(), None
    d = _normalize_job(d)
    d.setdefault("status", "applied")
    if not (d.get("company") or "").strip():
        abort(400, "company required")
    vals = {k: d.get(k) for k in JOB_FIELDS if k in d}
    cols = ", ".join(vals)
    cur = db.execute(f"INSERT INTO jobs ({cols}) VALUES ({', '.join('?' * len(vals))})", tuple(vals.values()))
    jid = cur.lastrowid
    if upload:
        ext = ".docx" if upload.filename.lower().endswith(".docx") else ".pdf"
        fname = f"{jid}-{uuid.uuid4().hex[:8]}{ext}"
        upload.save(db.SENT_DIR / fname)
        db.execute("UPDATE jobs SET resume_file = ? WHERE id = ?", (fname, jid))
    _event(jid, "created", None, d["status"])
    return jsonify(db.row("SELECT * FROM jobs WHERE id = ?", (jid,))), 201


@bp.put("/jobs/<int:jid>")
def put_job(jid):
    cur = db.row("SELECT * FROM jobs WHERE id = ?", (jid,)) or abort(404)
    d = _normalize_job(body(), cur)
    vals = pick(d, JOB_FIELDS)
    if vals:
        update_row("jobs", jid, vals, list(vals))
        db.execute("UPDATE jobs SET updated_at = datetime('now') WHERE id = ?", (jid,))
    if "status" in vals and vals["status"] != cur["status"]:
        _event(jid, "status", cur["status"], vals["status"])
    if "interview_count" in vals and vals["interview_count"] != cur["interview_count"]:
        _event(jid, "interviews", cur["interview_count"], vals["interview_count"])
    return jsonify(db.row("SELECT * FROM jobs WHERE id = ?", (jid,)))


@bp.delete("/jobs/<int:jid>")
def del_job(jid):
    j = db.row("SELECT resume_file FROM jobs WHERE id = ?", (jid,))
    db.execute("DELETE FROM jobs WHERE id = ?", (jid,))
    if j and j["resume_file"]:
        (db.SENT_DIR / j["resume_file"]).unlink(missing_ok=True)
    return jsonify(ok=True)


@bp.get("/jobs/<int:jid>/events")
def job_events(jid):
    return jsonify(db.rows("SELECT * FROM job_events WHERE job_id = ? ORDER BY at, id", (jid,)))


@bp.get("/jobs/<int:jid>/resume")
def job_resume(jid):
    j = db.row("SELECT * FROM jobs WHERE id = ?", (jid,)) or abort(404)
    if not j["resume_file"]:
        abort(404, "no resume saved for this job")
    path = db.SENT_DIR / j["resume_file"]
    if not path.exists():
        abort(404, "file missing")
    return send_file(path, as_attachment=request.args.get("dl") == "1", download_name=resume_filename(path.suffix))


@bp.get("/sankey")
def get_sankey():
    return jsonify(sankey.build(db.rows("SELECT status, interview_count FROM jobs")))


# ---------- backup ----------

@bp.get("/backup")
def backup():
    buf = io.BytesIO()
    snap = db.DATA_DIR / "backup-snapshot.db"
    src = db.connect()
    dst = sqlite3.connect(snap)
    src.backup(dst)
    dst.close()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(snap, "app.db")
        for f in db.SENT_DIR.iterdir():
            z.write(f, f"sent/{f.name}")
    snap.unlink(missing_ok=True)
    buf.seek(0)
    stamp = datetime.now().strftime("%Y-%m-%d")
    return send_file(buf, mimetype="application/zip", as_attachment=True,
                     download_name=f"hirelighter-backup-{stamp}.zip")
