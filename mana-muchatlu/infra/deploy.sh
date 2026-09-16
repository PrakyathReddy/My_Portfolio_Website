#!/usr/bin/env bash
#
# Deploy Mana Muchatlu end to end. Idempotent - safe to re-run.
#
#   ./deploy.sh              full deploy (infra + api + web)
#   ./deploy.sh web          frontend only (the common case while iterating)
#   ./deploy.sh api          lambda code + config only
#   ./deploy.sh archive      run the backup now and report what it wrote
#   ./deploy.sh report       send the weekly note now, without waiting for Sunday
#
set -euo pipefail

PROJECT_NAME="${PROJECT_NAME:-mana-muchatlu}"
DOMAIN_NAME="${DOMAIN_NAME:-mana-muchatlu-shivani.prakyath.dev}"
AWS_REGION="${AWS_REGION:-us-east-1}" # CloudFront requires us-east-1 certs
APEX_DOMAIN="${APEX_DOMAIN:-prakyath.dev}"
# Where the weekly report goes. SNS emails a confirmation link the first time.
NOTIFY_EMAIL="${NOTIFY_EMAIL:-}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"
BUILD_DIR="${ROOT}/.build"

DATA_STACK="${PROJECT_NAME}-data"
WEB_STACK="${PROJECT_NAME}-web"

# zsh does not strip "#" comments in interactive shells by default, so a
# pasted `./deploy.sh   # some note` arrives with "#" as argv[1]. Without this
# the script prints usage and exits, which scrolls past unnoticed and looks
# exactly like a deploy that ran and changed nothing.
case "${1:-}" in
  '#'*) set -- ;;
esac

TARGET="${1:-all}"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

stack_output() {
  aws cloudformation describe-stacks \
    --region "$AWS_REGION" --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" \
    --output text 2>/dev/null
}

require_tools() {
  for tool in aws node zip; do
    command -v "$tool" >/dev/null || { echo "required tool not found: $tool"; exit 1; }
  done
  aws sts get-caller-identity >/dev/null || { echo "AWS credentials not configured"; exit 1; }
}

# -----------------------------------------------------------------------------
deploy_data_stack() {
  log "Deploying data stack (DynamoDB, buckets, Lambda)"
  aws cloudformation deploy \
    --region "$AWS_REGION" \
    --stack-name "$DATA_STACK" \
    --template-file "${HERE}/data-stack.yaml" \
    --capabilities CAPABILITY_IAM \
    --no-fail-on-empty-changeset \
    --parameter-overrides \
      "ProjectName=${PROJECT_NAME}" \
      "AllowedOrigin=https://${DOMAIN_NAME}" \
      "NotifyEmail=${NOTIFY_EMAIL}"
}

configure_public_access() {
  # Lambda's public-access block, added by AWS in 2025, sits above the
  # resource-based policy: with RestrictPublicResource=true the function URL
  # is blocked even though the policy allows it, and the request is refused
  # before the handler runs so CloudWatch stays empty. Both settings default
  # to true on new functions, and there is no CloudFormation resource for
  # them yet - hence doing it here rather than in the template.
  #
  # This is what makes the journal reachable from a browser at all. The
  # passphrase is the gate; see README for why that is the right trade here.
  log "Allowing public access to the function URL"

  local fn_arn
  fn_arn="$(aws lambda get-function-configuration --region "$AWS_REGION" \
    --function-name "${PROJECT_NAME}-api" --query 'FunctionArn' --output text 2>/dev/null)"

  if [ -z "$fn_arn" ] || [ "$fn_arn" = "None" ]; then
    echo "  could not resolve the function ARN - is the data stack deployed?"
    return 0
  fi

  if aws lambda put-public-access-block-config \
       --region "$AWS_REGION" \
       --resource-arn "$fn_arn" \
       --public-access-block-config "BlockPublicPolicy=false,RestrictPublicResource=false" \
       >/dev/null 2>&1; then
    echo "  public access allowed on ${fn_arn}"
  else
    # Not every aws CLI knows this command - the API has come and gone from
    # the SDKs. Its absence is fine; the resource-based policy is what
    # actually governs the URL. Never fail the deploy over it.
    echo "  (skipped: this aws CLI has no put-public-access-block-config)"
  fi

  return 0
}

deploy_api_code() {
  log "Packaging API"
  rm -rf "$BUILD_DIR" && mkdir -p "$BUILD_DIR"
  cp -r "${ROOT}/api/index.js" "${ROOT}/api/archive.js" "${ROOT}/api/lib" "$BUILD_DIR/"

  # One bundle, two handlers: the API and the archive share every lib they use,
  # so shipping them together keeps the two from drifting apart.
  #
  # No node_modules: the handlers use only Node built-ins plus the AWS SDK
  # that the Lambda runtime already ships. The artifact is a few KB, so cold
  # starts stay in the low tens of milliseconds.
  (cd "$BUILD_DIR" && zip -qr "${BUILD_DIR}/api.zip" index.js archive.js lib)

  log "Uploading API code"
  aws lambda update-function-code \
    --region "$AWS_REGION" \
    --function-name "${PROJECT_NAME}-api" \
    --zip-file "fileb://${BUILD_DIR}/api.zip" \
    --output text --query 'LastModified'

  aws lambda wait function-updated \
    --region "$AWS_REGION" --function-name "${PROJECT_NAME}-api"

  log "Injecting secrets from SSM into the function config"
  local session_secret members table_name media_bucket
  session_secret="$(aws ssm get-parameter --region "$AWS_REGION" \
    --name "/${PROJECT_NAME}/session-secret" --with-decryption \
    --query 'Parameter.Value' --output text)"
  members="$(aws ssm get-parameter --region "$AWS_REGION" \
    --name "/${PROJECT_NAME}/members" --with-decryption \
    --query 'Parameter.Value' --output text)"
  table_name="$(stack_output "$DATA_STACK" TableName)"
  media_bucket="$(stack_output "$DATA_STACK" MediaBucketName)"

  # --environment carries the secrets, so send it via a temp file with tight
  # permissions rather than argv, which is world-readable through `ps`.
  local env_file
  env_file="$(mktemp)"
  chmod 600 "$env_file"
  # shellcheck disable=SC2064
  trap "rm -f '$env_file'" RETURN

  MM_SECRET="$session_secret" MM_MEMBERS="$members" MM_TABLE="$table_name" \
  MM_MEDIA="$media_bucket" MM_COUPLE="${COUPLE_ID:-mana}" MM_ORIGIN="https://${DOMAIN_NAME}" \
  node -e '
    process.stdout.write(JSON.stringify({ Variables: {
      TABLE_NAME: process.env.MM_TABLE,
      MEDIA_BUCKET: process.env.MM_MEDIA,
      COUPLE_ID: process.env.MM_COUPLE,
      ALLOWED_ORIGIN: process.env.MM_ORIGIN,
      SESSION_SECRET: process.env.MM_SECRET,
      MEMBERS: process.env.MM_MEMBERS,
    }}));
  ' > "$env_file"

  aws lambda update-function-configuration \
    --region "$AWS_REGION" \
    --function-name "${PROJECT_NAME}-api" \
    --environment "file://${env_file}" \
    --output text --query 'LastModified'

  aws lambda wait function-updated \
    --region "$AWS_REGION" --function-name "${PROJECT_NAME}-api"

  # --- archive function: same bytes, its own configuration -----------------
  log "Uploading archive code"
  aws lambda update-function-code \
    --region "$AWS_REGION" \
    --function-name "${PROJECT_NAME}-archive" \
    --zip-file "fileb://${BUILD_DIR}/api.zip" \
    --output text --query 'LastModified'

  aws lambda wait function-updated \
    --region "$AWS_REGION" --function-name "${PROJECT_NAME}-archive"

  # The archive needs the member list for names in the report. It writes only
  # publicMembers() into the snapshot, so no hash reaches the backup - there
  # is a test asserting exactly that.
  local archive_env backup_bucket topic_arn
  backup_bucket="$(stack_output "$DATA_STACK" BackupBucketName)"
  topic_arn="$(stack_output "$DATA_STACK" ReportTopicArn)"

  archive_env="$(mktemp)"
  chmod 600 "$archive_env"
  # shellcheck disable=SC2064
  trap "rm -f '$env_file' '$archive_env'" RETURN

  MM_MEMBERS="$members" MM_TABLE="$table_name" MM_BACKUP="$backup_bucket" \
  MM_MEDIA="$media_bucket" MM_COUPLE="${COUPLE_ID:-mana}" MM_TOPIC="$topic_arn" \
  node -e '
    process.stdout.write(JSON.stringify({ Variables: {
      TABLE_NAME: process.env.MM_TABLE,
      BACKUP_BUCKET: process.env.MM_BACKUP,
      MEDIA_BUCKET: process.env.MM_MEDIA,
      COUPLE_ID: process.env.MM_COUPLE,
      TOPIC_ARN: process.env.MM_TOPIC,
      MEMBERS: process.env.MM_MEMBERS,
    }}));
  ' > "$archive_env"

  aws lambda update-function-configuration \
    --region "$AWS_REGION" \
    --function-name "${PROJECT_NAME}-archive" \
    --environment "file://${archive_env}" \
    --output text --query 'LastModified'

  aws lambda wait function-updated \
    --region "$AWS_REGION" --function-name "${PROJECT_NAME}-archive"
}

# Run the backup once, now, rather than finding out at 03:10 whether it works.
# An untested backup is a rumour; this turns the deploy itself into the test.
verify_archive() {
  log "Running the archive once to prove it works"

  local out
  out="$(mktemp)"
  # shellcheck disable=SC2064
  trap "rm -f '$out'" RETURN

  if aws lambda invoke \
       --region "$AWS_REGION" \
       --function-name "${PROJECT_NAME}-archive" \
       --payload '{"job":"archive"}' \
       --cli-binary-format raw-in-base64-out \
       "$out" --output text --query 'FunctionError' 2>/dev/null | grep -q 'Unhandled'; then
    echo "  ARCHIVE FAILED:"
    sed 's/^/    /' "$out"
    echo "  logs: aws logs tail /aws/lambda/${PROJECT_NAME}-archive --region ${AWS_REGION} --since 10m"
    return 1
  fi

  echo "  $(cat "$out")"
}

deploy_web_stack() {
  log "Resolving hosted zone for ${APEX_DOMAIN}"
  local zone_id
  zone_id="$(aws route53 list-hosted-zones-by-name \
    --dns-name "${APEX_DOMAIN}." \
    --query "HostedZones[?Name=='${APEX_DOMAIN}.'].Id | [0]" \
    --output text | sed 's|/hostedzone/||')"

  [ -n "$zone_id" ] && [ "$zone_id" != "None" ] || {
    echo "No Route53 hosted zone found for ${APEX_DOMAIN}"; exit 1;
  }
  echo "  zone: ${zone_id}"

  log "Deploying web stack (S3, CloudFront, ACM, Route53)"
  echo "  First run issues an ACM certificate - this can take 5-30 minutes"
  echo "  while DNS validation propagates. Later runs are fast."
  aws cloudformation deploy \
    --region "$AWS_REGION" \
    --stack-name "$WEB_STACK" \
    --template-file "${HERE}/web-stack.yaml" \
    --no-fail-on-empty-changeset \
    --parameter-overrides \
      "ProjectName=${PROJECT_NAME}" \
      "DomainName=${DOMAIN_NAME}" \
      "HostedZoneId=${zone_id}"
}

publish_web() {
  local api_endpoint site_bucket distribution_id
  api_endpoint="$(stack_output "$DATA_STACK" ApiEndpoint)"
  site_bucket="$(stack_output "$WEB_STACK" SiteBucketName)"
  distribution_id="$(stack_output "$WEB_STACK" DistributionId)"

  [ -n "$api_endpoint" ] || { echo "data stack not deployed yet"; exit 1; }
  [ -n "$site_bucket" ] || { echo "web stack not deployed yet"; exit 1; }

  log "Writing config.js"
  # Generated, not committed: the endpoint is an output of the data stack, so
  # keeping a copy in git would be a second source of truth that goes stale.
  cat > "${ROOT}/web/config.js" <<EOF
// Generated by infra/deploy.sh - do not edit, do not commit.
window.MANA_CONFIG = {
  apiBase: '${api_endpoint%/}',
};
EOF

  log "Syncing web/ to ${site_bucket}"
  # Hashed-forever assets could be cached longer, but the whole app is ~40KB;
  # the edge-level no-cache behaviours in web-stack.yaml handle the shell.
  aws s3 sync "${ROOT}/web" "s3://${site_bucket}" --delete \
    --cache-control 'public, max-age=300'

  log "Invalidating CloudFront"
  aws cloudfront create-invalidation \
    --distribution-id "$distribution_id" \
    --paths '/*' \
    --output text --query 'Invalidation.Id'

  log "Live at https://${DOMAIN_NAME}"
}

# Fire the weekly note on demand. Useful once, to confirm the mail actually
# arrives - an unconfirmed SNS subscription delivers nothing and says nothing.
send_report() {
  log "Sending the weekly report now"

  local out
  out="$(mktemp)"
  # shellcheck disable=SC2064
  trap "rm -f '$out'" RETURN

  aws lambda invoke \
    --region "$AWS_REGION" \
    --function-name "${PROJECT_NAME}-archive" \
    --payload '{"job":"report"}' \
    --cli-binary-format raw-in-base64-out \
    "$out" --output text --query 'FunctionError' >/dev/null 2>&1 || true

  echo "  $(cat "$out")"
  echo "  If no mail arrives, the subscription is probably unconfirmed - run ./doctor.sh"
}

# -----------------------------------------------------------------------------
require_tools

case "$TARGET" in
  all)
    deploy_data_stack
    deploy_api_code
    configure_public_access
    verify_archive
    deploy_web_stack
    publish_web
    ;;
  api)
    deploy_api_code
    configure_public_access
    verify_archive
    ;;
  archive)
    verify_archive
    ;;
  report)
    send_report
    ;;
  web)
    publish_web
    ;;
  *)
    echo
    echo "  Nothing was deployed: '${TARGET}' is not a valid target."
    echo "  usage: $0 [all|api|web|archive|report]   (default: all)"
    echo
    exit 1
    ;;
esac
