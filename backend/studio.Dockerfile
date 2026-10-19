# Lecture studio (app.studio): the API image's Python deps + headless Chromium for broadcast graphics + ffmpeg.
FROM mcr.microsoft.com/playwright/python:v1.55.0-noble
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PYTHONPATH=/app PIP_BREAK_SYSTEM_PACKAGES=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install -r requirements.txt playwright==1.55.0
COPY . .
ENTRYPOINT ["python", "-m", "app.studio.build"]
