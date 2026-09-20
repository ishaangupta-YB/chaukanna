#!/usr/bin/env bash
# Refuses a commit that would publish a secret, a private file, or a real account identifier.
# This repository is public. Run by .githooks/pre-commit, and usable on its own:
#   scripts/check-staged.sh            # what is staged now
#   scripts/check-staged.sh <ref>      # every file a ref introduced
set -uo pipefail

fail=0
note() { printf '  %s\n' "$1"; }
reject() { printf 'BLOCKED %s\n' "$1"; fail=1; }

if [ $# -ge 1 ]; then
  files=$(git diff-tree --no-commit-id --name-only -r "$1")
  show() { git show "$1:$2" 2>/dev/null; }
  ref=$1
else
  files=$(git diff --cached --name-only --diff-filter=ACMR)
  show() { git show ":$2" 2>/dev/null; }
  ref=""
fi

# 1. Paths that must never enter the public repository.
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    docs/*)                  reject "$f"; note "private project docs" ;;
    *.pem|*.key|*.cert|*.crt) reject "$f"; note "key or certificate material" ;;
    apps/agent/runs/*)       reject "$f"; note "local drill recording, may hold transcript text" ;;
    .env|.env.local|.env.*.local|.env.production|.env.staging)
                             reject "$f"; note "environment file with real values" ;;
  esac
done <<< "$files"

# 2. Secret material and real account identifiers inside the content being committed.
#    Patterns only: no real value of ours is ever written into this file.
secrets='AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|aws_secret_access_key|BEGIN [A-Z ]*PRIVATE KEY|xox[baprs]-[0-9A-Za-z-]{10}|gh[pous]_[A-Za-z0-9]{20}|arn:aws:[a-z0-9-]*:[a-z0-9-]*:[0-9]{12}:'
# The two account numbers AWS itself uses in documentation. Tests and comments need a realistic
# ARN to be worth reading, and these belong to nobody. Every other twelve digit account still
# trips the rule above.
placeholder_accounts=':(123456789012|000000000000):'
while IFS= read -r f; do
  [ -z "$f" ] && continue
  # The guard itself spells out the patterns it looks for.
  case "$f" in
    scripts/check-staged.sh) continue ;;
    *.lock|*lock.json|*.pcm|*.wav|*.png|*.ico) continue ;;
  esac
  content=$(show "$ref" "$f") || continue
  hit=$(printf '%s' "$content" | grep -oIE "$secrets" | grep -vE "$placeholder_accounts" | head -1)
  if [ -n "$hit" ]; then
    reject "$f"
    note "matches a secret or account-id pattern: $(printf '%s' "$hit" | cut -c1-12)…"
  fi
  # A filled-in template is the easiest way to leak pool ids by accident.
  case "$f" in
    *.env.example|.env.example)
      if printf '%s' "$content" | grep -qE '^(USER_POOL_ID|USER_POOL_CLIENT_ID|ARTIFACTS_BUCKET|COGNITO_DOMAIN|POLICY_STORE_ID|AGENT_RUNTIME_ARN|FAL_KEY)=.+'; then
        reject "$f"
        note "template carries a real value; keep deployed ids in .env.local"
      fi ;;
  esac
done <<< "$files"

# 3. A source file that .gitignore silently swallows never reaches the deploy.
for dir in apps services infra fixtures scripts; do
  [ -d "$dir" ] || continue
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    case "$f" in
      # Dependencies, caches and generated output are ignored on purpose.
      */node_modules/*|*/.venv/*|*/__pycache__/*|*/.pytest_cache/*|*/.ruff_cache/*) continue ;;
      */cdk.out/*|*/.next/*|*/dist/*|*/build/*|*/htmlcov/*|*/coverage/*) continue ;;
      *cdk-outputs.json|*next-env.d.ts|apps/agent/runs/*) continue ;;
    esac
    reject "$f"
    note "source file is ignored by .gitignore and would never be deployed"
  done <<< "$(git ls-files --others --ignored --exclude-standard -- "$dir" | grep -E '\.(ts|tsx|py|json|ya?ml|css|md)$')"
done

if [ "$fail" -ne 0 ]; then
  echo
  echo "Nothing was committed. Remove the file from the commit, or fix the content above."
  exit 1
fi
echo "staged changes look safe"
