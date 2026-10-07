"""Hirelighter: resume builder + job tracker."""
import base64
import hmac
import os
from pathlib import Path

from flask import Flask, Response, request, send_from_directory

from . import db
from .api import bp

STATIC = Path(__file__).resolve().parent / "static"


def create_app():
    app = Flask(__name__, static_folder=None)
    app.config["MAX_CONTENT_LENGTH"] = 10 * 1024 * 1024

    with app.app_context():
        db.migrate()

    password = os.environ.get("APP_PASSWORD", "")
    user = os.environ.get("APP_USER", "admin")

    if password:
        @app.before_request
        def basic_auth():
            auth = request.headers.get("Authorization", "")
            if auth.startswith("Basic "):
                try:
                    u, _, p = base64.b64decode(auth[6:]).decode().partition(":")
                except Exception:
                    u, p = "", ""
                if hmac.compare_digest(u, user) and hmac.compare_digest(p, password):
                    return None
            return Response("Login required", 401, {"WWW-Authenticate": 'Basic realm="hirelighter"'})

    @app.after_request
    def headers(resp):
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["X-Frame-Options"] = "SAMEORIGIN"
        resp.headers["Referrer-Policy"] = "no-referrer"
        resp.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; "
            "font-src 'self' data: blob:; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'none'",
        )
        if request.path.startswith("/api/"):
            resp.headers["Cache-Control"] = "no-store"
        elif request.path == "/" or request.path.startswith("/static/"):
            # revalidate every load so a redeploy shows up immediately (cheap 304s on the LAN)
            resp.headers["Cache-Control"] = "no-cache"
        return resp

    app.register_blueprint(bp)

    @app.get("/")
    def index():
        return send_from_directory(STATIC, "index.html")

    @app.get("/static/<path:p>")
    def static_files(p):
        return send_from_directory(STATIC, p)

    @app.get("/healthz")
    def healthz():
        return {"ok": True}

    return app
