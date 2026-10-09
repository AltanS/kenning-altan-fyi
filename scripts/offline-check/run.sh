#!/usr/bin/env bash
# Airplane-mode check for the Kenning PWA.
#
#   scripts/offline-check/run.sh              # prepare, build, run every scenario
#   scripts/offline-check/run.sh --only S1,S6 # run some scenarios
#   SKIP_BUILD=1 scripts/offline-check/run.sh # reuse the existing build/
#
# It uses a throwaway database (kenning_offline_check) on the shared dev
# Postgres in container projects-postgres-1, and never touches another one.
# Everything it starts is stopped again on exit.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo"
db="${OFFLINE_CHECK_DB:-kenning_offline_check}"
case "$db" in *offline_check*) ;; *) echo "OFFLINE_CHECK_DB must contain 'offline_check'"; exit 2;; esac
tb() { toolbox run -c ts-dev env CI=true "$@"; }

echo "[prepare] database $db"
if ! docker exec projects-postgres-1 psql -U postgres -tAc "select 1 from pg_database where datname='$db'" | grep -q 1; then
  docker exec projects-postgres-1 psql -U postgres -c "create database $db" >/dev/null
fi
tb DB_NAME="$db" pnpm drizzle:migrate >/dev/null
tb DB_NAME="$db" pnpm cli data-migration run >/dev/null
tb DB_NAME="$db" node scripts/offline-check/seed-user.mjs

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "[prepare] production build"
  tb pnpm build >/dev/null
fi

# The driver runs on the HOST node, not in the toolbox: it has no dependencies,
# and Chromium started inside the toolbox finds no system fonts, which turns
# every screenshot into text-free boxes. The app itself still runs in ts-dev.
node scripts/offline-check/run.mjs "$@"
