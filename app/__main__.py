"""Local dev server: python -m app  (http://127.0.0.1:8080)."""
import os

from . import create_app

if __name__ == "__main__":
    create_app().run(host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "8080")), debug=True)
