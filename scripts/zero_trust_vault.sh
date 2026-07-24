#!/usr/bin/env bash
set -euo pipefail

VAULT_DIR=".local_vault"
VAULT_FILE="$VAULT_DIR/zero_trust.env"

SECRET_LINE_REGEX='([A-Za-z_][A-Za-z0-9_]{2,})\s*[:=]\s*["'"'"']?([A-Za-z0-9_\-\/=+]{16,})["'"'"']?'
BANNED_IDENTIFIER_REGEX='\b([0-9]{3}[ -]?[0-9]{3}[ -]?[0-9]{3}|[0-9]{10})\b'
BLOCKLIST_REGEX='(AKIA[0-9A-Z]{16}|sk_live_[0-9A-Za-z]{24,}|xox[baprs]-[0-9A-Za-z-]{10,}|-----BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY-----)'

ensure_vault() {
  mkdir -p "$VAULT_DIR"
  touch "$VAULT_FILE"
  chmod 600 "$VAULT_FILE"
}

scan_repo_mode() {
  local failed=0
  while IFS= read -r -d '' f; do
    if grep -EIn "$BLOCKLIST_REGEX" "$f" >/dev/null; then
      echo "[zero-trust] blocked high-risk secret pattern in: $f" >&2
      failed=1
    fi
  done < <(find . -type f -not -path './.git/*' -not -path "./$VAULT_DIR/*" -print0)
  return "$failed"
}

list_staged_files() {
  git diff --cached --name-only --diff-filter=ACMR
}

contains_binary() {
  local f="$1"
  if [ ! -f "$f" ]; then
    return 0
  fi
  grep -Iq . "$f"
}

append_vault_secret() {
  local key="$1"
  local value="$2"
  if ! grep -q "^${key}=" "$VAULT_FILE"; then
    printf '%s=%q\n' "$key" "$value" >> "$VAULT_FILE"
  fi
}

sanitize_file() {
  local file="$1"
  local changed=0

  if grep -EIn "$BANNED_IDENTIFIER_REGEX" "$file" >/dev/null; then
    echo "[zero-trust] blocked regulated identifier format in $file. Redact manually." >&2
    return 2
  fi

  while IFS= read -r match; do
    local key value vault_key placeholder
    key="$(echo "$match" | sed -E 's/^([A-Za-z_][A-Za-z0-9_]{2,}).*/\1/')"
    value="$(echo "$match" | sed -E 's/^[A-Za-z_][A-Za-z0-9_]{2,}\s*[:=]\s*["'"'"']?([^"'"'"' ]+).*/\1/')"

    case "$key" in
      PUBLIC_*|NEXT_PUBLIC_*|VITE_*)
        continue
        ;;
    esac

    vault_key="${key}_FROM_VAULT"
    placeholder="${key}=\"\${${vault_key}}\""

    append_vault_secret "$vault_key" "$value"

    sed -i -E "s#${key}[[:space:]]*[:=][[:space:]]*[\"']?${value}[\"']?#${placeholder}#g" "$file"
    changed=1
  done < <(grep -Eo "$SECRET_LINE_REGEX" "$file" || true)

  if [ "$changed" -eq 1 ]; then
    git add "$file"
    echo "[zero-trust] diverted secret assignments to $VAULT_FILE for $file"
  fi

  return 0
}

main() {
  ensure_vault

  if [ "${1:-}" = "--scan-repo" ]; then
    scan_repo_mode
    return $?
  fi

  local rc=0
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    if ! contains_binary "$file"; then
      continue
    fi
    if ! sanitize_file "$file"; then
      rc=1
    fi
  done < <(list_staged_files)

  if [ "$rc" -ne 0 ]; then
    echo "[zero-trust] pre-commit check failed." >&2
    return 1
  fi

  echo "[zero-trust] scan complete."
}

main "$@"
