"""
SlideCraft — Google OAuth login + share-link tokens.

Setup:
  1. Create a Google Cloud project: https://console.cloud.google.com
  2. APIs & Services → OAuth consent screen → External → fill in basics.
  3. Credentials → Create Credentials → OAuth client ID → Web application.
  4. Authorized redirect URIs: http://127.0.0.1:5050/auth/callback
     (add your production URL too if deploying).
  5. Set env vars in .env (or your shell):
        GOOGLE_OAUTH_CLIENT_ID=...apps.googleusercontent.com
        GOOGLE_OAUTH_CLIENT_SECRET=...
        SLIDECRAFT_SECRET_KEY=<a long random string>
        SLIDECRAFT_ALLOWED_EMAILS=you@gmail.com,teammate@gmail.com   (comma-sep)
  6. pip install authlib

If env vars are unset, auth is DISABLED and the app behaves as today.
"""

import os
import secrets
import json
from pathlib import Path
from functools import wraps
from flask import session, request, redirect, jsonify, url_for


def auth_enabled():
    return bool(os.environ.get("GOOGLE_OAUTH_CLIENT_ID")
                and os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET"))


def register_auth_routes(app, ctx):
    BASE_DIR = ctx["BASE_DIR"]
    SHARE_FILE = BASE_DIR / "share_tokens.json"

    if not auth_enabled():
        @app.route("/auth/status")
        def _disabled():
            return jsonify({
                "enabled": False,
                "hint": "Set GOOGLE_OAUTH_CLIENT_ID/SECRET to enable. See app_auth.py.",
            })
        return

    app.secret_key = os.environ.get("SLIDECRAFT_SECRET_KEY") or secrets.token_hex(32)
    allowed = {e.strip().lower()
               for e in os.environ.get("SLIDECRAFT_ALLOWED_EMAILS", "").split(",")
               if e.strip()}

    try:
        from authlib.integrations.flask_client import OAuth
    except ImportError:
        app.logger.warning("authlib not installed — auth disabled. pip install authlib")
        return

    oauth = OAuth(app)
    oauth.register(
        name="google",
        client_id=os.environ["GOOGLE_OAUTH_CLIENT_ID"],
        client_secret=os.environ["GOOGLE_OAUTH_CLIENT_SECRET"],
        server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
        client_kwargs={"scope": "openid email profile"},
    )

    def _load_share_tokens():
        if SHARE_FILE.exists():
            try:
                return json.loads(SHARE_FILE.read_text())
            except json.JSONDecodeError:
                return {}
        return {}

    def _save_share_tokens(d):
        SHARE_FILE.write_text(json.dumps(d, indent=2))

    def _is_share_request():
        token = request.args.get("share")
        if not token:
            return False
        return token in _load_share_tokens()

    def _logged_in():
        user = session.get("user") or {}
        if not user:
            return False
        if allowed and (user.get("email", "").lower() not in allowed):
            return False
        return True

    @app.before_request
    def _gate():
        path = request.path
        # Always allow auth endpoints, static, and share links
        if (path.startswith("/auth/") or path.startswith("/static/")
                or path == "/favicon.ico"):
            return None
        if _logged_in() or _is_share_request():
            return None
        if path.startswith("/api/"):
            return jsonify({"error": "Not authenticated", "loginUrl": url_for("auth_login")}), 401
        return redirect(url_for("auth_login"))

    @app.route("/auth/login")
    def auth_login():
        return oauth.google.authorize_redirect(url_for("auth_callback", _external=True))

    @app.route("/auth/callback")
    def auth_callback():
        try:
            token = oauth.google.authorize_access_token()
        except Exception as e:
            return f"OAuth failed: {e}", 400
        user = token.get("userinfo") or {}
        if allowed and (user.get("email", "").lower() not in allowed):
            return f"Email {user.get('email')} not in SLIDECRAFT_ALLOWED_EMAILS", 403
        session["user"] = {
            "email": user.get("email"),
            "name":  user.get("name"),
            "picture": user.get("picture"),
        }
        return redirect("/")

    @app.route("/auth/logout")
    def auth_logout():
        session.clear()
        return redirect("/auth/login")

    @app.route("/auth/status")
    def auth_status():
        return jsonify({
            "enabled": True,
            "user": session.get("user"),
            "allowedEmails": sorted(allowed) if allowed else "ANY",
        })

    @app.route("/auth/share/create", methods=["POST"])
    def share_create():
        if not _logged_in():
            return jsonify({"error": "Not authenticated"}), 401
        token = secrets.token_urlsafe(24)
        tokens = _load_share_tokens()
        tokens[token] = {
            "created_by": session["user"].get("email"),
            "created_at": secrets.token_hex(4),  # placeholder timestamp tag
        }
        _save_share_tokens(tokens)
        return jsonify({"token": token,
                        "url": f"{request.host_url}?share={token}"})

    @app.route("/auth/share/list", methods=["GET"])
    def share_list():
        if not _logged_in():
            return jsonify({"error": "Not authenticated"}), 401
        return jsonify(_load_share_tokens())

    @app.route("/auth/share/revoke", methods=["POST"])
    def share_revoke():
        if not _logged_in():
            return jsonify({"error": "Not authenticated"}), 401
        payload = request.get_json(silent=True) or {}
        tokens = _load_share_tokens()
        tokens.pop(payload.get("token", ""), None)
        _save_share_tokens(tokens)
        return jsonify({"ok": True})
