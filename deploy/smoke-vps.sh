#!/bin/bash
# Run the smoke test on the VPS with the live environment; the bid probe targets
# a project the first account already bid on, so the duplicate guard blocks it.
set -euo pipefail
. "$(dirname "$0")/env-mcp.sh"
export SMOKE_PROJECT_ID
SMOKE_PROJECT_ID=$(cd /root/x && venv/bin/python - <<'PY' 2>/dev/null
import os
from pymongo import MongoClient
from helpers.account_registry import live_accounts
from helpers.accounts import first_active_account
db = MongoClient(os.environ["MONGO_URI"])["freelancer_analytics"]
acc = first_active_account(live_accounts())["name"]
d = db.my_bids.find_one({"account": acc, "status": "placed"}, sort=[("bid_at", -1)])
print(d["project_id"] if d else "")
PY
)
cd /root/freelancer-mcp-server && npm run smoke
