#!/usr/bin/env bash
# Run the acceptance tests against the running stack described by ../.env.
#
#   tests/run.sh                the API tests (fast + slow)
#   tests/run.sh --fast         only the fast API tests (no library writes)
#   tests/run.sh --slow         only the slow API tests (library writes + Kavita scans)
#   tests/run.sh --browser      also the browser tests (Playwright in Docker)
#   tests/run.sh --roles        also test_roles_and_limits.py (changes test-uploader's roles)
#   tests/run.sh --all          everything (fast + slow + browser + roles)
#   tests/run.sh --repeat N     run the fast tier N times, reporting anything that failed once
#   tests/run.sh --only NAME    a single test file, e.g. --only test_review
#
# A full run restarts kavita-companion first to clear its in-memory rate-limit counters, so repeated
# runs don't lock the test accounts out. Needs the TEST_* accounts in .env (tests/README.md), python3
# and Docker on the host.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright/python:v1.62.0-noble"
PLAYWRIGHT_VERSION="1.62.0"
fast_tests=(test_settings_guard test_auth test_activity test_library test_preview test_notifications test_sidebar_label test_sidebar_connect test_providers_framework test_providers_metron test_providers_gcd test_providers_mangadex test_providers_anilist test_providers_hardcover test_providers_openlibrary test_providers_match test_providers_safeguard test_book_identification)
slow_tests=(test_uploads test_review test_metadata test_themes test_fix test_requests test_metadata_match)
browser_tests=(upload_page review_page fix_page library_page kavita_integration activity_page notifications_page requests_page suggestion_card)
run_fast=0 run_slow=0 run_browser=0 run_roles=0 only="" repeat=1
while [ $# -gt 0 ]; do
  case "$1" in
    --fast) run_fast=1 ;;
    --slow) run_slow=1 ;;
    --browser) run_browser=1 ;;
    --roles) run_roles=1 ;;
    --all) run_fast=1 run_slow=1 run_browser=1 run_roles=1 ;;
    --repeat) repeat="$2"; shift ;;
    --only) only="$2"; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
[ "$run_fast$run_slow$run_browser$run_roles" = "0000" ] && { run_fast=1; run_slow=1; }   # default: API
# --repeat is about flakiness in the quick tier, so it ignores the slow/browser/roles selections.
[ "$repeat" -gt 1 ] && { run_fast=1; run_slow=0; run_browser=0; run_roles=0; }

[ -f .env ] || { echo "No .env: run ./setup.sh first." >&2; exit 1; }
grep -q '^TEST_UPLOADER_PASSWORD=.\+' .env || { echo "TEST_* accounts are not set in .env (see tests/README.md)." >&2; exit 1; }
# Refuse before restarting or writing anything if this is not a test stack. settings.py owns the check
# (TEST_STACK=1 and a media root that is not the live library), so there is one source of truth.
python3 -c 'import sys; sys.path.insert(0, "tests"); import settings' "$PWD/.env" || exit 1

failed=()
run_api() {
  echo "== $1"
  if python3 "tests/$1.py"; then :; else failed+=("$1"); fi
}

# The browser tests run in a container; the portal (in the compose network) can only reach a fake
# started on the host, through the Docker gateway. Start tests/provider_fake.py here for the browser
# tier so tests/browser/suggestion_card.py has a Metron to talk to (no network, no real keys).
provider_fake_pid=""
port_open() {
  python3 - "$1" <<'PY'
import socket, sys
sock = socket.socket()
sock.settimeout(0.5)
try:
    sock.connect(("127.0.0.1", int(sys.argv[1])))
    raise SystemExit(0)
except OSError:
    raise SystemExit(1)
finally:
    sock.close()
PY
}
start_provider_fake() {
  port_open 20901 && return
  python3 tests/provider_fake.py 20901 >/dev/null 2>&1 &
  provider_fake_pid=$!
  for _ in $(seq 1 25); do port_open 20901 && return; sleep 0.2; done
  echo "warning: the provider fake did not start" >&2
}
stop_provider_fake() {
  [ -n "$provider_fake_pid" ] && kill "$provider_fake_pid" 2>/dev/null
  provider_fake_pid=""
}
run_ui() {
  echo "== browser/$1"
  start_provider_fake
  mkdir -p tests/screenshots && chmod 777 tests/screenshots
  if docker run --rm --ipc=host \
      -v "$PWD/.env:/work/.env:ro" -v "$PWD/tests:/work/tests:ro" -v "$PWD/tests/screenshots:/shots" \
      "$PLAYWRIGHT_IMAGE" sh -c "pip install -q --root-user-action=ignore --disable-pip-version-check playwright==$PLAYWRIGHT_VERSION >/dev/null 2>&1 && cd /work/tests && PYTHONPATH=/work/tests python3 browser/$1.py /work/.env /shots"; then :; else failed+=("browser/$1"); fi
}

# Restart the portal so its in-memory failed-sign-in counters start clean, then wait for health.
restart_portal() {
  local domain port url
  domain="$(sed -n 's/^DOMAIN=//p' .env)"
  port="$(sed -n 's/^COMPANION_HTTPS_PORT=//p' .env)"
  docker compose restart kavita-companion >/dev/null 2>&1
  url="https://${domain}:${port}/api/health"
  for _ in $(seq 1 60); do curl -sf -m 5 "$url" >/dev/null 2>&1 && return; sleep 1; done
  echo "warning: kavita-companion did not report healthy" >&2
}

# browser/review_page approves a "Browser Review <tag>" series; remove it from disk and Kavita.
cleanup_browser_series() {
  local media
  media="$(sed -n 's/^MEDIA_ROOT=//p' .env)"
  rm -rf "${media:?}/comics/Browser Review "*
  python3 - <<'EOF'
import json, subprocess, time
for _ in range(20):
    out = subprocess.run(["python3", "scripts/kavita-api.py", "POST", "/api/Series/v2?PageNumber=1&PageSize=500", "{}"],
                         capture_output=True, text=True).stdout
    ids = [s["id"] for s in json.loads(out or "[]") if s["name"].startswith("Browser Review")]
    if ids:
        for i in ids:
            subprocess.run(["python3", "scripts/kavita-api.py", "DELETE", f"/api/Series/{i}"], capture_output=True)
        break
    time.sleep(3)
EOF
}

if [ -n "$only" ]; then
  if [ -f "tests/browser/$only.py" ]; then
    run_ui "$only"
    case "$only" in review_page|fix_page) cleanup_browser_series ;; esac
  else
    run_api "$only"
  fi
else
  for rep in $(seq 1 "$repeat"); do
    [ "$repeat" -gt 1 ] && echo "### run $rep/$repeat"
    restart_portal
    if [ "$run_fast" = 1 ]; then for t in "${fast_tests[@]}"; do run_api "$t"; done; fi
    if [ "$run_slow" = 1 ]; then for t in "${slow_tests[@]}"; do run_api "$t"; done; fi
  done
  [ "$run_roles" = 1 ] && run_api test_roles_and_limits
  if [ "$run_browser" = 1 ]; then
    for t in "${browser_tests[@]}"; do run_ui "$t"; done
    cleanup_browser_series
  fi
fi

stop_provider_fake

echo
if [ ${#failed[@]} -eq 0 ]; then echo "All test files passed."; else echo "Failed: ${failed[*]}"; exit 1; fi
