import { Board, BLACK, WHITE, EMPTY, other, colorChar, charColor, toGTP, fromGTP, starPoints, handicapPoints } from "./go.js";
import * as X from "./explain.js";
import { lineChart, barChart } from "./charts.js";

const $ = (s) => document.querySelector(s);
const cv = $("#board"), ctx = cv.getContext("2d");

// ------------------------------------------------------------------ state
const S = {
  size: 19, komi: 7.5, handicap: 0, aiResign: true,
  players: { [BLACK]: { type: "human", assist: 1000 }, [WHITE]: { type: "ai", level: "super", visits: 1000 } },
  paused: false,
  boards: [], moves: [], initialStones: [], first: BLACK,
  pre: {},        // moveNum -> Promise<analysis> for positions where the human is to move
  preDone: {},    // moveNum -> analysis (resolved)
  wr: [],         // moveNum -> black winrate
  latest: null,   // most recent analysis of any position {n, res}
  lastReview: null,
  gen: 0, thinking: false, over: false, result: null, lowStreak: { [BLACK]: 0, [WHITE]: 0 }, reviewed: new Set(), losses: [],
  showHints: false, showOwner: false, hover: null, preview: null, finalOwnership: null,
  llm: null, chatLog: [],
  stats: {},      // moveNum -> what the AI (side 'ai') or assistant (side 'assist') thought at that position
  activity: [],   // [{kind:'ai'|'assist'|'llm', t0, t1}] wall-clock thinking intervals (for the machine charts)
  metrics: [], sys: null, tab: "assist",
};
const board = () => S.boards[S.boards.length - 1];
const n = () => S.moves.length;
const toPlay = () => (n() % 2 === 0 ? S.first : other(S.first));

// ------------------------------------------------------------------ players (P1 = black, P2 = white; each human or AI)
const LEVELS = [
  ["super", "🔥 KataGo เต็มกำลัง (เหนือมนุษย์)"], ["rank_9d", "เลียนแบบมนุษย์ 9 ดั้ง"], ["rank_7d", "เลียนแบบมนุษย์ 7 ดั้ง"],
  ["rank_5d", "เลียนแบบมนุษย์ 5 ดั้ง"], ["rank_3d", "เลียนแบบมนุษย์ 3 ดั้ง"], ["rank_1d", "เลียนแบบมนุษย์ 1 ดั้ง"],
  ["rank_3k", "เลียนแบบมนุษย์ 3 คิว"], ["rank_7k", "เลียนแบบมนุษย์ 7 คิว"], ["rank_12k", "เลียนแบบมนุษย์ 12 คิว"],
  ["rank_18k", "เลียนแบบมนุษย์ 18 คิว (มือใหม่)"],
];
const pl = (c) => S.players[c];
const isAI = (c) => pl(c).type === "ai";
const isRemote = (c) => pl(c).type === "remote";          // the other person in an online room
const isHuman = (c) => pl(c).type === "human";             // a person clicking on *this* screen
const humans = () => [BLACK, WHITE].filter(isHuman);
// AI vs AI / human vs AI / human vs human / online room
const mode = () => (S.online ? "online" : ["ava", "hva", "hvh"][humans().length]);
const solo = () => mode() === "hva" || (mode() === "online" && humans().length === 1);  // exactly one local player → "คุณ"
const me = () => (humans().length === 1 ? humans()[0] : BLACK);   // whose point of view the numbers use
const meName = () => (solo() ? "คุณ" : X.colorName(me()));
const pNum = (c) => (c === BLACK ? 1 : 2);
const levelName = (c) => { const l = pl(c).level; return l === "super" ? "เต็มกำลัง" : l.replace("rank_", "").replace("d", " ดั้ง").replace("k", " คิว"); };
function playerName(c) {
  if (isAI(c)) return `AI · ${levelName(c)}`;
  if (isRemote(c)) return S.online?.names?.[c] || "รอผู้เล่น…";
  return solo() ? "คุณ" : `ผู้เล่น ${pNum(c)}`;
}
const stoneEmoji = (c) => (c === BLACK ? "⚫" : "⚪");
// helper AI strength per human player (visits); 0 = helper switched off for that player
const assistFor = (c) => (isHuman(c) ? pl(c).assist ?? 1000 : 0);
const assistName = (v) => ({ 0: "ปิด", 500: "เร็ว", 1000: "มาตรฐาน", 3000: "ลึก", 8000: "สุดกำลัง" }[v] ?? `${v} visits`);
// may analysis (hints, win %, territory, charts) be shown right now? Not on the turn of a player who switched the helper off.
function helpAllowed() {
  if (S.over || mode() === "ava") return true;
  return isHuman(toPlay()) ? assistFor(toPlay()) > 0 : humans().some((c) => assistFor(c) > 0);
}

// ------------------------------------------------------------------ API
// Where is the game server? In order: ?server=… in the URL, the Mac serving this page itself,
// /server.json published by scripts/play-online.sh on each run, or an address saved from the ⚙️ dialog.
function stored(k) { try { return localStorage.getItem(k) || ""; } catch { return ""; } }
function store(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* storage unavailable */ } }
const ACCESS_KEY = stored("go.key");
let API_BASE = "", SERVER_SOURCE = "same";          // "param" | "same" | "published" | "saved" | "none"
async function isGameServer(base) {
  try {
    const r = await fetch(base + "/api/status", { cache: "no-store" });
    return (r.headers.get("Content-Type") || "").includes("application/json");
  } catch { return false; }
}
const serverReady = (async () => {
  const param = new URL(location.href).searchParams.get("server");
  if (param && /^https?:\/\//.test(param)) {
    API_BASE = param.replace(/\/+$/, ""); SERVER_SOURCE = "param"; store("go.server", API_BASE); return;
  }
  if (await isGameServer("")) return;                 // this page is served by the Mac itself
  try {
    const r = await fetch("/server.json", { cache: "no-store" });
    if (r.ok) {
      S.published = await r.json();
      if (S.published.server) { API_BASE = S.published.server.replace(/\/+$/, ""); SERVER_SOURCE = "published"; return; }
    }
  } catch { /* not published */ }
  API_BASE = stored("go.server");
  SERVER_SOURCE = API_BASE ? "saved" : "none";
})();
async function api(path, body) {
  await serverReady;
  const headers = { "Content-Type": "application/json" };
  if (ACCESS_KEY) headers["X-Go-Key"] = ACCESS_KEY;
  const r = await fetch(API_BASE + path, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get("Content-Type") || "";
  if (!ct.includes("application/json")) throw new Error(`no game server at ${API_BASE || location.origin}`);
  return r.json();
}
function analyze(extra) {
  if (S.online) return api("/api/room/analyze", { code: S.online.code, token: S.online.token });
  return api("/api/analyze", {
    size: S.size, komi: S.komi, moves: S.moves.map(([c, m]) => [colorChar(c), m]),
    initialStones: S.initialStones.map(([c, m]) => [colorChar(c), m]),
    initialPlayer: colorChar(S.first), ...extra,
  });
}

async function pollStatus() {
  try {
    const s = await api("/api/status");
    const el = $("#engine");
    el.classList.toggle("ok", s.ready && s.alive);
    el.classList.toggle("err", !s.alive);
    const net = s.model.replace(/\.bin\.gz$/, "").replace(/-s\d+-d\d+$/, "");
    $("#engineText").textContent = !s.alive ? "AI หยุดทำงาน — ดู logs/" : s.ready ? `พร้อม · ${net}${s.llm ? " · " + s.llm : ""}` : "กำลังวอร์มอัพ AI (ครั้งแรก ~30 วิ)…";
    S.llm = s.llm;
    Object.assign(S, { isLocal: s.local, full: s.full, serverOnline: s.online, lanUrl: s.lanUrl, publicUrl: s.publicUrl, frontendUrl: s.frontendUrl });
    $("#btnServer").classList.toggle("hidden", !!s.local);
    $("#btnServer").textContent = s.full ? "🔑 เชื่อมต่อแล้ว" : SERVER_SOURCE === "published" ? "🔑 รหัสเข้าถึง" : "⚙️ เซิร์ฟเวอร์";
    if (S.online) renderRoomBar();
    if ($("#dlgNew").open) syncDialog();
    $("#assistSub").textContent = `KataGo ${net} (ตัวเดียวกับคู่แข่ง)${s.llm ? " + " + s.llm : ""}`;
    if (!s.ready && s.alive) setTimeout(pollStatus, 1500);
  } catch {
    const offline = S.published && !S.published.server;
    $("#engineText").textContent = offline ? "🔴 เซิร์ฟเวอร์ของเจ้าของเกมปิดอยู่ตอนนี้"
      : SERVER_SOURCE === "published" ? "กำลังเชื่อมต่อ Mac ของเจ้าของเกม… (ถ้านานเกิน 1 นาที แปลว่าเซิร์ฟเวอร์ปิดอยู่)"
      : API_BASE ? "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ (Mac ปิดอยู่หรือ tunnel หมดอายุ?)" : "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้";
    $("#engine").classList.add("err");
    $("#btnServer").classList.remove("hidden");
    // only ask for an address when nothing tells us where the server is
    if (!S.serverAsked && SERVER_SOURCE !== "published" && !offline && !["localhost", "127.0.0.1"].includes(location.hostname)) {
      S.serverAsked = true; openServerDialog();
    }
    if (offline && $("#dlgNew").open) $("#dlgNew").close();
    setTimeout(pollStatus, offline ? 15000 : 3000);
  }
}

// ------------------------------------------------------------------ game flow
function newGame(opts) {
  Object.assign(S, opts);
  S.gen++;
  api("/api/cancel", { channel: "ai" }); api("/api/cancel", { channel: "assist" });
  const b = new Board(S.size);
  S.initialStones = [];
  if (S.handicap >= 2) {
    for (const [x, y] of handicapPoints(S.size, S.handicap)) { b.grid[b.idx(x, y)] = BLACK; S.initialStones.push([BLACK, toGTP(x, y, S.size)]); }
    S.first = WHITE;
  } else S.first = BLACK;
  Object.assign(S, { boards: [b], moves: [], pre: {}, preDone: {}, wr: [], latest: null, lastReview: null, paused: false, thinking: false,
    over: false, result: null, lowStreak: { [BLACK]: 0, [WHITE]: 0 }, reviewed: new Set(), losses: [], showOwner: false, finalOwnership: null,
    preview: null, chatLog: [], stats: {} });
  $("#btnOwner").classList.remove("on");
  $("#feed").innerHTML = "";
  $("#nameB").textContent = playerName(BLACK);
  $("#nameW").textContent = playerName(WHITE);
  const who = (c) => `${stoneEmoji(c)} ${isRemote(c) ? playerName(c) : `P${pNum(c)} ${isAI(c) ? `AI ${levelName(c)}${pl(c).level === "super" ? ` (${pl(c).visits} visits)` : ""}` : `${solo() ? "คุณ" : "คน"} · ผู้ช่วย${assistName(assistFor(c))}`}`}`;
  const modeLine = { hva: "คน vs AI", hvh: "คน vs คน (ผลัดกันเดินบนเครื่องนี้)", ava: "AI vs AI (ดูอย่างเดียว)",
    online: `ออนไลน์ · ห้อง ${S.online?.code}${humans().length ? "" : " (ผู้ชม)"}` }[mode()];
  post({ cls: "hint", title: `เริ่มเกมใหม่ · ${modeLine}`, lines: [
    `กระดาน ${S.size}×${S.size} · โคมิ ${S.komi}${S.handicap ? ` · ต่อ ${S.handicap} เม็ด` : ""}`,
    `${who(BLACK)} vs ${who(WHITE)}`,
    mode() === "ava" ? "กด ⏸ เพื่อหยุดดูตำแหน่ง · แท็บ 📈 เทียบ AI จะเทียบความคิดของ AI ทั้งสองฝั่ง"
      : "กด 💡 หรือปุ่ม H เพื่อดูท่าแนะนำบนกระดาน · ชี้เมาส์ที่วงกลมเพื่อดูลำดับที่ AI อ่านไว้",
  ] });
  resize();
  for (const [c, m] of opts.replay || []) play(charColor(c), m);
  delete S.replay;
  nextTurn();
}

function nextTurn() {
  updateUI();
  if (S.over) return;
  if (isAI(toPlay())) {
    if (S.paused) return;
    if (mode() === "ava") { const gen = S.gen; setTimeout(() => { if (gen === S.gen && !S.paused && !S.thinking) aiMove(); }, 700); }
    else aiMove();
  } else if (isRemote(toPlay())) {
    quietReview();                       // review my last move while the opponent thinks
  } else if (assistFor(toPlay()) > 0) {
    if ($("#coachOn").checked || S.showHints) startAssist();
  } else quietReview();
  refreshTab();
}

const now = () => Date.now() / 1000;
const toPlayAt = (k) => (k % 2 === 0 ? S.first : other(S.first));
function busy(kind) {
  const a = { kind, t0: now(), t1: null };
  S.activity.push(a);
  if (S.activity.length > 400) S.activity.splice(0, 100);
  return () => { a.t1 = now(); };
}
function topHuman(hp) {
  const N = S.size * S.size, idx = [...hp.keys()].filter((i) => hp[i] > 0).sort((x, y) => hp[y] - hp[x]).slice(0, 5);
  return idx.map((i) => ({ move: i === N ? "pass" : toGTP(i % S.size, (i / S.size) | 0, S.size), p: hp[i] }));
}
function record(side, res, k) {
  const r = res.rootInfo, st = res._stats || {};
  const total = res.moveInfos.reduce((s, m) => s + m.visits, 0) || 1;
  S.stats[k] = {
    side, k, color: toPlayAt(k), wr: X.wrFor(r, me()), score: X.scoreFor(r, me()),
    visits: st.visits ?? r.visits, ms: st.ms || 0, vps: st.vps || 0,
    top: res.moveInfos.slice(0, 5).map((m) => ({ move: m.move, share: m.visits / total, visits: m.visits, wr: X.wrFor(m, me()), score: X.scoreFor(m, me()), pv: m.pv })),
    human: res.humanPolicy ? topHuman(res.humanPolicy) : null,
  };
  return S.stats[k];
}

function startAssist() {
  const k = n(), visits = assistFor(toPlay());
  if (S.pre[k]) return S.pre[k];
  if (!visits) return Promise.resolve(null);
  const gen = S.gen, done = busy("assist");
  S.pre[k] = analyze({ channel: "assist", maxVisits: visits, ownership: true }).then((res) => {
    done();
    if (gen !== S.gen || res.error || !res.rootInfo) { if (gen === S.gen) delete S.pre[k]; return null; }
    S.preDone[k] = res;
    record("assist", res, k);
    if (k > 0 && isHuman(S.moves[k - 1]?.[0])) reviewMove(k - 1, res);
    refreshTab();
    S.wr[k] = res.rootInfo.winrate;
    if (k === n()) { S.latest = { n: k, res }; updateEval(); draw(); }
    return res;
  });
  return S.pre[k];
}

function play(color, gtp) {
  const b = board().clone();
  if (gtp === "pass") b.pass();
  else {
    const p = fromGTP(gtp, S.size);
    if (b.play(p.x, p.y, color) === null) return false;
  }
  S.boards.push(b);
  S.moves.push([color, gtp]);
  return true;
}

function humanPlay(gtp) {
  if (S.over || S.thinking || !isHuman(toPlay())) return;
  const k = n(), color = toPlay();
  if (gtp !== "pass") {
    const p = fromGTP(gtp, S.size);
    if (!board().isLegal(p.x, p.y, color)) return flash("จุดนี้เล่นไม่ได้ (ผิดกติกา: ฆ่าตัวตายหรือโกะ)");
  }
  if (S.online) return roomMove(gtp, k);
  // stop the assistant search early; its partial result is still used for the move review
  if (S.pre[k] && !S.preDone[k]) api("/api/cancel", { channel: "assist" });
  const prevAi = S.stats[k - 1];
  if (prevAi?.side === "ai" && prevAi.predicted) prevAi.hit = prevAi.predicted === gtp;
  play(color, gtp);
  S.preview = null;
  if (gtp === "pass" && k > 0 && S.moves[k - 1][1] === "pass") return endGame();
  nextTurn();
}

async function aiMove() {
  const gen = S.gen, k = n(), me_ = toPlay(), cfg = pl(me_);
  S.thinking = true; updateUI();
  const human = cfg.level !== "super", done = busy("ai");
  const res = await analyze({ channel: "ai", ownership: true, maxVisits: human ? 300 : cfg.visits, ...(human ? { humanProfile: cfg.level } : {}) });
  done();
  if (gen !== S.gen) return;
  S.thinking = false;
  if (res.error || !res.rootInfo) { updateUI(); return flash(res.error === "forbidden" ? "ต้องใส่รหัสเข้าถึง (⚙️ เซิร์ฟเวอร์) เพื่อเล่นกับ AI" : "AI ผิดพลาด: " + (res.error || "no result")); }
  S.wr[k] = res.rootInfo.winrate;
  S.latest = { n: k, res };
  const rec = record("ai", res, k);

  // review the human's previous move with this (post-move) evaluation
  if (k > 0 && isHuman(S.moves[k - 1][0])) reviewMove(k - 1, res);

  // resign?
  const aiWr = X.wrFor(res.rootInfo, me_);
  S.lowStreak[me_] = aiWr < 0.03 ? S.lowStreak[me_] + 1 : 0;
  if (S.aiResign && S.lowStreak[me_] >= 3 && k > (S.size * S.size) / 6) return endGame({ resign: me_ });

  let mv = human ? pickHuman(res, k, me_) : res.moveInfos[0].move;
  if (mv !== "pass") {
    const p = fromGTP(mv, S.size);
    if (!board().isLegal(p.x, p.y, me_)) mv = res.moveInfos.find((m) => m.move === "pass" || (() => { const q = fromGTP(m.move, S.size); return board().isLegal(q.x, q.y, me_); })())?.move || "pass";
  }
  const prevRec = S.stats[k - 1];
  if (prevRec?.side === "ai" && prevRec.predicted) prevRec.hit = prevRec.predicted === mv;   // AI vs AI: did the other AI see this coming?
  play(me_, mv);
  // who predicted what: the assistant's line for the human's move vs the AI's actual reply, and the AI's expected answer
  rec.played = mv;
  rec.predicted = res.moveInfos.find((m) => m.move === mv)?.pv?.[1] || null;
  const pre = S.preDone[k - 1], humanMv = S.moves[k - 1]?.[1];
  const mi = pre?.moveInfos.find((m) => m.move === humanMv);
  if (mi?.pv?.[1]) { rec.assistPredicted = mi.pv[1]; rec.assistHit = mi.pv[1] === mv; }
  if (mi && mi.visits >= 20) rec.assistView = { wr: X.wrFor(mi, me()), score: X.scoreFor(mi, me()) };
  refreshTab();
  if (mv === "pass") {
    if (k > 0 && S.moves[k - 1][1] === "pass") return endGame();
    post({ cls: "hint", title: `${stoneEmoji(me_)} AI ผ่าน (pass)`, lines: [mode() === "ava" ? "AI คิดว่าไม่มีจุดที่ได้ประโยชน์แล้ว" : "AI คิดว่าไม่มีจุดที่ได้ประโยชน์แล้ว ถ้าเห็นด้วยให้กด ‘ผ่าน’ เพื่อจบเกมและนับแต้ม"] });
  }
  nextTurn();
}

function pickHuman(res, k, color) {
  if (k > 0 && S.moves[k - 1][1] === "pass" && res.moveInfos[0]?.move === "pass") return "pass";
  const hp = res.humanPolicy, N = S.size * S.size, b = board();
  if (!hp) return res.moveInfos[0].move;
  if (hp[N] > 0.5) return "pass";
  const max = Math.max(...hp.slice(0, N));
  const cand = [];
  for (let i = 0; i < N; i++) {
    if (hp[i] <= 0 || hp[i] < max * 0.02) continue;
    const x = i % S.size, y = (i / S.size) | 0;
    if (b.isLegal(x, y, color)) cand.push([i, hp[i]]);
  }
  if (!cand.length) return "pass";
  let r = Math.random() * cand.reduce((a, c) => a + c[1], 0);
  for (const [i, p] of cand) { r -= p; if (r <= 0) return toGTP(i % S.size, (i / S.size) | 0, S.size); }
  const [i] = cand[cand.length - 1];
  return toGTP(i % S.size, (i / S.size) | 0, S.size);
}

function quietReview() {
  const k = n() - 1;
  if (k < 0 || !$("#coachOn").checked || !S.pre[k] || S.reviewed.has(k) || !isHuman(S.moves[k][0])) return;
  const gen = S.gen;
  analyze({ channel: "assist", maxVisits: Math.min(assistFor(S.moves[k][0]), 1000) }).then((res) => {
    if (gen === S.gen && res.rootInfo) reviewMove(k, res, true);
  });
}

async function reviewMove(k, postRes, quiet = false) {
  if (!$("#coachOn").checked || !S.pre[k] || S.reviewed.has(k)) return;
  S.reviewed.add(k);
  const pre = await S.pre[k];
  if (!pre || !pre.moveInfos?.length) return;
  const color = S.moves[k][0], gtp = S.moves[k][1];
  const best = pre.moveInfos[0];
  const mi = pre.moveInfos.find((m) => m.move === gtp);
  let after, wrAfter;
  if (mi && mi.visits >= Math.max(8, best.visits * 0.05)) { after = X.scoreFor(mi, color); wrAfter = X.wrFor(mi, color); }
  else { after = X.scoreFor(postRes.rootInfo, color); wrAfter = X.wrFor(postRes.rootInfo, color); }
  const bestScore = X.scoreFor(best, color), wrBefore = X.wrFor(best, color);
  const loss = Math.max(0, bestScore - after);
  const c = gtp === best.move ? X.classify(0) : X.classify(loss);
  const prevBoard = S.boards[k];
  const lines = [];
  if (gtp === best.move) lines.push("ตรงกับท่าที่ดีที่สุดของ AI เลย! 🎯");
  else {
    lines.push(`เสียไปประมาณ <b>${loss.toFixed(1)}</b> แต้ม · โอกาสชนะ ${X.pct(wrBefore)} → ${X.pct(wrAfter)}`);
    if (loss > 0.4) {
      lines.push(`ท่าที่ดีที่สุดคือ ${mvLink(best.move, best.pv, color)} — ${X.where(best.move, S.size)}`);
      const bp = fromGTP(best.move, S.size);
      if (bp) for (const t of X.tactics(prevBoard, bp.x, bp.y, color).slice(0, 3)) lines.push(`• ${t}`);
      const rank = pre.moveInfos.findIndex((m) => m.move === gtp);
      if (rank > 0) lines.push(`ท่านี้เป็นตัวเลือกอันดับ ${rank + 1} ของ AI`);
    }
    if (!quiet && loss >= 3 && postRes.moveInfos?.[0]?.pv && (isHuman(other(color)) || pl(other(color)).level === "super")) {
      lines.push(`${isAI(other(color)) ? "AI จะลงโทษด้วย" : "ฝ่ายตรงข้ามควรตอบด้วย"}: ${mvLink(postRes.moveInfos[0].move, postRes.moveInfos[0].pv, other(color))} ${X.pvText(postRes.moveInfos[0].pv, other(color), 5)}`);
    }
  }
  if (gtp !== "pass") {
    const p = fromGTP(gtp, S.size);
    const own = X.tactics(prevBoard, p.x, p.y, color);
    if (own.length && gtp !== best.move) lines.push(`ท่าที่เล่น: ${own.join(", ")}`);
  }
  S.lastReview = { k, gtp, loss, best: best.move, label: c.label, wrBefore, wrAfter, bestPv: best.pv, color };
  S.losses.push({ k, color, loss: gtp === best.move ? 0 : loss });
  refreshTab();
  const tag = mode() === "hvh" ? `${stoneEmoji(color)} P${pNum(color)} ` : "";
  post({ cls: c.key, title: `${c.emoji} ${tag}ท่าที่ ${k + 1}: ${gtp === "pass" ? "ผ่าน" : gtp} — ${c.label}`, sub: `${pts(-loss)}`, lines });
}
const pts = X.pts;

async function endGame(opts = {}) {
  S.over = true; S.thinking = false; S.gen++;
  if (opts.resign) {
    const winner = other(opts.resign);
    S.result = `${colorChar(winner)}+R`;
    updateUI();
    return showResult(winTitle(winner), `${X.colorName(opts.resign)} (${playerName(opts.resign)}) ยอมแพ้${isAI(opts.resign) ? " — AI เห็นว่าไม่มีทางพลิกเกมแล้ว" : ""}`);
  }
  updateUI();
  flash("กำลังนับแต้ม…");
  const res = await analyze({ channel: "final", maxVisits: 1500, ownership: true });
  if (res.error || !res.rootInfo) return showResult("จบเกม", "นับแต้มไม่สำเร็จ: " + res.error);
  const lead = res.rootInfo.scoreLead;
  const margin = Math.max(0.5, Math.round(Math.abs(lead) - 0.5) + 0.5);
  const winner = lead > 0 ? BLACK : WHITE;
  S.result = `${colorChar(winner)}+${margin}`;
  S.finalOwnership = res.ownership; S.showOwner = true;
  $("#btnOwner").classList.add("on");
  const t = X.territory(res.ownership, S.size);
  draw(); updateUI();
  showResult(winTitle(winner),
    `${X.colorName(winner)}ชนะ ${margin} แต้ม (กติกาจีน, โคมิ ${S.komi})\nพื้นที่+หมากโดยประมาณ: ดำ ${t.b} · ขาว ${t.w}\nจุดบนกระดานแสดงเจ้าของพื้นที่ · หมากที่มีกากบาทคือหมากตาย`);
}
function winTitle(w) {
  if (mode() === "online") return isHuman(w) ? "🎉 คุณชนะ!" : `${stoneEmoji(w)} ${playerName(w)} ชนะ`;
  if (mode() === "hva") return isHuman(w) ? "🎉 คุณชนะ!" : "AI ชนะ";
  if (mode() === "hvh") return `🎉 ผู้เล่น ${pNum(w)} (${X.colorName(w)}) ชนะ!`;
  return `${stoneEmoji(w)} AI ${X.colorName(w)} (${levelName(w)}) ชนะ`;
}
function showResult(title, body) {
  $("#resTitle").textContent = title; $("#resBody").textContent = body;
  $("#dlgResult").showModal();
  post({ cls: "hint", title: `🏁 ${title}`, lines: [escapeHtml(body).replace(/\n/g, "<br>")] });
}

function undo() {
  if (!S.moves.some(([c]) => isHuman(c))) return;
  S.gen++; S.thinking = false; S.over = false; S.result = null; S.finalOwnership = null; S.lowStreak = { [BLACK]: 0, [WHITE]: 0 };
  api("/api/cancel", { channel: "ai" });
  while (S.moves.length) { const [c] = S.moves.pop(); S.boards.pop(); if (isHuman(c)) break; }
  for (const k of [...S.reviewed]) if (k >= n()) S.reviewed.delete(k);
  S.losses = S.losses.filter((l) => l.k < n());
  for (const k of Object.keys(S.pre)) if (+k > n()) { delete S.pre[k]; delete S.preDone[k]; }
  if (S.pre[n()] && !S.preDone[n()]) delete S.pre[n()];
  S.wr.length = n() + 1;
  for (const k of Object.keys(S.stats)) if (+k > n()) delete S.stats[k];
  if (S.stats[n() - 1]) delete S.stats[n() - 1].hit;
  S.latest = S.preDone[n()] ? { n: n(), res: S.preDone[n()] } : null;
  post({ cls: "hint", title: "↩︎ ย้อนกลับ", lines: [`กลับไปที่ท่าที่ ${n()}`] });
  nextTurn();
}

// ------------------------------------------------------------------ assistant: hints & chat
async function requestHint(silent) {
  if (S.over) return;
  S.showHints = true; $("#btnHint").classList.add("on"); draw();
  if (!isHuman(toPlay())) return flash(`รอ${isRemote(toPlay()) ? "คู่แข่ง" : " AI "}เดินก่อน แล้วจะแสดงคำแนะนำ`);
  if (!assistFor(toPlay())) { S.showHints = false; $("#btnHint").classList.remove("on"); return flash(`${playerName(toPlay())} ปิดผู้ช่วยไว้`); }
  const k = n();
  const pending = post({ cls: "pending", title: "กำลังวิเคราะห์…", lines: [] });
  const res = await startAssist();
  pending.remove();
  if (!res || k !== n()) return;
  if (!silent) post(hintCard(res));
}
function hintCard(res) {
  const color = toPlay(), b = board();
  const top = res.moveInfos.filter((m) => m.visits >= Math.max(3, res.moveInfos[0].visits * 0.03)).slice(0, 3);
  const best = top[0];
  const lines = X.explainMove(b, best, color, res);
  if (top.length > 1) {
    lines.push("ตัวเลือกอื่น:");
    for (const m of top.slice(1)) lines.push(`• ${mvLink(m.move, m.pv, color)} — ${X.where(m.move, S.size)} · ชนะ ${X.pct(X.wrFor(m, color))} · ${pts(X.scoreFor(m, color))} (ด้อยกว่า ${(X.scoreFor(best, color) - X.scoreFor(m, color)).toFixed(1)} แต้ม)`);
  }
  return { cls: "hint", title: `💡 ท่าแนะนำ: ${best.move}`, sub: `${best.visits} visits`, lines, rawLines: false, bestMove: best };
}

function ruleAnswer(q, res) {
  const b = board(), color = isHuman(toPlay()) ? toPlay() : me();
  const lines = [];
  const wantMove = /ตรงไหน|เล่น|ควร|แนะนำ|ท่า(ไหน|ต่อ)|where|move/i.test(q) && !/ล่าสุด/.test(q);
  const wantGroup = /กลุ่ม|อันตราย|ตาย|อ่อน|รอด/.test(q);
  const wantLast = /ล่าสุด|พลาด|ผิด|last/.test(q);
  if (wantLast) {
    const r = S.lastReview;
    if (!r) lines.push("ยังไม่มีท่าของคุณที่ถูกวิเคราะห์ (เปิด ‘โค้ชอัตโนมัติ’ ไว้แล้วเดินหนึ่งท่า)");
    else {
      lines.push(`ท่าที่ ${r.k + 1} (${r.gtp}) ถูกจัดเป็น “${r.label}” เสียไป ${r.loss.toFixed(1)} แต้ม`);
      if (r.gtp !== r.best) lines.push(`ท่าที่ AI เลือกคือ ${mvLink(r.best, r.bestPv, color)}: ${X.pvText(r.bestPv, color, 6)}`);
    }
  }
  if (!res) { lines.push("ตอนนี้ยังไม่มีผลวิเคราะห์ของตำแหน่งนี้"); return lines; }
  const sit = X.situation(b, res, color);
  if (wantGroup) {
    const g = sit.slice(2);
    lines.push(...(g.length ? g : ["ตอนนี้ไม่มีกลุ่มหมากที่อ่อนแออย่างชัดเจน ทุกกลุ่มค่อนข้างปลอดภัย"]));
  }
  if (wantMove && isHuman(toPlay())) {
    const h = hintCard(res);
    lines.push(`<b>${h.title}</b>`, ...h.lines);
  }
  if (!wantMove && !wantGroup && !wantLast) lines.push(...sit);
  else if (!wantGroup) lines.unshift(sit[0]);
  return lines;
}

function llmContext(res) {
  const b = board(), color = isHuman(toPlay()) ? toPlay() : me(), parts = [];
  const desc = (c) => `${X.colorName(c)} (${c === BLACK ? "X" : "O"}) = ${isAI(c) ? `AI ${levelName(c)}` : mode() === "hva" ? "ผู้ใช้" : `ผู้เล่นคนที่ ${pNum(c)}`}`;
  parts.push(`กระดาน ${S.size}x${S.size}, กติกาจีน, โคมิ ${S.komi}. ${desc(BLACK)}, ${desc(WHITE)}. ผู้ที่กำลังถามคือฝ่าย${X.colorName(color)}. ตาเดินถัดไป: ${X.colorName(toPlay())}. ท่าที่ ${n()}.`);
  parts.push("กระดาน (X=ดำ, O=ขาว):\n" + X.boardAscii(b));
  parts.push("10 ท่าล่าสุด: " + S.moves.slice(-10).map(([c, m]) => `${colorChar(c)} ${m}`).join(", "));
  if (res) {
    parts.push(...X.situation(b, res, color));
    const whoMoves = toPlay();
    parts.push(`ตัวเลือกของ KataGo สำหรับ${X.colorName(whoMoves)} (ตัวเลขจากมุมมองฝ่าย${X.colorName(color)}):`);
    for (const m of res.moveInfos.slice(0, 5)) {
      const p = fromGTP(m.move, S.size);
      const tac = p ? X.tactics(b, p.x, p.y, whoMoves).join("; ") : "";
      parts.push(`- ${m.move} [${X.where(m.move, S.size)}] ชนะ ${X.pct(X.wrFor(m, color))}, แต้ม ${pts(X.scoreFor(m, color))}, visits ${m.visits}, PV: ${m.pv.slice(0, 8).join(" ")}${tac ? " | " + tac : ""}`);
    }
  }
  if (S.lastReview) {
    const r = S.lastReview;
    parts.push(`รีวิวท่าล่าสุดของผู้ใช้: ท่าที่ ${r.k + 1} เล่น ${r.gtp} = ${r.label}, เสีย ${r.loss.toFixed(1)} แต้ม, ท่าที่ดีที่สุดคือ ${r.best} (PV ${r.bestPv.slice(0, 6).join(" ")})`);
  }
  return parts.join("\n");
}

async function ask(q) {
  q = q.trim();
  if (!q) return;
  post({ cls: "user", lines: [escapeHtml(q)] });
  if (!helpAllowed()) {
    post({ cls: "hint", title: "🧠 ผู้ช่วย", lines: [`${isHuman(toPlay()) ? playerName(toPlay()) : "คุณ"} ปิดผู้ช่วยไว้ในเกมนี้ — จะตอบได้หลังจบเกม`] });
    return;
  }
  let res = isHuman(toPlay()) && !S.over ? await startAssist() : S.latest?.res;
  if (S.over && S.finalOwnership) res = S.latest?.res;
  if (/ตรงไหน|ควรเล่น|แนะนำ/.test(q)) { S.showHints = true; $("#btnHint").classList.add("on"); draw(); }
  if (!S.llm) {
    post({ cls: "hint", title: "🧠 ผู้ช่วย", lines: ruleAnswer(q, res) });
    return;
  }
  const pending = post({ cls: "pending", title: `${S.llm} กำลังเรียบเรียงคำตอบ…`, lines: [] });
  const sys = "คุณคือโค้ชหมากล้อม (Go/Baduk/Weiqi) ภาษาไทยที่เป็นกันเอง อธิบายชัด กระชับ ใช้ศัพท์หมากล้อมที่ถูกต้อง " +
    "ข้อมูลวิเคราะห์ด้านล่างมาจาก KataGo ซึ่งแข็งแกร่งระดับเหนือมนุษย์ ให้ยึดตัวเลขและท่าจาก KataGo เท่านั้น ห้ามแต่งพิกัดหรือท่าขึ้นมาเอง " +
    "เวลาพูดถึงพิกัดให้ใช้รูปแบบเดียวกับข้อมูล (เช่น Q16) อธิบายเหตุผลเชิงกลยุทธ์ (พื้นที่, ความแข็งแรงของกลุ่ม, ลมหายใจ, เซนเต/โกเต, อิทธิพล) ตอบไม่เกิน 8 บรรทัด";
  const ctxMsg = { role: "user", content: "ข้อมูลตำแหน่งปัจจุบัน:\n" + llmContext(res) };
  const msgs = [{ role: "system", content: sys }, ctxMsg, { role: "assistant", content: "รับทราบ ผมจะอ้างอิงเฉพาะข้อมูล KataGo นี้" },
    ...S.chatLog.slice(-6), { role: "user", content: q }];
  const llmDone = busy("llm");
  const out = S.online ? await api("/api/room/ask", { code: S.online.code, token: S.online.token, messages: msgs })
    : await api("/api/chat", { messages: msgs });
  llmDone();
  pending.remove();
  if (out.error) {
    post({ cls: "hint", title: "🧠 ผู้ช่วย (โหมดพื้นฐาน)", lines: ruleAnswer(q, res) });
    return;
  }
  S.chatLog.push({ role: "user", content: q }, { role: "assistant", content: out.text });
  post({ cls: "hint", title: `🧠 ${out.model}`, lines: [linkifyMoves(escapeHtml(out.text)).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/^\s*[*-] /gm, "• ").replace(/\n/g, "<br>")] });
}

// ------------------------------------------------------------------ feed helpers
function escapeHtml(s) { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function mvLink(move, pv, color) {
  return `<span class="mv" data-pv="${(pv || [move]).slice(0, 12).join(" ")}" data-c="${color}">${move}</span>`;
}
function linkifyMoves(html) {
  const re = new RegExp(`\\b([A-HJ-T](?:1[0-9]|[1-9]))\\b`, "g");
  return html.replace(re, (m) => { const p = fromGTP(m, S.size); return p.x < S.size && p.y >= 0 ? mvLink(m, [m], toPlay()) : m; });
}
function post({ cls = "", title, sub, lines }) {
  const d = document.createElement("div");
  d.className = `msg ${cls}`;
  d.innerHTML = (title ? `<div class="t"><span>${title}</span>${sub ? `<small>${sub}</small>` : ""}</div>` : "") +
    (lines.length ? `<ul>${lines.map((l) => `<li>${l}</li>`).join("")}</ul>` : "");
  const feed = $("#feed");
  feed.appendChild(d);
  feed.scrollTop = feed.scrollHeight;
  return d;
}
let flashTimer;
function flash(msg) {
  const t = $("#turn"); t.textContent = msg; t.style.color = "var(--danger)";
  clearTimeout(flashTimer); flashTimer = setTimeout(() => { t.style.color = ""; updateUI(); }, 2200);
}
$("#feed").addEventListener("mouseover", (e) => {
  const el = e.target.closest(".mv"); if (!el) return;
  S.preview = { pv: el.dataset.pv.split(" "), color: +el.dataset.c }; draw();
});
$("#feed").addEventListener("mouseout", (e) => { if (e.target.closest(".mv")) { S.preview = null; draw(); } });

// ------------------------------------------------------------------ UI
function updateUI() {
  const t = toPlay();
  $("#pB").classList.toggle("active", !S.over && t === BLACK);
  $("#pW").classList.toggle("active", !S.over && t === WHITE);
  $("#capB").textContent = board().captures[BLACK];
  $("#capW").textContent = board().captures[WHITE];
  const thinkingText = mode() === "ava" ? `AI ${X.colorName(t)} กำลังคิด…` : "AI กำลังคิด…";
  const roomStatus = S.online?.state?.status;
  $("#turn").textContent = S.over ? `จบเกม ${S.result || ""}` : S.paused ? "⏸ หยุดชั่วคราว" : S.thinking ? thinkingText
    : roomStatus === "waiting" ? "⏳ รอเพื่อนเข้าห้อง…" : roomStatus === "scoring" ? "กำลังนับแต้ม…"
    : isRemote(t) ? `รอ ${playerName(t)} ${stoneEmoji(t)} เดิน…`
    : isHuman(t) ? (solo() ? `ตาคุณ (ท่าที่ ${n() + 1})` : `ตา${playerName(t)} ${stoneEmoji(t)} (ท่าที่ ${n() + 1})`) : `ตา AI ${X.colorName(t)}`;
  $("#thinkingText").textContent = thinkingText;
  $("#thinking").classList.toggle("hidden", !S.thinking);
  $("#btnPause").classList.toggle("hidden", mode() !== "ava" || S.over);
  $("#btnPause").textContent = S.paused ? "▶ เล่นต่อ" : "⏸ หยุด";
  const myTurn = !S.over && !S.thinking && isHuman(t) && (!S.online || roomStatus === "playing");
  $("#btnPass").disabled = !myTurn;
  $("#btnResign").disabled = S.over;
  $("#btnHint").disabled = S.over;
  $("#btnUndo").disabled = !!S.online || !S.moves.some(([c]) => isHuman(c));
  $("#btnResign").disabled = S.over || mode() === "ava" || (mode() === "hva" && S.thinking) || (mode() === "online" && !humans().length);
  $("#btnHint").disabled = S.over || mode() === "ava" || (isHuman(t) && !assistFor(t)) || (!!S.online && !humans().some(assistFor));
  $("#btnOwner").disabled = !helpAllowed();
  $("#assistSub").textContent = mode() === "ava" ? "โหมด AI vs AI" : !humans().length ? "ผู้ชมใช้ผู้ช่วยไม่ได้"
    : humans().map((c) => `${solo() ? "ผู้ช่วยของคุณ" : `P${pNum(c)}`}: ${assistName(assistFor(c))}`).join(" · ");
  $("#chatToRow").classList.toggle("hidden", !S.online);
  updateEval();
  draw();
}
function updateEval() {
  const locked = !helpAllowed();
  $(".card.eval").classList.toggle("locked", locked);
  if (locked) {
    $("#wrLabelB").textContent = "ดำ –"; $("#wrLabelW").textContent = "ขาว –"; $("#wrB").style.width = "50%";
    $("#scoreText").textContent = "🙈 ซ่อน (ปิดผู้ช่วย)";
    const g = $("#graph"); g.getContext("2d").clearRect(0, 0, g.width, g.height);
    return;
  }
  const r = S.latest?.res?.rootInfo;
  if (!r) $("#scoreText").textContent = "—";
  if (!r && !n()) {
    $("#wrB").style.width = "50%"; $("#wrLabelB").textContent = "ดำ –"; $("#wrLabelW").textContent = "ขาว –"; $("#scoreText").textContent = "—";
  }
  if (r) {
    const b = r.winrate;
    $("#wrB").style.width = `${b * 100}%`;
    $("#wrLabelB").textContent = `ดำ ${(b * 100).toFixed(1)}%`;
    $("#wrLabelW").textContent = `ขาว ${((1 - b) * 100).toFixed(1)}%`;
    const lead = r.scoreLead;
    $("#scoreText").textContent = `${lead >= 0 ? "ดำ" : "ขาว"} นำ ${Math.abs(lead).toFixed(1)} แต้ม`;
  }
  drawGraph();
}
function drawGraph() {
  const g = $("#graph"), dpr = devicePixelRatio || 1, w = g.clientWidth, h = g.clientHeight;
  g.width = w * dpr; g.height = h * dpr;
  const c = g.getContext("2d"); c.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  c.strokeStyle = css.getPropertyValue("--line"); c.lineWidth = 1;
  c.beginPath(); c.moveTo(0, h / 2); c.lineTo(w, h / 2); c.stroke();
  const pts = S.wr.map((v, i) => [i, v]).filter(([, v]) => v !== undefined);
  if (pts.length < 2) return;
  const N = Math.max(n(), 20);
  c.beginPath();
  pts.forEach(([i, v], j) => { const x = (i / N) * w, y = (1 - v) * h; j ? c.lineTo(x, y) : c.moveTo(x, y); });
  c.strokeStyle = css.getPropertyValue("--accent"); c.lineWidth = 2; c.stroke();
  c.fillStyle = css.getPropertyValue("--muted"); c.font = "10px sans-serif";
  c.textAlign = "right"; c.fillText("ดำได้เปรียบ ▲", w - 4, 11); c.fillText("ขาวได้เปรียบ ▼", w - 4, h - 4);
}

// ------------------------------------------------------------------ board rendering
let geo = { cell: 0, pad: 0, px: 0 };
let hintSpots = [];
function resize() {
  const dpr = devicePixelRatio || 1, w = cv.clientWidth;
  cv.width = w * dpr; cv.height = w * dpr;
  geo.px = w * dpr; geo.cell = geo.px / (S.size + 0.9); geo.pad = geo.cell * 0.95;
  draw(); drawGraph();
}
const P = (i) => geo.pad + i * geo.cell;

function draw() {
  if (!S.boards.length) return;
  hintSpots = [];
  const b = board(), s = S.size, c = geo.cell, W = geo.px;
  const g = ctx.createLinearGradient(0, 0, W, W);
  g.addColorStop(0, "#e9c784"); g.addColorStop(1, "#d4a45a");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, W);
  ctx.globalAlpha = 0.06; ctx.strokeStyle = "#7a4e14";
  for (let i = 0; i < 40; i++) { ctx.lineWidth = 1 + (i % 3); ctx.beginPath(); const y = (i * 37.3) % W; ctx.moveTo(0, y); ctx.bezierCurveTo(W * 0.3, y + 12, W * 0.7, y - 10, W, y + 6); ctx.stroke(); }
  ctx.globalAlpha = 1;
  // grid
  ctx.strokeStyle = "#3b2a14"; ctx.lineWidth = Math.max(1, c * 0.03);
  for (let i = 0; i < s; i++) {
    ctx.beginPath(); ctx.moveTo(P(0), P(i)); ctx.lineTo(P(s - 1), P(i)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(P(i), P(0)); ctx.lineTo(P(i), P(s - 1)); ctx.stroke();
  }
  ctx.fillStyle = "#3b2a14";
  for (const [x, y] of starPoints(s)) { ctx.beginPath(); ctx.arc(P(x), P(y), c * 0.1, 0, 7); ctx.fill(); }
  // coordinates
  ctx.fillStyle = "rgba(59,42,20,.75)"; ctx.font = `${c * 0.3}px -apple-system, sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (let i = 0; i < s; i++) {
    ctx.fillText("ABCDEFGHJKLMNOPQRST"[i], P(i), geo.pad * 0.42);
    ctx.fillText("ABCDEFGHJKLMNOPQRST"[i], P(i), W - geo.pad * 0.42);
    ctx.fillText(String(s - i), geo.pad * 0.4, P(i));
    ctx.fillText(String(s - i), W - geo.pad * 0.4, P(i));
  }
  // ownership
  const own = S.finalOwnership || (S.showOwner && helpAllowed() ? S.latest?.res?.ownership : null);
  if (own && S.showOwner) {
    for (let i = 0; i < s * s; i++) {
      const o = own[i], x = i % s, y = (i / s) | 0;
      if (Math.abs(o) < 0.15) continue;
      const stone = b.grid[i];
      const dead = stone !== EMPTY && ((stone === BLACK && o < -0.5) || (stone === WHITE && o > 0.5));
      if (stone !== EMPTY && !dead) continue;
      ctx.globalAlpha = Math.min(1, Math.abs(o)) * 0.85;
      ctx.fillStyle = o > 0 ? "#111" : "#f7f4ec";
      const sz = c * 0.36;
      ctx.fillRect(P(x) - sz / 2, P(y) - sz / 2, sz, sz);
      ctx.globalAlpha = 1;
    }
  }
  // stones
  const previewSet = new Map();
  if (S.preview) {
    let col = S.preview.color;
    S.preview.pv.forEach((m, j) => { const p = fromGTP(m, s); if (p && !previewSet.has(b.idx(p.x, p.y))) previewSet.set(b.idx(p.x, p.y), { col, j: j + 1 }); col = other(col); });
  }
  for (let i = 0; i < s * s; i++) if (b.grid[i] !== EMPTY) stone(i % s, (i / s) | 0, b.grid[i], S.preview ? 0.55 : 1);
  // dead marks
  if (own && S.showOwner) for (let i = 0; i < s * s; i++) {
    const st = b.grid[i], o = own[i];
    if ((st === BLACK && o < -0.5) || (st === WHITE && o > 0.5)) {
      const x = P(i % s), y = P((i / s) | 0), r = c * 0.18;
      ctx.strokeStyle = st === BLACK ? "#fff" : "#000"; ctx.lineWidth = c * 0.07;
      ctx.beginPath(); ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); ctx.stroke();
    }
  }
  // last move marker
  const last = S.moves[S.moves.length - 1];
  if (last && last[1] !== "pass" && !S.preview) {
    const p = fromGTP(last[1], s);
    ctx.strokeStyle = last[0] === BLACK ? "#fff" : "#111"; ctx.lineWidth = c * 0.07;
    ctx.beginPath(); ctx.arc(P(p.x), P(p.y), c * 0.22, 0, 7); ctx.stroke();
  }
  // hints
  const pre = S.preDone[n()];
  if (S.showHints && pre && !S.over && isHuman(toPlay()) && !S.preview) drawHints(pre);
  // pv preview
  for (const [i, { col, j }] of previewSet) {
    const x = i % s, y = (i / s) | 0;
    if (b.grid[i] !== EMPTY) continue;
    stone(x, y, col, 0.85);
    ctx.fillStyle = col === BLACK ? "#fff" : "#111"; ctx.font = `600 ${c * 0.42}px -apple-system, sans-serif`;
    ctx.fillText(String(j), P(x), P(y) + c * 0.02);
  }
  // hover ghost
  if (S.hover && !S.over && !S.thinking && isHuman(toPlay()) && !S.preview && b.get(S.hover.x, S.hover.y) === EMPTY) stone(S.hover.x, S.hover.y, toPlay(), 0.45);
}

function stone(x, y, color, alpha) {
  const c = geo.cell, cx = P(x), cy = P(y), r = c * 0.48;
  ctx.globalAlpha = alpha;
  if (alpha === 1) { ctx.fillStyle = "rgba(0,0,0,.28)"; ctx.beginPath(); ctx.arc(cx + c * 0.05, cy + c * 0.07, r, 0, 7); ctx.fill(); }
  const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r);
  if (color === BLACK) { g.addColorStop(0, "#5a5a5a"); g.addColorStop(1, "#0b0b0b"); }
  else { g.addColorStop(0, "#ffffff"); g.addColorStop(1, "#d8d2c4"); }
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill();
  if (color === WHITE) { ctx.strokeStyle = "rgba(0,0,0,.25)"; ctx.lineWidth = 1; ctx.stroke(); }
  ctx.globalAlpha = 1;
}

function drawHints(res) {
  const color = toPlay(), c = geo.cell;
  const best = res.moveInfos[0];
  const top = res.moveInfos.filter((m) => m.move !== "pass" && m.visits >= Math.max(3, best.visits * 0.03)).slice(0, 6);
  top.forEach((m, idx) => {
    const p = fromGTP(m.move, S.size);
    const loss = X.scoreFor(best, color) - X.scoreFor(m, color);
    const col = idx === 0 ? "#2b8fd6" : loss < 1 ? "#3aa35c" : loss < 3 ? "#c9b12a" : loss < 6 ? "#e07b2a" : "#d2412f";
    ctx.globalAlpha = 0.88; ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(P(p.x), P(p.y), c * 0.46, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
    if (idx === 0) { ctx.strokeStyle = "#fff"; ctx.lineWidth = c * 0.06; ctx.stroke(); }
    ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = `600 ${c * 0.27}px -apple-system, sans-serif`;
    ctx.fillText((X.wrFor(m, color) * 100).toFixed(0), P(p.x), P(p.y) - c * 0.12);
    ctx.font = `${c * 0.22}px -apple-system, sans-serif`;
    ctx.fillText(idx === 0 ? X.pts(X.scoreFor(m, color)) : `-${loss.toFixed(1)}`, P(p.x), P(p.y) + c * 0.16);
    hintSpots.push({ x: p.x, y: p.y, pv: m.pv });
  });
}

// ------------------------------------------------------------------ input
function evToPoint(e) {
  const r = cv.getBoundingClientRect(), k = geo.px / r.width;
  const x = Math.round(((e.clientX - r.left) * k - geo.pad) / geo.cell);
  const y = Math.round(((e.clientY - r.top) * k - geo.pad) / geo.cell);
  return x >= 0 && y >= 0 && x < S.size && y < S.size ? { x, y } : null;
}
cv.addEventListener("mousemove", (e) => {
  const p = evToPoint(e);
  const key = p ? `${p.x},${p.y}` : "";
  if (key === (S.hover ? `${S.hover.x},${S.hover.y}` : "")) return;
  S.hover = p;
  const spot = p && S.showHints && hintSpots.find((h) => h.x === p.x && h.y === p.y);
  const fromFeed = S.preview && !S.preview.fromBoard;
  if (spot) S.preview = { pv: spot.pv, color: toPlay(), fromBoard: true };
  else if (!fromFeed) S.preview = null;
  draw();
});
cv.addEventListener("mouseleave", () => { S.hover = null; if (S.preview?.fromBoard) S.preview = null; draw(); });
cv.addEventListener("click", (e) => { const p = evToPoint(e); if (p) { S.preview = null; humanPlay(toGTP(p.x, p.y, S.size)); } });

$("#btnPass").onclick = () => humanPlay("pass");
$("#btnUndo").onclick = undo;
$("#btnHint").onclick = () => {
  if (S.showHints && $("#btnHint").classList.contains("on")) { S.showHints = false; $("#btnHint").classList.remove("on"); draw(); return; }
  requestHint(false);
};
$("#btnOwner").onclick = async () => {
  S.showOwner = !S.showOwner; $("#btnOwner").classList.toggle("on", S.showOwner);
  if (S.showOwner && !helpAllowed()) flash("ปิดผู้ช่วยไว้ — แผนที่พื้นที่จะแสดงเมื่อจบเกม");
  if (S.showOwner && !S.latest?.res?.ownership && isHuman(toPlay())) await startAssist();
  draw();
};
$("#btnResign").onclick = () => {
  if (S.over || mode() === "ava") return;
  if (S.online) {
    if (humans().length && confirm("ยอมแพ้เกมนี้?")) roomPost("resign", {}).then((st) => st && applyRoomState(st));
    return;
  }
  const loser = mode() === "hva" ? humans()[0] : toPlay();
  if (confirm(mode() === "hva" ? "ยอมแพ้เกมนี้?" : `${playerName(loser)} (${X.colorName(loser)}) ยอมแพ้?`)) { S.gen++; api("/api/cancel", { channel: "ai" }); endGame({ resign: loser }); }
};
$("#btnPause").onclick = () => {
  S.paused = !S.paused;
  if (S.paused) { S.gen++; S.thinking = false; api("/api/cancel", { channel: "ai" }); updateUI(); }
  else nextTurn();
};
$("#btnNew").onclick = () => $("#dlgNew").showModal();
$("#btnSgf").onclick = () => {
  const sg = (gtp) => { const p = fromGTP(gtp, S.size); return p ? String.fromCharCode(97 + p.x) + String.fromCharCode(97 + p.y) : ""; };
  const ab = S.initialStones.length ? "AB" + S.initialStones.map(([, m]) => `[${sg(m)}]`).join("") : "";
  const name = (c) => (isHuman(c) ? (mode() === "hva" ? "Human" : `Player ${pNum(c)}`) : `KataGo ${pl(c).level === "super" ? `full (${pl(c).visits} visits)` : pl(c).level.replace("rank_", "")}`);
  const sgf = `(;GM[1]FF[4]CA[UTF-8]SZ[${S.size}]KM[${S.komi}]RU[Chinese]HA[${S.handicap}]PB[${name(BLACK)}]PW[${name(WHITE)}]` +
    `DT[${new Date().toISOString().slice(0, 10)}]${S.result ? `RE[${S.result}]` : ""}${ab}` +
    S.moves.map(([c, m]) => `;${colorChar(c)}[${sg(m)}]`).join("") + ")";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([sgf], { type: "application/x-go-sgf" }));
  a.download = `go-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.sgf`;
  a.click();
};
$("#coachOn").onchange = (e) => { if (e.target.checked && isHuman(toPlay()) && assistFor(toPlay()) && !S.over) startAssist(); };
document.querySelectorAll(".quick button").forEach((b) => (b.onclick = () => ask(b.dataset.q)));
$("#chat").onsubmit = (e) => {
  e.preventDefault();
  const v = $("#chatIn").value.trim(); $("#chatIn").value = "";
  if (!v) return;
  if (S.online && segVal("chatTo") === "room") roomPost("chat", { text: v });
  else ask(v);
};
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, select, textarea") || $("#dlgNew").open) return;
  if (e.key === "h" || e.key === "H") $("#btnHint").click();
});

// new game dialog
document.querySelectorAll(".seg").forEach((seg) => seg.addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
}));
const segVal = (name) => document.querySelector(`.seg[data-name=${name}] .on`).dataset.v;
const setSeg = (name, v) => document.querySelectorAll(`.seg[data-name=${name}] button`).forEach((b) => b.classList.toggle("on", b.dataset.v === String(v)));
const cfgBox = (ch) => document.querySelector(`.pcfg[data-color="${ch}"]`);
document.querySelectorAll(".pcfg .lvl").forEach((sel) => { sel.innerHTML = LEVELS.map(([v, t]) => `<option value="${v}">${t}</option>`).join(""); });
const readCfg = (ch) => ({ level: cfgBox(ch).querySelector(".lvl").value || "super", visits: +cfgBox(ch).querySelector(".vis").value || 1000 });
function writeCfg(ch, c) { cfgBox(ch).querySelector(".lvl").value = c.level; cfgBox(ch).querySelector(".vis").value = String(c.visits); }
// In "vs AI" mode the W card always holds the opponent's settings; in "AI vs AI" both cards are used.
function syncDialog() {
  const limited = S.full === false;       // remote visitor without the access key → online rooms only
  document.querySelectorAll('.seg[data-name="mode"] button').forEach((b) => { b.disabled = limited && b.dataset.v !== "online"; });
  if (limited && segVal("mode") !== "online") setSeg("mode", "online");
  const m = segVal("mode"), you = segVal("you"), onl = segVal("onl");
  const joining = m === "online" && onl === "join";
  $("#onlineRow").classList.toggle("hidden", m !== "online");
  $("#olCodeRow").classList.toggle("hidden", !joining);
  $("#youRow").classList.toggle("hidden", !(m === "hva" || (m === "online" && !joining)));
  $("#aiRow").classList.toggle("hidden", m === "hvh" || m === "online");
  $("#p2pNote").classList.toggle("hidden", m !== "hvh");
  $("#assistRow").classList.toggle("hidden", m !== "hva" && m !== "online");
  $("#resignRow").classList.toggle("hidden", m === "hvh" || m === "online");
  $("#sizeRow").classList.toggle("hidden", joining);
  $("#ruleRow").classList.toggle("hidden", joining);
  $("#btnStart").textContent = m !== "online" ? "เริ่มเล่น" : joining ? "เข้าห้อง" : "สร้างห้อง";
  const warn = $("#olWarn");
  warn.classList.remove("warn");
  if (m === "online") {
    if (S.isLocal && !S.serverOnline) {
      warn.classList.add("warn");
      warn.textContent = "ตอนนี้เซิร์ฟเวอร์เปิดแบบเครื่องเดียว เพื่อนในเครือข่ายจะเข้าไม่ได้ — ปิดแล้วรัน ./start.command --online";
    } else warn.textContent = joining ? "ใส่รหัส 6 ตัวที่เพื่อนส่งมา (ถ้าห้องมีผู้เล่นครบแล้วจะเข้าเป็นผู้ชม)"
      : "สร้างห้องแล้วส่งลิงก์หรือรหัสห้องให้เพื่อน · AI ผู้ช่วยรันบนเครื่องที่เปิดเซิร์ฟเวอร์";
  }
  $("#swapRow").classList.toggle("hidden", m !== "ava");
  cfgBox("B").classList.toggle("hidden", m !== "ava");
  $("#aiRowTitle").textContent = m === "ava" ? "AI สองฝั่ง" : "AI คู่แข่ง";
  const w = cfgBox("W");
  if (m === "ava") {
    w.querySelector(".pc-title").textContent = "P2 · ขาว"; w.querySelector(".pc-sub").textContent = "ได้โคมิ";
    w.querySelector(".stone").className = "stone w";
  } else {
    const aiColor = you === "B" ? "ขาว" : you === "W" ? "ดำ" : "สุ่มสี";
    w.querySelector(".pc-title").textContent = "AI คู่แข่ง";
    w.querySelector(".pc-sub").textContent = `เล่น${aiColor}`;
    w.querySelector(".stone").className = you === "W" ? "stone b" : you === "B" ? "stone w" : "stone hidden";
  }
  for (const ch of ["B", "W"]) {
    const box = cfgBox(ch), sup = box.querySelector(".lvl").value === "super";
    box.querySelector(".pc-ai").classList.toggle("no-vis", !sup);
  }
}
document.querySelectorAll('.seg[data-name="mode"], .seg[data-name="you"], .seg[data-name="onl"]').forEach((el) => el.addEventListener("click", () => setTimeout(syncDialog)));
document.querySelectorAll(".pcfg select").forEach((el) => el.addEventListener("change", syncDialog));
$("#swapP").onclick = () => { const b = readCfg("B"), w = readCfg("W"); writeCfg("B", w); writeCfg("W", b); syncDialog(); };
$("#handicap").onchange = () => { $("#komi").value = +$("#handicap").value ? 0.5 : 7.5; };
$("#btnNew").addEventListener("click", syncDialog);

// remember the last setup (per-browser convenience only)
const PREF_KEY = "go.newgame.v1";
function savePrefs() {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({ mode: segVal("mode"), you: segVal("you"), size: segVal("size"),
      B: readCfg("B"), W: readCfg("W"), assist: $("#assistVisits").value, resign: $("#aiResign").checked,
      p2p: [...document.querySelectorAll(".p-assist")].map((s) => s.value), name: $("#olName").value }));
  } catch { /* storage unavailable */ }
}
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) || "null");
    if (!p) return;
    setSeg("mode", p.mode); setSeg("you", p.you); setSeg("size", p.size);
    if (p.B) writeCfg("B", p.B); if (p.W) writeCfg("W", p.W);
    if (p.assist != null) $("#assistVisits").value = p.assist;
    (p.p2p || []).forEach((v, i) => { const s = document.querySelectorAll(".p-assist")[i]; if (s) s.value = v; });
    if (p.name) $("#olName").value = p.name;
    $("#aiResign").checked = p.resign !== false;
  } catch { /* ignore bad prefs */ }
}

$("#dlgNew").addEventListener("close", () => {
  if ($("#dlgNew").returnValue !== "ok") return;
  savePrefs();
  const m = segVal("mode"), ai = (c) => ({ type: "ai", ...c });
  if (m === "online") return segVal("onl") === "join" ? joinRoom($("#olCode").value) : createRoom();
  leaveRoom();
  const pAssist = (ch) => +document.querySelector(`.p-assist[data-color="${ch}"]`).value;
  const human = { type: "human", assist: +$("#assistVisits").value };
  let players;
  if (m === "hvh") players = { [BLACK]: { type: "human", assist: pAssist("B") }, [WHITE]: { type: "human", assist: pAssist("W") } };
  else if (m === "ava") players = { [BLACK]: ai(readCfg("B")), [WHITE]: ai(readCfg("W")) };
  else {
    let you = segVal("you");
    if (you === "R") you = Math.random() < 0.5 ? "B" : "W";
    players = you === "B" ? { [BLACK]: human, [WHITE]: ai(readCfg("W")) } : { [BLACK]: ai(readCfg("W")), [WHITE]: human };
  }
  newGame({ size: +segVal("size"), players, handicap: +$("#handicap").value,
    komi: +$("#komi").value || 0, aiResign: $("#aiResign").checked });
});
$("#dlgResult").addEventListener("close", () => { if ($("#dlgResult").returnValue === "new") $("#dlgNew").showModal(); });


// ------------------------------------------------------------------ tabs: compare AIs & machine usage
document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => {
  S.tab = b.dataset.tab;
  document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("sel", x === b));
  for (const t of ["assist", "compare", "machine"]) $(`#tab-${t}`).classList.toggle("hidden", t !== S.tab);
  refreshTab();
}));
$("#miniStats").onclick = () => document.querySelector('.tabs [data-tab="machine"]').click();
function refreshTab() {
  if (S.tab === "compare") renderCompare();
  else if (S.tab === "machine") renderMachine();
}
const pct0 = (v) => `${(v * 100).toFixed(0)}%`;
const sec = (ms) => `${(ms / 1000).toFixed(1)}`;
const tile = (label, value, sub, color) =>
  `<div class="tile"><small>${color ? `<i class="sw" style="background:var(${color})"></i>` : ""}${label}</small><b>${value}</b>${sub ? `<br><span>${sub}</span>` : ""}</div>`;

function compareGroups() {
  const m = mode();
  if (m === "ava") return [BLACK, WHITE].map((c, i) => ({
    name: `AI ${stoneEmoji(c)} ${levelName(c)}`, short: `AI${stoneEmoji(c)}`, color: `--series-${i + 1}`, match: (r) => r.side === "ai" && r.color === c }));
  const g = [{ name: "ผู้ช่วย", short: "ผู้ช่วย", color: "--series-2", match: (r) => r.side === "assist" }];
  if (m === "hva") g.unshift({ name: "AI คู่แข่ง", short: "AI", color: "--series-1", match: (r) => r.side === "ai" });
  return g;
}
function renderCompare() {
  if (!helpAllowed()) {
    $("#cmpNote").innerHTML = "🙈 ซ่อนไว้ในตานี้ เพราะผู้เล่นที่กำลังเดินปิดผู้ช่วย — จะกลับมาแสดงในตาที่เปิดผู้ช่วยหรือหลังจบเกม";
    for (const id of ["#cmpTiles", "#chWr", "#chScore", "#chTime", "#chVps", "#cmpThink"]) $(id).innerHTML = "";
    return;
  }
  const m = mode(), recs = Object.values(S.stats).sort((a, b) => a.k - b.k);
  const groups = compareGroups().map((g) => ({ ...g, recs: recs.filter(g.match) }));
  const groupOf = (r) => groups.find((g) => g.match(r));
  const avg = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
  const rate = (xs, key) => (xs.length ? `${Math.round((xs.filter((r) => r[key]).length / xs.length) * 100)}%` : "–");
  const count = (xs, key) => `${xs.filter((r) => r[key]).length}/${xs.length} ท่า`;
  const lossTile = (c) => {
    const ls = S.losses.filter((l) => l.color === c).map((l) => l.loss);
    return tile(solo() ? "คุณเสียแต้มเฉลี่ย/ท่า" : `P${pNum(c)} ${stoneEmoji(c)} เสียแต้มเฉลี่ย/ท่า`, ls.length ? avg(ls).toFixed(1) : "–", `${ls.length} ท่าที่รีวิว · ยิ่งน้อยยิ่งแม่น`);
  };
  const noteHtml = {
    hva: () => `ทั้งสองฝั่งใช้ KataGo โมเดลเดียวกัน — <b class="k-ai">AI คู่แข่ง</b> คิดตอนตาของมัน, <b class="k-as">ผู้ช่วย</b> คิดตอนตาคุณ · ตัวเลขทั้งหมดเป็นมุมมองของ<b>คุณ</b>`,
    online: () => `ออนไลน์ — <b class="k-as">ผู้ช่วย</b> ของคุณวิเคราะห์ตำแหน่งจากเครื่องที่เปิดห้อง · ตัวเลขเป็นมุมมองของ<b>${meName()}</b>`,
    hvh: () => `คน vs คน — <b class="k-as">ผู้ช่วย</b> วิเคราะห์ให้ทั้งสองฝั่ง · ตัวเลขเป็นมุมมองของ<b>ดำ (P1)</b>`,
    ava: () => `AI vs AI — <b class="k-ai">${groups[0].name}</b> vs <b class="k-as">${groups[1].name}</b> · ตัวเลขเป็นมุมมองของ<b>ดำ</b>`,
  }[m];
  $("#cmpNote").innerHTML = noteHtml();

  const tiles = [];
  if (m === "hva") {
    const [ai, as] = [groups[0].recs, groups[1].recs];
    const aHit = ai.filter((r) => r.assistHit !== undefined), hHit = ai.filter((r) => r.hit !== undefined);
    const diffs = ai.filter((r) => r.assistView).map((r) => Math.abs(r.wr - r.assistView.wr));
    tiles.push(tile("ผู้ช่วยทายท่า AI ถูก", rate(aHit, "assistHit"), count(aHit, "assistHit"), "--series-2"),
      tile("AI ทายท่าคุณถูก", rate(hHit, "hit"), count(hHit, "hit"), "--series-1"),
      tile("ประเมินต่างกันเฉลี่ย", diffs.length ? `${(avg(diffs) * 100).toFixed(1)}%` : "–", "โอกาสชนะ ตำแหน่งเดียวกัน"),
      lossTile(humans()[0]));
  } else if (m === "ava") {
    for (const g of groups) { const h = g.recs.filter((r) => r.hit !== undefined); tiles.push(tile(`${g.short} ทายท่าอีกฝ่ายถูก`, rate(h, "hit"), count(h, "hit"), g.color)); }
  } else {
    tiles.push(...humans().map(lossTile));
  }
  for (const g of groups) tiles.push(tile("เวลาคิดเฉลี่ย (วิ)", g.recs.length ? sec(avg(g.recs.map((r) => r.ms))) : "–", g.name, g.color));
  $("#cmpTiles").innerHTML = tiles.join("");

  const tipTitle = (x) => `ท่าที่ ${x + 1} · ตา${X.colorName(toPlayAt(x))}`;
  const note = (r) => `${r.visits.toLocaleString()} visits · ${sec(r.ms)} วิ`;
  const who = meName();
  document.querySelector("#tab-compare h4").textContent = m === "hva" ? "โอกาสชนะของคุณ ในสายตาแต่ละ AI" : `โอกาสชนะของ${who}`;
  lineChart($("#chWr"), groups.map((g) => ({ name: g.name, short: g.short, color: g.color, points: g.recs.map((r) => ({ x: r.k, y: r.wr * 100, note: note(r) })) })),
    { yMin: 0, yMax: 100, ref: 50, yFmt: (v) => `${v.toFixed(0)}%`, tipTitle, xFmt: (x) => `ท่า ${x + 1}`, empty: m === "ava" ? "รอ AI เดิน…" : "เดินหมากสักท่าเพื่อเริ่มเก็บข้อมูล" });
  lineChart($("#chScore"), groups.map((g) => ({ name: g.name, short: g.short, color: g.color, points: g.recs.map((r) => ({ x: r.k, y: r.score })) })),
    { symmetric: true, ref: 0, yFmt: (v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}`, tipTitle, xFmt: (x) => `ท่า ${x + 1}` });
  const shown = recs.filter(groupOf);
  const bars = (key) => shown.map((r) => ({
    x: r.k + 1, y: key(r), color: groupOf(r).color,
    tip: `<div class="tt">ท่าที่ ${r.k + 1} · ${groupOf(r).name}</div><div>เวลา<b>${sec(r.ms)} วิ</b></div><div>visits<b>${r.visits.toLocaleString()}</b></div><div>ความเร็ว<b>${r.vps.toLocaleString()} /วิ</b></div>`,
  }));
  const legend = groups.map((g) => ({ name: g.name, color: g.color }));
  barChart($("#chTime"), bars((r) => r.ms / 1000), { legend, yFmt: (v) => v.toFixed(v < 10 ? 1 : 0), xLabel: "ท่า " });
  barChart($("#chVps"), bars((r) => r.vps), { legend, yFmt: (v) => v.toFixed(0), xLabel: "ท่า " });

  // what is each side thinking right now
  const list = (r, color, chosen) => r.top.map((mi) => `<div class="cand${mi.move === chosen ? " chosen" : ""}" title="${mi.move}: ${pct0(mi.share)} ของการคิดทั้งหมด (${mi.visits} visits)">
      ${mvLink(mi.move, mi.pv, r.color)}
      <div class="bar" style="width:${Math.max(3, (mi.share / r.top[0].share) * 100)}%;background:var(${color})"></div>
      <span class="v">${pct0(mi.wr)} · ${pts(mi.score)}</span></div>`).join("");
  let html = "";
  for (const g of groups) {
    const r = g.recs[g.recs.length - 1];
    const isAiGroup = r ? r.side === "ai" : g.short.startsWith("AI");
    const sub = !r ? (isAiGroup ? "ยังไม่ได้เดิน" : "รอตาฝั่งคน")
      : isAiGroup ? `แบ่งเวลาคิดให้แต่ละท่า (ความยาวแถบ) · ${note(r)}` : `ท่าที่แนะนำให้${mode() === "hva" ? "คุณ" : playerName(r.color)} · ${note(r)}`;
    html += `<div class="col"><h5>${g.name}${r ? ` · ท่าที่ ${r.k + 1}` : ""}<small>${sub}</small></h5>`;
    if (r) {
      html += list(r, g.color, isAiGroup ? r.played : S.moves[r.k]?.[1]);
      if (r.human) {
        html += `<h5 style="margin-top:8px">สัญชาตญาณแบบมนุษย์ (${levelName(r.color)})<small>AI ระดับนี้สุ่มท่าตามโอกาสนี้ แล้วเลือก ${r.played}</small></h5>`;
        html += r.human.map((h) => `<div class="cand${h.move === r.played ? " chosen" : ""}"><span class="mv">${h.move}</span><div class="bar" style="width:${Math.max(3, (h.p / r.human[0].p) * 100)}%;background:var(${g.color});opacity:.55"></div><span class="v">${pct0(h.p)}</span></div>`).join("");
      }
      if (isAiGroup && r.predicted) {
        const target = m === "hva" ? "คุณ" : "อีกฝ่าย";
        html += `<p class="note" style="margin:6px 0 0">AI คาดว่า${target}จะตอบที่ <b>${r.predicted}</b>${r.hit === undefined ? "" : r.hit ? " — ✔ ทายถูก" : ` — ✘ ${target}เล่นท่าอื่น`}</p>`;
      }
      const nextAi = !isAiGroup && S.stats[r.k + 1];
      if (nextAi?.assistPredicted) html += `<p class="note" style="margin:6px 0 0">ผู้ช่วยคาดว่า AI จะตอบที่ <b>${nextAi.assistPredicted}</b> — ${nextAi.assistHit ? "✔ ทายถูก" : `✘ AI เล่น ${nextAi.played}`}</p>`;
    }
    html += "</div>";
  }
  $("#cmpThink").innerHTML = html;
}
$("#cmpThink").addEventListener("mouseover", (e) => {
  const el = e.target.closest(".mv[data-pv]"); if (!el) return;
  S.preview = { pv: el.dataset.pv.split(" "), color: +el.dataset.c }; draw();
});
$("#cmpThink").addEventListener("mouseout", (e) => { if (e.target.closest(".mv")) { S.preview = null; draw(); } });

const GB = (mb) => mb / 1024;
function renderMachine() {
  if (S.full === false) {
    $("#macTiles").innerHTML = `<p class="note">🔒 ข้อมูล CPU/RAM/GPU เป็นของเครื่อง Mac ที่รันเกม — ดูได้บนเครื่องนั้น
      หรือใส่ <b>รหัสเข้าถึง</b> ที่ปุ่ม 🔑 มุมขวาบน (รหัสที่ขึ้นตอนรัน play-online.sh)</p>`;
    for (const id of ["#chCpu", "#chRam", "#chGpu"]) $(id).innerHTML = "";
    return;
  }
  const m = S.metrics, sys = S.sys;
  if (!m.length || !sys) { $("#macTiles").innerHTML = `<p class="note">กำลังเก็บข้อมูล…</p>`; return; }
  const cur = m[m.length - 1], t = now();
  const kg = cur.procs.katago, llm = cur.procs.llm;
  $("#cpuInfo").textContent = `· ${sys.ncpu} คอร์: ${sys.pcores}P + ${sys.ecores}E`;
  $("#macTiles").innerHTML = [
    tile("CPU ทั้งเครื่อง", `${cur.cpu.total.toFixed(0)}%`, `user ${cur.cpu.user.toFixed(0)}% · sys ${cur.cpu.sys.toFixed(0)}%`),
    tile("RAM ทั้งเครื่อง", `${GB(cur.mem.usedMB).toFixed(1)} GB`, `จาก ${GB(cur.mem.totalMB).toFixed(0)} GB (${pct0(cur.mem.usedMB / cur.mem.totalMB)})`),
    tile("GPU", cur.gpu.util == null ? "–" : `${cur.gpu.util}%`, cur.gpu.memMB ? `หน่วยความจำ GPU ${GB(cur.gpu.memMB).toFixed(1)} GB` : ""),
    tile("KataGo", `${GB(kg.mem).toFixed(1)} GB`, `CPU ${kg.cpuMachine.toFixed(1)}% (${(kg.cpu / 100).toFixed(1)} คอร์) · ${kg.threads} threads`, "--series-3"),
    tile("LLM (Ollama)", `${GB(llm.mem).toFixed(1)} GB`, `CPU ${llm.cpuMachine.toFixed(1)}%${llm.mem < 200 ? " · ยังไม่โหลดโมเดล" : ""}`, "--series-4"),
  ].join("");
  const x = (s) => s.t - t;
  const bands = S.activity.filter((a) => (a.t1 ?? t) > t - 330).map((a) => ({
    x0: a.t0 - t, x1: (a.t1 ?? t) - t, color: a.kind === "ai" ? "--series-1" : a.kind === "assist" ? "--series-2" : "--series-4",
  }));
  const busyAt = (ts) => {
    const k = S.activity.filter((a) => a.t0 <= ts && (a.t1 ?? t) >= ts).map((a) => ({ ai: "AI คู่แข่งคิด", assist: "ผู้ช่วยคิด", llm: "LLM ตอบ" }[a.kind]));
    return k.length ? k.join(", ") : "ว่าง";
  };
  const base = { xMin: -300, xMax: 0, bands, xFmt: (v) => (v >= -0.5 ? "ตอนนี้" : `${Math.round(-v)} วิที่แล้ว`), tipTitle: (v) => `${Math.round(-v)} วิที่แล้ว · ${busyAt(t + v)}` };
  lineChart($("#chCpu"), [
    { name: "ทั้งเครื่อง", short: "รวม", color: "--neutral-series", points: m.map((s) => ({ x: x(s), y: s.cpu.total })) },
    { name: "KataGo", color: "--series-3", points: m.map((s) => ({ x: x(s), y: s.procs.katago.cpuMachine })) },
    { name: "LLM", color: "--series-4", points: m.map((s) => ({ x: x(s), y: s.procs.llm.cpuMachine })) },
  ], { ...base, yMin: 0, yMax: Math.max(20, ...m.map((s) => s.cpu.total)), yFmt: (v) => `${v.toFixed(0)}%` });
  lineChart($("#chRam"), [
    { name: "ทั้งเครื่อง", short: "รวม", color: "--neutral-series", points: m.map((s) => ({ x: x(s), y: GB(s.mem.usedMB) })) },
    { name: "KataGo", color: "--series-3", points: m.map((s) => ({ x: x(s), y: GB(s.procs.katago.mem) })) },
    { name: "LLM", color: "--series-4", points: m.map((s) => ({ x: x(s), y: GB(s.procs.llm.mem) })) },
  ], { ...base, yMin: 0, yMax: GB(sys.memTotalMB), yFmt: (v) => (v === 0 || v >= 10 ? v.toFixed(0) : v.toFixed(1)) });
  lineChart($("#chGpu"), [
    { name: "GPU", color: "--neutral-series", points: m.filter((s) => s.gpu.util != null).map((s) => ({ x: x(s), y: s.gpu.util })) },
  ], { ...base, yMin: 0, yMax: 100, yFmt: (v) => `${v.toFixed(0)}%` });
}

async function pollMetrics() {
  if (S.full === undefined) { setTimeout(pollMetrics, 1000); return; }    // wait for /api/status
  if (S.full === false) { if (S.tab === "machine") renderMachine(); return; }
  if (!document.hidden) {
    try {
      const since = S.metrics.length ? S.metrics[S.metrics.length - 1].t : 0;
      const r = await api(`/api/metrics?since=${since}`);
      S.sys = r;
      S.metrics.push(...r.samples);
      const cut = now() - 300;
      while (S.metrics.length && S.metrics[0].t < cut) S.metrics.shift();
      const cur = S.metrics[S.metrics.length - 1];
      if (cur) {
        $("#miniStats").innerHTML = `CPU <b>${cur.cpu.total.toFixed(0)}%</b> · RAM <b>${GB(cur.mem.usedMB).toFixed(1)}</b>/${GB(cur.mem.totalMB).toFixed(0)} GB · GPU <b>${cur.gpu.util ?? "–"}%</b>`;
      }
      if (S.tab === "machine") renderMachine();
    } catch { /* server restarting */ }
  }
  setTimeout(pollMetrics, 2000);
}

// ------------------------------------------------------------------ online rooms
const ROOMS_KEY = "go.rooms.v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function savedTokens() { try { return JSON.parse(localStorage.getItem(ROOMS_KEY) || "{}"); } catch { return {}; } }
function saveToken(code, token) {
  try { const t = savedTokens(); t[code] = token; localStorage.setItem(ROOMS_KEY, JSON.stringify(t)); } catch { /* storage unavailable */ }
}
async function roomPost(action, body) {
  const o = S.online;
  if (!o) return null;
  const r = await api(`/api/room/${action}`, { code: o.code, token: o.token, ...body });
  if (r.error) { flash(r.error); return null; }
  return r;
}
function setRoomUrl(code) {
  const u = new URL(location.href);
  if (code) u.searchParams.set("room", code); else u.searchParams.delete("room");
  history.replaceState(null, "", u);
}
function dialogError(msg) {
  $("#dlgNew").showModal(); syncDialog();
  const w = $("#olWarn"); w.textContent = msg; w.classList.add("warn");
}
async function createRoom() {
  let you = segVal("you");
  const r = await api("/api/room/create", { name: $("#olName").value, color: you, size: +segVal("size"), komi: +$("#komi").value || 0,
    handicap: +$("#handicap").value, helper: +$("#assistVisits").value });
  if (r.error) return dialogError(r.error);
  enterRoom(r.code, r.token);
}
async function joinRoom(code) {
  code = String(code || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return dialogError("รหัสห้องต้องเป็นตัวอักษร/ตัวเลข 6 ตัว");
  const r = await api("/api/room/join", { code, name: $("#olName").value, helper: +$("#assistVisits").value });
  if (r.error) return dialogError(r.error);
  enterRoom(r.code, r.token);
}
function enterRoom(code, token) {
  saveToken(code, token);
  setRoomUrl(code);
  S.online = { code, token, version: 0, lastChat: 0, started: false, names: {} };
  roomLoop(S.online);
}
function leaveRoom() {
  if (!S.online) return;
  S.online = null;
  setRoomUrl(null);
  $("#roomBar").classList.add("hidden");
}
async function roomLoop(o) {
  while (S.online === o) {
    let st;
    try { st = await api(`/api/room/state?code=${o.code}&token=${encodeURIComponent(o.token)}&since=${o.version}`); }
    catch { await sleep(2000); continue; }
    if (S.online !== o) return;
    if (st.error) {
      flash(st.error);
      if (/ไม่พบห้อง/.test(st.error)) { leaveRoom(); return dialogError(st.error); }
      await sleep(3000); continue;
    }
    applyRoomState(st);
  }
}
function startRoomGame(st) {
  const o = S.online, you = st.you;
  const mk = (ch) => (ch === you ? { type: "human", assist: st.seats[ch]?.helper ?? 0 } : { type: "remote" });
  o.started = true;
  newGame({ size: st.size, komi: st.komi, handicap: st.handicap, aiResign: false,
    players: { [BLACK]: mk("B"), [WHITE]: mk("W") }, replay: st.moves });
}
function applyRoomState(st) {
  const o = S.online;
  if (!o || st.code !== o.code || st.version < o.version) return;
  o.version = st.version; o.state = st;
  o.names = { [BLACK]: st.seats.B?.name, [WHITE]: st.seats.W?.name };
  const sameStart = o.started && S.size === st.size && S.moves.every(([c, m], i) => st.moves[i] && colorChar(c) === st.moves[i][0] && m === st.moves[i][1]);
  if (!sameStart) startRoomGame(st);
  else if (st.moves.length > n()) {
    for (let i = n(); i < st.moves.length; i++) {
      const [c, m] = st.moves[i];
      if (!play(charColor(c), m)) return startRoomGame(st);
    }
    S.preview = null;
    nextTurn();
  }
  $("#nameB").textContent = playerName(BLACK);
  $("#nameW").textContent = playerName(WHITE);
  for (const m of st.chat) {
    if (m.t <= o.lastChat) continue;
    o.lastChat = m.t;
    if (m.from === "sys") post({ cls: "sys", lines: [escapeHtml(m.text)] });
    else {
      const mine = m.from === st.you, who = m.from === "spec" ? `👀 ${m.name}` : `${stoneEmoji(charColor(m.from))} ${m.name}`;
      post({ cls: `room${mine ? " mine" : ""}`, title: `💬 ${escapeHtml(who)}`, lines: [escapeHtml(m.text)] });
    }
  }
  if (st.status === "over" && !S.over) {
    S.over = true; S.thinking = false; S.result = st.result;
    if (st.ownership) { S.finalOwnership = st.ownership; S.showOwner = true; $("#btnOwner").classList.add("on"); }
    const winner = st.result?.[0] === "B" ? BLACK : WHITE;
    const loser = other(winner);
    const body = st.reason?.startsWith("resign") ? `${playerName(loser)} (${X.colorName(loser)}) ยอมแพ้`
      : `${X.colorName(winner)}ชนะ ${st.result.split("+")[1]} แต้ม (กติกาจีน, โคมิ ${st.komi})\nจุดบนกระดานแสดงเจ้าของพื้นที่ · หมากที่มีกากบาทคือหมากตาย`;
    showResult(winTitle(winner), body);
  }
  updateUI(); renderRoomBar(); refreshTab();
}
async function roomMove(gtp, k) {
  const o = S.online;
  if (o.sending) return;
  o.sending = true;
  try {
    const st = await roomPost("move", { move: gtp, n: k });
    if (st) applyRoomState(st);
  } finally { o.sending = false; }
}
function shareBase() { return S.publicUrl || S.lanUrl || location.origin; }
function inviteLink(code) {
  if (SERVER_SOURCE === "published") return `${location.origin}/?room=${code}`;   // the page already knows the server
  const server = API_BASE || (S.frontendUrl && S.publicUrl);
  if (!server) return `${shareBase()}/?room=${code}`;
  const u = new URL(API_BASE ? location.origin + location.pathname : S.frontendUrl);
  u.searchParams.set("server", API_BASE || S.publicUrl);
  u.searchParams.set("room", code);
  return u.toString();
}
function openServerDialog(msg) {
  $("#srvUrl").value = API_BASE; $("#srvKey").value = ACCESS_KEY;
  $("#srvMsg").textContent = msg || (location.protocol === "https:" ? "ต้องเป็นลิงก์ https:// (เบราว์เซอร์บล็อก http จากหน้าเว็บ https)" : "");
  if ($("#dlgNew").open) $("#dlgNew").close();
  $("#dlgServer").showModal();
}
$("#btnServer").onclick = () => openServerDialog();
$("#dlgServer").addEventListener("close", () => {
  const v = $("#dlgServer").returnValue;
  if (v === "clear") { store("go.server", ""); store("go.key", ""); location.reload(); return; }
  if (v !== "ok") return;
  const url = $("#srvUrl").value.trim().replace(/\/+$/, "");
  if (url && !/^https?:\/\/[^\s/]+/.test(url)) return openServerDialog("ลิงก์ไม่ถูกต้อง");
  store("go.server", url); store("go.key", $("#srvKey").value.trim());
  const u = new URL(location.href); u.searchParams.delete("server"); history.replaceState(null, "", u);
  location.reload();
});
function renderRoomBar() {
  const o = S.online, st = o?.state, bar = $("#roomBar");
  if (!o || !st) { bar.classList.add("hidden"); return; }
  const link = inviteLink(o.code);
  const seat = (c) => {
    const s = st.seats[c];
    return `<span><span class="dot${s?.online ? " on" : ""}"></span>${stoneEmoji(c === "B" ? BLACK : WHITE)} ${s ? escapeHtml(s.name) : "ว่าง"}${st.you === c ? " (คุณ)" : ""}</span>`;
  };
  const localOnly = S.isLocal && !S.serverOnline;
  bar.innerHTML = `<span>ห้อง <span class="code">${o.code}</span></span>
    <span class="link"><input readonly value="${escapeHtml(link)}" aria-label="ลิงก์เชิญ"><button type="button" id="btnCopyLink">คัดลอก</button></span>
    <span class="seats">${seat("B")}${seat("W")}${st.spectators ? `<span>👀 ${st.spectators}</span>` : ""}</span>
    <button type="button" id="btnLeave">ออกจากห้อง</button>
    ${localOnly ? `<span class="warn">⚠️ เซิร์ฟเวอร์เปิดแบบเครื่องเดียว — ให้คนอื่นเข้าได้ต้องรัน <b>./start.command --online</b></span>` : ""}`;
  bar.classList.remove("hidden");
  $("#btnCopyLink").onclick = () => { navigator.clipboard?.writeText(link).then(() => flash("คัดลอกลิงก์แล้ว"), () => {}); bar.querySelector("input").select(); };
  $("#btnLeave").onclick = () => { if (confirm("ออกจากห้องนี้? (เข้าใหม่ได้ด้วยลิงก์เดิมจากเบราว์เซอร์นี้)")) { leaveRoom(); newGame({ players: { [BLACK]: { type: "human", assist: 1000 }, [WHITE]: { type: "ai", level: "super", visits: 1000 } } }); } };
}

let rT;
new ResizeObserver(() => { clearTimeout(rT); rT = setTimeout(refreshTab, 150); }).observe($(".panel"));
pollMetrics();

new ResizeObserver(resize).observe(cv);
pollStatus();
newGame({});
loadPrefs();
{
  const code = new URL(location.href).searchParams.get("room")?.toUpperCase();
  const token = code && savedTokens()[code];
  if (token) enterRoom(code, token);                 // reload / come back to a room we're in
  else {
    if (code) { setSeg("mode", "online"); setSeg("onl", "join"); $("#olCode").value = code; }
    syncDialog();
    $("#dlgNew").showModal();
  }
}
