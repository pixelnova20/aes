#!/usr/bin/env bash
# Fail before a public commit when runtime data, credentials or scattered docs can be included.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
ERRORS=0

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  ERRORS=$((ERRORS + 1))
}

is_forbidden_tracked_path() {
  local path="$1"
  case "$path" in
    courseworks/.env|courseworks/.env.local)
      return 0
      ;;
    accounts-data/*)
      [[ "$path" != "accounts-data/.gitkeep" ]]
      return
      ;;
    archive-data/*)
      [[ "$path" != "archive-data/.gitkeep" ]]
      return
      ;;
    homeworks/uploads/*|slideshow/uploads/*|courseworks/student-workspace/*|courseworks/logs/*)
      return 0
      ;;
    *.db|*.db-*|*.sqlite|*.sqlite3|*.pem|*.key|*.log)
      return 0
      ;;
  esac
  return 1
}

check_gitignore_rules() {
  local check_root
  check_root="$(mktemp -d)"
  git -C "$check_root" init -q
  mkdir -p "$check_root/courseworks"
  cp "$ROOT/.gitignore" "$check_root/.gitignore"
  cp "$ROOT/courseworks/.gitignore" "$check_root/courseworks/.gitignore"

  local paths=(
    "courseworks/.env"
    "accounts-data/accounts.db"
    "accounts-data/accounts.db-wal"
    "archive-data/deleted-user/manifest.json"
    "homeworks/uploads/answers/submission.pdf"
    "slideshow/uploads/presentations/slides/001.jpg"
    "courseworks/student-workspace/student/session.jsonl"
    "courseworks/logs/backend.log"
    "private.key"
  )
  local path
  for path in "${paths[@]}"; do
    mkdir -p "$(dirname "$check_root/$path")"
    : >"$check_root/$path"
    git -C "$check_root" check-ignore -q -- "$path" \
      || fail ".gitignore does not exclude $path"
  done

  find "$check_root" -depth -delete
}

check_tracked_files() {
  if ! git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    printf 'INFO: no .git directory; tracked-file audit will run after this tree is cloned or initialized.\n'
    return
  fi

  local path
  while IFS= read -r -d '' path; do
    if is_forbidden_tracked_path "$path"; then
      fail "runtime data or credentials are tracked by Git: $path"
    fi
  done < <(git -C "$ROOT" ls-files -z)

  git -C "$ROOT" diff --check || fail "Git reports whitespace errors."
}

check_document_locations() {
  local path relative
  while IFS= read -r -d '' path; do
    relative="${path#"$ROOT/"}"
    case "$relative" in
      README.md|INSTALL.md|known-limitations.md|docs/*)
        ;;
      *)
        fail "independent documentation is outside the repository root or docs/: $relative"
        ;;
    esac
  done < <(
    find "$ROOT" \
      -path "$ROOT/.git" -prune -o \
      -path '*/node_modules' -prune -o \
      -path '*/dist' -prune -o \
      -path '*/build' -prune -o \
      -path '*/.pytest_cache' -prune -o \
      -path "$ROOT/courseworks/student-workspace" -prune -o \
      -type f \( \
        -iname 'README*.md' -o -iname 'INSTALL*.md' -o \
        -iname 'CHANGELOG*.md' -o -iname 'CONTRIBUTING*.md' -o \
        -iname 'SECURITY*.md' \
      \) -print0
  )
}

check_sensitive_text() {
  local scan_globs=(
    --hidden
    -g '!**/.git/**'
    -g '!**/node_modules/**'
    -g '!**/dist/**'
    -g '!**/build/**'
    -g '!**/.pytest_cache/**'
    -g '!courseworks/student-workspace/**'
    -g '!courseworks/.env'
    -g '!docs/pictures/**'
    -g '!scripts/check_open_source_readiness.sh'
  )

  local sensitive
  sensitive="$(rg -n "${scan_globs[@]}" \
    -e '-----BEGIN ([A-Z ]+ )?PRIVATE KEY-----' \
    -e 'sk-[A-Za-z0-9_-]{20,}' \
    -e 'AKIA[0-9A-Z]{16}' \
    -e '222\.20\.98\.153|8\.148\.72\.30|192\.168\.101\.' \
    -e 'd5206\.synology\.me|szy123|zyshao@|hust\.edu\.cn|/home/zhiyuan' \
    "$ROOT" || true)"
  [[ -z "$sensitive" ]] || fail "possible private credential or deployment-specific value found:\n$sensitive"

  local email lower
  while IFS= read -r email; do
    [[ -n "$email" ]] || continue
    lower="${email,,}"
    case "$lower" in
      *@example.com|*@example.edu|abc@abc.com)
        ;;
      *)
        fail "non-example email address found in publishable text: $email"
        ;;
    esac
  done < <(
    rg -o --no-filename "${scan_globs[@]}" \
      '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' "$ROOT" \
      | sort -fu || true
  )
}

check_public_superuser_example() {
  local email password
  [[ -f "$ROOT/superuser.toml" ]] || {
    fail "superuser.toml is missing."
    return
  }
  email="$(awk '
    /^[[:space:]]*\[/ {
      in_superuser = ($0 ~ /^[[:space:]]*\[superuser\][[:space:]]*(#.*)?$/)
      next
    }
    in_superuser && /^[[:space:]]*email[[:space:]]*=/ {
      value = $0
      sub(/^[^=]*=[[:space:]]*"/, "", value)
      sub(/"[[:space:]]*(#.*)?$/, "", value)
      print value
      exit
    }
  ' "$ROOT/superuser.toml")"
  password="$(awk '
    /^[[:space:]]*\[/ {
      in_superuser = ($0 ~ /^[[:space:]]*\[superuser\][[:space:]]*(#.*)?$/)
      next
    }
    in_superuser && /^[[:space:]]*password[[:space:]]*=/ {
      value = $0
      sub(/^[^=]*=[[:space:]]*"/, "", value)
      sub(/"[[:space:]]*(#.*)?$/, "", value)
      print value
      exit
    }
  ' "$ROOT/superuser.toml")"
  [[ "$email" == "abc@abc.com" && "$password" == "abcdef" ]] \
    || fail "superuser.toml contains non-example credentials; restore abc@abc.com / abcdef before publishing."
}

[[ -f "$ROOT/.gitignore" ]] || fail ".gitignore is missing."

check_public_superuser_example
check_gitignore_rules
check_tracked_files
check_document_locations
check_sensitive_text

if (( ERRORS > 0 )); then
  printf '\nOpen-source readiness check failed with %d error(s).\n' "$ERRORS" >&2
  exit 1
fi

printf 'Open-source readiness check passed.\n'
