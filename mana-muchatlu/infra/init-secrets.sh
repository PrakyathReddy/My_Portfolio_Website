#!/usr/bin/env bash
#
# One-time setup: create the session secret and the member list in SSM.
#
# Run this before the first deploy. Passphrases are hashed locally with scrypt
# and only the hash leaves this machine - the plaintext is never stored, never
# logged, and never recoverable. If someone forgets theirs, re-run this script.
#
set -euo pipefail

PROJECT_NAME="${PROJECT_NAME:-mana-muchatlu}"
AWS_REGION="${AWS_REGION:-us-east-1}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v aws >/dev/null || { echo "aws CLI not found"; exit 1; }
command -v node >/dev/null || { echo "node not found"; exit 1; }

echo "Setting up secrets for ${PROJECT_NAME} in ${AWS_REGION}"
echo

# --- Session secret -----------------------------------------------------------
# 32 random bytes. Rotating this value invalidates every existing session,
# which is the app's only logout-everywhere button.
SESSION_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')"

aws ssm put-parameter \
  --region "$AWS_REGION" \
  --name "/${PROJECT_NAME}/session-secret" \
  --type SecureString \
  --value "$SESSION_SECRET" \
  --overwrite >/dev/null
echo "  /${PROJECT_NAME}/session-secret written"

# --- Members ------------------------------------------------------------------
read -rp "First member id (lowercase, no spaces) [prakyath]: " ID1
ID1="${ID1:-prakyath}"
read -rp "  Display name [Prakyath]: " NAME1
NAME1="${NAME1:-Prakyath}"
read -rp "  Accent colour (hex) [#4a6fa5]: " ACCENT1
ACCENT1="${ACCENT1:-#4a6fa5}"
read -rsp "  Passphrase for ${NAME1}: " PASS1; echo
[ -n "$PASS1" ] || { echo "passphrase cannot be empty"; exit 1; }

read -rp "Second member id [shivani]: " ID2
ID2="${ID2:-shivani}"
read -rp "  Display name [Shivani]: " NAME2
NAME2="${NAME2:-Shivani}"
read -rp "  Accent colour (hex) [#c2847a]: " ACCENT2
ACCENT2="${ACCENT2:-#c2847a}"
read -rsp "  Passphrase for ${NAME2}: " PASS2; echo
[ -n "$PASS2" ] || { echo "passphrase cannot be empty"; exit 1; }

# Hash in a child process and pass the plaintext via env rather than argv:
# argv is visible in `ps` to every other user on the machine.
MEMBERS_JSON="$(
  MM_AUTH_LIB="${HERE}/../api/lib/auth.js" \
  MM_ID1="$ID1" MM_NAME1="$NAME1" MM_ACCENT1="$ACCENT1" MM_PASS1="$PASS1" \
  MM_ID2="$ID2" MM_NAME2="$NAME2" MM_ACCENT2="$ACCENT2" MM_PASS2="$PASS2" \
  node -e '
    const { hashPassphrase } = require(process.env.MM_AUTH_LIB);

    const names = [1, 2].map((n) => String(process.env[`MM_NAME${n}`] || "").trim());

    // Two names starting with the same letter would give both people the same
    // avatar, which defeats the point of having avatars at all. Fall back to
    // two letters for both when the first letters collide - "Ba" and "Bu"
    // rather than "B" and "B".
    const first = (name) => name.slice(0, 1).toUpperCase();
    const collide = names[0] && first(names[0]) === first(names[1]);
    const initials = (name) => collide
      ? (name.slice(0, 1).toUpperCase() + name.slice(1, 2).toLowerCase())
      : first(name);

    const members = [1, 2].map((n) => ({
      id: process.env[`MM_ID${n}`],
      name: names[n - 1],
      initials: initials(names[n - 1]),
      accent: process.env[`MM_ACCENT${n}`],
      passphraseHash: hashPassphrase(process.env[`MM_PASS${n}`]),
    }));
    process.stdout.write(JSON.stringify(members));
  '
)"

aws ssm put-parameter \
  --region "$AWS_REGION" \
  --name "/${PROJECT_NAME}/members" \
  --type SecureString \
  --value "$MEMBERS_JSON" \
  --overwrite >/dev/null
echo "  /${PROJECT_NAME}/members written (${ID1}, ${ID2})"

unset PASS1 PASS2 MEMBERS_JSON SESSION_SECRET

echo
echo "Done. Next: ./deploy.sh"
