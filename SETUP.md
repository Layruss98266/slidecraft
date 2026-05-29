# SlideCraft — Optional Setup Guide

Most features work out of the box. This guide covers the **optional** integrations:

1. [Local AI via Ollama](#1-local-ai-via-ollama) — AI Rewrite / Translate / Alt-text / Slides-from-prompt
2. [Background Remover (rembg)](#2-background-remover-rembg)
3. [Google OAuth login + share links](#3-google-oauth-login--share-links)
4. [Google Slides export](#4-google-slides-export)
5. [Docker deployment](#5-docker-deployment)
6. [Running tests](#6-running-tests)

---

## 1. Local AI via Ollama

All AI features in SlideCraft (rewrite, translate, alt-text, slide-from-prompt) call a **local** LLM via [Ollama](https://ollama.com). No API keys, no usage fees, no data leaves your machine.

### Install Ollama
- **Windows / macOS / Linux:** download from <https://ollama.com>
- Or via package manager: `brew install ollama`, `winget install Ollama.Ollama`

### Pull models
```bash
ollama pull llama3.2:3b      # text model (rewrite, translate, slide-from-prompt)
ollama pull llava:7b         # vision model (alt-text generation)
```

### Run Ollama
```bash
ollama serve
```
This starts a local server on `http://127.0.0.1:11434`.

### Configure SlideCraft (all optional — defaults work)
```bash
# Windows PowerShell
$env:OLLAMA_HOST = "http://127.0.0.1:11434"
$env:OLLAMA_MODEL = "llama3.2:3b"
$env:OLLAMA_VISION_MODEL = "llava:7b"

# macOS / Linux
export OLLAMA_HOST=http://127.0.0.1:11434
export OLLAMA_MODEL=llama3.2:3b
export OLLAMA_VISION_MODEL=llava:7b
```

### Verify
With SlideCraft running, open `http://127.0.0.1:5050/api/ai/status`. You should see a JSON list of installed models.

### Use in the editor
- Select a text overlay → click **AI Rewrite** (in the More group on the toolbar)
- **AI Translate** asks for a target language
- **AI Alt-text** generates a screen-reader description for the current slide
- **AI Slides** opens a prompt → returns N slide outlines in a new tab

---

## 2. Background Remover (rembg)

Removes the background from any image overlay using the U²-Net model.

```bash
pip install rembg
```

First call downloads the ~170 MB model (one-time).

Use: select an image overlay → click **Remove BG** in the toolbar.

---

## 3. Google OAuth login + share links

Adds Google sign-in so the app is no longer open to anyone on your network, plus shareable read-only links.

### Step 1: Create OAuth credentials
1. Go to <https://console.cloud.google.com>
2. Create a project (or reuse one)
3. **APIs & Services** → **OAuth consent screen** → External → fill in App name + your email
4. **Credentials** → **Create Credentials** → **OAuth client ID** → **Web application**
5. Authorized redirect URI: `http://127.0.0.1:5050/auth/callback`
   (add your production URL too if deploying)
6. Save the **Client ID** and **Client secret**

### Step 2: Set environment variables
```bash
# Windows PowerShell
$env:GOOGLE_OAUTH_CLIENT_ID = "...apps.googleusercontent.com"
$env:GOOGLE_OAUTH_CLIENT_SECRET = "..."
$env:SLIDECRAFT_SECRET_KEY = "any-long-random-string-here"
$env:SLIDECRAFT_ALLOWED_EMAILS = "you@gmail.com,teammate@gmail.com"

# macOS / Linux
export GOOGLE_OAUTH_CLIENT_ID=...apps.googleusercontent.com
export GOOGLE_OAUTH_CLIENT_SECRET=...
export SLIDECRAFT_SECRET_KEY="any-long-random-string-here"
export SLIDECRAFT_ALLOWED_EMAILS=you@gmail.com,teammate@gmail.com
```

If `SLIDECRAFT_ALLOWED_EMAILS` is empty, **any** Google account can log in. Set it to lock down access.

### Step 3: Install authlib
```bash
pip install authlib
```

### Step 4: Restart and use
Restart `python app.py`. Visiting any page redirects to Google login. Once logged in, the header shows your email.

### Share links
- `POST /auth/share/create` → returns a one-time token + a URL like `http://host/?share=xxxxx`
- Anyone with the URL can view (read-only) without logging in
- `POST /auth/share/revoke` with `{"token": "xxxxx"}` invalidates a link

---

## 4. Google Slides export

Lets you click **Google Slides** in the toolbar to upload the current deck to your Google Drive as a real Google Slides presentation.

### Step 1: Enable APIs
In the same Google Cloud project as above (or a new one):
1. **APIs & Services** → **Library**
2. Enable **Google Slides API** and **Google Drive API**

### Step 2: Install Python libs
```bash
pip install google-api-python-client google-auth google-auth-oauthlib
```

### Step 3: Get a refresh token (one-time)
```bash
# Set client ID/secret first (same as above)
python app_gslides.py --bootstrap
```
This opens your browser, asks you to authorize, and prints a **refresh token**.

### Step 4: Set the env var
```bash
$env:GOOGLE_OAUTH_REFRESH_TOKEN = "1//..."        # Windows
export GOOGLE_OAUTH_REFRESH_TOKEN=1//...           # macOS / Linux
```

### Step 5: Use it
Restart SlideCraft → click **Google Slides** in the More toolbar → it uploads each slide image and creates a Google Slides presentation under your Drive. The URL is returned in a confirmation dialog.

---

## 5. Docker deployment

```bash
# Build and run
docker compose up -d

# View logs
docker compose logs -f slidecraft

# Stop
docker compose down
```

The compose file persists `uploads/`, `exports/`, `videos/`, `history/`, `themes_saved/`, `audio/`, and `static/slides/` to host volumes so your work survives container restarts.

To run an Ollama service alongside SlideCraft, uncomment the `ollama:` service in `docker-compose.yml` and set `OLLAMA_HOST=http://ollama:11434`.

---

## 6. Running tests

```bash
pip install -r requirements-dev.txt
pytest tests/ -v
```

`tests/test_features.py` covers the new endpoints. AI / Google / rembg tests gracefully pass when the service or library isn't installed (the endpoints correctly return 501 / 503).
