#!/usr/bin/env bash
#
# Pull a complete copy of the journal out of AWS and onto this machine.
#
#   ./pull-backup.sh [destination]      default: ~/mana-muchatlu-backup
#
# This is the step that answers the original requirement: "google poyina mana
# memories pokudadu". Everything else - DynamoDB point-in-time recovery, S3
# versioning, the nightly archive - lives inside one AWS account and dies with
# it. This is the only copy that survives losing the account.
#
# Deliberately a command a person runs, not a cron job. An automated push to
# Drive needs an OAuth refresh token that expires quietly, which leaves you a
# backup you believe in but do not have. A copy made on purpose four times a
# year beats an automated one you cannot see failing.
#
# Point it at a synced folder and the sync client does the off-machine hop:
#   ./pull-backup.sh ~/"Google Drive"/mana-muchatlu
#
set -euo pipefail

PROJECT_NAME="${PROJECT_NAME:-mana-muchatlu}"
AWS_REGION="${AWS_REGION:-us-east-1}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARCHIVE_LIB="${HERE}/../api/lib/archive.js"

# Tolerate a pasted trailing comment, as deploy.sh does.
case "${1:-}" in '#'*) set -- ;; esac
DEST="${1:-$HOME/mana-muchatlu-backup}"

DATA_STACK="${PROJECT_NAME}-data"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

command -v aws >/dev/null  || { echo "aws CLI not found"; exit 1; }
command -v node >/dev/null || { echo "node not found"; exit 1; }
[ -f "$ARCHIVE_LIB" ]      || { echo "cannot find ${ARCHIVE_LIB}"; exit 1; }
aws sts get-caller-identity >/dev/null || { echo "AWS credentials not configured"; exit 1; }

stack_output() {
  aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name "$DATA_STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text 2>/dev/null
}

BACKUP_BUCKET="$(stack_output BackupBucketName)"
MEDIA_BUCKET="$(stack_output MediaBucketName)"

[ -n "$BACKUP_BUCKET" ] && [ "$BACKUP_BUCKET" != "None" ] || {
  echo "could not find the backup bucket - is the data stack deployed?"; exit 1;
}

mkdir -p "$DEST/archives" "$DEST/media"

log "Pulling archives to ${DEST}/archives"
aws s3 sync "s3://${BACKUP_BUCKET}/archives" "${DEST}/archives" --no-progress

log "Pulling photos to ${DEST}/media"
# No --delete anywhere in this script. A local copy that mirrors deletions is
# not a backup: it would faithfully reproduce the accident you are protecting
# against. Extra stale files here are harmless; missing ones are not.
aws s3 sync "s3://${MEDIA_BUCKET}/media" "${DEST}/media" --no-progress

# --- verify what actually arrived --------------------------------------------
log "Checking the copy"

LATEST="${DEST}/archives/latest.json"
if [ ! -f "$LATEST" ]; then
  echo "  FAIL: no latest.json - the nightly archive may never have run"
  echo "  try: ./deploy.sh archive"
  exit 1
fi

# Verified with the same module the Lambda uses, so "verified" means the same
# thing here as it does in the weekly email.
MM_LIB="$ARCHIVE_LIB" MM_LATEST="$LATEST" MM_MEDIA_DIR="${DEST}/media" node -e '
  const fs = require("fs");
  const path = require("path");
  const archiveLib = require(process.env.MM_LIB);

  let archive;
  try {
    archive = JSON.parse(fs.readFileSync(process.env.MM_LATEST, "utf8"));
  } catch (err) {
    console.log("  FAIL: latest.json is not readable JSON - " + err.message);
    process.exit(1);
  }

  const verification = archiveLib.verifyArchive(archive);
  if (!verification.ok) {
    console.log("  FAIL: " + verification.problems.join("; "));
    process.exit(1);
  }

  // Count photo files actually on disk, so the check covers the copy itself
  // and not merely the manifest describing it.
  const countFiles = (dir) => {
    let total = 0;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return 0; // no media pulled yet
    }
    for (const entry of entries) {
      total += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1;
    }
    return total;
  };

  const summary = archiveLib.summarizeArchive(archive);
  const onDisk = countFiles(process.env.MM_MEDIA_DIR);

  console.log(`  archive ok: ${summary.entries} entries, ${summary.words} words`);
  console.log(`  covering:   ${summary.earliest || "-"} to ${summary.latest || "-"}`);
  console.log(`  photos:     ${summary.photos} referenced, ${onDisk} files copied`);

  if (onDisk < summary.photos) {
    console.log(`  WARNING: ${summary.photos - onDisk} referenced photos are missing locally`);
    process.exit(1);
  }
'

SIZE="$(du -sh "$DEST" 2>/dev/null | cut -f1 || echo '?')"
log "Done - ${SIZE} at ${DEST}"
echo "  entries.json is plain JSON; photos are ordinary files."
echo "  Nothing here needs this app, or AWS, to read it."
