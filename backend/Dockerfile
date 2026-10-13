FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PYTHONPATH=/app
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY . .
RUN useradd -u 10001 -m app && mkdir -p /data/media && chown -R app /data /app
USER app
EXPOSE 8000
CMD ["sh", "-c", "alembic upgrade head && python -m app.seed.seed && if [ \"$SEED_HISTORY\" = 1 ]; then python -m app.seed.history; fi && gunicorn app.main:app -k uvicorn.workers.UvicornWorker -w ${WORKERS:-3} -b 0.0.0.0:8000 --timeout 120 --access-logfile -"]
