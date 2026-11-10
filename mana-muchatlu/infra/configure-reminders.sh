#!/usr/bin/env bash
# One daily rule for the existing API. Never redeploy the data stack or its secrets.
set -euo pipefail
PROJECT_NAME="${PROJECT_NAME:-mana-muchatlu}"
AWS_REGION="${AWS_REGION:-us-east-1}"
RULE_NAME="${PROJECT_NAME}-nightly-reminder"
FUNCTION_NAME="${PROJECT_NAME}-api"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT
chmod 700 "$TEMP_DIR"

function_arn="$(aws lambda get-function-configuration --region "$AWS_REGION" \
  --function-name "$FUNCTION_NAME" --query 'FunctionArn' --output text)"
[ -n "$function_arn" ] && [ "$function_arn" != 'None' ] || { echo 'Missing API function'; exit 1; }
# India has no daylight-saving shift: 16:00 UTC is 21:30 Asia/Kolkata year-round.
rule_arn="$(aws events put-rule --region "$AWS_REGION" --name "$RULE_NAME" \
  --description 'Mana Muchatlu nightly journal reminder at 21:30 Asia/Kolkata' \
  --schedule-expression 'cron(0 16 * * ? *)' --state ENABLED --query 'RuleArn' --output text)"
[ -n "$rule_arn" ] && [ "$rule_arn" != 'None' ] || { echo 'Missing reminder rule ARN'; exit 1; }

if ! aws lambda add-permission --region "$AWS_REGION" --function-name "$FUNCTION_NAME" \
    --statement-id ManaNightlyReminder --action lambda:InvokeFunction \
    --principal events.amazonaws.com --source-arn "$rule_arn" \
    > /dev/null 2> "$TEMP_DIR/permission-error"; then
  if ! grep -q 'ResourceConflictException' "$TEMP_DIR/permission-error"; then
    cat "$TEMP_DIR/permission-error" >&2; exit 1
  fi
  # Idempotent only if the existing permission is scoped to this exact rule.
  aws lambda get-policy --region "$AWS_REGION" --function-name "$FUNCTION_NAME" \
    --query Policy --output text > "$TEMP_DIR/policy.json"
  node - "$TEMP_DIR/policy.json" "$rule_arn" <<'JS'
const fs = require('fs');
const statement = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).Statement.find(s => s.Sid === 'ManaNightlyReminder');
const sourceArn = ['ArnLike', 'ArnEquals', 'StringLike', 'StringEquals'].map(operator => statement?.Condition?.[operator]?.['AWS:SourceArn']).find(Boolean);
if (!statement || statement.Principal?.Service !== 'events.amazonaws.com' || statement.Action !== 'lambda:InvokeFunction' ||
    sourceArn !== process.argv[3]) throw new Error('Existing reminder permission has an unexpected scope');
JS
fi

node - "$function_arn" > "$TEMP_DIR/targets.json" <<'JS'
process.stdout.write(JSON.stringify([{ Id: 'nightly-reminder', Arn: process.argv[2],
  RetryPolicy: { MaximumEventAgeInSeconds: 900, MaximumRetryAttempts: 2 } }]));
JS
failed="$(aws events put-targets --region "$AWS_REGION" --rule "$RULE_NAME" \
  --targets "file://$TEMP_DIR/targets.json" --query 'FailedEntryCount' --output text)"
[ "$failed" = '0' ] || { echo 'Could not attach reminder target'; exit 1; }

actual_schedule="$(aws events describe-rule --region "$AWS_REGION" --name "$RULE_NAME" --query 'ScheduleExpression' --output text)"
actual_target="$(aws events list-targets-by-rule --region "$AWS_REGION" --rule "$RULE_NAME" \
  --query "Targets[?Id=='nightly-reminder'].Arn | [0]" --output text)"
[ "$actual_schedule" = 'cron(0 16 * * ? *)' ] && [ "$actual_target" = "$function_arn" ] || { echo 'Reminder schedule verification failed'; exit 1; }

# A direct IAM-only probe loads the actual production library and derives only
# public configuration. It does not send a notification or touch journal data.
function_error="$(aws lambda invoke --region "$AWS_REGION" --function-name "$FUNCTION_NAME" \
  --payload '{"job":"reminder-health"}' --cli-binary-format raw-in-base64-out \
  "$TEMP_DIR/health.json" --query 'FunctionError' --output text)"
[ "$function_error" = 'None' ] || [ "$function_error" = 'null' ] || [ -z "$function_error" ] || { echo 'Reminder runtime probe failed'; exit 1; }
node - "$TEMP_DIR/health.json" <<'JS'
const health = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
if (!health.ok || health.messageCount < 30 || health.schedule?.time !== '21:30' || health.schedule?.timeZone !== 'Asia/Kolkata' || !health.publicKey) {
  throw new Error('Reminder runtime is not configured correctly');
}
JS
printf 'Nightly reminders verified: 9:30 PM Asia/Kolkata; 60 rotating messages.\n'
