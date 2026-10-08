"""SQLite storage. One file in DATA_DIR; schema versioned with PRAGMA user_version."""
import fcntl
import json
import os
import sqlite3
import threading
from pathlib import Path

DATA_DIR = Path(os.environ.get("DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
DB_PATH = DATA_DIR / "app.db"
SENT_DIR = DATA_DIR / "sent"

_local = threading.local()

STATUSES = [
    "not_applied",
    "applied",
    "interviewing",
    "rejected",
    "rejected_after_interview",
    "offered",
    "accepted",
    "declined",
]

ENTRY_KINDS = ["job", "education", "cert", "project", "activity"]

SCHEMA = [
    # v1
    """
    CREATE TABLE profile (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        name TEXT NOT NULL DEFAULT '',
        links TEXT NOT NULL DEFAULT '[]'          -- JSON [{text, url}]
    );
    CREATE TABLE sections (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'entries',     -- entries | skills
        sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE entries (
        id INTEGER PRIMARY KEY,
        section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
        kind TEXT NOT NULL DEFAULT 'job',
        title TEXT NOT NULL DEFAULT '',
        org TEXT NOT NULL DEFAULT '',
        date TEXT NOT NULL DEFAULT '',
        location TEXT NOT NULL DEFAULT '',
        tech TEXT NOT NULL DEFAULT '',
        sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE bullets (
        id INTEGER PRIMARY KEY,
        entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
        text TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        archived INTEGER NOT NULL DEFAULT 0,
        sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE skill_groups (
        id INTEGER PRIMARY KEY,
        section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE skills (
        id INTEGER PRIMARY KEY,
        group_id INTEGER NOT NULL REFERENCES skill_groups(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE resumes (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        format TEXT NOT NULL DEFAULT 'pdf',
        config TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE jobs (
        id INTEGER PRIMARY KEY,
        company TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'applied',
        applied_date TEXT,
        interview_count INTEGER NOT NULL DEFAULT 0,
        resume_id INTEGER REFERENCES resumes(id) ON DELETE SET NULL,
        resume_name TEXT NOT NULL DEFAULT '',
        resume_file TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE job_events (
        id INTEGER PRIMARY KEY,
        job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,                       -- status | interviews | created
        from_value TEXT,
        to_value TEXT,
        at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    """,
    # v2: Gmail rejection tracking (app/mailwatch.py)
    """
    CREATE TABLE mail_messages (
        id INTEGER PRIMARY KEY,
        message_id TEXT NOT NULL UNIQUE,          -- RFC 5322 Message-ID, so nothing is processed twice
        received_at TEXT NOT NULL,
        from_name TEXT NOT NULL DEFAULT '',
        from_addr TEXT NOT NULL DEFAULT '',
        subject TEXT NOT NULL DEFAULT '',
        snippet TEXT NOT NULL DEFAULT '',         -- short plain-text excerpt; full emails are never stored
        category TEXT NOT NULL,                   -- rejection | ack | other
        confidence TEXT NOT NULL DEFAULT '',      -- high | medium
        reason TEXT NOT NULL DEFAULT '',          -- the phrase that decided the category
        job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
        candidates TEXT NOT NULL DEFAULT '[]',    -- JSON job ids, best match first
        outcome TEXT NOT NULL,                    -- auto | review | accepted | dismissed | ignored | linked | undone
        from_status TEXT,
        to_status TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT
    );
    CREATE TABLE mail_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT ''
    );
    ALTER TABLE jobs ADD COLUMN expect_from TEXT NOT NULL DEFAULT '';   -- "Name <addr>" from the application-received email
    ALTER TABLE job_events ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';   -- manual | email
    ALTER TABLE job_events ADD COLUMN mail_id INTEGER REFERENCES mail_messages(id) ON DELETE SET NULL;
    """,
]


def connect() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(DB_PATH, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
        _local.conn = conn
    return conn


def close():
    conn = getattr(_local, "conn", None)
    if conn is not None:
        conn.close()
        _local.conn = None


def migrate():
    conn = connect()
    # gunicorn workers start together; the lock keeps two of them from running the same upgrade
    with open(DATA_DIR / ".migrate.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        for i, script in enumerate(SCHEMA[version:], start=version + 1):
            conn.executescript(script)
            conn.execute(f"PRAGMA user_version = {i}")
        conn.commit()
    SENT_DIR.mkdir(parents=True, exist_ok=True)


def rows(sql, args=()):
    return [dict(r) for r in connect().execute(sql, args).fetchall()]


def row(sql, args=()):
    r = connect().execute(sql, args).fetchone()
    return dict(r) if r else None


def execute(sql, args=()):
    conn = connect()
    cur = conn.execute(sql, args)
    conn.commit()
    return cur


def schema_current() -> bool:
    return connect().execute("PRAGMA user_version").fetchone()[0] >= len(SCHEMA)


def next_sort(table, where="1=1", args=()):
    r = connect().execute(f"SELECT COALESCE(MAX(sort), -1) + 1 FROM {table} WHERE {where}", args).fetchone()
    return r[0]


# ---------- bank snapshot ----------

def bank():
    """Everything in the content bank, nested and in bank order."""
    profile = row("SELECT * FROM profile WHERE id = 1") or {"name": "", "links": "[]"}
    profile["links"] = json.loads(profile["links"])
    sections = rows("SELECT * FROM sections ORDER BY sort, id")
    entries = rows("SELECT * FROM entries ORDER BY sort, id")
    bullets = rows("SELECT * FROM bullets ORDER BY sort, id")
    groups = rows("SELECT * FROM skill_groups ORDER BY sort, id")
    skills = rows("SELECT * FROM skills ORDER BY sort, id")

    by_entry = {}
    for b in bullets:
        b["archived"] = bool(b["archived"])
        by_entry.setdefault(b["entry_id"], []).append(b)
    by_section = {}
    for e in entries:
        e["bullets"] = by_entry.get(e["id"], [])
        by_section.setdefault(e["section_id"], []).append(e)
    by_group = {}
    for s in skills:
        by_group.setdefault(s["group_id"], []).append(s)
    groups_by_section = {}
    for g in groups:
        g["skills"] = by_group.get(g["id"], [])
        groups_by_section.setdefault(g["section_id"], []).append(g)
    for s in sections:
        s["entries"] = by_section.get(s["id"], [])
        s["groups"] = groups_by_section.get(s["id"], [])
    return {"profile": profile, "sections": sections}


def resumes():
    out = rows("SELECT * FROM resumes ORDER BY name COLLATE NOCASE")
    for r in out:
        r["config"] = json.loads(r["config"])
    return out


def prune_configs():
    """Drop ids that no longer exist from every preset config."""
    sec = {r["id"] for r in rows("SELECT id FROM sections")}
    ent = {r["id"] for r in rows("SELECT id FROM entries")}
    bul = {r["id"] for r in rows("SELECT id FROM bullets")}
    skl = {r["id"] for r in rows("SELECT id FROM skills")}
    for r in resumes():
        cfg = r["config"]
        new_secs = []
        for s in cfg.get("sections", []):
            if s.get("id") not in sec:
                continue
            s["entries"] = [
                {**e, "bullets": [b for b in e.get("bullets", []) if b in bul]}
                for e in s.get("entries", []) if e.get("id") in ent
            ]
            s["skills"] = [k for k in s.get("skills", []) if k in skl]
            new_secs.append(s)
        cfg["sections"] = new_secs
        execute("UPDATE resumes SET config = ? WHERE id = ?", (json.dumps(cfg), r["id"]))


# ---------- jobs ----------

def job_event(job_id, kind, a, b, source="manual", mail_id=None):
    execute("INSERT INTO job_events (job_id, kind, from_value, to_value, source, mail_id) VALUES (?, ?, ?, ?, ?, ?)",
            (job_id, kind, None if a is None else str(a), None if b is None else str(b), source, mail_id))


def set_job_status(job_id, status, source="manual", mail_id=None):
    """Change a job's status and log it. Returns the previous status (None if the job is gone)."""
    cur = row("SELECT status FROM jobs WHERE id = ?", (job_id,))
    if not cur:
        return None
    if cur["status"] != status:
        execute("UPDATE jobs SET status = ?, updated_at = datetime('now') WHERE id = ?", (status, job_id))
        job_event(job_id, "status", cur["status"], status, source, mail_id)
    return cur["status"]


# ---------- mail watcher state ----------

def mail_state():
    return {r["key"]: r["value"] for r in rows("SELECT key, value FROM mail_state")}


def set_mail_state(**kv):
    conn = connect()
    for k, v in kv.items():
        conn.execute("INSERT INTO mail_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                     (k, "" if v is None else str(v)))
    conn.commit()
