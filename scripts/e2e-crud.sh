#!/usr/bin/env bash
# Entity CRUD against the real database on a running `docker compose` stack, using the
# smoke fixture's User entity (scripts/smoke-generate.mjs). Catches schema / migration /
# ORM bugs that /health can't. Run from the generated repo (needs .env, curl, jq, openssl).
#
#   CRUD_CASE=camel|snake   JSON field casing the create/update bodies use (default camel)
#   CRUD_SEND_ID=1          send a client-generated id in the create body (default: server assigns)
set -euo pipefail

base=${BASE_URL:-http://localhost:8080}

# Same HS256 token as e2e-roundtrip.sh, signed with JWT_SECRET from .env.
secret=$(sed -n 's/^JWT_SECRET=//p' .env)
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
now=$(date +%s)
jwt_head=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)
jwt_body=$(printf '{"sub":"e2e","email":"e2e@example.com","iat":%d,"exp":%d}' "$now" $((now + 3600)) | b64url)
jwt_sig=$(printf '%s.%s' "$jwt_head" "$jwt_body" | openssl dgst -binary -sha256 -hmac "$secret" | b64url)
token="$jwt_head.$jwt_body.$jwt_sig"

# call STEP METHOD PATH [BODY] EXPECTED_CODES... -> response body in /tmp/crud.json
call() {
  local step=$1 method=$2 path=$3 body=$4; shift 4
  local code; : > /tmp/crud.json
  # Content-Type only with a body: Fastify rejects an empty body declared as JSON.
  local data=()
  [ -n "$body" ] && data=(-H 'Content-Type: application/json' -d "$body")
  code=$(curl -s -o /tmp/crud.json -w '%{http_code}' -X "$method" "$base$path" \
    -H "Authorization: Bearer $token" "${data[@]}" || true)
  echo "$step: $method $path -> $code $(head -c 300 /tmp/crud.json)"
  for want in "$@"; do [ "$code" = "$want" ] && return 0; done
  fail "$step" "$method $path -> HTTP $code (want $*): $(head -c 300 /tmp/crud.json)"
}
fail() { echo "::error::CRUD $1 failed: $2"; exit 1; }

created=created_at; [ "${CRUD_CASE:-camel}" = camel ] && created=createdAt
email="crud$(date +%s)$RANDOM@example.com"
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
id_field=""
[ "${CRUD_SEND_ID:-0}" = 1 ] && id_field="\"id\":\"$(cat /proc/sys/kernel/random/uuid)\","
user() { printf '{%s"email":"%s","score":%d,"active":%s,"%s":"%s"}' "$1" "$email" "$2" "$3" "$created" "$ts"; }

call create POST /users "$(user "$id_field" 7 true)" 201 200
id=$(jq -r '.id // empty' /tmp/crud.json 2>/dev/null || true)
[ -n "$id" ] || fail create "response has no id: $(head -c 300 /tmp/crud.json)"

call get GET "/users/$id" "" 200
[ "$(jq -r .email /tmp/crud.json 2>/dev/null)" = "$email" ] || fail get "email is not $email: $(head -c 300 /tmp/crud.json)"

# List shapes: bare array, {data:[…]} or {items:[…]}.
call list GET "/users?limit=100" "" 200
jq -e --arg id "$id" '(if type == "array" then . else (.data // .items // []) end) | any(.id == $id)' /tmp/crud.json >/dev/null \
  || fail list "id $id not in list: $(head -c 300 /tmp/crud.json)"

call update PUT "/users/$id" "$(user "" 42 false)" 200
jq -e '.score == 42 and .active == false' /tmp/crud.json >/dev/null \
  || fail update "score/active not updated: $(head -c 300 /tmp/crud.json)"

call delete DELETE "/users/$id" "" 204 200
call get-deleted GET "/users/$id" "" 404

echo "CRUD round trip ok for user $id"
