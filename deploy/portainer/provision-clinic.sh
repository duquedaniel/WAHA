#!/usr/bin/env bash
# Provision (or revoke) an Osteogest clinic on WAHA: one session + one session-scoped API key.
set -euo pipefail

usage() {
  cat <<EOF
Usage:
  $0 create <session-name> [waha-url]   create session + scoped API key
  $0 list [waha-url]                    list sessions and API keys
  $0 revoke <key-id> [waha-url]         delete an API key

The admin key is read from WAHA_ADMIN_KEY (or prompted).
waha-url defaults to \$WAHA_URL, then http://192.168.200.6:3002 (host LAN port, not the internal waha:3000).
Session name: letters, digits, "-" or "_" (e.g. osteogest-vilma).
EOF
  exit 1
}

[[ $# -ge 1 ]] || usage
ACTION="$1"
DEFAULT_URL="${WAHA_URL:-http://192.168.200.6:3002}"

if [[ -z "${WAHA_ADMIN_KEY:-}" ]]; then
  read -r -s -p "WAHA admin API key: " WAHA_ADMIN_KEY
  echo
fi

pretty() {
  python3 -m json.tool 2>/dev/null || cat
}

call() {
  local method="$1" url="$2" body="${3:-}"
  local args=(-sS -f -X "$method" "$url" -H "X-Api-Key: ${WAHA_ADMIN_KEY}" -H "Content-Type: application/json")
  if [[ -n "$body" ]]; then
    args+=(-d "$body")
  fi
  curl "${args[@]}"
}

case "$ACTION" in
  create)
    [[ $# -ge 2 ]] || usage
    SESSION="$2"
    WAHA_URL="${3:-$DEFAULT_URL}"
    if [[ ! "$SESSION" =~ ^[a-zA-Z0-9_-]+$ ]]; then
      echo "Invalid session name: $SESSION" >&2
      exit 1
    fi

    echo "Creating session '$SESSION'..."
    call POST "$WAHA_URL/api/sessions" \
      "{\"name\":\"$SESSION\",\"start\":false,\"config\":{\"metadata\":{\"app\":\"osteogest\",\"clinic\":\"$SESSION\"}}}" >/dev/null

    echo "Creating session-scoped API key..."
    KEY_JSON=$(call POST "$WAHA_URL/api/keys" \
      "{\"isAdmin\":false,\"isActive\":true,\"session\":\"$SESSION\",\"actions\":{\"read\":true,\"send\":true,\"control\":true,\"setting\":true,\"app\":false,\"delete\":false}}")

    echo
    echo "Give these values to the clinic's Osteogest backoffice (Integrações > WhatsApp):"
    echo "  WAHA URL (internal): http://waha:3000"
    echo "  Session name:        $SESSION"
    echo "$KEY_JSON" | pretty
    echo
    echo "Store the key in a password manager. It will not be shown again by this script."
    ;;
  list)
    WAHA_URL="${2:-$DEFAULT_URL}"
    echo "Sessions:"
    call GET "$WAHA_URL/api/sessions?all=true" | pretty
    echo "API keys:"
    call GET "$WAHA_URL/api/keys" | pretty
    ;;
  revoke)
    [[ $# -ge 2 ]] || usage
    WAHA_URL="${3:-$DEFAULT_URL}"
    call DELETE "$WAHA_URL/api/keys/$2" | pretty
    ;;
  *)
    usage
    ;;
esac
