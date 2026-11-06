#!/usr/bin/env bash
# Verify migrations, seed idempotency and RLS against a throwaway local Postgres.
# Usage: supabase/tests/db/run.sh   (needs Postgres server binaries, e.g. postgresql-16)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
WORK="$(mktemp -d)"
chmod 777 "$WORK"
RUN=""
if [ "$(id -u)" = "0" ]; then RUN="runuser -u postgres --"; chown postgres "$WORK"; fi
PORT="${PGPORT_TEST:-54329}"
$RUN "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
$RUN "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK" -l "$WORK/log" -w start >/dev/null
trap '$RUN "$PGBIN/pg_ctl" -D "$WORK/data" -m fast stop >/dev/null; rm -rf "$WORK"' EXIT
export PGOPTIONS="-c client_min_messages=warning"
PSQL=(psql -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d postgres)
"${PSQL[@]}" -f "$ROOT/supabase/tests/db/supabase-shim.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do "${PSQL[@]}" -f "$f"; done
"${PSQL[@]}" -f "$ROOT/supabase/tests/db/rls-test.sql"
if [ "${DUMP_SEED_JSON:-}" != "" ]; then
  "${PSQL[@]}" -At -c "select json_build_object(
    'merchants', (select json_agg(m order by m.id) from public.merchants m),
    'products',  (select json_agg(p order by p.id) from public.products p))" > "$DUMP_SEED_JSON"
fi
