#!/bin/bash
# Lecture studio runner (see backend/app/studio/build.py). Usage: sudo bash deploy/studio.sh c1:L2 --draft | --max-seconds 60 | --publish
# Writes into the platform's media volume; FAL_KEY comes from deploy/.env; spend is capped by STUDIO_BUDGET_USD (default 20).
set -euo pipefail
cd "$(dirname "$0")"
FAL=$(grep -E '^FAL_KEY=' .env | tail -1 | cut -d= -f2- || true)
BUDGET=$(grep -E '^STUDIO_BUDGET_USD=' .env | tail -1 | cut -d= -f2- || true)
exec docker run --rm --user 10001 -e HOME=/tmp -e FAL_KEY="$FAL" -e STUDIO_BUDGET_USD="${STUDIO_BUDGET_USD:-${BUDGET:-20}}" \
  -e MEDIA_DIR=/data/media -e ASSETS_DIR=/app/assets --cpus "${STUDIO_CPUS:-3}" \
  -v uom-learning_media:/data/media -v "$(pwd)/../assets:/app/assets:ro" uom-studio "$@"
