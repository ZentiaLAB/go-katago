#!/bin/zsh
# Put this Mac's game server on the internet (Cloudflare Quick Tunnel) so friends can play from the Vercel page.
#   ./scripts/play-online.sh            → go.zentia.tech starts pointing at this Mac, Ctrl+C closes everything
# The tunnel address changes on every run, so the script re-deploys web/server.json to Vercel with the new
# address (and marks the server offline on exit). Set GO_PUBLISH=0 to skip that and share ?server= links instead.
# Anyone can create/join rooms; the printed access key unlocks vs-AI / analysis / LLM for trusted people.
set -e
cd "$(dirname "$0")/.."
FRONTEND="${GO_FRONTEND_URL:-https://go.zentia.tech}"
PORT="${GO_PORT:-8765}"

if ! command -v cloudflared >/dev/null; then
  echo "ต้องติดตั้ง cloudflared ก่อน:  brew install cloudflared"; exit 1
fi
if ! command -v katago >/dev/null; then echo "Installing KataGo…"; brew install katago; fi
if ! ls models/kata1-*.bin.gz >/dev/null 2>&1; then ./scripts/download_models.sh; fi

PUBLISH="${GO_PUBLISH:-1}"
LOG=$(mktemp -t go-tunnel)
DEPLOY_LOG=$(mktemp -t go-deploy)

# Write web/server.json and deploy the static site so the front-end knows where the server is ("" = offline).
publish() {
  if [[ -n "$1" ]]; then
    print -r -- "{\"server\": \"$1\", \"updated\": $(date +%s)}" > web/server.json
  else
    print -r -- "{\"server\": null, \"updated\": $(date +%s)}" > web/server.json
  fi
  npx --yes vercel@latest deploy --prod --yes >"$DEPLOY_LOG" 2>&1
}

cleanup() {
  trap - EXIT INT TERM
  kill $TUNNEL_PID 2>/dev/null || true
  if [[ "$PUBLISH" == "1" ]]; then
    echo "\nกำลังอัปเดตหน้าเว็บว่าเซิร์ฟเวอร์ปิดแล้ว…"
    publish "" && echo "✅ $FRONTEND แสดงสถานะออฟไลน์แล้ว" || echo "⚠️ อัปเดตไม่สำเร็จ (ดู $DEPLOY_LOG)"
  fi
  rm -f "$LOG"
}

cloudflared tunnel --no-autoupdate --url "http://localhost:$PORT" >"$LOG" 2>&1 &
TUNNEL_PID=$!
trap cleanup EXIT INT TERM

echo "กำลังเปิด tunnel…"
URL=""
for _ in {1..60}; do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)
  [[ -n "$URL" ]] && break
  sleep 1
done
if [[ -z "$URL" ]]; then echo "เปิด tunnel ไม่สำเร็จ:"; cat "$LOG"; exit 1; fi

KEY="${GO_ACCESS_KEY:-$(openssl rand -hex 8)}"
if [[ "$PUBLISH" == "1" ]]; then
  SHARE="$FRONTEND   (เปิดแล้วเล่นได้เลย — ไม่ต้องกรอกอะไร)"
  ( publish "$URL" && echo "\n  ✅ $FRONTEND ชี้มาที่ Mac เครื่องนี้แล้ว\n" \
      || echo "\n  ⚠️ อัปเดตหน้าเว็บไม่สำเร็จ (ดู $DEPLOY_LOG) — ใช้ลิงก์ $FRONTEND/?server=$URL แทน\n" ) &
else
  SHARE="$FRONTEND/?server=$URL"
fi
cat <<EOF

  🌍 เซิร์ฟเวอร์ออนไลน์แล้ว: $URL
  🔗 หน้าเล่นสำหรับเพื่อน:   $SHARE
  🔑 รหัสเข้าถึงเต็มรูปแบบ:  $KEY   (ให้เฉพาะคนที่ไว้ใจ — ใช้เล่นกับ AI/วิเคราะห์ผ่านเว็บ)
  💻 เล่นบนเครื่องนี้:        http://localhost:$PORT/

  หน้าเว็บจะอัปเดตภายใน ~20 วินาที · สร้างห้องในโหมด 🌐 ออนไลน์ แล้วกด "คัดลอก" ส่งลิงก์ให้เพื่อน
  Ctrl+C = ปิดเซิร์ฟเวอร์, tunnel และตั้งหน้าเว็บเป็นออฟไลน์

EOF
GO_PUBLIC_URL="$URL" GO_FRONTEND_URL="$FRONTEND" GO_ALLOWED_ORIGINS="$FRONTEND" GO_ACCESS_KEY="$KEY" \
  python3 server.py --online "$@" || true
