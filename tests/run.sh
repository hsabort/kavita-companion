#!/usr/bin/env bash
# Run the acceptance tests against the running stack described by ../.env.
#
#   tests/run.sh              API tests (auth, uploads, review, metadata, themes, fix, activity, notifications, requests, preview, sidebar label)
#   tests/run.sh --browser    also the browser tests (Playwright in Docker; screenshots in tests/screenshots/)
#   tests/run.sh --roles      also test_roles_and_limits.py (changes test-uploader's roles for ~5 min;
#                             refuses to run while real people are using the portal)
#   tests/run.sh --only NAME  a single test file, e.g. --only test_review
#
# Needs the TEST_* accounts in .env (see tests/README.md), python3 on the host, and Docker.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright/python:v1.62.0-noble"
PLAYWRIGHT_VERSION="1.62.0"
api_tests=(test_auth test_uploads test_review test_metadata test_themes test_fix test_activity test_notifications test_requests test_preview test_sidebar_label)
browser_tests=(upload_page review_page fix_page kavita_integration activity_page notifications_page requests_page)
run_browser=0 run_roles=0 only=""
while [ $# -gt 0 ]; do
  case "$1" in
    --browser) run_browser=1 ;;
    --roles) run_roles=1 ;;
    --only) only="$2"; shift ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -f .env ] || { echo "No .env: run ./setup.sh first." >&2; exit 1; }
grep -q '^TEST_UPLOADER_PASSWORD=.\+' .env || { echo "TEST_* accounts are not set in .env (see tests/README.md)." >&2; exit 1; }
[ "$run_roles" = 1 ] && api_tests+=(test_roles_and_limits)

failed=()
run_api() {
  echo "== $1"
  if python3 "tests/$1.py"; then :; else failed+=("$1"); fi
}
run_ui() {
  echo "== browser/$1"
  mkdir -p tests/screenshots && chmod 777 tests/screenshots
  if docker run --rm --ipc=host \
      -v "$PWD/.env:/work/.env:ro" -v "$PWD/tests:/work/tests:ro" -v "$PWD/tests/screenshots:/shots" \
      "$PLAYWRIGHT_IMAGE" sh -c "pip install -q --root-user-action=ignore --disable-pip-version-check playwright==$PLAYWRIGHT_VERSION >/dev/null 2>&1 && cd /work/tests && PYTHONPATH=/work/tests python3 browser/$1.py /work/.env /shots"; then :; else failed+=("browser/$1"); fi
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
  for t in "${api_tests[@]}"; do run_api "$t"; done
  if [ "$run_browser" = 1 ]; then
    for t in "${browser_tests[@]}"; do run_ui "$t"; done
    cleanup_browser_series
  fi
fi

echo
if [ ${#failed[@]} -eq 0 ]; then echo "All test files passed."; else echo "Failed: ${failed[*]}"; exit 1; fi
