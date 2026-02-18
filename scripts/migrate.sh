#!/bin/bash
# Database migration runner
# Usage: ./scripts/migrate.sh [--dry-run]
#
# Requires environment variables or .env file:
#   DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
# Or for remote with SSL:
#   PGSSLMODE=require

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS_DIR="$SCRIPT_DIR/../drizzle"

# Load .env if exists
if [ -f "$SCRIPT_DIR/../.env" ]; then
  export $(grep -v '^#' "$SCRIPT_DIR/../.env" | xargs)
fi

DRY_RUN=false
if [ "$1" = "--dry-run" ]; then
  DRY_RUN=true
  echo "DRY RUN MODE - no changes will be made"
fi

# Build connection string
if [ -z "$DB_HOST" ] || [ -z "$DB_USER" ] || [ -z "$DB_NAME" ]; then
  echo "Error: Missing database connection variables (DB_HOST, DB_USER, DB_NAME)"
  exit 1
fi

PGPASSWORD="${DB_PASSWORD}"
export PGPASSWORD

PSQL_ARGS="-h $DB_HOST -p ${DB_PORT:-5432} -U $DB_USER -d $DB_NAME"

# Create schema_migrations table if not exists
psql $PSQL_ARGS -c "
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(255) PRIMARY KEY,
  applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);" 2>/dev/null || true

# Get list of applied migrations
APPLIED=$(psql $PSQL_ARGS -t -c "SELECT version FROM schema_migrations ORDER BY version;" 2>/dev/null | tr -d ' ')

echo "=== Migration Status ==="
echo ""

# Find and run pending migrations
PENDING=0
for migration in $(ls "$MIGRATIONS_DIR"/*.sql 2>/dev/null | sort); do
  filename=$(basename "$migration" .sql)

  if echo "$APPLIED" | grep -q "^${filename}$"; then
    echo "[OK] $filename"
  else
    PENDING=$((PENDING + 1))
    if [ "$DRY_RUN" = true ]; then
      echo "[PENDING] $filename (would apply)"
    else
      echo "[APPLYING] $filename..."
      psql $PSQL_ARGS -f "$migration"
      psql $PSQL_ARGS -c "INSERT INTO schema_migrations (version) VALUES ('$filename') ON CONFLICT DO NOTHING;"
      echo "[DONE] $filename"
    fi
  fi
done

echo ""
if [ "$DRY_RUN" = true ]; then
  echo "=== $PENDING migrations pending ==="
else
  echo "=== Migration complete ==="
fi
