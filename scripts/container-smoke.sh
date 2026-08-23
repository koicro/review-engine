#!/usr/bin/env bash
set -euo pipefail

image="${1:-review-engine:ci}"
suffix="${GITHUB_RUN_ID:-local}-$$"
standard_container="review-engine-standard-${suffix}"
headless_container="review-engine-headless-${suffix}"
volume="review-engine-data-${suffix}"
token="container-smoke-administrator-token"
security_args=(
  --read-only
  --tmpfs /tmp:rw,exec,nosuid,nodev,size=64m,mode=1777
  --cap-drop ALL
  --security-opt no-new-privileges:true
)

cleanup() {
  docker rm --force "$standard_container" "$headless_container" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker volume create "$volume" >/dev/null
docker run --detach \
  --name "$standard_container" \
  --volume "$volume:/data" \
  --env "REVIEW_ADMIN_TOKEN=$token" \
  --env "REVIEW_UI_ENABLED=true" \
  "${security_args[@]}" \
  "$image" >/dev/null

for _ in $(seq 1 30); do
  if docker exec "$standard_container" curl --fail --silent http://127.0.0.1:8080/api/v1/health/ready >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

docker exec "$standard_container" curl --fail --silent http://127.0.0.1:8080/api/v1/health/ready | grep --quiet 'ready'
docker exec "$standard_container" curl --fail --silent http://127.0.0.1:8080/ | grep --quiet 'Review Engine'

docker exec "$standard_container" curl --fail --silent \
  --request POST \
  --header 'Origin: http://127.0.0.1:8080' \
  --header 'Content-Type: application/json' \
  --data "{\"token\":\"$token\"}" \
  --dump-header /tmp/review-engine-session.headers \
  --cookie-jar /tmp/review-engine-session.cookies \
  http://127.0.0.1:8080/api/v1/session >/dev/null
docker exec "$standard_container" grep --ignore-case --quiet 'set-cookie: review_engine_session=.*HttpOnly.*SameSite=Strict' /tmp/review-engine-session.headers
if docker exec "$standard_container" grep --ignore-case 'set-cookie:' /tmp/review-engine-session.headers | grep --quiet --ignore-case 'Secure'; then
  echo "HTTP session cookie unexpectedly has the Secure attribute" >&2
  exit 1
fi
docker exec "$standard_container" curl --fail --silent \
  --request POST \
  --header 'Origin: http://127.0.0.1:8080' \
  --header 'Content-Type: application/json' \
  --cookie /tmp/review-engine-session.cookies \
  --data '{"name":"Persistent smoke category"}' \
  http://127.0.0.1:8080/api/v1/categories | grep --quiet 'Persistent smoke category'
docker exec "$standard_container" curl --fail --silent \
  --request DELETE \
  --header 'Origin: http://127.0.0.1:8080' \
  --cookie /tmp/review-engine-session.cookies \
  --cookie-jar /tmp/review-engine-session.cookies \
  http://127.0.0.1:8080/api/v1/session >/dev/null
session_status="$(docker exec "$standard_container" curl --silent --output /dev/null --write-out '%{http_code}' \
  --cookie /tmp/review-engine-session.cookies \
  http://127.0.0.1:8080/api/v1/categories)"
test "$session_status" = "401"

docker stop --time 15 "$standard_container" >/dev/null
docker rm "$standard_container" >/dev/null

docker run --detach \
  --name "$headless_container" \
  --volume "$volume:/data" \
  --env "REVIEW_ADMIN_TOKEN=$token" \
  --env "REVIEW_UI_ENABLED=false" \
  "${security_args[@]}" \
  "$image" >/dev/null

for _ in $(seq 1 30); do
  if docker exec "$headless_container" curl --fail --silent http://127.0.0.1:8080/api/v1/health/ready >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

docker exec "$headless_container" curl --fail --silent \
  --header "Authorization: Bearer $token" \
  http://127.0.0.1:8080/api/v1/categories | grep --quiet 'Persistent smoke category'

root_status="$(docker exec "$headless_container" curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:8080/)"
test "$root_status" = "404"

echo "Container modes and volume persistence verified."
