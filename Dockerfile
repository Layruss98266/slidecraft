FROM python:3.12-slim

# System deps: LibreOffice for high-fidelity PPTX → images, ffmpeg for video/audio,
# fonts for cross-platform baking.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libreoffice \
        ffmpeg \
        fonts-dejavu \
        fonts-liberation \
        fonts-noto \
        libgl1 \
        libglib2.0-0 \
        curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Optional extras — uncomment as needed
# RUN pip install --no-cache-dir rembg authlib \
#     google-api-python-client google-auth google-auth-oauthlib

COPY . .

ENV HOST=0.0.0.0 \
    PORT=5050 \
    PYTHONIOENCODING=utf-8 \
    PYTHONUNBUFFERED=1

EXPOSE 5050

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:5050/ > /dev/null || exit 1

CMD ["python", "app.py"]
