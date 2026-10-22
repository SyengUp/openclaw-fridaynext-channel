#!/usr/bin/env bash
# 完整包部署入口；备份、校验、受控重启和回滚由同一事务实现负责。
set -euo pipefail
DEPLOY_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$DEPLOY_SCRIPT_DIR/deploy-gateway.py" "$@"
