#!/usr/bin/env bash
#
# Creates the GitHub OIDC provider and the `chaukanna-github-deploy` role that
# .github/workflows/deploy-infra.yml and deploy-agent.yml assume.
#
# Read this before running it. It mints a role that GitHub Actions can assume to deploy this
# whole account, and by default attaches AdministratorAccess (docs/AWS_SETUP.md section 8.3 allows
# that for the hackathon and says to narrow it afterwards). That is your decision, not a script's,
# so nothing is created until you type the confirmation word.
#
# It is idempotent: an existing provider, role or attachment is left alone, and the trust policy
# of an existing role is updated in place to match what is printed.
#
# Usage:
#   scripts/setup-github-oidc.sh <org>/<repo> [--profile chaukanna] [--role-name NAME] [--policy-arn ARN]
#
# Afterwards, set the printed ARN as the repository secret `AWS_ROLE_TO_ASSUME`:
#   gh secret set AWS_ROLE_TO_ASSUME --body 'arn:aws:iam::<account>:role/chaukanna-github-deploy'
# Until that secret exists, both workflows skip cleanly instead of failing.

set -euo pipefail

REPO=''
PROFILE=''
ROLE_NAME='chaukanna-github-deploy'
POLICY_ARN='arn:aws:iam::aws:policy/AdministratorAccess'
PROVIDER_HOST='token.actions.githubusercontent.com'
AUDIENCE='sts.amazonaws.com'

usage() {
  sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --profile)     PROFILE="$2"; shift 2 ;;
    --role-name)   ROLE_NAME="$2"; shift 2 ;;
    --policy-arn)  POLICY_ARN="$2"; shift 2 ;;
    -h|--help)     usage ;;
    -*)            echo "unknown option: $1" >&2; usage ;;
    *)             REPO="$1"; shift ;;
  esac
done

# `<org>/<repo>`, nothing looser: the trust policy is only worth anything if this is exact.
if ! printf '%s' "$REPO" | grep -Eq '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'; then
  echo "error: expected a repository as <org>/<repo>, got '${REPO}'" >&2
  usage
fi

REPO_OWNER="${REPO%%/*}"
REPO_NAME="${REPO##*/}"

aws_cli() {
  if [ -n "$PROFILE" ]; then
    aws --profile "$PROFILE" "$@"
  else
    aws "$@"
  fi
}

command -v aws >/dev/null || { echo 'error: the AWS CLI is not on PATH' >&2; exit 1; }

ACCOUNT_ID="$(aws_cli sts get-caller-identity --query Account --output text)"
CALLER="$(aws_cli sts get-caller-identity --query Arn --output text)"
PROVIDER_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${PROVIDER_HOST}"
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"

# The trust policy. `sub` is pinned to this one repository (any branch, any workflow); an OIDC
# role without that StringLike can be assumed by any repository on GitHub, which is why
# docs/AWS_SETUP.md calls the restriction mandatory.
#
# Two patterns, not one. GitHub issues the subject claim in two shapes and which one a repository
# gets is not ours to choose:
#
#   repo:<org>/<repo>:ref:refs/heads/main                     the long-standing form
#   repo:<org>@<orgId>/<repo>@<repoId>:ref:refs/heads/main    the newer form, with database ids
#
# This repository gets the second one, and a policy carrying only the first denies every run with
# `Not authorized to perform sts:AssumeRoleWithWebIdentity` and no hint as to why. The `@*` in the
# second pattern cannot be widened by an attacker: `@` is not a legal character in a GitHub user,
# organisation or repository name, so only GitHub's own id substitution can produce a subject that
# matches it.
TRUST_POLICY=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Federated": "${PROVIDER_ARN}" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": { "${PROVIDER_HOST}:aud": "${AUDIENCE}" },
        "StringLike": {
          "${PROVIDER_HOST}:sub": [
            "repo:${REPO}:*",
            "repo:${REPO_OWNER}@*/${REPO_NAME}@*:*"
          ]
        }
      }
    }
  ]
}
JSON
)

# ---- Say what will happen, then stop and wait ---------------------------------------------

provider_exists() { aws_cli iam get-open-id-connect-provider --open-id-connect-provider-arn "$PROVIDER_ARN" >/dev/null 2>&1; }
role_exists()     { aws_cli iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; }

echo
echo "About to change IAM in AWS account ${ACCOUNT_ID}"
echo "  as:                ${CALLER}"
echo "  profile:           ${PROFILE:-<default>}"
echo
if provider_exists; then
  echo "  OIDC provider:     ${PROVIDER_ARN}  (already exists, left alone)"
else
  echo "  OIDC provider:     ${PROVIDER_ARN}  (WILL BE CREATED)"
fi
if role_exists; then
  echo "  role:              ${ROLE_ARN}  (exists, trust policy WILL BE UPDATED)"
else
  echo "  role:              ${ROLE_ARN}  (WILL BE CREATED)"
fi
echo "  trusted repo:      repo:${REPO}:*  (this repository only, any branch)"
echo "                     repo:${REPO_OWNER}@*/${REPO_NAME}@*:*  (same repository, id-bearing subject)"
echo "  attached policy:   ${POLICY_ARN}"
echo
echo "$TRUST_POLICY"
echo
if [ "$POLICY_ARN" = 'arn:aws:iam::aws:policy/AdministratorAccess' ]; then
  echo "WARNING: AdministratorAccess means every workflow run on ${REPO} can do anything in this"
  echo "         account. docs/AWS_SETUP.md 8.3 permits this for the hackathon and says to replace"
  echo "         it with least privilege once the infrastructure settles."
  echo
fi
printf 'Type CREATE to proceed, anything else to abort: '
read -r CONFIRM
if [ "$CONFIRM" != 'CREATE' ]; then
  echo 'Aborted. Nothing was changed.'
  exit 1
fi

# ---- Create, idempotently -------------------------------------------------------------------

echo
if provider_exists; then
  echo "OIDC provider already present, skipping."
else
  # No --thumbprint-list: IAM has trusted GitHub's OIDC endpoint by its CA since 2023 and works
  # out the thumbprint itself. A hardcoded thumbprint here would be a time bomb.
  aws_cli iam create-open-id-connect-provider \
    --url "https://${PROVIDER_HOST}" \
    --client-id-list "$AUDIENCE" >/dev/null
  echo "Created OIDC provider ${PROVIDER_ARN}"
fi

if role_exists; then
  aws_cli iam update-assume-role-policy --role-name "$ROLE_NAME" --policy-document "$TRUST_POLICY"
  echo "Role ${ROLE_NAME} already present, trust policy updated."
else
  aws_cli iam create-role \
    --role-name "$ROLE_NAME" \
    --description "GitHub Actions deploy role for ${REPO} (Chaukanna)" \
    --assume-role-policy-document "$TRUST_POLICY" >/dev/null
  echo "Created role ${ROLE_ARN}"
fi

if aws_cli iam list-attached-role-policies --role-name "$ROLE_NAME" \
     --query "AttachedPolicies[?PolicyArn=='${POLICY_ARN}'] | length(@)" --output text | grep -qv '^0$'; then
  echo "Policy ${POLICY_ARN} already attached, skipping."
else
  aws_cli iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn "$POLICY_ARN"
  echo "Attached ${POLICY_ARN}"
fi

echo
echo "Done. Now tell the repository about the role:"
echo
echo "  gh secret set AWS_ROLE_TO_ASSUME --repo ${REPO} --body '${ROLE_ARN}'"
echo
echo "Until that secret is set, deploy-infra and deploy-agent skip instead of failing."
