#!/usr/bin/env bash
# Message round trip on a running `docker compose` stack: publish through the
# app's HTTP API, then wait for the consumer's `consumed` log line carrying that
# message's id. Run from the generated repo (needs .env, curl, jq, openssl).
#
#   e2e-roundtrip.sh notification   POST /notifications (send_notification pattern);
#                                   id = the unique recipient we send
#   e2e-roundtrip.sh user           POST /users (entity create emits user.created);
#                                   id = the id in the 201 response
#
# Publishes are retried every 10s: a consumer that joins after the first publish
# (Kafka group rebalance, queue declared by the consumer) may never see it.
set -euo pipefail

mode=${1:?usage: e2e-roundtrip.sh notification|user}
base=${BASE_URL:-http://localhost:8080}

# Protected routes take the app's own HS256 tokens; sign one with JWT_SECRET from .env.
secret=$(sed -n 's/^JWT_SECRET=//p' .env)
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
now=$(date +%s)
jwt_head=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)
jwt_body=$(printf '{"sub":"e2e","email":"e2e@example.com","iat":%d,"exp":%d}' "$now" $((now + 3600)) | b64url)
jwt_sig=$(printf '%s.%s' "$jwt_head" "$jwt_body" | openssl dgst -binary -sha256 -hmac "$secret" | b64url)
token="$jwt_head.$jwt_body.$jwt_sig"

ids=$(mktemp)
run="e2e$(date +%s)$RANDOM"
code=none

publish() {
  local nonce="$run-$1" path body id=""
  case $mode in
    notification)
      path=/notifications
      body=$(printf '{"recipient":"%s@example.com","channel":"email","template":"e2e","message":"round trip"}' "$nonce") ;;
    user)
      path=/users
      body=$(printf '{"email":"%s@example.com","active":true,"createdAt":"2024-01-01T00:00:00Z"}' "$nonce") ;;
    *) echo "::error::unknown mode $mode"; exit 2 ;;
  esac
  code=$(curl -s -o /tmp/publish.json -w '%{http_code}' -X POST "$base$path" \
    -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d "$body" || true)
  echo "publish #$1: POST $path -> $code $(head -c 300 /tmp/publish.json 2>/dev/null)"
  case $code in 2??) ;; *) return 0 ;; esac
  if [ "$mode" = user ]; then id=$(jq -r '.id // empty' /tmp/publish.json 2>/dev/null || true); else id=$nonce; fi
  [ -n "$id" ] && echo "$id" >> "$ids"
  return 0
}

for i in $(seq 0 29); do
  [ $((i % 5)) -eq 0 ] && publish $((i / 5 + 1))
  sleep 2
  # api and worker both: Spring/Quarkus consume in-process, Ktor consumes in both.
  hit=$(docker compose logs --no-color 2>/dev/null | grep -w consumed | grep -F -f "$ids" | head -1 || true)
  if [ -n "$hit" ]; then
    echo "round trip after ~$(((i + 1) * 2))s: $hit"
    exit 0
  fi
done

echo "::error::no 'consumed' log line for ids [$(paste -sd, "$ids")] within 60s (last publish: HTTP $code $(head -c 200 /tmp/publish.json 2>/dev/null))"
exit 1
