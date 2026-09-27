#!/usr/bin/env bash
# Install AES after the Ubuntu packages and Node.js 22 have been prepared.
set -Eeuo pipefail
umask 027

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SERVICE_USER="${SUDO_USER:-}"
SERVICE_GROUP=""
SERVICE_HOME="/var/lib/aes/home"
WEB_ROOT="/var/lib/aes/www"
HTTP_PORT="${AES_HTTP_PORT:-}"
ENV_FILE="$ROOT/courseworks/.env"
VENV="$ROOT/.venv"

usage() {
  cat <<'EOF'
Usage: sudo ./install_script.sh [--port PORT]

Clone AES as your normal user under your home directory, then run this script
through sudo. The repository remains owned by that normal user. Before running
it, install the Ubuntu packages listed in INSTALL.md and Node.js 22 or newer.

Environment override:
  AES_HTTP_PORT      public HTTP port (default: existing port or 10001)
EOF
}

log() {
  printf '\n==> %s\n' "$*"
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

on_error() {
  local line="$1"
  printf '\nInstallation stopped at line %s. Fix the error and run the script again.\n' "$line" >&2
}
trap 'on_error "$LINENO"' ERR

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      [[ $# -ge 2 ]] || die "--port requires a value."
      HTTP_PORT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1"
      ;;
  esac
done

if [[ -z "$HTTP_PORT" && -f /etc/nginx/sites-available/aes ]]; then
  HTTP_PORT="$(sed -nE 's/^[[:space:]]*listen[[:space:]]+([0-9]+);.*$/\1/p' \
    /etc/nginx/sites-available/aes | head -n 1)"
fi
HTTP_PORT="${HTTP_PORT:-10001}"

[[ "$EUID" -eq 0 ]] || die "Run this script with sudo."
[[ -n "$SERVICE_USER" && "$SERVICE_USER" != "root" ]] \
  || die "Run this script as a normal user through sudo; do not run it from a root login."
getent passwd "$SERVICE_USER" >/dev/null 2>&1 || die "Cannot resolve the installing user: $SERVICE_USER"
SERVICE_GROUP="$(id -gn "$SERVICE_USER")"
[[ "$HTTP_PORT" =~ ^[0-9]+$ ]] || die "HTTP port must be numeric."
(( HTTP_PORT >= 1 && HTTP_PORT <= 65535 )) || die "HTTP port is out of range."
[[ "$ROOT" =~ ^[A-Za-z0-9_./-]+$ ]] || die "The installation path may only contain letters, numbers, _, -, . and /."
[[ -f "$ROOT/courseworks/package.json" ]] || die "Run the script from a complete AES repository clone."
[[ "$(stat -c %u "$ROOT")" == "$(id -u "$SERVICE_USER")" ]] \
  || die "The AES repository must be owned by $SERVICE_USER. Clone it without sudo under that user's home directory."

required_commands=(
  awk cp curl docker find getent git grep head hostname install ip iptables libreoffice mysql
  nginx node npm openssl pdftoppm python3 runuser sed stat systemctl tail usermod
)
for command_name in "${required_commands[@]}"; do
  command -v "$command_name" >/dev/null 2>&1 || die "Missing command: $command_name. Complete section 2 of INSTALL.md first."
done
for writable_path in "$ROOT" "$ROOT/.git" "$ROOT/courseworks" "$ROOT/management"; do
  runuser -u "$SERVICE_USER" -- test -w "$writable_path" \
    || die "$writable_path is not writable by $SERVICE_USER. Clone the repository without sudo."
done

node_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
[[ "$node_major" =~ ^[0-9]+$ ]] && (( node_major >= 22 )) \
  || die "Node.js 22 or newer is required; found $(node --version)."

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  source /etc/os-release
  [[ "${ID:-}" == "ubuntu" ]] || printf 'WARNING: this installer is tested on Ubuntu; detected %s.\n' "${PRETTY_NAME:-unknown OS}" >&2
fi

log "Starting MySQL, Docker and Nginx"
systemctl enable --now mysql docker nginx
docker info >/dev/null

log "Preparing the application runtime for $SERVICE_USER"
usermod -aG docker "$SERVICE_USER"
install -d -o root -g root -m 0755 /var/lib/aes
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$SERVICE_HOME"

read_superuser_value() {
  local key="$1"
  awk -v wanted="$key" '
    /^[[:space:]]*\[/ {
      in_superuser = ($0 ~ /^[[:space:]]*\[superuser\][[:space:]]*(#.*)?$/)
      next
    }
    in_superuser && $0 ~ "^[[:space:]]*" wanted "[[:space:]]*=" {
      value = $0
      sub(/^[^=]*=[[:space:]]*\"/, "", value)
      sub(/\"[[:space:]]*(#.*)?$/, "", value)
      print value
      exit
    }
  ' "$ROOT/superuser.toml"
}

write_superuser_config() {
  local email="$1"
  local password="$2"
  local temporary
  temporary="$(mktemp)"
  awk -v email="$email" -v password="$password" '
    /^[[:space:]]*\[/ {
      in_superuser = ($0 ~ /^[[:space:]]*\[superuser\][[:space:]]*(#.*)?$/)
    }
    in_superuser && /^[[:space:]]*email[[:space:]]*=/ {
      print "email = \"" email "\""
      next
    }
    in_superuser && /^[[:space:]]*password[[:space:]]*=/ {
      print "password = \"" password "\""
      next
    }
    { print }
  ' "$ROOT/superuser.toml" >"$temporary"
  install -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0600 "$temporary" "$ROOT/superuser.toml"
  rm -f "$temporary"
}

configure_superuser() {
  local current_email current_password email password confirmation
  [[ -f "$ROOT/superuser.toml" ]] || die "Missing superuser.toml."
  current_email="$(read_superuser_value email)"
  current_password="$(read_superuser_value password)"

  if [[ "$current_email" == "abc@abc.com" || "$current_password" == "abcdef" ]]; then
    [[ -t 0 ]] || die "Edit superuser.toml before running non-interactively."
    printf '\nThe repository still contains example superuser credentials.\n'
    while :; do
      read -r -p 'Superuser email: ' email
      if [[ "$email" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ \
        && "$email" != *'"'* && "$email" != *'\'* ]]; then
        break
      fi
      printf 'Please enter a valid email address.\n' >&2
    done
    while :; do
      read -r -s -p 'Superuser password (at least 6 characters): ' password
      printf '\n'
      read -r -s -p 'Confirm password: ' confirmation
      printf '\n'
      [[ ${#password} -ge 6 ]] || { printf 'Password is too short.\n' >&2; continue; }
      [[ "$password" == "$confirmation" ]] || { printf 'Passwords do not match.\n' >&2; continue; }
      [[ "$password" != *'"'* && "$password" != *'\'* ]] \
        || { printf 'Password cannot contain a double quote or backslash in this installer.\n' >&2; continue; }
      break
    done
    write_superuser_config "$email" "$password"
  else
    [[ -n "$current_email" && "$current_email" == *@* ]] || die "superuser.toml contains an invalid email."
    [[ ${#current_password} -ge 6 ]] || die "superuser.toml password must contain at least 6 characters."
    chown "$SERVICE_USER:$SERVICE_GROUP" "$ROOT/superuser.toml"
    chmod 0600 "$ROOT/superuser.toml"
  fi
}

configure_superuser

set_env_value() {
  local file="$1"
  local key="$2"
  local value="$3"
  local escaped
  escaped="$(printf '%s' "$value" | sed 's/[\\&|]/\\&/g')"
  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*$|${key}=\"${escaped}\"|" "$file"
  else
    printf '%s="%s"\n' "$key" "$value" >>"$file"
  fi
}

env_value() {
  local key="$1"
  local value
  value="$(sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n 1)"
  value="${value#\"}"
  value="${value%\"}"
  printf '%s' "$value"
}

NEW_ENV=0
if [[ ! -f "$ENV_FILE" ]]; then
  log "Generating application secrets and environment configuration"
  NEW_ENV=1
  temporary_env="$(mktemp)"
  cp "$ROOT/courseworks/.env.example" "$temporary_env"
  DB_PASSWORD="$(openssl rand -hex 24)"
  DEFAULT_IFACE="$(ip route show default | awk 'NR == 1 { print $5; exit }')"
  [[ -n "$DEFAULT_IFACE" ]] || die "Cannot determine the default outbound network interface."

  set_env_value "$temporary_env" DATABASE_URL "mysql://vibeos_user:${DB_PASSWORD}@localhost:3306/vibeos_agent"
  set_env_value "$temporary_env" NODE_ENV "production"
  set_env_value "$temporary_env" JWT_SECRET "$(openssl rand -hex 48)"
  set_env_value "$temporary_env" SECRET_KEY "$(openssl rand -hex 32)"
  set_env_value "$temporary_env" SLIDESHOW_SESSION_SECRET "$(openssl rand -hex 32)"
  set_env_value "$temporary_env" SUPERUSER_CONFIG_PATH "$ROOT/superuser.toml"
  set_env_value "$temporary_env" BACKEND_HOST "127.0.0.1"
  set_env_value "$temporary_env" BACKEND_PORT "3000"
  set_env_value "$temporary_env" COURSEWORKS_INTERNAL_API_URL "http://127.0.0.1:3000/api"
  set_env_value "$temporary_env" HOMEWORKS_ACCOUNT_DATABASE_PATH "$ROOT/accounts-data/accounts.db"
  set_env_value "$temporary_env" HOMEWORKS_COURSE_DATABASE_PATH "$ROOT/accounts-data/courses.db"
  set_env_value "$temporary_env" HOMEWORKS_UPLOAD_PATH "$ROOT/homeworks/uploads"
  set_env_value "$temporary_env" HOMEWORKS_PUBLIC_PATH "/homeworks"
  set_env_value "$temporary_env" SLIDESHOW_DATABASE_PATH "$ROOT/accounts-data/slideshow.db"
  set_env_value "$temporary_env" SLIDESHOW_UPLOAD_PATH "$ROOT/slideshow/uploads"
  set_env_value "$temporary_env" SLIDESHOW_PUBLIC_PATH "/slideshow"
  set_env_value "$temporary_env" ARCHIVE_ROOT "$ROOT/archive-data"
  set_env_value "$temporary_env" WORKSPACE_ROOT "$ROOT/courseworks/student-workspace"
  set_env_value "$temporary_env" DOCKER_DIRECT_IFACE "$DEFAULT_IFACE"
  install -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0600 "$temporary_env" "$ENV_FILE"
  rm -f "$temporary_env"
else
  log "Keeping existing courseworks/.env"
  chown "$SERVICE_USER:$SERVICE_GROUP" "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
fi

DATABASE_URL="$(env_value DATABASE_URL)"
if [[ "$DATABASE_URL" =~ ^mysql://vibeos_user:([0-9a-fA-F]+)@localhost:3306/vibeos_agent$ ]]; then
  DB_PASSWORD="${BASH_REMATCH[1]}"
else
  die "DATABASE_URL must use the dedicated local vibeos_user/vibeos_agent database and a hexadecimal password."
fi

log "Creating or updating the AES MySQL database"
mysql --protocol=socket <<SQL
CREATE DATABASE IF NOT EXISTS vibeos_agent CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'vibeos_user'@'localhost' IDENTIFIED BY '${DB_PASSWORD}';
ALTER USER 'vibeos_user'@'localhost' IDENTIFIED BY '${DB_PASSWORD}';
GRANT ALL PRIVILEGES ON vibeos_agent.* TO 'vibeos_user'@'localhost';
FLUSH PRIVILEGES;
SQL

log "Preparing persistent data directories and Python environment"
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0755 \
  "$ROOT/accounts-data" \
  "$ROOT/homeworks/uploads" \
  "$ROOT/slideshow/uploads" \
  "$ROOT/courseworks/student-workspace"
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0700 "$ROOT/archive-data"

if [[ ! -x "$VENV/bin/python" ]]; then
  runuser -u "$SERVICE_USER" -- python3 -m venv "$VENV"
fi
runuser -u "$SERVICE_USER" -- "$VENV/bin/pip" install --upgrade pip wheel
runuser -u "$SERVICE_USER" -- "$VENV/bin/pip" install \
  -r "$ROOT/homeworks/requirements.txt" \
  -r "$ROOT/slideshow/requirements.txt"

as_app() {
  runuser -u "$SERVICE_USER" -- env \
    HOME="$SERVICE_HOME" \
    PATH="$VENV/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    "$@"
}

log "Installing, testing and building Courseworks"
cd "$ROOT/courseworks"
as_app npm run setup
as_app npm run seed

log "Publishing the Courseworks web application"
install -d -o root -g www-data -m 0755 "$WEB_ROOT"
find "$WEB_ROOT" -mindepth 1 -depth -delete
cp -a "$ROOT/courseworks/apps/web/dist/." "$WEB_ROOT/"
chown -R root:www-data "$WEB_ROOT"
chmod -R u=rwX,g=rX,o=rX "$WEB_ROOT"

log "Creating the restricted Courseworks Docker network"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
"$ROOT/courseworks/docker/toolbox/setup-restricted-network.sh"

log "Installing systemd units"
NODE_BIN="$(command -v node)"
cat > /etc/systemd/system/courseworks-network.service <<EOF
[Unit]
Description=Courseworks restricted Docker network
Requires=docker.service
After=docker.service network-online.target
Before=courseworks-backend.service

[Service]
Type=oneshot
EnvironmentFile=$ENV_FILE
ExecStart=$ROOT/courseworks/docker/toolbox/setup-restricted-network.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/courseworks-backend.service <<EOF
[Unit]
Description=Courseworks Backend Server
Requires=courseworks-network.service
After=network-online.target mysql.service docker.service courseworks-network.service

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$ROOT/courseworks
ExecStart=$NODE_BIN apps/server/src/build/app/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=HOME=$SERVICE_HOME
Environment=PATH=$VENV/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EnvironmentFile=$ENV_FILE

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/homework.service <<EOF
[Unit]
Description=AES Homeworks Service
After=network-online.target courseworks-backend.service

[Service]
Type=simple
User=$SERVICE_USER
Group=www-data
WorkingDirectory=$ROOT/homeworks
RuntimeDirectory=homework
RuntimeDirectoryMode=0750
ExecStart=$VENV/bin/gunicorn --bind unix:/run/homework/homework.sock --worker-class gthread --workers 2 --threads 4 --timeout 180 --umask 007 --access-logfile - --error-logfile - app:create_app()
Restart=always
RestartSec=5
Environment=PYTHONUNBUFFERED=1
Environment=HOME=$SERVICE_HOME
Environment=FLASK_ENV=production
Environment=APPLICATION_ROOT=/homeworks
Environment=SERVICE_PORTAL_URL=/portal
Environment=COURSEWORKS_REGISTER_URL=/?register=1
EnvironmentFile=$ENV_FILE

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/slideshow.service <<EOF
[Unit]
Description=AES Slideshow Service
After=network-online.target courseworks-backend.service

[Service]
Type=simple
User=$SERVICE_USER
Group=www-data
WorkingDirectory=$ROOT/slideshow
RuntimeDirectory=slideshow
RuntimeDirectoryMode=0750
ExecStart=$VENV/bin/gunicorn --bind unix:/run/slideshow/slideshow.sock --worker-class gthread --workers 2 --threads 4 --timeout 360 --umask 007 --access-logfile - --error-logfile - app:app
Restart=always
RestartSec=5
Environment=PYTHONUNBUFFERED=1
Environment=HOME=$SERVICE_HOME
Environment=APPLICATION_ROOT=/slideshow
Environment=SERVICE_PORTAL_URL=/portal
EnvironmentFile=$ENV_FILE

[Install]
WantedBy=multi-user.target
EOF

chmod 0644 \
  /etc/systemd/system/courseworks-network.service \
  /etc/systemd/system/courseworks-backend.service \
  /etc/systemd/system/homework.service \
  /etc/systemd/system/slideshow.service

log "Installing the Nginx entry point on port $HTTP_PORT"
sed \
  -e "s/listen 10001;/listen ${HTTP_PORT};/" \
  "$ROOT/courseworks/scripts/nginx-courseworks.conf" \
  > /etc/nginx/sites-available/aes
ln -sfn /etc/nginx/sites-available/aes /etc/nginx/sites-enabled/aes
nginx -t

log "Starting AES services"
systemctl daemon-reload
systemctl enable courseworks-network courseworks-backend homework slideshow
systemctl restart courseworks-network
systemctl restart courseworks-backend
systemctl restart homework slideshow
systemctl reload nginx

log "Verifying services and HTTP endpoints"
for service in courseworks-network courseworks-backend homework slideshow; do
  systemctl is-active --quiet "$service" || {
    systemctl status --no-pager "$service" || true
    die "$service did not start successfully."
  }
done
curl --fail --silent --show-error --head "http://127.0.0.1:${HTTP_PORT}/" >/dev/null
curl --fail --silent --show-error --head "http://127.0.0.1:${HTTP_PORT}/homeworks/" >/dev/null
curl --fail --silent --show-error --head "http://127.0.0.1:${HTTP_PORT}/slideshow/" >/dev/null

SERVER_IP="$(hostname -I 2>/dev/null | awk '{ print $1 }')"
printf '\nAES installation completed.\n'
printf 'Open: http://%s:%s/\n' "${SERVER_IP:-SERVER_IP}" "$HTTP_PORT"
printf 'Configuration: %s\n' "$ENV_FILE"
printf 'Superuser credentials: %s\n' "$ROOT/superuser.toml"
if [[ "$NEW_ENV" -eq 1 ]]; then
  printf 'A new database password and application secrets were generated automatically.\n'
fi
