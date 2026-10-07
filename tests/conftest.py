import importlib
import io
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
SAMPLE_TEX = ROOT / "tests" / "fixtures" / "sample_main.tex"


@pytest.fixture()
def empty_client(tmp_path, monkeypatch):
    """A fresh app with an empty database (what a new user sees)."""
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    from app import db
    db.close()
    importlib.reload(db)
    import app.api, app.seed
    importlib.reload(app.seed)
    importlib.reload(app.api)
    import app as app_pkg
    importlib.reload(app_pkg)
    flask_app = app_pkg.create_app()
    flask_app.testing = True
    yield flask_app.test_client()
    db.close()


@pytest.fixture()
def client(empty_client):
    """An app set up by uploading the fictional sample resume (tests/fixtures/sample_main.tex)."""
    r = empty_client.post("/api/import", data={"file": (io.BytesIO(SAMPLE_TEX.read_bytes()), "sample_main.tex")},
                          content_type="multipart/form-data")
    assert r.status_code == 200, r.get_json()
    return empty_client
