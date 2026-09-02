#!/usr/bin/env bash
#
# deploy-gateway.sh — 一键把插件部署到网关机并重启 gateway。
#
# 流程：本地 tsc 构建（dist/）→ rsync 到网关临时目录 → 网关侧备份旧 dist +
#       覆盖安装目录 → 重启 gateway（launchd ai.openclaw.gateway）→ 健康检查。
#
# 用法：
#   ./scripts/deploy-gateway.sh                # 完整流程
#   ./scripts/deploy-gateway.sh --no-build     # 跳过本地构建（dist 已是最新）
#   ./scripts/deploy-gateway.sh --no-restart   # 只同步文件不重启（手动重启用）
#   ./scripts/deploy-gateway.sh --skip-verify  # 跳过部署后健康检查
#
# 环境变量（可覆盖）：
#   GATEWAY_HOST   网关机 SSH 地址（默认 192.168.100.133，免密）
#   GATEWAY_TMP    网关侧临时同步目录（默认 /tmp/friday-plugin-dist）
#
# 网关拓扑（详见 .claude-memory/plugin-hotpatch-deploy.md）：
#   - openclaw 装在 /opt/homebrew/lib/node_modules/openclaw（launchd ai.openclaw.gateway，
#     端口 18789）
#   - 已装插件 = ~/.openclaw/npm/projects/syengup-friday-channel-next-*/
#     node_modules/@syengup/friday-channel-next（npm 拷贝安装，非 link）
#   - 回滚：网关侧保留 dist.prev，拷回 + 重启即恢复
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

HOST="${GATEWAY_HOST:-192.168.100.133}"
GATEWAY_TMP="${GATEWAY_TMP:-/tmp/friday-plugin-dist}"
DO_BUILD=1
DO_RESTART=1
DO_VERIFY=1
for arg in "$@"; do
  case "$arg" in
    --no-build)   DO_BUILD=0 ;;
    --no-restart) DO_RESTART=0 ;;
    --skip-verify) DO_VERIFY=0 ;;
    *) echo "✗ 未知参数: $arg" >&2; exit 1 ;;
  esac
done

say() { printf '\n\033[1;32m▸ %s\033[0m\n' "$1"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# ---- 1. 本地构建 ----------------------------------------------------------
if [[ "$DO_BUILD" == "1" ]]; then
  say "本地构建 dist/（tsc）"
  node_modules/.bin/tsc -p tsconfig.json
  [[ -f dist/index.js ]] || die "dist/index.js 未产出，构建失败"
  ls dist/src/session/session-title-generator.js >/dev/null 2>&1 \
    && echo "  已包含 session-title-generator" || true
fi

# ---- 2. 同步到网关 --------------------------------------------------------
say "rsync dist/ → ${HOST}:${GATEWAY_TMP}"
rsync -az --delete --exclude '*.prev*' -e ssh dist/ "${HOST}:${GATEWAY_TMP}/" \
  || die "rsync 失败（网关免密 SSH 是否配置？）"

# ---- 3. 网关侧：备份 + 覆盖安装目录 --------------------------------------
say "网关侧备份旧 dist 并覆盖安装目录"
ssh "$HOST" "bash -lc '
set -e
PLUG=\$(ls -d ~/.openclaw/npm/projects/syengup-friday-channel-next-*/node_modules/@syengup/friday-channel-next 2>/dev/null | head -1)
[ -n \"\$PLUG\" ] || { echo \"✗ 找不到已装插件目录\" >&2; exit 1; }
rm -rf \"\$PLUG/dist.prev\"
if [ -d \"\$PLUG/dist\" ]; then mv \"\$PLUG/dist\" \"\$PLUG/dist.prev\"; fi
cp -R ${GATEWAY_TMP} \"\$PLUG/dist\"
chmod -R u+w \"\$PLUG/dist\" 2>/dev/null || true
echo \"  \${PLUG#\$HOME/}\"
ls \"\$PLUG/dist/index.js\" >/dev/null
echo \"  覆盖完成（回滚=拷回 dist.prev + 重启）\"
'" || die "网关侧覆盖失败"

# ---- 4. 重启 gateway ------------------------------------------------------
if [[ "$DO_RESTART" == "1" ]]; then
  say "重启 gateway（launchd ai.openclaw.gateway）"
  ssh "$HOST" 'export PATH=/opt/homebrew/opt/node/bin:$PATH; \
    node /opt/homebrew/lib/node_modules/openclaw/openclaw.mjs gateway restart' \
    || die "gateway 重启失败"
fi

# ---- 5. 健康检查 ----------------------------------------------------------
if [[ "$DO_VERIFY" == "1" ]]; then
  say "健康检查（等待启动）"
  sleep 6
  ssh "$HOST" 'export PATH=/opt/homebrew/opt/node/bin:$PATH; \
    TOKEN=$(python3 -c "import json,sys,re
try:
  d=json.load(open(\"$HOME/.openclaw/openclaw.json\"))
  print(d.get(\"gateway\",{}).get(\"auth\",{}).get(\"token\",\"\"))
except Exception:
  s=open(\"$HOME/.openclaw/openclaw.json\").read()
  m=re.search(r\"[\x27\\\"]?token[\x27\\\"]?\\s*:\\s*[\x27\\\"]([^\x27\\\"]+)\",s)
  print(m.group(1) if m else \"\")"); \
    BODY=$(curl -s -m 10 -H "Authorization: Bearer $TOKEN" http://127.0.0.1:18789/friday-next/agents || true); \
    if echo "$BODY" | grep -q "<!DOCTYPE\\|<html\\|<head"; then \
      echo "✗ 返回的是 Control UI HTML —— 插件可能没加载（stale copy）"; exit 1; \
    fi; \
    echo "$BODY" | head -c 120; echo; \
    echo "  /friday-next/agents 正常"' || die "健康检查失败"
fi

cat <<DONE

✅ 部署完成
   目标：${HOST}（ai.openclaw.gateway :18789）
   验证：/friday-next/agents 返回 JSON（非 HTML）
DONE