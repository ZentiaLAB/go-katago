#!/bin/zsh
# Download the KataGo networks this project uses into ./models (~370 MB total).
set -e
cd "$(dirname "$0")/../models"
fetch() {  # url file
  if [[ -f "$2" ]]; then echo "✓ $2 (มีอยู่แล้ว)"; return; fi
  echo "↓ $2"; curl -L --fail --progress-bar -o "$2.part" "$1" && mv "$2.part" "$2"
}
fetch https://media.katagotraining.org/uploaded/networks/models/kata1/kata1-b28c512nbt-s13255194368-d5935380940.bin.gz \
      kata1-b28c512nbt-s13255194368-d5935380940.bin.gz
fetch https://github.com/lightvector/KataGo/releases/download/v1.15.0/b18c384nbt-humanv0.bin.gz \
      b18c384nbt-humanv0.bin.gz
echo "เสร็จแล้ว — รัน ./start.command ได้เลย"
