#!/usr/bin/env bash
# Smoke-test a DEPLOYED welcome-api with real requests.
# Usage:
#   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=<anon/publishable key> supabase/tests/smoke.sh
# Optional: OWNER_JWT=<access token of the demo merchant user> to also test publish/unpublish.
set -euo pipefail
: "${SUPABASE_URL:?set SUPABASE_URL}"; : "${SUPABASE_ANON_KEY:?set SUPABASE_ANON_KEY}"
FN="$SUPABASE_URL/functions/v1/welcome-api"
NORTHLINE=0a000000-0000-4000-8000-000000000001
QUERY="Find a solid walnut dining table under \$1,500 that seats six people and arrives within 14 days."
call() { # $1=json body  $2=bearer token
  curl -sS -X POST "$FN" -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer ${2:-$SUPABASE_ANON_KEY}" \
    -H "Content-Type: application/json" -d "$1"; echo; }
echo "== listMerchants (public)";  call '{"action":"listMerchants","payload":{}}'
echo "== searchProducts (demo)";   call "{\"action\":\"searchProducts\",\"payload\":{\"query\":\"$QUERY\"}}"
echo "== setPublished (anon, expect 401 UNAUTHENTICATED)"
call "{\"action\":\"setPublished\",\"payload\":{\"merchant_id\":\"$NORTHLINE\",\"published\":true}}"
if [ -n "${OWNER_JWT:-}" ]; then
  echo "== setPublished (owner)"; call "{\"action\":\"setPublished\",\"payload\":{\"merchant_id\":\"$NORTHLINE\",\"published\":true}}" "$OWNER_JWT"
  echo "== searchProducts (after publish)"; call "{\"action\":\"searchProducts\",\"payload\":{\"query\":\"$QUERY\"}}"
fi
