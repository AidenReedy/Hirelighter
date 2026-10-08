import importlib
import io
import re
from pathlib import Path

import pytest

from app.escape import tex, visible_len
from app.render_latex import find_pdflatex
from app.sankey import build, job_path

SAMPLE_TEX = Path(__file__).resolve().parent / "fixtures" / "sample_main.tex"


# ---------- escaping ----------

def test_escape_specials():
    assert tex("50% & $5 #1 a_b {x} ~ ^") == r"50\% \& \$5 \#1 a\_b \{x\} \textasciitilde{} \textasciicircum{}"


def test_escape_blocks_commands():
    out = tex(r"\write18{rm -rf /} \input{/etc/passwd}")
    assert "\\write" not in out.replace(r"\textbackslash{}write", "")
    assert r"\textbackslash{}input\{/etc/passwd\}" in out


def test_bold_markup():
    assert tex("Cut **90%** of noise") == r"Cut \textbf{90\%} of noise"


def test_visible_len():
    assert visible_len("**ab** -- c") == len("ab – c")


# ---------- sankey ----------

@pytest.mark.parametrize("status,n,path", [
    ("not_applied", 0, None),
    ("applied", 0, ["Applied", "No response yet"]),
    ("rejected", 0, ["Applied", "Rejected"]),
    ("rejected", 2, ["Applied", "Interview", "Rejected after interview"]),
    ("interviewing", 1, ["Applied", "Interview", "In progress"]),
    ("offered", 3, ["Applied", "Interview", "Offer", "Deciding"]),
    ("accepted", 2, ["Applied", "Interview", "Offer", "Accepted"]),
    ("declined", 0, ["Applied", "Offer", "Declined"]),
])
def test_job_path(status, n, path):
    assert job_path(status, n) == path


def test_sankey_aggregate():
    s = build([{"status": "applied", "interview_count": 0},
               {"status": "rejected_after_interview", "interview_count": 2},
               {"status": "accepted", "interview_count": 3},
               {"status": "not_applied", "interview_count": 0}])
    names = [n["name"] for n in s["nodes"]]
    links = {(names[l["source"]], names[l["target"]]): l["value"] for l in s["links"]}
    assert links[("Applied", "Interview")] == 2
    assert links[("Interview", "Offer")] == 1
    assert s["totals"] == {"applied": 3, "interviews": 5, "jobs_interviewed": 2, "offers": 1}


# ---------- API + rendering ----------

def normalize(src: str) -> str:
    body = src[src.index(r"\begin{document}"):]
    body = "\n".join(re.sub(r"(?<!\\)%.*", "", ln) for ln in body.splitlines())
    body = re.sub(r"\s+", " ", body)
    body = re.sub(r"\s*([{}])\s*", r"\1", body)
    return body.strip()


def preamble(src: str) -> str:
    head = src[:src.index(r"\begin{document}")]
    return re.sub(r"\s+", "", "\n".join(l for l in head.splitlines() if not l.lstrip().startswith("%")))


def render_general(c, fmt="tex"):
    st = c.get("/api/state").get_json()
    return c.post("/api/render", json={"config": st["resumes"][0]["config"], "format": fmt})


# ---------- setup / import ----------

def test_new_install_is_empty(empty_client):
    st = empty_client.get("/api/state").get_json()
    assert st["empty"] is True and st["bank"]["sections"] == [] and st["resumes"] == []
    assert st["settings"]["max_bullet_chars"] == 107
    t = empty_client.get("/api/template")
    assert t.status_code == 200 and b"Your Name" in t.data


def test_start_blank(empty_client):
    assert empty_client.post("/api/start-blank").status_code == 200
    st = empty_client.get("/api/state").get_json()
    assert [s["title"] for s in st["bank"]["sections"]] == ["Experience", "Education", "Projects", "Technical Skills"]
    assert empty_client.post("/api/start-blank").status_code == 409


def test_import_roundtrip_matches_jakes_template(client):
    """Upload a Jake's-template resume, render it back: same LaTeX, token for token."""
    original = SAMPLE_TEX.read_text(encoding="utf-8")
    out = render_general(client).get_data(as_text=True)
    assert normalize(out) == normalize(original)
    assert preamble(out) == preamble(original)


PRIVATE_TEX = Path(__file__).resolve().parent.parent / "private" / "main.tex"


@pytest.mark.skipif(not PRIVATE_TEX.exists(), reason="no private/main.tex (your own resume, never committed)")
def test_import_roundtrip_own_resume(empty_client):
    src = PRIVATE_TEX.read_text(encoding="utf-8")
    r = empty_client.post("/api/import", data={"file": (io.BytesIO(src.encode()), "main.tex")},
                          content_type="multipart/form-data")
    assert r.status_code == 200 and not r.get_json()["warnings"]
    assert normalize(render_general(empty_client).get_data(as_text=True)) == normalize(src)


def test_import_blank_template_parses(empty_client):
    raw = empty_client.get("/api/template").data
    r = empty_client.post("/api/import?preview=1", data={"file": (io.BytesIO(raw), "resume_template.tex")},
                          content_type="multipart/form-data")
    info = r.get_json()
    assert r.status_code == 200 and info["name"] == "Your Name" and info["entries"] == 7 and not info["warnings"]
    assert empty_client.get("/api/state").get_json()["empty"] is True  # preview doesn't save


def test_import_replaces_content_keeps_jobs(client):
    client.post("/api/jobs", json={"company": "Acme", "applied": True})
    raw = client.get("/api/template").data
    client.post("/api/import", data={"file": (io.BytesIO(raw), "t.tex")}, content_type="multipart/form-data")
    st = client.get("/api/state").get_json()
    assert st["bank"]["profile"]["name"] == "Your Name" and len(st["resumes"]) == 1
    assert [j["company"] for j in client.get("/api/jobs").get_json()] == ["Acme"]


def test_import_rejects_garbage(empty_client):
    r = empty_client.post("/api/import", data={"file": (io.BytesIO(b"hello"), "x.tex")}, content_type="multipart/form-data")
    assert r.status_code == 400 and "Couldn't read" in r.get_json()["error"]


def test_tex_unescape():
    from app.import_tex import to_text
    assert to_text(r"Cut \textbf{90\%} of alerts \& noise for ATT\&CK") == "Cut **90%** of alerts & noise for ATT&CK"
    assert tex(to_text(r"50\% \$5 a\_b")) == r"50\% \$5 a\_b"


def test_seed_cli_imports_tex(tmp_path, monkeypatch):
    from app import db, seed
    d = tmp_path / "data"
    monkeypatch.setattr(db, "DATA_DIR", d)
    monkeypatch.setattr(db, "DB_PATH", d / "app.db")
    monkeypatch.setattr(db, "SENT_DIR", d / "sent")
    db.close()
    assert seed.main([str(SAMPLE_TEX)]) == 0
    assert db.row("SELECT name FROM profile")["name"] == "Alex Rivera"
    assert seed.main([str(SAMPLE_TEX)]) == 1  # refuses once there's content
    db.close()


def test_docx_renders(client):
    from docx import Document
    st = client.get("/api/state").get_json()
    r = client.post("/api/render", json={"config": st["resumes"][0]["config"], "format": "docx", "name": "SOC"})
    assert r.status_code == 200 and r.headers["X-Filename"] == "Alex_Rivera.docx"
    text = "\n".join(p.text for p in Document(io.BytesIO(r.data)).paragraphs)
    assert "Automated weekly vulnerability scans" in text and "Leadership & Activities" in text


@pytest.mark.skipif(not find_pdflatex(), reason="pdflatex not installed")
def test_pdf_compiles_one_page(client):
    r = render_general(client, "pdf")
    assert r.status_code == 200, r.get_json()
    assert r.headers["X-Page-Count"] == "1"


def test_bank_crud_and_prune(client):
    st = client.get("/api/state").get_json()
    exp = st["bank"]["sections"][0]
    # new role + bullet
    eid = client.post("/api/entries", json={"section_id": exp["id"], "kind": "job", "title": "Pentester", "org": "X"}).get_json()["id"]
    bid = client.post("/api/bullets", json={"entry_id": eid, "text": "Found **5** vulns"}).get_json()["id"]
    assert client.put(f"/api/bullets/{bid}", json={"text": "Found 6 vulns"}).status_code == 200
    # include it in General, then delete the entry: preset must be pruned
    general = st["resumes"][0]
    general["config"]["sections"][0]["entries"].append({"id": eid, "bullets": [bid]})
    client.put(f"/api/resumes/{general['id']}", json={"config": general["config"]})
    assert client.delete(f"/api/entries/{eid}").status_code == 200
    cfg = client.get("/api/state").get_json()["resumes"][0]["config"]
    assert eid not in [e["id"] for e in cfg["sections"][0]["entries"]]
    # new section + skills
    sid = client.post("/api/sections", json={"title": "Awards"}).get_json()["id"]
    assert client.put(f"/api/sections/{sid}", json={"title": "Honors"}).status_code == 200
    skills_sec = st["bank"]["sections"][-1]
    gid = client.post("/api/skill-groups", json={"section_id": skills_sec["id"], "name": "Frameworks"}).get_json()["id"]
    kid = client.post("/api/skills", json={"group_id": gid, "name": "NIST CSF"}).get_json()["id"]
    assert client.delete(f"/api/skills/{kid}").status_code == 200
    assert client.post("/api/resumes", json={"name": "general"}).status_code == 409


def test_jobs_flow(client):
    r = client.post("/api/jobs", json={"company": "Acme", "role": "SOC Analyst", "applied": True})
    j = r.get_json()
    assert r.status_code == 201 and j["status"] == "applied" and j["applied_date"]
    j = client.put(f"/api/jobs/{j['id']}", json={"status": "interviewing"}).get_json()
    assert j["interview_count"] == 1
    j = client.put(f"/api/jobs/{j['id']}", json={"interview_count": 3}).get_json()
    j = client.put(f"/api/jobs/{j['id']}", json={"status": "offered"}).get_json()
    client.put(f"/api/jobs/{j['id']}", json={"status": "accepted"})
    ev = client.get(f"/api/jobs/{j['id']}/events").get_json()
    assert [e["to_value"] for e in ev if e["kind"] == "status"] == ["interviewing", "offered", "accepted"]
    # saved-but-not-applied job, with a resume attached
    data = {"job": '{"company": "Beta", "role": "GRC", "applied": false}',
            "resume": (io.BytesIO(b"%PDF-1.4 test"), "Alex_Rivera.pdf")}
    b = client.post("/api/jobs", data=data, content_type="multipart/form-data").get_json()
    assert b["status"] == "not_applied" and b["resume_file"].endswith(".pdf")
    assert client.get(f"/api/jobs/{b['id']}/resume").data == b"%PDF-1.4 test"
    sk = client.get("/api/sankey").get_json()
    assert sk["totals"]["applied"] == 1 and sk["totals"]["offers"] == 1
    assert client.get("/api/backup").status_code == 200


@pytest.mark.skipif(not find_pdflatex(), reason="pdflatex not installed")
def test_selftest_leaves_data_dir_alone(tmp_path, monkeypatch):
    """The Docker build runs the selftest as root; it must not create files in the real /data."""
    from app import db, selftest
    real = tmp_path / "real-data"
    monkeypatch.setattr(db, "DATA_DIR", real)
    monkeypatch.setattr(db, "DB_PATH", real / "app.db")
    monkeypatch.setattr(db, "SENT_DIR", real / "sent")
    db.close()
    selftest.main()
    assert not real.exists()


def test_healthz_skips_login(tmp_path, monkeypatch):
    """Docker's health check can't log in, so /healthz must answer even with APP_PASSWORD set."""
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("APP_PASSWORD", "secret")
    from app import db
    db.close()
    importlib.reload(db)
    import app as app_pkg
    importlib.reload(app_pkg)
    c = app_pkg.create_app().test_client()
    assert c.get("/healthz").status_code == 200
    assert c.get("/api/state").status_code == 401
    db.close()
