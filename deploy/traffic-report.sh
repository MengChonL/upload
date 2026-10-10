#!/usr/bin/env bash
#
# imgdrop 流量與異常偵測報告（唯讀，不修改任何東西）
#
# 用法：
#   sudo bash deploy/traffic-report.sh
#
# 建議先開啟 ufw 記錄（沒開的話第 2 節會沒有資料）：
#   sudo ufw logging on

set -uo pipefail

LOG_NGINX_ACCESS="${LOG_NGINX_ACCESS:-/var/log/nginx/access.log}"
LOG_UFW="${LOG_UFW:-/var/log/ufw.log}"
LOG_AUTH="${LOG_AUTH:-/var/log/auth.log}"
SCAN_LINES=50000

c_bold=$'\033[1m'; c_dim=$'\033[2m'; c_red=$'\033[31m'
c_yellow=$'\033[33m'; c_green=$'\033[32m'; c_cyan=$'\033[36m'; c_off=$'\033[0m'

section() { printf '\n%s───── %s ─────%s\n' "$c_bold" "$1" "$c_off"; }
note() { printf '  %s%s%s\n' "$c_dim" "$1" "$c_off"; }
warn() { printf '  %s⚠ %s%s\n' "$c_yellow" "$1" "$c_off"; }

printf '%s════════════════════════════════════════════════════════%s\n' "$c_cyan" "$c_off"
printf '%s imgdrop 流量與異常偵測報告%s\n' "$c_bold" "$c_off"
printf ' 主機：%s   時間：%s\n' "$(hostname)" "$(date '+%F %T %Z')"
printf ' 對外 IP：%s\n' "$(curl -fsS --max-time 3 http://100.100.100.200/latest/meta-data/eipv4 2>/dev/null || echo '（取不到）')"
printf '%s════════════════════════════════════════════════════════%s\n' "$c_cyan" "$c_off"

# ═══════════════════════════════════════════════════════════
section "1. 服務與目前連線"

printf '  imgdrop：%s\n' "$(systemctl is-active imgdrop 2>/dev/null || echo 未安裝)"
printf '  nginx  ：%s\n' "$(systemctl is-active nginx 2>/dev/null || echo 未安裝)"
printf '  ufw    ：%s（記錄等級：%s）\n' \
  "$(ufw status 2>/dev/null | head -1 | awk '{print $2}')" \
  "$(ufw status verbose 2>/dev/null | awk -F': ' '/Logging/{print $2}' | head -1)"

printf '\n  目前與 3000／80 埠建立的連線：\n'
if ss -tnp 2>/dev/null | grep -qE ':(3000|80)\s'; then
  ss -tnp 2>/dev/null | grep -E ':(3000|80)\s' | head -15 | sed 's/^/    /'
else
  note "（目前沒有連線）"
fi

printf '\n  3000 埠的連線來源統計：\n'
ss -tn 2>/dev/null | awk '$4 ~ /:3000$/ {print $5}' | sed 's/:[0-9]*$//' \
  | sort | uniq -c | sort -rn | head -10 | sed 's/^/    /' || note "（無）"

# ═══════════════════════════════════════════════════════════
section "2. ufw 封鎖紀錄 —— 最直接看到機器人的地方"

if [ ! -f "$LOG_UFW" ]; then
  warn "$LOG_UFW 不存在"
  note "請先執行：sudo ufw logging on"
  note "開啟後，所有被 geofence 擋掉的掃描都會記錄在這裡。"
elif ! grep -q "UFW BLOCK" "$LOG_UFW" 2>/dev/null; then
  note "已開啟記錄，但還沒有任何封鎖事件。"
  note "（這其實是好消息：搭配澳門 geofence，境外掃描在阿里雲邊緣就被丟棄，"
  note "  封包根本到不了你的伺服器，所以 ufw 看不到——安全組那層才是第一道。"
  note "  真正到達 ufw 才被擋的，會出現在這裡。）"
else
  TOTAL=$(grep -c "UFW BLOCK" "$LOG_UFW" 2>/dev/null || echo 0)
  printf '  總封鎖次數：%s%s%s\n' "$c_red" "$TOTAL" "$c_off"
  printf '  記錄期間：%s → %s\n' \
    "$(grep 'UFW BLOCK' "$LOG_UFW" | head -1 | awk '{print $1" "$2" "$3}')" \
    "$(grep 'UFW BLOCK' "$LOG_UFW" | tail -1 | awk '{print $1" "$2" "$3}')"

  printf '\n  %s被封鎖的來源 IP（Top 15）%s\n' "$c_bold" "$c_off"
  grep "UFW BLOCK" "$LOG_UFW" | grep -o 'SRC=[0-9.]*' | cut -d= -f2 2>/dev/null \
    | sort | uniq -c | sort -rn | head -15 \
    | awk '{printf "    %6d 次  %s\n", $1, $2}'

  printf '\n  %s被嘗試的目標埠（Top 10）%s\n' "$c_bold" "$c_off"
  grep "UFW BLOCK" "$LOG_UFW" | grep -o 'DPT=[0-9]*' | cut -d= -f2 2>/dev/null \
    | sort | uniq -c | sort -rn | head -10 \
    | awk '{printf "    %6d 次  埠 %s\n", $1, $2}'
fi

# ═══════════════════════════════════════════════════════════
section "3. nginx 存取日誌（你的網站是公開的，會被大量掃描）"

if [ ! -f "$LOG_NGINX_ACCESS" ]; then
  note "$LOG_NGINX_ACCESS 不存在，略過"
else
  LINES=$(wc -l < "$LOG_NGINX_ACCESS" 2>/dev/null || echo 0)
  printf '  日誌總行數：%s（以下分析最近 %s 行）\n' "$LINES" "$SCAN_LINES"
  TAIL=$(tail -n "$SCAN_LINES" "$LOG_NGINX_ACCESS" 2>/dev/null)

  printf '\n  %s來源 IP（Top 10）%s\n' "$c_bold" "$c_off"
  printf '%s' "$TAIL" | awk '{print $1}' | sort | uniq -c | sort -rn | head -10 \
    | awk '{printf "    %6d 次  %s\n", $1, $2}'

  printf '\n  %s被存取的路径（Top 12）%s\n' "$c_bold" "$c_off"
  printf '%s' "$TAIL" | awk '{print $7}' | sort | uniq -c | sort -rn | head -12 \
    | awk '{printf "    %6d 次  %s\n", $1, $2}'

  printf '\n  %sHTTP 狀態碼分佈%s\n' "$c_bold" "$c_off"
  printf '%s' "$TAIL" | awk '{print $9}' | sort | uniq -c | sort -rn | head -8 \
    | awk '{printf "    %6d 次  %s\n", $1, $2}'

  printf '\n  %s%s掃描探測（駭客在找漏洞的典型路徑）%s\n' "$c_bold" "$c_red" "$c_off"
  HITS=$(printf '%s' "$TAIL" | grep -icE '/(\.env|\.git|wp-admin|wp-login|xmlrpc\.php|phpmyadmin|adminer|\.well-known/security|vendor/phpunit|actuator|config\.json|\.aws|\.ssh|shell|eval|\.php)' || true)
  if [ "${HITS:-0}" -gt 0 ]; then
    warn "偵測到 ${HITS} 筆典型漏洞掃描請求"
    printf '%s' "$TAIL" | grep -iE '/(\.env|\.git|wp-admin|wp-login|xmlrpc\.php|phpmyadmin|adminer|actuator|\.aws|\.ssh)' \
      | awk '{print $1}' | sort | uniq -c | sort -rn | head -8 \
      | awk '{printf "      %5d 次  %s\n", $1, $2}'
    printf '    範例：\n'
    printf '%s' "$TAIL" | grep -iE '/(\.env|\.git|wp-admin|wp-login|xmlrpc\.php|phpmyadmin|actuator|\.aws|\.ssh)' \
      | tail -3 | awk '{printf "      %s %s\n", $1, $7}'
  else
    printf '    %s✓ 沒有發現典型掃描路徑%s\n' "$c_green" "$c_off"
  fi

  printf '\n  %s最常見的 User-Agent（Top 10）%s\n' "$c_bold" "$c_off"
  UAS=$(printf '%s' "$TAIL" | grep -oE '"[^"]*"[[:space:]]*$' | sed 's/^"//; s/"[[:space:]]*$//')
  if [ -n "$UAS" ]; then
    printf '%s\n' "$UAS" | sort | uniq -c | sort -rn | head -10 \
      | awk '{n=$1; $1=""; sub(/^ /,""); printf "    %6d 次  %s\n", n, substr($0,1,90)}'
  else
    note "（無法解析 User-Agent）"
  fi

  printf '\n  %s%s疑似自動化工具／掃描器%s\n' "$c_bold" "$c_yellow" "$c_off"
  BOTS=$(printf '%s\n' "$UAS" | grep -iE 'python-requests|python-urllib|^curl/|^wget/|go-http-client|zgrab|masscan|^nmap|sqlmap|nikto|semrushbot|ahrefsbot|mj12bot|dotbot|petalbot|bytespider|censys|internetmeasurement|scrapy|libwww-perl|okhttp|apache-httpclient|^java/|^axios|headlesschrome|phantomjs' || true)
  if [ -n "$BOTS" ]; then
    printf '%s\n' "$BOTS" | sort | uniq -c | sort -rn | head -12 \
      | awk '{n=$1; $1=""; sub(/^ /,""); printf "    %6d 次  %s\n", n, substr($0,1,90)}'
  else
    printf '    %s✓ 沒有明顯的自動化工具%s\n' "$c_green" "$c_off"
  fi

  printf '\n  %s%s單一 IP 高頻請求（可能是在暴力嘗試）%s\n' "$c_bold" "$c_yellow" "$c_off"
  printf '%s' "$TAIL" | awk '{print $1}' | sort | uniq -c | sort -rn \
    | awk '$1 > 100 {printf "    %6d 次  %s\n", $1, $2}' | head -10
  note "（沒有列出代表沒有單一 IP 超過 100 次）"
fi

# ═══════════════════════════════════════════════════════════
section "4. imgdrop 應用層"

if systemctl is-active --quiet imgdrop 2>/dev/null; then
  printf '  最近的上傳／刪除紀錄：\n'
  journalctl -u imgdrop --no-pager -n 500 2>/dev/null \
    | grep -E '\[imgdrop\]' | tail -12 | sed 's/^/    /' || note "（沒有紀錄）"

  printf '\n  上傳總數（依日誌）：%s\n' \
    "$(journalctl -u imgdrop --no-pager 2>/dev/null | grep -c '上傳 ' || echo 0)"
  printf '  刪除總數（依日誌）：%s\n' \
    "$(journalctl -u imgdrop --no-pager 2>/dev/null | grep -c '刪除 ' || echo 0)"
  printf '  被清理的過期圖片：%s\n' \
    "$(journalctl -u imgdrop --no-pager 2>/dev/null | grep -c '已清理' || echo 0)"

  printf '\n  目前用量：\n'
  if [ -f /var/lib/imgdrop/imgdrop.db ]; then
    if command -v sqlite3 >/dev/null 2>&1; then
      sqlite3 /var/lib/imgdrop/imgdrop.db \
        "SELECT '    圖片數： '||COUNT(*) FROM photos;
         SELECT '    佔用：   '||ROUND(SUM(size+thumb_size)/1048576.0,2)||' MB' FROM photos;
         SELECT '    最早：   '||datetime(MIN(created_at)/1000,'unixepoch','localtime') FROM photos;
         SELECT '    最近：   '||datetime(MAX(created_at)/1000,'unixepoch','localtime') FROM photos;" 2>/dev/null
    else
      note "（沒裝 sqlite3，改用檔案大小估算）"
      du -sh /var/lib/imgdrop 2>/dev/null | sed 's/^/    /'
    fi
  fi
  printf '    service 記憶體：%s\n' \
    "$(systemctl show imgdrop -p MemoryCurrent --value 2>/dev/null | awk '{printf "%.1f MB", $1/1048576}')"
else
  note "imgdrop 服務不在執行中"
fi

# ═══════════════════════════════════════════════════════════
section "5. 系統負載與流量"

printf '  負載：%s\n' "$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"
free -h 2>/dev/null | head -2 | sed 's/^/  /'
printf '\n  磁碟：\n'
df -h / /var/lib/imgdrop 2>/dev/null | sed 's/^/    /'

if command -v vnstat >/dev/null 2>&1; then
  printf '\n  vnstat 流量統計：\n'
  vnstat --oneline 2>/dev/null | sed 's/^/    /'
else
  printf '\n  網卡累計流量（開機至今）：\n'
  for i in /sys/class/net/*/statistics; do
    dev=$(basename "$(dirname "$i")")
    [ "$dev" = "lo" ] && continue
    rx=$(cat "$i/rx_bytes" 2>/dev/null || echo 0)
    tx=$(cat "$i/tx_bytes" 2>/dev/null || echo 0)
    awk -v d="$dev" -v r="$rx" -v t="$tx" 'BEGIN{printf "    %-12s 收 %.1f MB  送 %.1f MB\n", d, r/1048576, t/1048576}'
  done
  note "（想看得更細可安裝：apt install vnstat && systemctl enable --now vnstat）"
fi

# ═══════════════════════════════════════════════════════════
section "6. 其他值得看的紀錄"

if [ -f "$LOG_AUTH" ]; then
  FAILS=$(grep -c "Failed password" "$LOG_AUTH" 2>/dev/null || echo 0)
  printf '  SSH 登入失敗次數：%s%s%s\n' "$([ "${FAILS:-0}" -gt 0 ] && echo "$c_red")" "$FAILS" "$c_off"
  if [ "${FAILS:-0}" -gt 0 ]; then
    grep "Failed password" "$LOG_AUTH" 2>/dev/null | grep -o 'from [0-9.]*' | cut -d' ' -f2 \
      | sort | uniq -c | sort -rn | head -8 | awk '{printf "    %6d 次  %s\n", $1, $2}'
    note "（你的 22 埠沒對外開放，這些多半來自阿里雲內部或已封鎖的來源）"
  fi
fi

printf '\n  Docker 容器（若有異常容器也在這裡）：\n'
docker ps --format '    {{.Names}} | {{.Image}} | {{.Status}}' 2>/dev/null | head -10 || note "（docker 不可用）"

printf '\n  最近 24 小時系統錯誤：\n'
journalctl --since '24 hours ago' -p err --no-pager 2>/dev/null | tail -8 | sed 's/^/    /' || note "（無）"

# ═══════════════════════════════════════════════════════════
printf '\n%s════════════════════════════════════════════════════════%s\n' "$c_cyan" "$c_off"
printf '%s 報告完成（全程唯讀，未修改任何設定）%s\n' "$c_bold" "$c_off"
printf '%s════════════════════════════════════════════════════════%s\n' "$c_cyan" "$c_off"

if ! ufw status verbose 2>/dev/null | grep -q 'Logging: on'; then
  printf '\n%s建議%s：開啟 ufw 記錄，才能看到被封鎖的機器人\n' "$c_yellow" "$c_off"
  printf '  sudo ufw logging on\n\n'
fi
