#!/bin/bash
# Freelancer MCP server launcher for the VPS (stdio). Claude Code connects with:
#   ssh -i <key> root@<vps> /root/freelancer-mcp-server/deploy/run-mcp.sh
set -euo pipefail
. "$(dirname "$0")/env-mcp.sh"
exec node /root/freelancer-mcp-server/dist/index.js
