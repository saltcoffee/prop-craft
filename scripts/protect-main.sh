#!/usr/bin/env bash
# Protect the `main` branch so only pull requests can merge.
#
# Run this ONCE, after the first push, on a machine with the GitHub CLI
# authenticated (`gh auth login`). It is intentionally not run by CI.
#
# Usage:
#   OWNER=saltcoffee REPO=prop-craft ./scripts/protect-main.sh
#
# It requires a pull request for every merge (count 0 = no approval needed),
# runs the "Validate plugin" CI check, and blocks direct pushes, force pushes,
# and branch deletion.
set -euo pipefail

: "${OWNER:?set OWNER to the GitHub owner, e.g. saltcoffee}"
: "${REPO:?set REPO to the GitHub repository, e.g. prop-craft}"

gh api -X PUT "repos/${OWNER}/${REPO}/branches/main/protection" \
  -H "Accept: application/vnd.github+json" \
  --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["check"] },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON

echo "Protected main: pull-request-only merges enabled for ${OWNER}/${REPO}."
