#!/bin/bash
# Source this on the VPS: exports the MCP server's environment from the bot's live
# account registry (every ACTIVE account with its token and proxy) and .env
# (MONGO_URI). Tokens never leave the machine; nothing is written to disk.
cd /root/x || exit 1
set -a; . ./.env; set +a
export FREELANCER_ACCOUNTS
FREELANCER_ACCOUNTS=$(venv/bin/python - <<'PY' 2>/dev/null
import json
from helpers.account_registry import live_accounts
from helpers.accounts import active_accounts
print(json.dumps({a["name"]: {"token": a["oauth_token"], "proxy": a.get("proxy") or ""} for a in active_accounts(live_accounts())}))
PY
)
export MESSAGE_MIN_GAP_S="${MESSAGE_MIN_GAP_S:-45}"
export MESSAGE_DAILY_CAP="${MESSAGE_DAILY_CAP:-80}"
