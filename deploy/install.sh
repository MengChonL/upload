#!/usr/bin/env bash
#
# imgdrop 一鍵安裝（Ubuntu 22.04 / 24.04，阿里雲 ECS）
#
# 用法：把整個 imgdrop 目錄上傳到伺服器，然後：
#   cd imgdrop
#   sudo bash deploy/install.sh
#
# 這個腳本會：
#   1. 確認 / 安裝 Node.js 22.13+（沒有的話用 NodeSource 裝 Node 24 LTS）
#   2. 建立系統使用者 imgdrop
#   3. 複製程式到 /opt/imgdrop，資料放 /var/lib/imgdrop
#   4. 產生 .env（自動生成上傳碼與管理金鑰，已存在就不覆蓋）
#   5. 安裝並啟動 systemd 服務
#
# 可以重複執行（idempotent）：再次執行只會更新程式碼並重啟服務，不會動你的 .env 與圖片。

set -euo pipefail

APP_DIR=/opt/imgdrop
DATA_DIR=/var/lib/imgdrop
SVC_USER=imgdrop
SVC_NAME=imgdrop
NODE_MIN_MAJOR=22
NODE_MIN_MINOR=13
NODE_SETUP=24

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '    \033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m錯誤：%s\033[0m\n\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "請用 root 執行：sudo bash deploy/install.sh"

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -f "$SRC_DIR/server.js" ]] || die "在 $SRC_DIR 找不到 server.js，請在 imgdrop 目錄內執行此腳本"

# ---------------------------------------------------------------- Node.js
# 重要：systemd 服務不會載入 nvm，而且本單元有 ProtectHome=true 會遮蔽 /root。
# 所以「nvm 裝的 node」對本服務不可用，必須是系統路徑（/usr/bin 等）的 node。
node_version_ok() {
  local bin="$1" v major minor
  [ -x "$bin" ] || return 1
  v="$("$bin" -p 'process.versions.node' 2>/dev/null)" || return 1
  major="${v%%.*}"
  minor="$(printf '%s' "$v" | cut -d. -f2)"
  [[ "$major" =~ ^[0-9]+$ ]] || return 1
  (( major > NODE_MIN_MAJOR || (major == NODE_MIN_MAJOR && minor >= NODE_MIN_MINOR) ))
}

# 判斷路徑是否為 systemd 能安全存取的系統位置（排除 nvm / 家目錄）
node_is_system_path() {
  case "$1" in
    /usr/bin/node|/usr/local/bin/node|/usr/bin/nodejs|/opt/*) return 0 ;;
    *) return 1 ;;
  esac
}

install_system_node() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_SETUP}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
}

log "檢查 Node.js"
NODE_BIN="$(command -v node 2>/dev/null || true)"

if [ -n "$NODE_BIN" ] && node_version_ok "$NODE_BIN" && node_is_system_path "$NODE_BIN"; then
  ok "已有系統版 Node.js $("$NODE_BIN" -v)：$NODE_BIN"
else
  if [ -n "$NODE_BIN" ] && node_version_ok "$NODE_BIN"; then
    warn "找到的 Node.js 在非系統路徑：$NODE_BIN"
    warn "nvm／家目錄的 Node 無法被 systemd 服務使用（且 /root 會被 ProtectHome 遮蔽）"
  else
    warn "找不到夠新的 Node.js（需要 ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}+，Ubuntu 內建只有 18）"
  fi
  warn "→ 將另外安裝系統版 Node.js ${NODE_SETUP}.x（不影響你原有的 nvm）"
  install_system_node
  NODE_BIN="$(command -v node 2>/dev/null || true)"
  node_version_ok "$NODE_BIN" || die "系統版 Node.js 安裝失敗，請手動安裝 22.13+ 後再執行本腳本"
  ok "已安裝系統版 Node.js $("$NODE_BIN" -v)：$NODE_BIN"
fi

# ---------------------------------------------------------------- 使用者 / 目錄
log "建立系統使用者與目錄"
if id -u "$SVC_USER" >/dev/null 2>&1; then
  ok "使用者 $SVC_USER 已存在"
else
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$SVC_USER"
  ok "已建立使用者 $SVC_USER"
fi

install -d -m 755 -o root       -g root       "$APP_DIR"
install -d -m 750 -o "$SVC_USER" -g "$SVC_USER" "$DATA_DIR"
ok "程式目錄 $APP_DIR，資料目錄 $DATA_DIR"

# ---------------------------------------------------------------- 複製程式
log "複製程式檔案"
rm -rf "$APP_DIR/public" "$APP_DIR/deploy" "$APP_DIR/test"
cp -a "$SRC_DIR/server.js" "$SRC_DIR/package.json" "$APP_DIR/"
cp -a "$SRC_DIR/public" "$SRC_DIR/deploy" "$APP_DIR/"
if [[ -d "$SRC_DIR/test" ]]; then cp -a "$SRC_DIR/test" "$APP_DIR/"; fi
if [[ -f "$SRC_DIR/README.md" ]]; then cp -a "$SRC_DIR/README.md" "$APP_DIR/"; fi
chown -R root:root "$APP_DIR"
chmod 755 "$APP_DIR"
ok "已複製到 $APP_DIR（零 npm 依賴，不需要 npm install）"

# ---------------------------------------------------------------- .env
log "設定 .env"
if [[ -f "$APP_DIR/.env" ]]; then
  ok "已存在 $APP_DIR/.env，保留不動"
  NEW_CODE=""
else
  # 用 Node 產生（此時 Node 一定已安裝），避免依賴 base32 等不一定存在的工具
  NEW_CODE="$(node -e "const A='23456789ABCDEFGHJKMNPQRSTUVWXYZ';const c=require('node:crypto');let s='';for(let i=0;i<10;i++)s+=A[c.randomInt(A.length)];process.stdout.write(s)")"
  NEW_ADMIN="$(node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('hex'))")"
  [[ -n "$NEW_CODE" && -n "$NEW_ADMIN" ]] || die "產生上傳碼失敗"
  cat > "$APP_DIR/.env" <<EOF
# 由 deploy/install.sh 於 $(date '+%Y-%m-%d %H:%M:%S') 產生

# 上傳碼（給要上傳的人輸入；可自行修改，改完重啟服務）
UPLOAD_CODE=${NEW_CODE}

# 管理金鑰（看用量、手動清理用；請勿外流）
ADMIN_KEY=${NEW_ADMIN}

SITE_NAME=圖片上傳
PORT=3000
DEFAULT_EXPIRE_HOURS=24
MAX_EXPIRE_HOURS=168
ALLOWED_EXPIRE_HOURS=1,6,24,72,168

DATA_DIR=${DATA_DIR}
MAX_FILE_BYTES=20971520
MAX_TOTAL_BYTES=2147483648
MAX_PHOTOS=20000
PUBLIC_GALLERY=true
MAX_UPLOADS_PER_HOUR=120
TRUST_PROXY=false
LOG_REQUESTS=false
EOF
  chown "root:${SVC_USER}" "$APP_DIR/.env"
  chmod 640 "$APP_DIR/.env"
  ok "已產生 $APP_DIR/.env"
fi

# ---------------------------------------------------------------- systemd
log "安裝 systemd 服務"
# 把 ExecStart 換成實際解析到的 node 絕對路徑，避免 systemd 找不到 nvm 的 node
UNIT_TMP="$(mktemp)"
sed "s|^ExecStart=.*|ExecStart=${NODE_BIN} --disable-warning=ExperimentalWarning ${APP_DIR}/server.js|" \
  "$APP_DIR/deploy/imgdrop.service" > "$UNIT_TMP"
install -m 644 "$UNIT_TMP" "/etc/systemd/system/${SVC_NAME}.service"
rm -f "$UNIT_TMP"
ok "服務將使用：${NODE_BIN}"
systemctl daemon-reload
systemctl enable "$SVC_NAME" >/dev/null 2>&1 || true
systemctl restart "$SVC_NAME"
sleep 2

if systemctl is-active --quiet "$SVC_NAME"; then
  ok "服務 $SVC_NAME 正在執行"
else
  systemctl status "$SVC_NAME" --no-pager -l || true
  die "服務啟動失敗，請看上面的訊息（journalctl -u $SVC_NAME -n 80）"
fi

# ---------------------------------------------------------------- 完成
PORT_USED="$(grep -E '^PORT=' "$APP_DIR/.env" | cut -d= -f2 || echo 3000)"
IP_ADDR="$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"

cat <<EOF

────────────────────────────────────────────────────────
 安裝完成 🎉

 上傳碼        見下方（也記錄在 $APP_DIR/.env）
 管理金鑰      請看 $APP_DIR/.env

 服務管理
   sudo systemctl status ${SVC_NAME}
   sudo journalctl -u ${SVC_NAME} -f
   sudo systemctl restart ${SVC_NAME}

 資料位置      ${DATA_DIR}
   （files/ 原圖、thumbs/ 縮圖、imgdrop.db 資料庫）

 下一步（很重要）
   1. 到阿里雲控制台 → 安全組 → 放行 TCP ${PORT_USED} 埠（來源 0.0.0.0/0）
   2. 手機瀏覽器打開   http://${IP_ADDR}:${PORT_USED}
   3. 輸入上面的上傳碼即可上傳

 建議
   • 若綁了網域，用 deploy/Caddyfile 上 HTTPS（相機、剪貼簿等功能需要安全來源）
   • 用了 Nginx/Caddy 反向代理後，把 .env 的 TRUST_PROXY 改成 true 再重啟
────────────────────────────────────────────────────────
EOF

if [[ -n "${NEW_CODE:-}" ]]; then
  printf '\n 你的上傳碼是：\033[1;32m%s\033[0m  （請抄下來）\n\n' "$NEW_CODE"
else
  printf '\n 目前的上傳碼：\033[1;32m%s\033[0m\n\n' "$(grep -E '^UPLOAD_CODE=' "$APP_DIR/.env" | cut -d= -f2-)"
fi
