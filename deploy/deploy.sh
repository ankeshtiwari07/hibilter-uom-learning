#!/usr/bin/env bash
# Deploy/upgrade on the server (run from /opt/uom-learning/deploy). Backs up the DB first; rolls back images on failed health check.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "deploy/.env missing (see .env.production.example)"; exit 1; }
TS=$(date +%Y%m%d-%H%M%S); mkdir -p ../backups
if docker compose ps db --status running -q | grep -q .; then
  docker compose exec -T db pg_dump -U uom -Fc uom > ../backups/uom-$TS.dump && echo "backup: backups/uom-$TS.dump"
fi
for s in api web render; do docker image inspect uom-learning-$s:latest >/dev/null 2>&1 && docker tag uom-learning-$s:latest uom-learning-$s:rollback || true; done
docker compose build
docker compose up -d
for i in $(seq 1 40); do curl -fs http://127.0.0.1:8150/api/health >/dev/null && { echo "healthy"; exit 0; }; sleep 3; done
echo "health check failed — rolling back images"; docker compose logs api --tail 60
for s in api web render; do docker image inspect uom-learning-$s:rollback >/dev/null 2>&1 && docker tag uom-learning-$s:rollback uom-learning-$s:latest; done
docker compose up -d; exit 1
