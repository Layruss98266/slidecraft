"""
SlideCraft — Google Slides export.

Setup:
  1. Google Cloud project with the **Google Slides API** + **Drive API** enabled.
  2. OAuth client (Desktop or Web) — same project as app_auth.py is fine.
  3. Env vars:
        GOOGLE_OAUTH_CLIENT_ID=...
        GOOGLE_OAUTH_CLIENT_SECRET=...
        GOOGLE_OAUTH_REFRESH_TOKEN=...   (one-time: run this module standalone)
  4. pip install google-api-python-client google-auth google-auth-oauthlib

One-time refresh-token bootstrap:
        python app_gslides.py --bootstrap
  prints a URL, you paste the code, get a refresh token, set the env var.

If env vars aren't set, the endpoint returns 503 with setup instructions.
"""

import os
import sys
import json
from pathlib import Path
from flask import jsonify, request


def _has_creds():
    return all(os.environ.get(k) for k in
               ("GOOGLE_OAUTH_CLIENT_ID",
                "GOOGLE_OAUTH_CLIENT_SECRET",
                "GOOGLE_OAUTH_REFRESH_TOKEN"))


def _build_services():
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build
    creds = Credentials(
        token=None,
        refresh_token=os.environ["GOOGLE_OAUTH_REFRESH_TOKEN"],
        client_id=os.environ["GOOGLE_OAUTH_CLIENT_ID"],
        client_secret=os.environ["GOOGLE_OAUTH_CLIENT_SECRET"],
        token_uri="https://oauth2.googleapis.com/token",
        scopes=["https://www.googleapis.com/auth/presentations",
                "https://www.googleapis.com/auth/drive.file"],
    )
    slides_svc = build("slides", "v1", credentials=creds, cache_discovery=False)
    drive_svc  = build("drive",  "v3", credentials=creds, cache_discovery=False)
    return slides_svc, drive_svc


def register_gslides_routes(app, ctx):
    get_slides = ctx["_get_slide_files"]
    get_deck_name = ctx["_get_deck_name"]

    @app.route("/api/export/gslides", methods=["POST"])
    def export_gslides():
        if not _has_creds():
            return jsonify({
                "error": "Google Slides export not configured",
                "hint": "See app_gslides.py for setup. Need GOOGLE_OAUTH_CLIENT_ID, "
                        "GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN.",
            }), 503
        try:
            from googleapiclient.http import MediaFileUpload
        except ImportError:
            return jsonify({
                "error": "google-api-python-client not installed",
                "hint": "pip install google-api-python-client google-auth google-auth-oauthlib",
            }), 501

        slides_svc, drive_svc = _build_services()
        slide_files = get_slides()
        if not slide_files:
            return jsonify({"error": "No slides"}), 400

        # Create a new presentation
        title = get_deck_name() or "SlideCraft Export"
        pres = slides_svc.presentations().create(body={"title": title}).execute()
        pres_id = pres["presentationId"]

        # Upload each slide image to Drive, then insert into a Slides page
        requests_body = []
        for i, sf in enumerate(slide_files):
            media = MediaFileUpload(str(sf), mimetype="image/jpeg")
            uploaded = drive_svc.files().create(
                body={"name": sf.name},
                media_body=media,
                fields="id, webContentLink",
            ).execute()
            drive_svc.permissions().create(
                fileId=uploaded["id"],
                body={"role": "reader", "type": "anyone"},
            ).execute()
            url = f"https://drive.google.com/uc?id={uploaded['id']}"
            page_id = f"slide_{i}"
            if i > 0:
                requests_body.append({
                    "createSlide": {
                        "objectId": page_id,
                        "insertionIndex": i,
                    }
                })
            else:
                # Use the default first slide
                page_id = pres["slides"][0]["objectId"]
            requests_body.append({
                "createImage": {
                    "url": url,
                    "elementProperties": {
                        "pageObjectId": page_id,
                        "size": {"width":  {"magnitude": 9144000, "unit": "EMU"},
                                 "height": {"magnitude": 5143500, "unit": "EMU"}},
                        "transform": {"scaleX": 1, "scaleY": 1, "translateX": 0,
                                      "translateY": 0, "unit": "EMU"},
                    },
                }
            })
        if requests_body:
            slides_svc.presentations().batchUpdate(
                presentationId=pres_id,
                body={"requests": requests_body},
            ).execute()

        return jsonify({
            "ok": True,
            "presentationId": pres_id,
            "url": f"https://docs.google.com/presentation/d/{pres_id}/edit",
        })


def _bootstrap():
    """One-time: run `python app_gslides.py --bootstrap` to get a refresh token."""
    from google_auth_oauthlib.flow import InstalledAppFlow
    SCOPES = ["https://www.googleapis.com/auth/presentations",
              "https://www.googleapis.com/auth/drive.file"]
    if not (os.environ.get("GOOGLE_OAUTH_CLIENT_ID")
            and os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET")):
        print("Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET first.")
        sys.exit(1)
    client_config = {
        "installed": {
            "client_id":     os.environ["GOOGLE_OAUTH_CLIENT_ID"],
            "client_secret": os.environ["GOOGLE_OAUTH_CLIENT_SECRET"],
            "redirect_uris": ["http://localhost"],
            "auth_uri":      "https://accounts.google.com/o/oauth2/auth",
            "token_uri":     "https://oauth2.googleapis.com/token",
        }
    }
    flow = InstalledAppFlow.from_client_config(client_config, SCOPES)
    creds = flow.run_local_server(port=0)
    print("\n=== SUCCESS ===\nSet this env var:\n")
    print(f"  GOOGLE_OAUTH_REFRESH_TOKEN={creds.refresh_token}\n")


if __name__ == "__main__":
    if "--bootstrap" in sys.argv:
        _bootstrap()
    else:
        print("Run with --bootstrap to generate a refresh token.")
