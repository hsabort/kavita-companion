#!/usr/bin/env bash
# Stand up (or update) the Kavita + kavita-companion stack.
#
#   ./setup.sh                    interactive: asks for anything it needs
#   ./setup.sh --non-interactive  takes values from the environment / defaults (for automation)
#
# Safe to run again: an existing .env, Kavita admin, libraries and portal key are detected and kept.
# Needs only bash and Docker (with the compose plugin). See README.md and docs/install.md.
set -euo pipefail
cd "$(dirname "$0")"

INTERACTIVE=1
for arg in "$@"; do
  case "$arg" in
    --non-interactive) INTERACTIVE=0 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die()  { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# ask VAR "Question" "default" [secret]
ask() {
  local var="$1" question="$2" default="${3:-}" secret="${4:-}" value=""
  if [ -n "${!var:-}" ]; then return; fi
  if [ "$INTERACTIVE" = 0 ]; then printf -v "$var" '%s' "$default"; return; fi
  while :; do
    if [ -n "$secret" ]; then
      read -r -s -p "  $question: " value; echo
    else
      read -r -p "  $question${default:+ [$default]}: " value
    fi
    value="${value:-$default}"
    [ -n "$value" ] && break
    echo "  A value is required."
  done
  printf -v "$var" '%s' "$value"
}

# set_env KEY VALUE: replace or append a line in .env
set_env() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$value" 'BEGIN{done=0} $0 ~ "^"k"=" {print k"="v; done=1; next} {print} END{if(!done) print k"="v}' .env > "$tmp"
  cat "$tmp" > .env && rm -f "$tmp"
}

# ---------------------------------------------------------------- prerequisites
bold "Checking prerequisites"
command -v docker >/dev/null || die "Docker is not installed (see host/install-docker.sh for Ubuntu)."
docker compose version >/dev/null 2>&1 || die "The Docker compose plugin is missing."
docker info >/dev/null 2>&1 || die "Can't talk to Docker. Is it running, and is $(id -un) in the docker group?"
info "Docker $(docker version --format '{{.Server.Version}}'), $(docker compose version --short 2>/dev/null || echo compose)"

# ---------------------------------------------------------------- .env
if [ ! -f .env ]; then
  bold "Creating .env"
  ask DOMAIN "Domain name for HTTPS (must point at this server)" ""
  ask KAVITA_HTTPS_PORT "Port for Kavita (HTTPS)" "20005"
  ask COMPANION_HTTPS_PORT "Port for the upload portal (HTTPS)" "20004"
  ask ACME_HTTP_PORT "Port for Let's Encrypt checks (80 if this host owns port 80)" "20003"
  ask MEDIA_ROOT "Media library folder" "/srv/media"
  detected_tz="$(cat /etc/timezone 2>/dev/null || timedatectl show -p Timezone --value 2>/dev/null || echo UTC)"
  ask TZ "Time zone" "$detected_tz"
  cp .env.example .env
  chmod 600 .env
  # Any other setting from .env.example can be given as an environment variable (automation).
  while IFS= read -r line; do
    case "$line" in ''|\#*) continue ;; esac
    key="${line%%=*}"
    if [ -n "${!key+x}" ]; then set_env "$key" "${!key}"; fi
  done < .env.example
  set_env DOMAIN "$DOMAIN"
  set_env KAVITA_HTTPS_PORT "$KAVITA_HTTPS_PORT"
  set_env COMPANION_HTTPS_PORT "$COMPANION_HTTPS_PORT"
  set_env ACME_HTTP_PORT "$ACME_HTTP_PORT"
  set_env MEDIA_ROOT "$MEDIA_ROOT"
  set_env TZ "$TZ"
  set_env PUID "$(id -u)"
  set_env PGID "$(id -g)"
  info "Wrote .env (other settings use the defaults in .env.example)."
else
  bold "Using existing .env"
  chmod 600 .env
  # Add any settings introduced since this .env was written, with their default values.
  while IFS= read -r line; do
    key="${line%%=*}"
    case "$line" in ''|\#*) continue ;; esac
    grep -q "^${key}=" .env || { printf '%s\n' "$line" >> .env; info "Added new setting $key (default)."; }
  done < .env.example
fi

set -a; . ./.env; set +a
if [ -z "${DOMAIN:-}" ] || [ "$DOMAIN" = "kavita.example.com" ]; then die "Set DOMAIN in .env."; fi

# ---------------------------------------------------------------- folders
bold "Preparing folders"
DATA_ROOT="${DATA_ROOT:-./data}"
dirs=("$DATA_ROOT/kavita" "$DATA_ROOT/companion" "$DATA_ROOT/caddy/data" "$DATA_ROOT/caddy/config"
      "$MEDIA_ROOT/manga" "$MEDIA_ROOT/comics" "$MEDIA_ROOT/books" "$MEDIA_ROOT/.incoming")
for d in "${dirs[@]}"; do
  if ! mkdir -p "$d" 2>/dev/null; then
    info "Creating $d needs sudo."
    sudo mkdir -p "$d"
  fi
done
for d in "$DATA_ROOT" "$MEDIA_ROOT"; do
  owner="$(stat -c '%u:%g' "$d")"
  if [ "$owner" != "$PUID:$PGID" ]; then
    info "Giving $d to $PUID:$PGID (needs sudo)."
    sudo chown -R "$PUID:$PGID" "$d"
  fi
done
info "Data: $DATA_ROOT   Media: $MEDIA_ROOT"

# ---------------------------------------------------------------- images
bold "Building and pulling images"
docker compose pull --quiet kavita caddy
docker compose build --quiet kavita-companion

# ---------------------------------------------------------------- Kavita first run
bold "Starting Kavita"
docker compose up -d kavita
kavita_tool() { docker compose run --rm --no-deps -T "$@"; }
status="$(kavita_tool kavita-companion node dist/setup-kavita.js status)"
case "$status" in *'"healthy":true'*) ;; *) die "Kavita did not start. Check: docker compose logs kavita" ;; esac

key_ok=0
if [ -n "${COMPANION_KAVITA_AUTH_KEY:-}" ]; then
  check="$(KAVITA_CHECK_KEY="$COMPANION_KAVITA_AUTH_KEY" kavita_tool -e KAVITA_CHECK_KEY kavita-companion node dist/setup-kavita.js check-key)"
  case "$check" in *'"admin":true'*) key_ok=1; info "Portal key in .env works." ;; *) info "The portal key in .env doesn't work any more; making a new one." ;; esac
fi

if [ "$key_ok" = 0 ]; then
  case "$status" in
    *'"adminExists":false'*)
      bold "Create the Kavita admin account"
      info "This is the account you'll use to manage Kavita and review uploads." ;;
    *)
      bold "Sign in as a Kavita admin"
      info "Kavita is already set up. An admin's credentials are needed once, to create the portal's key." ;;
  esac
  ask KAVITA_ADMIN_USERNAME "Admin username" ""
  ask KAVITA_ADMIN_PASSWORD "Admin password (6+ characters)" "" secret
  export KAVITA_ADMIN_USERNAME KAVITA_ADMIN_PASSWORD
  result="$(kavita_tool -e KAVITA_ADMIN_USERNAME -e KAVITA_ADMIN_PASSWORD kavita-companion node dist/setup-kavita.js init)" || true
  key="$(printf '%s' "$result" | sed -n 's/.*"authKey":"\([A-Za-z0-9_-]*\)".*/\1/p')"
  [ -n "$key" ] || die "Kavita setup failed: $result"
  case "$result" in *'"adminCreated":true'*) info "Created the Kavita admin." ;; esac
  libs="$(printf '%s' "$result" | sed -n 's/.*"librariesCreated":\[\([^]]*\)\].*/\1/p' | tr -d '"')"
  [ -n "$libs" ] && info "Created libraries: $libs"
  set_env COMPANION_KAVITA_AUTH_KEY "$key"
  COMPANION_KAVITA_AUTH_KEY="$key"
  info "Saved the portal's key in .env."
fi

# ---------------------------------------------------------------- portal secret
if [ -z "${COMPANION_SECRET:-}" ]; then
  COMPANION_SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  set_env COMPANION_SECRET "$COMPANION_SECRET"
  info "Generated COMPANION_SECRET in .env."
fi

# ---------------------------------------------------------------- everything else
bold "Starting the stack"
docker compose up -d
for _ in $(seq 1 40); do
  state="$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q kavita-companion)" 2>/dev/null || true)"
  [ "$state" = healthy ] && break
  sleep 3
done
[ "${state:-}" = healthy ] || die "kavita-companion is not healthy. Check: docker compose logs kavita-companion"

bold "Done"
info "Kavita:          https://$DOMAIN:$KAVITA_HTTPS_PORT"
info "Upload portal:   https://$DOMAIN:$COMPANION_HTTPS_PORT"
echo
info "Certificates are requested from Let's Encrypt on first visit. That needs:"
info "  - $DOMAIN resolving to this server, and"
info "  - port 80 of $DOMAIN reaching this host's port $ACME_HTTP_PORT (directly if it's 80, otherwise via a"
info "    forward of /.well-known/acme-challenge/). See docs/install.md."
info "Each user signs in to the portal once with their Kavita password; that adds 'Uploads' to their Kavita sidebar."
