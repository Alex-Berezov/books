#!/bin/bash
set -euo pipefail

# Backup Status Check Script
# ==========================
# Проверяет:
# - Статус контейнеров (PostgreSQL, backend)
# - Свежесть последнего local backup (≤ 36 часов)
# - Свежесть последнего remote backup (≤ 36 часов)
# - Размер backup ≥ минимального
# - Remote upload success
# - Cron/systemd timer

export PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $(date '+%Y-%m-%d %H:%M:%S') $1"; }
log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_fail() { echo -e "${RED}[FAIL]${NC} $1"; }

# Source backup-specific environment (e.g., S3/R2 credentials)
BACKUP_ENV_FILE="${BACKUP_ENV_FILE:-/opt/books/app/.env.backup}"
if [[ -f "$BACKUP_ENV_FILE" ]]; then
    set -a
    source "$BACKUP_ENV_FILE"
    set +a
fi

PASS=0; FAIL=0; WARN=0
BACKUP_DIR="${BACKUP_DIR:-/opt/books/backups}"
MIN_BACKUP_SIZE_MB="${MIN_BACKUP_SIZE_MB:-1}"

check() {
  if [[ "$2" == "pass" ]]; then log_pass "$1"; ((PASS++))
  elif [[ "$2" == "warn" ]]; then log_warn "$1"; ((WARN++))
  else log_fail "$1"; ((FAIL++)); fi
}

echo "=== Backup Status Check ==="
echo "Date: $(date)"
echo ""

# 1. PostgreSQL container running
log_info "Checking PostgreSQL container..."
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q postgres; then
  check "PostgreSQL container running" "pass"
else
  check "PostgreSQL container NOT running" "fail"
fi

# 2. Backend container running
log_info "Checking backend container..."
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q books-app; then
  check "Backend container running" "pass"
else
  check "Backend container NOT running" "fail"
fi

# 3. Last local backup freshness (≤ 36 hours)
log_info "Checking local backup freshness..."
latest_local=$(find "$BACKUP_DIR" \( -name "bibliaris-prod-*.dump" -o -name "bibliaris-prod-*.sql*" -o -name "bibliaris-prod-uploads-*.tar.gz" \) -type f -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)
if [[ -n "$latest_local" ]]; then
  local_age=$(( ($(date +%s) - $(stat -c %Y "$latest_local")) / 3600 ))
  if [[ $local_age -le 36 ]]; then
    check "Local backup fresh: $(basename "$latest_local") (${local_age}h old)" "pass"
  else
    check "Local backup stale: $(basename "$latest_local") (${local_age}h > 36h)" "fail"
  fi
else
  check "No local backups found" "fail"
fi

# 4. Last local backup size
log_info "Checking local backup size..."
min_bytes=$(( MIN_BACKUP_SIZE_MB * 1024 * 1024 ))
latest_db=$(find "$BACKUP_DIR" \( -name "bibliaris-prod-*.dump" -o -name "bibliaris-prod-*.sql*" \) -type f -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)
if [[ -n "$latest_db" ]]; then
  size=$(stat -c %s "$latest_db" 2>/dev/null || echo 0)
  size_mb=$(( size / 1024 / 1024 ))
  if [[ $size -ge $min_bytes ]]; then
    check "Local backup size OK: ${size_mb}MB (≥ ${MIN_BACKUP_SIZE_MB}MB)" "pass"
  else
    check "Local backup suspiciously small: ${size_mb}MB (< ${MIN_BACKUP_SIZE_MB}MB)" "fail"
  fi
fi

# 5. Remote backup status
log_info "Checking remote backup status..."
if [[ "${BACKUP_REMOTE_ENABLED:-0}" == "1" ]] && command -v aws &> /dev/null; then
  export AWS_ACCESS_KEY_ID="${BACKUP_S3_ACCESS_KEY_ID:-}"
  export AWS_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET_ACCESS_KEY:-}"
  export AWS_DEFAULT_REGION="${BACKUP_S3_REGION:-auto}"
  aws_args=(--endpoint-url "${BACKUP_S3_ENDPOINT:-}")
  bucket="${BACKUP_S3_BUCKET:-}"
  prefix="${BACKUP_S3_PREFIX:-prod/postgres}"

  latest_remote=""
  latest_remote_epoch=0
  for t in daily weekly monthly before-deploy; do
    objects=$(aws s3 ls "s3://${bucket}/${prefix}/${t}/" "${aws_args[@]}" 2>/dev/null) || continue
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      obj_epoch=$(date -d "$(echo "$line" | awk '{print $1" "$2}')" +%s 2>/dev/null || echo 0)
      if [[ $obj_epoch -gt $latest_remote_epoch ]]; then
        latest_remote_epoch=$obj_epoch
        latest_remote=$(echo "$line" | awk '{print $4}')
      fi
    done <<< "$objects"
  done

  if [[ -n "$latest_remote" ]]; then
    remote_age=$(( ($(date +%s) - latest_remote_epoch) / 3600 ))
    if [[ $remote_age -le 36 ]]; then
      check "Remote backup fresh: ${latest_remote} (${remote_age}h old)" "pass"
    else
      check "Remote backup stale: ${latest_remote} (${remote_age}h > 36h)" "fail"
    fi
  else
    check "No remote backups found in bucket" "warn"
  fi
elif [[ "${BACKUP_REMOTE_ENABLED:-0}" != "1" ]]; then
  check "Remote backup check skipped (BACKUP_REMOTE_ENABLED != 1)" "warn"
else
  check "aws CLI not available for remote check" "warn"
fi

# 6. Cron status
log_info "Checking cron..."
if systemctl is-active cron >/dev/null 2>&1 || systemctl is-active crond >/dev/null 2>&1; then
  check "Cron service active" "pass"
else
  check "Cron service inactive" "fail"
fi
if crontab -l 2>/dev/null | grep -q "backup_database.sh"; then
  check "Backup cron job configured" "pass"
else
  check "No backup cron job found" "warn"
fi

# Summary
echo ""
echo "=== Summary ==="
echo -e "${GREEN}Passed: $PASS${NC}"
echo -e "${YELLOW}Warnings: $WARN${NC}"
echo -e "${RED}Failures: $FAIL${NC}"

if [[ $FAIL -eq 0 ]]; then
  echo -e "${GREEN}✓ All checks passed${NC}"
  exit 0
else
  echo -e "${RED}✗ ${FAIL} critical issue(s) found${NC}"
  exit 1
fi
