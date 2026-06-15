"""
SlideCraft — AI features via Ollama (local, no API key).

Setup:
  1. Install Ollama from https://ollama.com
  2. Pull a model:  ollama pull llama3.2:3b
     (for vision/alt-text:  ollama pull llava:7b)
  3. Set env var (optional):  OLLAMA_HOST=http://127.0.0.1:11434
                              OLLAMA_MODEL=llama3.2:3b
                              OLLAMA_VISION_MODEL=llava:7b

If Ollama isn't running, endpoints return 503 with a helpful message.
"""

import base64
import json
import os
from flask import jsonify, request

OLLAMA_HOST   = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")
OLLAMA_MODEL  = os.environ.get("OLLAMA_MODEL", "llama3.2:3b")
OLLAMA_VISION = os.environ.get("OLLAMA_VISION_MODEL", "llava:7b")


def _ollama_chat(prompt, model=None, images=None, timeout=60):
    """Call Ollama /api/generate. Returns (text, error_msg)."""
    try:
        import urllib.request as ur
        import urllib.error as ue
    except ImportError:
        return None, "urllib unavailable"

    body = {
        "model": model or OLLAMA_MODEL,
        "prompt": prompt,
        "stream": False,
    }
    if images:
        body["images"] = images  # list of base64 (no data: prefix)

    req = ur.Request(
        f"{OLLAMA_HOST}/api/generate",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with ur.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode())
            return data.get("response", "").strip(), None
    except ue.URLError as e:
        return None, (f"Ollama unreachable at {OLLAMA_HOST}. "
                      f"Install from https://ollama.com and run `ollama serve`. "
                      f"Detail: {e}")
    except Exception as e:
        return None, f"Ollama call failed: {e}"


def register_ai_routes(app, ctx):
    SLIDES_DIR = ctx["SLIDES_DIR"]
    get_slides = ctx["_get_slide_files"]
    load_data  = ctx["load_data"]
    save_data  = ctx["save_data"]
    DATA_FILE  = ctx["DATA_FILE"]
    data_lock  = ctx["_data_lock"]

    @app.route("/api/ai/status", methods=["GET"])
    def ai_status():
        try:
            import urllib.request as ur
            with ur.urlopen(f"{OLLAMA_HOST}/api/tags", timeout=3) as resp:
                tags = json.loads(resp.read().decode())
                models = [m.get("name") for m in tags.get("models", [])]
                return jsonify({
                    "ok": True, "host": OLLAMA_HOST,
                    "models": models,
                    "configured": {"text": OLLAMA_MODEL, "vision": OLLAMA_VISION},
                })
        except Exception as e:
            return jsonify({
                "ok": False, "host": OLLAMA_HOST, "error": str(e),
                "hint": "Install Ollama from https://ollama.com then run: ollama serve",
            }), 503

    @app.route("/api/ai/rewrite", methods=["POST"])
    def ai_rewrite():
        payload = request.get_json(silent=True) or {}
        text  = (payload.get("text") or "").strip()[:5000]
        mode  = (payload.get("mode") or "concise").lower()
        lang  = (payload.get("targetLang") or "").strip()[:32]
        if not text:
            return jsonify({"error": "text is required"}), 400
        prompts = {
            "concise":   "Rewrite this slide text to be tighter and more impactful. Reply with ONLY the rewritten text:\n\n",
            "grammar":   "Fix grammar/spelling. Preserve meaning and tone. Reply with ONLY the corrected text:\n\n",
            "expand":    "Expand this slide text with one extra supporting sentence. Reply with ONLY the rewritten text:\n\n",
            "casual":    "Rewrite in a casual, friendly tone. Reply with ONLY the rewritten text:\n\n",
            "formal":    "Rewrite in a formal, professional tone. Reply with ONLY the rewritten text:\n\n",
            "bullet":    "Rewrite as 3-5 punchy bullet points (one per line, no bullet characters). Reply with ONLY the lines:\n\n",
        }
        prompt = prompts.get(mode, prompts["concise"]) + text
        if mode == "translate":
            if not lang:
                return jsonify({"error": "targetLang required for translate"}), 400
            prompt = f"Translate to {lang}. Reply with ONLY the translation:\n\n{text}"
        out, err = _ollama_chat(prompt)
        if err:
            return jsonify({"error": err}), 503
        return jsonify({"text": out})

    @app.route("/api/ai/alt-text", methods=["POST"])
    def ai_alt_text():
        """Generate alt-text for a slide or an uploaded image data URL."""
        payload  = request.get_json(silent=True) or {}
        slide_n  = payload.get("slide")
        data_url = payload.get("dataUrl")
        if slide_n:
            slides = get_slides()
            try:
                n = int(slide_n)
            except (TypeError, ValueError):
                return jsonify({"error": "Bad slide"}), 400
            if n < 1 or n > len(slides):
                return jsonify({"error": "Invalid slide"}), 400
            with open(slides[n - 1], "rb") as f:
                b64 = base64.b64encode(f.read()).decode()
        elif data_url and data_url.startswith("data:image"):
            b64 = data_url.split(",", 1)[1]
        else:
            return jsonify({"error": "slide or dataUrl required"}), 400

        out, err = _ollama_chat(
            "Describe this slide for a screen reader in 1-2 sentences. Be specific. Reply with ONLY the description.",
            model=OLLAMA_VISION,
            images=[b64],
            timeout=120,
        )
        if err:
            return jsonify({"error": err}), 503
        return jsonify({"altText": out})

    @app.route("/api/ai/slide-from-prompt", methods=["POST"])
    def ai_slide_from_prompt():
        """Generate slide *content* (title + bullets) from a prompt.
        Doesn't generate the image — returns text overlays the client can place."""
        payload = request.get_json(silent=True) or {}
        topic = (payload.get("topic") or "").strip()[:500]
        n     = max(1, min(int(payload.get("count") or 5), 10))
        if not topic:
            return jsonify({"error": "topic is required"}), 400
        prompt = (
            f"Create {n} slides about: {topic}\n"
            "Return ONLY valid JSON of this exact shape with no commentary:\n"
            '{"slides":[{"title":"...","bullets":["...","..."]}, ...]}\n'
            "Each slide has a short title (max 8 words) and 3-5 short bullets."
        )
        out, err = _ollama_chat(prompt, timeout=120)
        if err:
            return jsonify({"error": err}), 503
        # Try to extract JSON
        try:
            start = out.find("{")
            end   = out.rfind("}")
            parsed = json.loads(out[start:end + 1])
            slides = parsed.get("slides", [])
            if not isinstance(slides, list):
                raise ValueError("slides not a list")
            # Sanitize
            clean = []
            for s in slides[:n]:
                clean.append({
                    "title": str(s.get("title", ""))[:200],
                    "bullets": [str(b)[:300] for b in (s.get("bullets") or [])][:8],
                })
            return jsonify({"slides": clean})
        except (ValueError, json.JSONDecodeError):
            return jsonify({"error": "Model returned non-JSON output", "raw": out[:1000]}), 500
