#!/usr/bin/env python3
"""Local Go (หมากล้อม) server.

- Runs one KataGo analysis engine (b28 main net + human-style net) on the Mac GPU + Neural Engine.
- Serves the web UI from ./web and a small JSON API used by both the AI opponent and the assistant.
- Optionally proxies natural-language questions to a local LLM via Ollama (if installed).

By default binds to 127.0.0.1 only. With --online it listens on the LAN so friends can join rooms;
remote clients can then use only the room APIs (/api/room/*), never the raw engine / LLM / metrics endpoints.
"""
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from collections import deque
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from rooms import Rooms

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
MODELS = ROOT / "models"
CONFIG = ROOT / "engine" / "analysis.cfg"
ONLINE = "--online" in sys.argv
HOST = "0.0.0.0" if ONLINE else "127.0.0.1"
PUBLIC_URL = os.environ.get("GO_PUBLIC_URL", "").rstrip("/")
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
# Web front-ends hosted elsewhere (e.g. the Vercel deployment) that may call this server from the browser.
ALLOWED_ORIGINS = {o.strip().rstrip("/") for o in os.environ.get("GO_ALLOWED_ORIGINS", "").split(",") if o.strip()}
# Remote visitors get rooms only; with this key (sent as X-Go-Key) they get every feature (vs AI, analysis, LLM).
ACCESS_KEY = os.environ.get("GO_ACCESS_KEY", "")
PORT = int(os.environ.get("GO_PORT", "8765"))
OLLAMA = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")
MAX_BODY = 256 * 1024

MOVE_RE = re.compile(r"^(pass|[A-HJ-T](1[0-9]|[1-9]))$", re.I)
PROFILE_RE = re.compile(r"^(rank|preaz|proyear)_[0-9a-z]{1,6}$")


def find_model(pattern):
    found = sorted(MODELS.glob(pattern))
    return found[-1] if found else None


class KataGo:
    """Thin async wrapper around `katago analysis` (JSON lines over stdin/stdout)."""

    def __init__(self):
        self.main_model = find_model("kata1-b28*.bin.gz") or find_model("kata1-*.bin.gz")
        if self.main_model is None:
            brew = shutil.which("katago")
            share = Path(brew).resolve().parent.parent / "share" / "katago" if brew else None
            cands = sorted(share.glob("kata1-b18*.bin.gz")) if share else []
            self.main_model = cands[-1] if cands else None
        self.human_model = find_model("*humanv0*.bin.gz")
        if self.main_model is None:
            sys.exit("ไม่พบไฟล์โมเดล KataGo ในโฟลเดอร์ models/ — ดู README.md")
        cmd = ["katago", "analysis", "-model", str(self.main_model), "-config", str(CONFIG)]
        if self.human_model:
            cmd += ["-human-model", str(self.human_model)]
        (ROOT / "logs").mkdir(exist_ok=True)
        self.proc = subprocess.Popen(
            cmd, cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=open(ROOT / "logs" / "katago_stderr.txt", "w"), text=True, bufsize=1,
        )
        self.lock = threading.Lock()
        self.pending = {}          # id -> [Event, result]
        self.channels = {}         # channel -> active query id (new query cancels the old one)
        self.counter = 0
        self.ready = False
        threading.Thread(target=self._reader, daemon=True).start()
        threading.Thread(target=self._warmup, daemon=True).start()

    def _reader(self):
        for line in self.proc.stdout:
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if msg.get("isDuringSearch"):
                continue
            qid = msg.get("id")
            with self.lock:
                slot = self.pending.pop(qid, None)
            if slot:
                slot[1] = msg
                slot[0].set()
        # engine died: release everyone
        with self.lock:
            for slot in self.pending.values():
                slot[1] = {"error": "KataGo engine stopped"}
                slot[0].set()
            self.pending.clear()

    def _warmup(self):
        # First query compiles the Metal/CoreML graphs (~20-30 s). Do it now instead of on the first move.
        self.query({"moves": [], "boardXSize": 19, "boardYSize": 19, "maxVisits": 8,
                    "rules": "chinese", "komi": 7.5}, timeout=300)
        for n in (9, 13):
            self.query({"moves": [], "boardXSize": n, "boardYSize": n, "maxVisits": 8,
                        "rules": "chinese", "komi": 7.5}, timeout=300)
        self.ready = True

    def _send(self, obj):
        with self.lock:
            self.proc.stdin.write(json.dumps(obj) + "\n")
            self.proc.stdin.flush()

    def query(self, q, channel=None, timeout=600):
        if self.proc.poll() is not None:
            return {"error": "KataGo engine is not running"}
        with self.lock:
            self.counter += 1
            qid = f"q{self.counter}"
            slot = [threading.Event(), None]
            self.pending[qid] = slot
            old = self.channels.get(channel) if channel else None
            if channel:
                self.channels[channel] = qid
        if old:
            self._send({"id": f"t{qid}", "action": "terminate", "terminateId": old})
        t0 = time.time()
        self._send(dict(q, id=qid))
        if not slot[0].wait(timeout):
            self._send({"id": f"t{qid}", "action": "terminate", "terminateId": qid})
            return {"error": "timeout"}
        with self.lock:
            if channel and self.channels.get(channel) == qid:
                del self.channels[channel]
        res = slot[1]
        ms = round((time.time() - t0) * 1000)
        visits = (res.get("rootInfo") or {}).get("visits", 0) if isinstance(res, dict) else 0
        if isinstance(res, dict):
            res["_stats"] = {"ms": ms, "visits": visits, "vps": round(visits / max(ms, 1) * 1000)}
        return res

    def cancel(self, channel):
        with self.lock:
            old = self.channels.pop(channel, None)
        if old:
            self._send({"id": f"c{old}", "action": "terminate", "terminateId": old})


def validate_moves(moves, key="moves"):
    if not isinstance(moves, list) or len(moves) > 1000:
        raise ValueError(f"bad {key}")
    out = []
    for m in moves:
        if (not isinstance(m, list) or len(m) != 2 or m[0] not in ("B", "W")
                or not isinstance(m[1], str) or not MOVE_RE.match(m[1])):
            raise ValueError(f"bad {key} entry")
        out.append([m[0], m[1].upper()])
    return out


def build_query(body):
    size = int(body.get("size", 19))
    if size not in (9, 13, 19):
        raise ValueError("size must be 9, 13 or 19")
    komi = float(body.get("komi", 7.5))
    if not -150 <= komi <= 150:
        raise ValueError("bad komi")
    q = {
        "moves": validate_moves(body.get("moves", [])),
        "initialStones": validate_moves(body.get("initialStones", []), "initialStones"),
        "rules": "chinese",
        "komi": komi,
        "boardXSize": size,
        "boardYSize": size,
        "maxVisits": max(1, min(int(body.get("maxVisits", 500)), 50000)),
        "includeOwnership": bool(body.get("ownership", False)),
        "includePolicy": bool(body.get("policy", False)),
    }
    ip = body.get("initialPlayer")
    if ip in ("B", "W"):
        q["initialPlayer"] = ip
    prof = body.get("humanProfile")
    if prof:
        if not isinstance(prof, str) or not PROFILE_RE.match(prof):
            raise ValueError("bad humanProfile")
        q["overrideSettings"] = {"humanSLProfile": prof}
        q["includePolicy"] = True
    return q


# ---------------------------------------------------------------- Ollama (optional)
def ollama_models():
    try:
        with urllib.request.urlopen(OLLAMA + "/api/tags", timeout=1.5) as r:
            return [m["name"] for m in json.load(r).get("models", [])]
    except Exception:
        return []


def pick_llm(models):
    pref = os.environ.get("GO_LLM_MODEL")
    if pref and pref in models:
        return pref
    for key in ("gemma4", "qwen3", "gemma3", "llama", "mistral"):
        for m in models:
            if m.startswith(key) and "embed" not in m:
                return m
    return next((m for m in models if "embed" not in m), None)


def ollama_chat(messages):
    model = pick_llm(ollama_models())
    if not model:
        return {"error": "no-llm"}
    payload = json.dumps({"model": model, "messages": messages, "stream": False,
                          "think": False, "keep_alive": "30m",
                          "options": {"temperature": 0.4, "num_ctx": 8192}}).encode()
    req = urllib.request.Request(OLLAMA + "/api/chat", data=payload,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            data = json.load(r)
    except Exception as e:  # noqa: BLE001
        return {"error": f"LLM error: {e}"}
    text = data.get("message", {}).get("content", "")
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()
    return {"model": model, "text": text}


# ---------------------------------------------------------------- system metrics (macOS, no sudo)
def _mb(tok):
    """Parse top's MEM column like '2335M-', '1.2G+', '512K' into MB."""
    m = re.match(r"([\d.]+)([BKMGT])", tok)
    if not m:
        return 0.0
    v, u = float(m.group(1)), m.group(2)
    return v * {"B": 1 / 1048576, "K": 1 / 1024, "M": 1, "G": 1024, "T": 1048576}[u]


def _sysctl(name):
    try:
        return int(subprocess.run(["sysctl", "-n", name], capture_output=True, text=True).stdout.strip())
    except ValueError:
        return 0


class SysMonitor:
    """Samples CPU / RAM / GPU every ~2 s while the UI is asking for metrics."""

    def __init__(self):
        self.ncpu = _sysctl("hw.ncpu") or os.cpu_count() or 1
        self.pcores = _sysctl("hw.perflevel0.physicalcpu")
        self.ecores = _sysctl("hw.perflevel1.physicalcpu")
        self.mem_total = _sysctl("hw.memsize")
        self.history = deque(maxlen=150)
        self.last_request = 0.0
        self.lock = threading.Lock()
        threading.Thread(target=self._loop, daemon=True).start()

    def touch(self):
        self.last_request = time.time()

    def _loop(self):
        while True:
            if time.time() - self.last_request > 20:
                time.sleep(0.5)
                continue
            try:
                sample = self._sample()
                with self.lock:
                    self.history.append(sample)
            except Exception as e:  # noqa: BLE001
                print("metrics error:", e, file=sys.stderr)
                time.sleep(2)
            time.sleep(0.8)

    def _procs(self):
        out = subprocess.run(["pgrep", "-f", "ollama"], capture_output=True, text=True).stdout.split()
        procs = {}
        if ENGINE and ENGINE.proc.poll() is None:
            procs[str(ENGINE.proc.pid)] = "katago"
        for pid in out:
            procs.setdefault(pid, "llm")
        procs[str(os.getpid())] = "server"
        return procs

    def _sample(self):
        procs = self._procs()
        cmd = ["top", "-l", "2", "-s", "1", "-stats", "pid,cpu,mem,threads"]
        for pid in procs:
            cmd += ["-pid", pid]
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=10).stdout
        lines = out.splitlines()
        cpu_line = [l for l in lines if l.startswith("CPU usage")][-1]
        user, sysc = (float(x) for x in re.findall(r"([\d.]+)% (?:user|sys)", cpu_line))
        groups = {k: {"cpu": 0.0, "mem": 0.0, "threads": 0} for k in ("katago", "llm", "server")}
        last_hdr = max(i for i, l in enumerate(lines) if l.startswith("PID"))
        for l in lines[last_hdr + 1:]:
            parts = l.split()
            if len(parts) < 4 or parts[0] not in procs:
                continue
            g = groups[procs[parts[0]]]
            g["cpu"] += float(parts[1])
            g["mem"] += _mb(parts[2])
            g["threads"] += int(re.sub(r"\D.*", "", parts[3]) or 0)
        # memory "used" the way Activity Monitor counts it: app + wired + compressed
        vm = subprocess.run(["vm_stat"], capture_output=True, text=True).stdout
        page = int(re.search(r"page size of (\d+)", vm).group(1))
        get = lambda k: int(re.search(k + r":\s+(\d+)", vm).group(1))
        app = (_sysctl("vm.page_pageable_internal_count") - get("Pages purgeable")) * page
        wired = get("Pages wired down") * page
        comp = get("Pages occupied by compressor") * page
        gpu = {}
        io = subprocess.run(["ioreg", "-r", "-d", "1", "-w", "0", "-c", "IOAccelerator"],
                            capture_output=True, text=True).stdout
        m = re.search(r'"Device Utilization %"=(\d+)', io)
        gpu["util"] = int(m.group(1)) if m else None
        m = re.search(r'"In use system memory"=(\d+)', io)
        gpu["memMB"] = int(m.group(1)) / 1048576 if m else None
        for g in groups.values():
            g["cpuMachine"] = g["cpu"] / self.ncpu
        return {
            "t": time.time(),
            "cpu": {"total": user + sysc, "user": user, "sys": sysc},
            "mem": {"usedMB": (app + wired + comp) / 1048576, "appMB": app / 1048576,
                    "wiredMB": wired / 1048576, "compressedMB": comp / 1048576,
                    "totalMB": self.mem_total / 1048576},
            "gpu": gpu,
            "procs": groups,
        }

    def snapshot(self, since=0.0):
        with self.lock:
            hist = [h for h in self.history if h["t"] > since]
        return {"ncpu": self.ncpu, "pcores": self.pcores, "ecores": self.ecores,
                "memTotalMB": self.mem_total / 1048576, "samples": hist}


# ---------------------------------------------------------------- HTTP
ENGINE = None
MONITOR = None
ROOMS = None


def lan_ip():
    """Best-effort LAN address (UDP connect sends no packets)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sk:
            sk.connect(("10.255.255.255", 1))
            return sk.getsockname()[0]
    except OSError:
        return None
MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
        ".ico": "image/x-icon", ".json": "application/json"}


class Handler(BaseHTTPRequestHandler):
    server_version = "GoLocal/1.0"

    def log_message(self, fmt, *args):
        pass

    def _json(self, obj, code=200):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    def _host_ok(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        return host in ("127.0.0.1", "localhost")

    def _is_local(self):
        """The person at this Mac (not a LAN guest, not tunnel traffic, not DNS rebinding)."""
        return self.client_address[0] in ("127.0.0.1", "::1") and self._host_ok()

    def _has_key(self):
        key = self.headers.get("X-Go-Key") or ""
        return bool(ACCESS_KEY) and ONLINE and secrets.compare_digest(key.encode(), ACCESS_KEY.encode())

    def _full(self):
        return self._is_local() or self._has_key()

    def _allowed(self, path):
        if self._full():
            return True
        if not ONLINE:
            return False
        # remote players: static files, status, and the room APIs only
        return path == "/api/status" or path.startswith("/api/room/") or not path.startswith("/api/")

    def _cors(self):
        origin = (self.headers.get("Origin") or "").rstrip("/")
        if ONLINE and origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def do_OPTIONS(self):
        origin = (self.headers.get("Origin") or "").rstrip("/")
        if not (ONLINE and origin in ALLOWED_ORIGINS):
            self.send_response(403)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Go-Key")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _room(self, fn, *args):
        try:
            return self._json(fn(*args))
        except KeyError as e:
            return self._json({"error": e.args[0] if e.args else "not found"}, 404)
        except PermissionError as e:
            return self._json({"error": str(e)}, 403)
        except (ValueError, TypeError) as e:
            return self._json({"error": str(e)}, 400)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if not self._allowed(path):
            return self._json({"error": "forbidden"}, 403)
        if path == "/api/room/state":
            from urllib.parse import parse_qs
            qs = parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
            token = qs.get("token", [""])[0]
            try:
                since = int(qs.get("since", ["0"])[0])
            except ValueError:
                since = 0
            return self._room(ROOMS.state, qs.get("code", [""])[0], token if TOKEN_RE.match(token) else "", since)
        if path == "/api/status":
            ip = lan_ip() if ONLINE else None
            return self._json({
                "local": self._is_local(),
                "full": self._full(),
                "online": ONLINE,
                "lanUrl": f"http://{ip}:{PORT}" if ip else None,
                "publicUrl": PUBLIC_URL or None,
                "frontendUrl": os.environ.get("GO_FRONTEND_URL", "").rstrip("/") or None,
                "ready": ENGINE.ready,
                "alive": ENGINE.proc.poll() is None,
                "model": ENGINE.main_model.name,
                "humanModel": ENGINE.human_model.name if ENGINE.human_model else None,
                "llm": pick_llm(ollama_models()),
            })
        if path == "/api/metrics":
            MONITOR.touch()
            try:
                since = float(self.path.split("since=", 1)[1]) if "since=" in self.path else 0.0
            except ValueError:
                since = 0.0
            return self._json(MONITOR.snapshot(since))
        if path == "/":
            path = "/index.html"
        target = (WEB / path.lstrip("/")).resolve()
        if WEB not in target.parents or not target.is_file():
            return self._json({"error": "not found"}, 404)
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(target.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
                         "font-src https://fonts.gstatic.com; img-src 'self' data:")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if not self._allowed(self.path):
            return self._json({"error": "forbidden"}, 403)
        if "application/json" not in (self.headers.get("Content-Type") or ""):
            return self._json({"error": "expected JSON"}, 415)
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self._json({"error": "bad body size"}, 413)
        try:
            body = json.loads(self.rfile.read(length))
        except json.JSONDecodeError:
            return self._json({"error": "bad json"}, 400)
        if not isinstance(body, dict):
            return self._json({"error": "bad json"}, 400)

        if self.path.startswith("/api/room/"):
            tok = body.get("token")
            body["token"] = tok if isinstance(tok, str) and TOKEN_RE.match(tok) else ""
            action = {"create": ROOMS.create, "join": ROOMS.join, "move": ROOMS.move, "resign": ROOMS.resign,
                      "chat": ROOMS.chat, "analyze": ROOMS.analyze, "ask": ROOMS.ask}.get(self.path[len("/api/room/"):])
            if not action:
                return self._json({"error": "not found"}, 404)
            return self._room(action, body)

        if self.path == "/api/analyze":
            try:
                q = build_query(body)
            except (ValueError, TypeError) as e:
                return self._json({"error": str(e)}, 400)
            channel = body.get("channel") if body.get("channel") in ("ai", "assist", "final") else None
            return self._json(ENGINE.query(q, channel=channel))
        if self.path == "/api/cancel":
            ch = body.get("channel")
            if ch in ("ai", "assist", "final"):
                ENGINE.cancel(ch)
            return self._json({"ok": True})
        if self.path == "/api/chat":
            msgs = body.get("messages")
            if (not isinstance(msgs, list) or len(msgs) > 40 or not all(
                    isinstance(m, dict) and m.get("role") in ("system", "user", "assistant")
                    and isinstance(m.get("content"), str) and len(m["content"]) < 20000 for m in msgs)):
                return self._json({"error": "bad messages"}, 400)
            return self._json(ollama_chat([{"role": m["role"], "content": m["content"]} for m in msgs]))
        return self._json({"error": "not found"}, 404)


def main():
    global ENGINE, MONITOR, ROOMS
    if not shutil.which("katago"):
        sys.exit("ไม่พบ katago — ติดตั้งด้วย: brew install katago")
    url = f"http://localhost:{PORT}/"
    try:
        srv = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError:
        try:
            with urllib.request.urlopen(url + "api/status", timeout=2) as r:
                json.load(r)
            print(f"เกมเปิดอยู่แล้วที่ {url} — เปิดเบราว์เซอร์ให้")
            if "--no-browser" not in sys.argv:
                webbrowser.open(url)
            return
        except Exception:
            sys.exit(f"พอร์ต {PORT} ถูกโปรแกรมอื่นใช้อยู่ — ลองรัน: GO_PORT=9000 ./start.command")
    srv.daemon_threads = True
    ENGINE = KataGo()
    MONITOR = SysMonitor()
    ROOMS = Rooms(lambda q: ENGINE.query(q, timeout=300), ollama_chat)
    print(f"♟  Go server: {url}")
    print(f"   main model : {ENGINE.main_model.name}")
    print(f"   human model: {ENGINE.human_model.name if ENGINE.human_model else '-'}")
    if ONLINE:
        ip = lan_ip()
        print(f"   🌐 โหมดออนไลน์: เพื่อนใน Wi-Fi เดียวกันเข้าได้ที่ http://{ip}:{PORT}/" if ip else "   🌐 โหมดออนไลน์")
        if PUBLIC_URL:
            print(f"   🌍 ลิงก์สาธารณะ: {PUBLIC_URL}/")
        if ALLOWED_ORIGINS:
            print(f"   🔓 อนุญาตหน้าเว็บจาก: {', '.join(sorted(ALLOWED_ORIGINS))}")
        print("   🔑 รหัสเข้าถึงเต็มรูปแบบ: " + ("ตั้งไว้แล้ว (GO_ACCESS_KEY)" if ACCESS_KEY else "ไม่ได้ตั้ง — คนนอกเล่นได้เฉพาะห้องออนไลน์"))
    else:
        print("   (เปิดให้คนอื่นเข้าห้องได้ด้วย: ./start.command --online)")
    print("   (warming up the engine ~30 s on first start — Ctrl+C to quit)")
    if "--no-browser" not in sys.argv:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        ENGINE.proc.terminate()


if __name__ == "__main__":
    main()
