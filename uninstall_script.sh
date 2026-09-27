#!/usr/bin/env bash
# Remove the AES deployment while leaving shared Ubuntu packages untouched.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ENV_FILE="$ROOT/courseworks/.env"
PURGE_DATA=0
REMOVE_IMAGE=0
ASSUME_YES=0
DRY_RUN=0

usage() {
  cat <<'USAGE'
Usage: sudo ./uninstall_script.sh [options]

Without options, displays an interactive uninstall menu. The source repository
and shared Ubuntu packages are retained by every uninstall mode.

Options:
  --purge-data    Also delete the AES database, database account, generated
                  .env file, uploads, SQLite databases, archives, and workspaces.
  --remove-image  Also delete the configured Courseworks toolbox Docker image.
  --yes           Do not ask for confirmation when --purge-data is used.
  --dry-run       Print actions without changing the system; sudo is not required.
  -h, --help      Show this help.
USAGE
}

choose_uninstall_mode() {
  [[ -t 0 ]] || die "No options were provided and no interactive terminal is available. Use --help for automation options."

  cat <<MENU

Choose an uninstall mode:
  1) Full uninstall: remove services, user data, databases, and Docker images
  2) Remove services and runtime deployment only; keep user data, databases,
     configuration, and Docker images
  3) Remove services, user data, and databases; keep Docker images
  4) Exit

All modes retain the AES source directory and shared Ubuntu packages.
MENU

  local choice
  read -r -p "Enter a choice [1-4]: " choice
  case "$choice" in
    1)
      PURGE_DATA=1
      REMOVE_IMAGE=1
      ;;
    2)
      ;;
    3)
      PURGE_DATA=1
      ;;
    4)
      printf "Exited without making any changes.\n"
      exit 0
      ;;
    *)
      die "Invalid selection: $choice"
      ;;
  esac
}

log() {
  printf '\n==> %s\n' "$*"
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

print_command() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
}

run() {
  print_command "$@"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    "$@"
  fi
}

run_optional() {
  print_command "$@"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    "$@" 2>/dev/null || true
  fi
}

read_env_value() {
  local key="$1"
  local value=""
  if [[ -f "$ENV_FILE" ]]; then
    value="$(sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n 1)"
    value="${value#\"}"
    value="${value%\"}"
  fi
  printf '%s' "$value"
}

purge_directory_contents() {
  local directory="$1"
  [[ -d "$directory" ]] || return 0
  printf '+ find %q -mindepth 1 -depth ! -name .gitkeep -delete\n' "$directory"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    find "$directory" -mindepth 1 -depth ! -name .gitkeep -delete
  fi
}

if [[ $# -eq 0 ]]; then
  choose_uninstall_mode
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --purge-data) PURGE_DATA=1 ;;
    --remove-image) REMOVE_IMAGE=1 ;;
    --yes) ASSUME_YES=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

if [[ "$DRY_RUN" -eq 0 && "$EUID" -ne 0 ]]; then
  die "Run this script with sudo."
fi

NETWORK_NAME="$(read_env_value DOCKER_RESTRICTED_NETWORK)"
NETWORK_NAME="${NETWORK_NAME:-courseworks-restricted}"
NETWORK_SUBNET="$(read_env_value DOCKER_RESTRICTED_SUBNET)"
NETWORK_SUBNET="${NETWORK_SUBNET:-172.30.0.0/24}"
TOOLBOX_IMAGE="$(read_env_value DOCKER_TOOLBOX_IMAGE)"
TOOLBOX_IMAGE="${TOOLBOX_IMAGE:-courseworks-toolbox:latest}"

[[ "$NETWORK_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] \
  || die "Invalid DOCKER_RESTRICTED_NETWORK in $ENV_FILE"
[[ "$NETWORK_SUBNET" =~ ^[0-9A-Fa-f:.]+/[0-9]+$ ]] \
  || die "Invalid DOCKER_RESTRICTED_SUBNET in $ENV_FILE"

if [[ "$PURGE_DATA" -eq 1 && "$ASSUME_YES" -eq 0 ]]; then
  [[ -t 0 ]] || die "Use --yes with --purge-data in a non-interactive shell."
  printf '\n--purge-data permanently deletes AES databases, uploads, archives, and student workspaces.\n'
  read -r -p 'Type DELETE to continue: ' confirmation
  [[ "$confirmation" == "DELETE" ]] || die "Uninstallation cancelled."
fi

services=(courseworks-backend courseworks-network homework slideshow)
unit_files=(
  /etc/systemd/system/courseworks-backend.service
  /etc/systemd/system/courseworks-network.service
  /etc/systemd/system/homework.service
  /etc/systemd/system/slideshow.service
)

log "Stopping and removing AES services"
for service in "${services[@]}"; do
  run_optional systemctl disable --now "$service"
done
run rm -f "${unit_files[@]}"
run systemctl daemon-reload
run_optional systemctl reset-failed

log "Removing the AES Nginx entry point"
run rm -f /etc/nginx/sites-enabled/aes /etc/nginx/sites-available/aes
if command -v nginx >/dev/null 2>&1; then
  run_optional nginx -t
  run_optional systemctl reload nginx
fi

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  log "Removing AES-managed containers and restricted Docker network"
  mapfile -t managed_containers < <(docker ps -aq --filter label=courseworks.managed=true)
  if [[ "${#managed_containers[@]}" -gt 0 ]]; then
    run docker rm -f "${managed_containers[@]}"
  fi
  run_optional docker network rm "$NETWORK_NAME"
else
  printf 'WARNING: Docker is unavailable; skipping container and network cleanup.\n' >&2
fi

if command -v iptables >/dev/null 2>&1; then
  log "Removing Courseworks firewall rules"
  while iptables -C DOCKER-USER -s "$NETWORK_SUBNET" -j COURSEWORKS_EGRESS >/dev/null 2>&1; do
    run iptables -D DOCKER-USER -s "$NETWORK_SUBNET" -j COURSEWORKS_EGRESS
    [[ "$DRY_RUN" -eq 0 ]] || break
  done
  while iptables -C INPUT -s "$NETWORK_SUBNET" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT >/dev/null 2>&1; do
    run iptables -D INPUT -s "$NETWORK_SUBNET" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    [[ "$DRY_RUN" -eq 0 ]] || break
  done
  while iptables -C INPUT -s "$NETWORK_SUBNET" -j REJECT >/dev/null 2>&1; do
    run iptables -D INPUT -s "$NETWORK_SUBNET" -j REJECT
    [[ "$DRY_RUN" -eq 0 ]] || break
  done
  run_optional iptables -F COURSEWORKS_EGRESS
  run_optional iptables -X COURSEWORKS_EGRESS
fi

log "Removing generated runtime and published web files"
run rm -rf /var/lib/aes

if [[ "$REMOVE_IMAGE" -eq 1 ]]; then
  if command -v docker >/dev/null 2>&1; then
    log "Removing the Courseworks toolbox image"
    run_optional docker image rm "$TOOLBOX_IMAGE"
  fi
fi

if [[ "$PURGE_DATA" -eq 1 ]]; then
  log "Deleting the AES database and application data"
  command -v mysql >/dev/null 2>&1 \
    || die "mysql is unavailable; refusing a partial data purge."
  run mysql --protocol=socket -e \
    "DROP DATABASE IF EXISTS vibeos_agent; DROP USER IF EXISTS 'vibeos_user'@'localhost'; FLUSH PRIVILEGES;"

  purge_directory_contents "$ROOT/accounts-data"
  purge_directory_contents "$ROOT/homeworks/uploads"
  purge_directory_contents "$ROOT/slideshow/uploads"
  purge_directory_contents "$ROOT/courseworks/student-workspace"
  purge_directory_contents "$ROOT/archive-data"
  run rm -f "$ENV_FILE"
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  printf '\nAES uninstall dry run completed; no changes were made.\n'
else
  printf '\nAES uninstallation completed.\n'
fi
printf 'The source repository and superuser.toml remain at: %s\n' "$ROOT"
printf 'MySQL, Docker, Nginx, Node.js, Python, LibreOffice, and other shared packages were not removed.\n'
if [[ "$PURGE_DATA" -eq 0 ]]; then
  printf 'Application data was retained. Use --purge-data only when permanent deletion is intended.\n'
fi
