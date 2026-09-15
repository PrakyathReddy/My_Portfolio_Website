#!/usr/bin/env bash
#
# Diagnose a Mana Muchatlu deployment.
#
#   ./doctor.sh
#
# Read-only: it inspects and reports, it never changes anything. Each check
# says what it found and, when something is wrong, the single command that
# fixes it. Written because "cannot reach the journal" has about six possible
# causes and guessing between them over chat is slow.
#
set -uo pipefail   # deliberately no -e: a failing check must not stop the rest

PROJECT_NAME="${PROJECT_NAME:-mana-muchatlu}"
DOMAIN_NAME="${DOMAIN_NAME:-mana-muchatlu-shivani.prakyath.dev}"
AWS_REGION="${AWS_REGION:-us-east-1}"

DATA_STACK="${PROJECT_NAME}-data"
WEB_STACK="${PROJECT_NAME}-web"

pass() { printf '  \033[32mok\033[0m    %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; PROBLEMS=$((PROBLEMS + 1)); }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$*"; }
note() { printf '        %s\n' "$*"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$*"; }

PROBLEMS=0

stack_output() {
  aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text 2>/dev/null
}

stack_status() {
  aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name "$1" \
    --query 'Stacks[0].StackStatus' --output text 2>/dev/null
}

# --- Prerequisites ------------------------------------------------------------
head_ "Prerequisites"

if command -v aws >/dev/null; then pass "aws CLI found"; else fail "aws CLI not installed"; exit 1; fi

if account="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)"; then
  pass "AWS credentials valid (account ${account}, region ${AWS_REGION})"
else
  fail "AWS credentials not working"
  note "fix: configure credentials, then re-run"
  exit 1
fi

# --- Secrets ------------------------------------------------------------------
head_ "SSM parameters"

for param in session-secret members; do
  if aws ssm get-parameter --region "$AWS_REGION" --name "/${PROJECT_NAME}/${param}" \
       --with-decryption >/dev/null 2>&1; then
    pass "/${PROJECT_NAME}/${param} exists"
  else
    fail "/${PROJECT_NAME}/${param} is missing"
    note "fix: ./init-secrets.sh"
  fi
done

members_json="$(aws ssm get-parameter --region "$AWS_REGION" --name "/${PROJECT_NAME}/members" \
  --with-decryption --query 'Parameter.Value' --output text 2>/dev/null)"
if [ -n "$members_json" ] && [ "$members_json" != "None" ]; then
  member_count="$(printf '%s' "$members_json" | node -pe \
    'try { JSON.parse(require("fs").readFileSync(0,"utf8")).length } catch (e) { "invalid" }' 2>/dev/null)"
  if [ "$member_count" = "2" ]; then
    pass "members parameter lists 2 people"
  else
    fail "members parameter lists ${member_count} people (expected 2)"
    note "fix: ./init-secrets.sh"
  fi
fi

# --- Stacks -------------------------------------------------------------------
head_ "CloudFormation stacks"

for stack in "$DATA_STACK" "$WEB_STACK"; do
  status="$(stack_status "$stack")"
  if [ -z "$status" ]; then
    fail "${stack} does not exist"
    note "fix: ./deploy.sh"
  elif [[ "$status" == *COMPLETE ]] && [[ "$status" != *ROLLBACK* ]]; then
    pass "${stack} is ${status}"
  else
    fail "${stack} is ${status}"
    note "look at: aws cloudformation describe-stack-events --stack-name ${stack} --region ${AWS_REGION} --max-items 20"
  fi
done

# --- Lambda -------------------------------------------------------------------
head_ "API Lambda"

fn="${PROJECT_NAME}-api"
if config="$(aws lambda get-function-configuration --region "$AWS_REGION" \
     --function-name "$fn" --output json 2>/dev/null)"; then
  pass "function ${fn} exists"

  size="$(printf '%s' "$config" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).CodeSize')"
  if [ "$size" -lt 1000 ]; then
    fail "code is ${size} bytes - that is still the CloudFormation placeholder"
    note "fix: ./deploy.sh api"
  else
    pass "code is ${size} bytes (real handler deployed)"
  fi

  for var in TABLE_NAME SESSION_SECRET MEMBERS ALLOWED_ORIGIN; do
    present="$(printf '%s' "$config" | MM_VAR="$var" node -pe \
      'const c = JSON.parse(require("fs").readFileSync(0,"utf8"));
       const v = (c.Environment && c.Environment.Variables) || {};
       v[process.env.MM_VAR] ? "yes" : "no"')"
    if [ "$present" = "yes" ]; then
      pass "env ${var} is set"
    else
      fail "env ${var} is NOT set"
      note "fix: ./deploy.sh api   (it injects these from SSM)"
    fi
  done

  origin="$(printf '%s' "$config" | node -pe \
    'const c = JSON.parse(require("fs").readFileSync(0,"utf8"));
     ((c.Environment && c.Environment.Variables) || {}).ALLOWED_ORIGIN || ""')"
  if [ -n "$origin" ] && [ "$origin" != "https://${DOMAIN_NAME}" ]; then
    fail "ALLOWED_ORIGIN is ${origin}, but the site is https://${DOMAIN_NAME}"
    note "a mismatch here is a CORS failure in the browser and nothing in the logs"
    note "fix: ./deploy.sh api"
  fi
else
  fail "function ${fn} not found"
  note "fix: ./deploy.sh"
fi

# --- Function URL authorization -----------------------------------------------
# A Function URL rejects with a bare "Forbidden" when either of two things is
# wrong, and the message does not say which: the URL's own AuthType, or the
# function's resource-based policy. Neither is visible in CloudWatch, because
# the request never reaches the handler. So check both explicitly.
head_ "Function URL authorization"

if url_config="$(aws lambda get-function-url-config --region "$AWS_REGION" \
     --function-name "$fn" --output json 2>/dev/null)"; then
  auth_type="$(printf '%s' "$url_config" | node -pe \
    'JSON.parse(require("fs").readFileSync(0,"utf8")).AuthType')"
  if [ "$auth_type" = "NONE" ]; then
    pass "AuthType is NONE (the app's own passphrase is the gate)"
  else
    fail "AuthType is ${auth_type}, so the browser cannot call it unsigned"
    note "fix: aws lambda update-function-url-config --function-name ${fn} \\"
    note "       --region ${AWS_REGION} --auth-type NONE"
  fi

  cors_origins="$(printf '%s' "$url_config" | node -pe \
    'const c = JSON.parse(require("fs").readFileSync(0,"utf8"));
     ((c.Cors && c.Cors.AllowOrigins) || []).join(",")')"
  if [ -n "$cors_origins" ]; then
    pass "CORS allows: ${cors_origins}"
  else
    warn "no CORS origins configured on the Function URL"
  fi
else
  fail "no Function URL configured on ${fn}"
fi

if policy="$(aws lambda get-policy --region "$AWS_REGION" \
     --function-name "$fn" --query Policy --output text 2>/dev/null)"; then
  invoke_ok="$(printf '%s' "$policy" | node -pe '
    const raw = require("fs").readFileSync(0, "utf8");
    let doc;
    try { doc = JSON.parse(raw); } catch (e) { console.log("unparseable"); process.exit(0); }
    const statements = [].concat(doc.Statement || []);
    const good = statements.some((s) => {
      const actions = [].concat(s.Action || []);
      const authType = ((s.Condition || {}).StringEquals || {})["lambda:FunctionUrlAuthType"];
      return s.Effect === "Allow"
        && actions.includes("lambda:InvokeFunctionUrl")
        && authType === "NONE";
    });
    good ? "yes" : "no";
  ')"
  # Since October 2025 a new function URL needs lambda:InvokeFunction too.
  # Granting only InvokeFunctionUrl produces a Forbidden with empty logs.
  invoke_fn_ok="$(printf '%s' "$policy" | node -pe '
    const raw = require("fs").readFileSync(0, "utf8");
    let doc;
    try { doc = JSON.parse(raw); } catch (e) { console.log("no"); process.exit(0); }
    const statements = [].concat(doc.Statement || []);
    const good = statements.some((s) => {
      const actions = [].concat(s.Action || []);
      const authType = ((s.Condition || {}).StringEquals || {})["lambda:FunctionUrlAuthType"];
      return s.Effect === "Allow"
        && actions.includes("lambda:InvokeFunction")
        && authType === "NONE";
    });
    good ? "yes" : "no";
  ')"
  if [ "$invoke_fn_ok" = "yes" ]; then
    pass "resource policy allows public InvokeFunction"
  else
    fail "resource policy is missing lambda:InvokeFunction"
    note "function URLs created after October 2025 need both InvokeFunctionUrl"
    note "and InvokeFunction; with only the first the URL returns Forbidden"
    note "before the handler runs, so CloudWatch shows nothing."
    note "fix: aws lambda add-permission --function-name ${fn} --region ${AWS_REGION} \\"
    note "       --statement-id FunctionUrlPublicInvoke \\"
    note "       --action lambda:InvokeFunction --principal '*' \\"
    note "       --function-url-auth-type NONE"
  fi

  if [ "$invoke_ok" = "yes" ]; then
    pass "resource policy allows public InvokeFunctionUrl"
  else
    fail "resource policy does NOT allow public InvokeFunctionUrl"
    note "fix: aws lambda add-permission --function-name ${fn} --region ${AWS_REGION} \\"
    note "       --statement-id FunctionUrlPublicAccess \\"
    note "       --action lambda:InvokeFunctionUrl --principal '*' \\"
    note "       --function-url-auth-type NONE"
  fi
else
  fail "the function has NO resource-based policy at all"
  note "this is the usual cause of a bare Forbidden from a Function URL"
  note "fix: aws lambda add-permission --function-name ${fn} --region ${AWS_REGION} \\"
  note "       --statement-id FunctionUrlPublicAccess \\"
  note "       --action lambda:InvokeFunctionUrl --principal '*' \\"
  note "       --function-url-auth-type NONE"
fi

# --- Public access block ------------------------------------------------------
# This sits ABOVE the resource policy. RestrictPublicResource=true blocks the
# URL even when the policy allows it, and both settings default to true on
# functions created since 2025. There is no CloudFormation resource for it, so
# a perfectly correct template still produces a dead endpoint.
head_ "Lambda public access block"

fn_arn="$(aws lambda get-function-configuration --region "$AWS_REGION" \
  --function-name "$fn" --query FunctionArn --output text 2>/dev/null)"

if [ -n "$fn_arn" ] && [ "$fn_arn" != "None" ]; then
  if pab="$(aws lambda get-public-access-block-config --region "$AWS_REGION" \
       --resource-arn "$fn_arn" --output json 2>/dev/null)"; then
    restrict="$(printf '%s' "$pab" | node -pe \
      'const c = JSON.parse(require("fs").readFileSync(0,"utf8"));
       String(((c.PublicAccessBlockConfig) || c).RestrictPublicResource)')"
    block_policy="$(printf '%s' "$pab" | node -pe \
      'const c = JSON.parse(require("fs").readFileSync(0,"utf8"));
       String(((c.PublicAccessBlockConfig) || c).BlockPublicPolicy)')"

    if [ "$restrict" = "false" ]; then
      pass "RestrictPublicResource is false (the URL may serve the public)"
    else
      fail "RestrictPublicResource is ${restrict} - this blocks the URL outright"
      note "it overrides the resource policy, and the request never reaches"
      note "your code, so there is nothing in CloudWatch to find."
      note "fix: aws lambda put-public-access-block-config --region ${AWS_REGION} \\"
      note "       --resource-arn ${fn_arn} \\"
      note "       --public-access-block-config BlockPublicPolicy=false,RestrictPublicResource=false"
    fi

    if [ "$block_policy" = "false" ]; then
      pass "BlockPublicPolicy is false (public statements may be attached)"
    else
      warn "BlockPublicPolicy is ${block_policy} - new public policy statements will be refused"
    fi
  else
    warn "could not read the public access block config"
    note "if your aws CLI predates late 2024 it will not know this command:"
    note "  aws --version"
  fi
fi

# --- Live endpoints -----------------------------------------------------------
head_ "Live endpoints"

api_endpoint="$(stack_output "$DATA_STACK" ApiEndpoint)"
if [ -n "$api_endpoint" ] && [ "$api_endpoint" != "None" ]; then
  pass "API endpoint: ${api_endpoint}"

  health="$(curl -sS --max-time 15 "${api_endpoint%/}/health" 2>&1)"
  if printf '%s' "$health" | grep -q '"ok":true'; then
    pass "GET /health -> ${health}"
    if printf '%s' "$health" | grep -q '"members":0'; then
      fail "the API reports 0 members, so nobody can sign in"
      note "fix: ./init-secrets.sh && ./deploy.sh api"
    fi
  else
    fail "GET /health did not answer as expected"
    note "got: ${health}"
    note "logs: aws logs tail /aws/lambda/${fn} --region ${AWS_REGION} --since 30m"
  fi

  members_response="$(curl -sS --max-time 15 "${api_endpoint%/}/members" 2>&1)"
  if printf '%s' "$members_response" | grep -q '"members"'; then
    pass "GET /members -> ${members_response}"
  else
    fail "GET /members failed"
    note "got: ${members_response}"
  fi
else
  fail "no ApiEndpoint output on ${DATA_STACK}"
fi

# --- The deployed frontend ----------------------------------------------------
head_ "Deployed frontend"

site_config="$(curl -sS --max-time 15 "https://${DOMAIN_NAME}/config.js" 2>&1)"
if printf '%s' "$site_config" | grep -q 'apiBase'; then
  pass "config.js is published: $(printf '%s' "$site_config" | tr -d '\n' | tail -c 120)"
  if [ -n "$api_endpoint" ] && ! printf '%s' "$site_config" | grep -qF "${api_endpoint%/}"; then
    fail "config.js points somewhere other than the current API endpoint"
    note "fix: ./deploy.sh web"
  fi
else
  fail "config.js is missing or wrong on the live site"
  note "got: ${site_config}"
  note "fix: ./deploy.sh web"
fi

if curl -sS --max-time 15 "https://${DOMAIN_NAME}/" 2>/dev/null | grep -q 'wordmark-en'; then
  warn "the live page still has the old romanised wordmark"
  note "the deployed frontend predates the current commit"
  note "fix: ./deploy.sh web"
else
  pass "live page matches the current frontend"
fi

# --- Summary ------------------------------------------------------------------
if [ "$PROBLEMS" -eq 0 ]; then
  printf '\n\033[32mEverything checks out.\033[0m https://%s\n\n' "$DOMAIN_NAME"
else
  printf '\n\033[31m%d problem(s) found.\033[0m Work through the fixes above, top to bottom.\n\n' "$PROBLEMS"
fi
exit 0
