#!/bin/bash
# FridayNext 云 — grant 库异地备份（P1 验收项）。
#
# 跑在家里常开的 Mac（.133）上：每天从中继拉 /v1/admin/backup（registry + 全量
# control-plane 状态），JSON 校验通过才落盘，保留最近 60 份。中继烧了/被清，
# grant/订阅/隧道归属都能从这里恢复——异地 = 不在中继那台机器上。
#
# 安装（LaunchAgent，见同目录 ai.fridaynext.relay-backup.plist）：
#   mkdir -p ~/.openclaw/friday-next/relay-backup
#   cp pull-relay-backup.sh ~/.openclaw/friday-next/relay-backup/ && chmod +x …
#   cp ai.fridaynext.relay-backup.plist ~/Library/LaunchAgents/
#   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.fridaynext.relay-backup.plist
#
# Token：/v1/admin/* 的 bearer 自 2026-07-18 起 = GW_ALLOC_ADMIN_TOKEN（与 frps
# relayToken 拆分，P0-3），只运维持有。从同目录 `admin-token` 文件读（0600，不入
# openclaw 配置）。过渡：文件缺失时回退旧的 relayToken（拆分前的老部署）。
set -euo pipefail

CP_BASE="${FN_RELAY_CP_BASE:-https://friday.syengup.host}"
DEST_DIR="${FN_RELAY_BACKUP_DIR:-$HOME/.openclaw/friday-next/relay-backup}"
KEEP=60
NODE_BIN="${FN_NODE_BIN:-/opt/homebrew/bin/node}"

mkdir -p "$DEST_DIR"

if [ -f "$DEST_DIR/admin-token" ]; then
  TOKEN=$(tr -d '[:space:]' < "$DEST_DIR/admin-token")
else
  TOKEN=$("$NODE_BIN" -e '
const fs = require("fs");
const c = JSON.parse(fs.readFileSync(process.env.HOME + "/.openclaw/openclaw.json", "utf8"));
console.log(((c.channels || {})["friday-next"]?.publicAccess || {}).relayToken || "");
')
fi
if [ -z "$TOKEN" ]; then
  echo "[relay-backup] FATAL: admin token not found (expected $DEST_DIR/admin-token)" >&2
  exit 1
fi

STAMP=$(date +%F)
TMP="$DEST_DIR/.backup-$STAMP.json.tmp"
OUT="$DEST_DIR/backup-$STAMP.json"

curl -fsS -m 60 -H "Authorization: Bearer $TOKEN" "$CP_BASE/v1/admin/backup" -o "$TMP"

# 校验：合法 JSON 且带 registry + cp 两块，坏响应绝不覆盖当天档。
"$NODE_BIN" -e '
const o = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
if (!o || typeof o !== "object" || !o.registry || !o.cp) throw new Error("backup shape invalid");
console.log(`[relay-backup] ok — ${Object.keys(o.registry).length} subdomains, ` +
  `${Object.keys(o.cp.grants || {}).length} grants, ${Object.keys(o.cp.subs || {}).length} subs`);
' "$TMP"

mv "$TMP" "$OUT"
ln -sf "$OUT" "$DEST_DIR/latest.json"

# 保留最近 $KEEP 份（文件名含日期，字典序=时间序；BSD 工具兼容写法）。
ls -1 "$DEST_DIR"/backup-*.json 2>/dev/null | sort -r | tail -n +$((KEEP + 1)) | while read -r f; do
  rm -f "$f"
done
echo "[relay-backup] wrote $OUT"
