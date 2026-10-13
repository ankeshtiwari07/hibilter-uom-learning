#!/usr/bin/env bash
# Nightly: DB dump + uploaded files, keep 14 days.  cron: 30 2 * * * /opt/uom-learning/deploy/backup.sh
set -euo pipefail
cd "$(dirname "$0")"; mkdir -p ../backups; TS=$(date +%Y%m%d)
docker compose exec -T db pg_dump -U uom -Fc uom > ../backups/uom-$TS.dump
docker run --rm -v uom-learning_media:/m -v "$(cd ..; pwd)/backups":/b alpine tar czf /b/media-uploads-$TS.tgz -C /m uploads 2>/dev/null || true
find ../backups -name 'uom-*.dump' -mtime +14 -delete; find ../backups -name 'media-uploads-*.tgz' -mtime +14 -delete
