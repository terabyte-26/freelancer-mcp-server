#!/bin/bash
# Call one MCP tool from a shell on the VPS: deploy/call-tool.sh freelancer_list_threads '{"limit":3}'
set -euo pipefail
. "$(dirname "$0")/env-mcp.sh"
exec node /root/freelancer-mcp-server/scripts/call.mjs "$@"
