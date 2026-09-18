#!/bin/zsh
# Double-click (or run ./start.command) to play Go against KataGo.
cd "$(dirname "$0")"
if ! command -v katago >/dev/null; then echo "Installing KataGo…"; brew install katago || exit 1; fi
if ! ls models/kata1-*.bin.gz >/dev/null 2>&1; then ./scripts/download_models.sh || exit 1; fi
exec python3 server.py "$@"
