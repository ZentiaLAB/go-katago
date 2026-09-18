"""Online rooms: server-authoritative Go games that other people join over the network.

Each room has a 6-character code; each seated player gets a secret token (kept in their browser).
The server validates every move with its own rules implementation, so a client can't cheat by
sending illegal moves or playing out of turn. Clients sync with long-polling (/api/room/state).
"""
import re
import secrets
import threading
import time

LETTERS = "ABCDEFGHJKLMNOPQRST"
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"   # no 0/O, 1/I/L
HELPER_LEVELS = (0, 500, 1000, 3000, 8000)
MAX_ROOMS = 60
ROOM_TTL = 6 * 3600          # drop rooms idle for 6 h
POLL_WAIT = 25               # seconds a long-poll may block
MOVE_RE = re.compile(r"^(pass|[A-HJ-T](1[0-9]|[1-9]))$")


# ---------------------------------------------------------------- rules (mirror of web/go.js)
def other(c):
    return "W" if c == "B" else "B"


def handicap_points(size, n):
    if n < 2:
        return []
    e = 3 if size >= 13 else 2
    m = (size - 1) // 2
    f = size - 1 - e
    pts = [(f, e), (e, f), (f, f), (e, e)]
    sides, tb, c = [(e, m), (f, m)], [(m, e), (m, f)], (m, m)
    if n <= 4:
        return pts[:n]
    return {5: pts + [c], 6: pts + sides, 7: pts + sides + [c], 8: pts + sides + tb}.get(n, pts + sides + tb + [c])


def to_gtp(x, y, size):
    return f"{LETTERS[x]}{size - y}"


def from_gtp(s, size):
    x = LETTERS.index(s[0])
    y = size - int(s[1:])
    if not (0 <= x < size and 0 <= y < size):
        raise ValueError("off board")
    return x, y


class Board:
    def __init__(self, size):
        self.size = size
        self.grid = [None] * (size * size)
        self.ko = -1

    def neighbors(self, i):
        s, x, y = self.size, i % self.size, i // self.size
        if x > 0:
            yield i - 1
        if x < s - 1:
            yield i + 1
        if y > 0:
            yield i - s
        if y < s - 1:
            yield i + s

    def group(self, i):
        color, stones, libs, stack, seen = self.grid[i], [], set(), [i], {i}
        while stack:
            p = stack.pop()
            stones.append(p)
            for n in self.neighbors(p):
                c = self.grid[n]
                if c is None:
                    libs.add(n)
                elif c == color and n not in seen:
                    seen.add(n)
                    stack.append(n)
        return stones, libs

    def play(self, gtp, color):
        """Apply a move; returns False (and leaves the board unchanged) if illegal."""
        if gtp == "pass":
            self.ko = -1
            return True
        x, y = from_gtp(gtp, self.size)
        i = y * self.size + x
        if self.grid[i] is not None or i == self.ko:
            return False
        saved = (list(self.grid), self.ko)
        self.grid[i] = color
        captured = []
        for n in self.neighbors(i):
            if self.grid[n] == other(color):
                stones, libs = self.group(n)
                if not libs:
                    for s in stones:
                        self.grid[s] = None
                    captured.extend(stones)
        stones, libs = self.group(i)
        if not libs:
            self.grid, self.ko = saved
            return False
        captured = set(captured)
        self.ko = next(iter(captured)) if len(captured) == 1 and len(stones) == 1 and len(libs) == 1 else -1
        return True


# ---------------------------------------------------------------- rooms
def clean_name(name, fallback):
    name = re.sub(r"[\x00-\x1f<>]", "", str(name or "")).strip()[:24]
    return name or fallback


class Room:
    def __init__(self, code, size, komi, handicap):
        self.code = code
        self.size = size
        self.komi = komi
        self.handicap = handicap
        self.board = Board(size)
        self.initial = []
        for x, y in handicap_points(size, handicap):
            self.board.grid[y * size + x] = "B"
            self.initial.append(["B", to_gtp(x, y, size)])
        self.first = "W" if self.initial else "B"
        self.moves = []
        self.seats = {"B": None, "W": None}     # color -> {token, name, helper, seen}
        self.spectators = {}                    # token -> {name, seen}
        self.status = "waiting"
        self.result = None
        self.reason = None
        self.ownership = None
        self.chat = []
        self.version = 1
        self.touched = time.time()
        self.cond = threading.Condition()
        self.analysis_cache = {}                # (version, visits) -> result
        self.busy_tokens = set()
        self.sender_ids = {}

    # --- helpers
    def to_play(self):
        return self.first if len(self.moves) % 2 == 0 else other(self.first)

    def color_of(self, token):
        for c, seat in self.seats.items():
            if seat and secrets.compare_digest(seat["token"], token or ""):
                return c
        return None

    def bump(self):
        """Call with self.cond held: publish a change to long-pollers."""
        self.version += 1
        self.touched = time.time()
        self.analysis_cache.clear()
        self.cond.notify_all()

    def sys_msg(self, text):
        self.chat.append({"from": "sys", "name": "", "text": text, "t": time.time()})
        self.chat = self.chat[-200:]

    def public(self, token=None):
        now = time.time()
        you = self.color_of(token) if token else None
        seats = {c: (None if not s else {"name": s["name"], "helper": s["helper"], "online": now - s["seen"] < 40})
                 for c, s in self.seats.items()}
        return {
            "code": self.code, "size": self.size, "komi": self.komi, "handicap": self.handicap,
            "initial": self.initial, "first": self.first, "moves": self.moves, "status": self.status,
            "toPlay": self.to_play(), "result": self.result, "reason": self.reason,
            "ownership": self.ownership if self.status == "over" else None,
            "seats": seats, "spectators": len(self.spectators),
            "chat": [{k: v for k, v in m.items() if not k.startswith("_")} for m in self.chat[-100:]],
            "version": self.version, "you": you,
        }


class Rooms:
    def __init__(self, engine_query, llm_chat):
        self.engine_query = engine_query
        self.llm_chat = llm_chat
        self.rooms = {}
        self.lock = threading.Lock()

    # --- lookup
    def _gc(self):
        now = time.time()
        for code in [c for c, r in self.rooms.items() if now - r.touched > ROOM_TTL]:
            del self.rooms[code]

    def get(self, code):
        code = str(code or "").upper().strip()
        with self.lock:
            room = self.rooms.get(code)
        if not room:
            raise KeyError("ไม่พบห้องนี้ (รหัสผิด หรือห้องหมดอายุแล้ว)")
        return room

    def _seen(self, room, token):
        for s in room.seats.values():
            if s and secrets.compare_digest(s["token"], token or ""):
                s["seen"] = time.time()
        if token in room.spectators:
            room.spectators[token]["seen"] = time.time()

    # --- actions
    def create(self, body):
        size = int(body.get("size", 19))
        if size not in (9, 13, 19):
            raise ValueError("ขนาดกระดานไม่ถูกต้อง")
        komi = float(body.get("komi", 7.5))
        if not -150 <= komi <= 150:
            raise ValueError("โคมิไม่ถูกต้อง")
        handicap = int(body.get("handicap", 0))
        if handicap not in (0, 2, 3, 4, 5, 6, 7, 8, 9):
            raise ValueError("หมากต่อไม่ถูกต้อง")
        color = body.get("color", "B")
        if color == "R":
            color = secrets.choice("BW")
        if color not in ("B", "W"):
            raise ValueError("สีไม่ถูกต้อง")
        helper = int(body.get("helper", 1000))
        if helper not in HELPER_LEVELS:
            raise ValueError("ระดับผู้ช่วยไม่ถูกต้อง")
        with self.lock:
            self._gc()
            if len(self.rooms) >= MAX_ROOMS:
                raise ValueError("มีห้องเยอะเกินไป ลองใหม่ภายหลัง")
            code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(6))
            while code in self.rooms:
                code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(6))
            room = Room(code, size, komi, handicap)
            self.rooms[code] = room
        token = secrets.token_urlsafe(18)
        name = clean_name(body.get("name"), "เจ้าของห้อง")
        with room.cond:
            room.seats[color] = {"token": token, "name": name, "helper": helper, "seen": time.time()}
            room.sys_msg(f"{name} สร้างห้อง — รอผู้เล่นอีกคน")
            room.bump()
        return {"code": code, "token": token, "color": color}

    def join(self, body):
        room = self.get(body.get("code"))
        helper = int(body.get("helper", 1000))
        if helper not in HELPER_LEVELS:
            raise ValueError("ระดับผู้ช่วยไม่ถูกต้อง")
        token = secrets.token_urlsafe(18)
        with room.cond:
            empty = [c for c, s in room.seats.items() if s is None]
            if room.status == "waiting" and empty:
                color = empty[0]
                name = clean_name(body.get("name"), "ผู้เล่น 2")
                room.seats[color] = {"token": token, "name": name, "helper": helper, "seen": time.time()}
                room.status = "playing"
                room.sys_msg(f"{name} เข้าห้องแล้ว — เริ่มเกม!")
            else:
                if len(room.spectators) >= 30:
                    raise ValueError("ห้องเต็ม")
                color = None
                name = clean_name(body.get("name"), "ผู้ชม")
                room.spectators[token] = {"name": name, "seen": time.time()}
                room.sys_msg(f"{name} เข้ามาดู")
            room.bump()
        return {"code": room.code, "token": token, "color": color}

    def state(self, code, token, since):
        room = self.get(code)
        deadline = time.time() + POLL_WAIT
        with room.cond:
            self._seen(room, token)
            while room.version <= since and time.time() < deadline:
                room.cond.wait(timeout=max(0.1, deadline - time.time()))
                self._seen(room, token)
            return room.public(token)

    def move(self, body):
        room = self.get(body.get("code"))
        mv = str(body.get("move", ""))
        if not MOVE_RE.match(mv):
            raise ValueError("ท่าไม่ถูกต้อง")
        with room.cond:
            color = room.color_of(body.get("token"))
            if color is None:
                raise PermissionError("คุณไม่ได้เป็นผู้เล่นในห้องนี้")
            if room.status != "playing":
                raise ValueError("เกมยังไม่เริ่มหรือจบไปแล้ว")
            if int(body.get("n", -1)) != len(room.moves):
                raise ValueError("กระดานไม่ตรงกับเซิร์ฟเวอร์ — กำลังซิงก์ใหม่")
            if room.to_play() != color:
                raise ValueError("ยังไม่ถึงตาคุณ")
            try:
                ok = room.board.play(mv, color)
            except ValueError:
                ok = False
            if not ok:
                raise ValueError("จุดนี้เล่นไม่ได้ (ผิดกติกา)")
            room.moves.append([color, mv])
            two_pass = mv == "pass" and len(room.moves) >= 2 and room.moves[-2][1] == "pass"
            if two_pass:
                room.status = "scoring"
                room.sys_msg("ผ่านติดกันทั้งสองฝ่าย — กำลังนับแต้ม…")
            room.bump()
        if two_pass:
            threading.Thread(target=self._score, args=(room,), daemon=True).start()
        return room.public(body.get("token"))

    def _score(self, room):
        q = {"moves": room.moves, "initialStones": room.initial, "initialPlayer": room.first, "rules": "chinese",
             "komi": room.komi, "boardXSize": room.size, "boardYSize": room.size, "maxVisits": 1500,
             "includeOwnership": True}
        res = self.engine_query(q)
        with room.cond:
            if room.status != "scoring":
                return
            info = (res or {}).get("rootInfo")
            if not info:
                room.status, room.result, room.reason = "over", "?", "นับแต้มไม่สำเร็จ"
            else:
                lead = info["scoreLead"]
                margin = max(0.5, round(abs(lead) - 0.5) + 0.5)
                room.result = f"{'B' if lead > 0 else 'W'}+{margin:g}"
                room.reason = "score"
                room.ownership = res.get("ownership")
                room.status = "over"
            room.sys_msg(f"จบเกม: {room.result}")
            room.bump()

    def resign(self, body):
        room = self.get(body.get("code"))
        with room.cond:
            color = room.color_of(body.get("token"))
            if color is None:
                raise PermissionError("คุณไม่ได้เป็นผู้เล่นในห้องนี้")
            if room.status not in ("playing", "waiting"):
                raise ValueError("เกมจบไปแล้ว")
            room.status, room.result, room.reason = "over", f"{other(color)}+R", f"resign:{color}"
            room.sys_msg(f"{room.seats[color]['name']} ยอมแพ้")
            room.bump()
        return room.public(body.get("token"))

    def chat(self, body):
        room = self.get(body.get("code"))
        text = re.sub(r"[\x00-\x08\x0b-\x1f]", "", str(body.get("text", ""))).strip()[:300]
        if not text:
            raise ValueError("ข้อความว่าง")
        token = body.get("token")
        with room.cond:
            color = room.color_of(token)
            if color:
                name = room.seats[color]["name"]
            elif token in room.spectators:
                name, color = room.spectators[token]["name"], "spec"
            else:
                raise PermissionError("คุณไม่ได้อยู่ในห้องนี้")
            sender = room.sender_ids.setdefault(token, secrets.token_hex(4))   # internal only, never sent out
            last = [m for m in room.chat if m.get("_sid") == sender]
            if last and time.time() - last[-1]["t"] < 0.7:
                raise ValueError("ส่งข้อความเร็วเกินไป")
            room.chat.append({"from": color, "name": name, "text": text, "t": time.time(), "_sid": sender})
            room.chat = room.chat[-200:]
            room.bump()
        return {"ok": True}

    def _helper(self, room, token):
        color = room.color_of(token)
        if color is None:
            raise PermissionError("ต้องเป็นผู้เล่นในห้องนี้")
        visits = room.seats[color]["helper"]
        if not visits:
            raise PermissionError("คุณปิดผู้ช่วยไว้ในห้องนี้")
        return color, visits

    def analyze(self, body):
        """Helper analysis of the room's *current* position, capped at the caller's helper level."""
        room = self.get(body.get("code"))
        token = body.get("token")
        with room.cond:
            _, visits = self._helper(room, token)
            key = (room.version, visits)
            if key in room.analysis_cache:
                return room.analysis_cache[key]
            if token in room.busy_tokens:
                raise ValueError("กำลังวิเคราะห์อยู่")
            room.busy_tokens.add(token)
            q = {"moves": list(room.moves), "initialStones": room.initial, "initialPlayer": room.first,
                 "rules": "chinese", "komi": room.komi, "boardXSize": room.size, "boardYSize": room.size,
                 "maxVisits": visits, "includeOwnership": True}
            version = room.version
        try:
            res = self.engine_query(q)
        finally:
            with room.cond:
                room.busy_tokens.discard(token)
        res = dict(res or {}, roomVersion=version, moveCount=len(q["moves"]))
        with room.cond:
            if room.version == version and "rootInfo" in res:
                room.analysis_cache[(version, visits)] = res
        return res

    def ask(self, body):
        room = self.get(body.get("code"))
        with room.cond:
            self._helper(room, body.get("token"))
        msgs = body.get("messages")
        if (not isinstance(msgs, list) or len(msgs) > 40 or not all(
                isinstance(m, dict) and m.get("role") in ("system", "user", "assistant")
                and isinstance(m.get("content"), str) and len(m["content"]) < 20000 for m in msgs)):
            raise ValueError("bad messages")
        return self.llm_chat([{"role": m["role"], "content": m["content"]} for m in msgs])
