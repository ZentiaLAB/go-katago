#!/bin/zsh
# Put this Mac's game server on the internet (Cloudflare Quick Tunnel) so friends can play from the Vercel page.
#   ./scripts/play-online.sh            → prints the invite link + an access key, Ctrl+C closes everything
# Anyone with the link can create/join rooms; the access key unlocks vs-AI / analysis / LLM for trusted people.
set -e
cd "$(dirname "$0")/.."
FRONTEND="${GO_FRONTEND_URL:-https://go-katago.vercel.app}"
PORT="${GO_PORT:-8765}"

if ! command -v cloudflared >/dev/null; then
  echo "ต้องติดตั้ง cloudflared ก่อน:  brew install cloudflared"; exit 1
fi
if ! command -v katago >/dev/null; then echo "Installing KataGo…"; brew install katago; fi
if ! ls models/kata1-*.bin.gz >/dev/null 2>&1; then ./scripts/download_models.sh; fi

LOG=$(mktemp -t go-tunnel)
cloudflared tunnel --no-autoupdate --url "http://localhost:$PORT" >"$LOG" 2>&1 &
TUNNEL_PID=$!
trap 'kill $TUNNEL_PID 2>/dev/null; rm -f "$LOG"' EXIT INT TERM

echo "กำลังเปิด tunnel…"
URL=""
for _ in {1..60}; do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)
  [[ -n "$URL" ]] && break
  sleep 1
done
if [[ -z "$URL" ]]; then echo "เปิด tunnel ไม่สำเร็จ:"; cat "$LOG"; exit 1; fi

KEY="${GO_ACCESS_KEY:-$(openssl rand -hex 8)}"
cat <<EOF

  🌍 เซิร์ฟเวอร์ออนไลน์แล้ว: $URL
  🔗 หน้าเล่นสำหรับเพื่อน:   $FRONTEND/?server=$URL
  🔑 รหัสเข้าถึงเต็มรูปแบบ:  $KEY   (ให้เฉพาะคนที่ไว้ใจ — ใช้เล่นกับ AI/วิเคราะห์ผ่านเว็บ)
  💻 เล่นบนเครื่องนี้:        http://localhost:$PORT/

  สร้างห้องในโหมด 🌐 ออนไลน์ แล้วกด "คัดลอก" ลิงก์เชิญส่งให้เพื่อน · Ctrl+C = ปิดเซิร์ฟเวอร์และ tunnel

EOF
GO_PUBLIC_URL="$URL" GO_FRONTEND_URL="$FRONTEND" GO_ALLOWED_ORIGINS="$FRONTEND" GO_ACCESS_KEY="$KEY" \
  python3 server.py --online "$@"
