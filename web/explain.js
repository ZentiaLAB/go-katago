// Turns raw KataGo analysis into Thai coaching text.
import { Board, BLACK, WHITE, EMPTY, other, fromGTP, toGTP } from "./go.js";

export const pct = (v) => `${(v * 100).toFixed(1)}%`;
export const pts = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;
export const colorName = (c) => (c === BLACK ? "ดำ" : "ขาว");

// KataGo reports from Black's view; convert to `color`'s view.
export const wrFor = (info, color) => (color === BLACK ? info.winrate : 1 - info.winrate);
export const scoreFor = (info, color) => (color === BLACK ? info.scoreLead : -info.scoreLead);

export function regionName(x, y, size) {
  const edge = size >= 13 ? 5 : 3;
  const top = y < edge, bottom = y >= size - edge, left = x < edge, right = x >= size - edge;
  if (top && left) return "มุมซ้ายบน";
  if (top && right) return "มุมขวาบน";
  if (bottom && left) return "มุมซ้ายล่าง";
  if (bottom && right) return "มุมขวาล่าง";
  if (top) return "ด้านบน";
  if (bottom) return "ด้านล่าง";
  if (left) return "ด้านซ้าย";
  if (right) return "ด้านขวา";
  return "กลางกระดาน";
}

function pointName(x, y, size) {
  const dx = Math.min(x, size - 1 - x) + 1, dy = Math.min(y, size - 1 - y) + 1;
  const [a, b] = [Math.min(dx, dy), Math.max(dx, dy)];
  if (size >= 13 && a <= 5 && b <= 5) {
    const names = { "3-3": "จุด 3-3 (ซัน-ซัน)", "4-4": "จุดดาว 4-4", "3-4": "จุด 3-4 (โคโมกุ)",
      "3-5": "จุด 3-5 (เมฮาซูชิ)", "4-5": "จุด 4-5 (ทากะโมกุ)", "5-5": "จุด 5-5" };
    if (names[`${a}-${b}`]) return names[`${a}-${b}`];
  }
  if (a === 1) return "เส้นที่ 1 (ขอบกระดาน)";
  if (a === 2) return "เส้นที่ 2";
  if (a === 3) return "เส้นที่ 3 (เส้นพื้นที่)";
  if (a === 4) return "เส้นที่ 4 (เส้นอิทธิพล)";
  return null;
}

export function where(gtp, size) {
  const p = fromGTP(gtp, size);
  if (!p) return "ผ่าน (pass)";
  const pn = pointName(p.x, p.y, size);
  return `${regionName(p.x, p.y, size)}${pn ? " · " + pn : ""}`;
}

// Tactical features of playing `color` at (x,y) on `board`.
export function tactics(board, x, y, color) {
  const out = [];
  const i = board.idx(x, y), opp = other(color);
  const oppGroups = new Map(), ownGroups = new Map();
  for (const n of board.neighbors(i)) {
    const c = board.grid[n];
    if (c === EMPTY) continue;
    const g = board.group(n), key = Math.min(...g.stones);
    (c === color ? ownGroups : oppGroups).set(key, g);
  }
  const after = board.clone();
  const captured = after.play(x, y, color);
  if (captured === null) return ["ผิดกติกา"];
  if (captured.length) out.push(`จับกินหมาก${colorName(opp)} ${captured.length} เม็ด`);
  for (const g of ownGroups.values()) {
    if (g.libs.size === 1) out.push(`ช่วยหมาก${colorName(color)} ${g.stones.length} เม็ดที่ถูกอะตาริให้หนีรอด`);
  }
  if (ownGroups.size >= 2) out.push("เชื่อมหมากสองกลุ่มเข้าด้วยกัน ทำให้แข็งแรงขึ้น");
  if (oppGroups.size >= 2 && !captured.length) out.push("ตัดหมากของอีกฝ่ายออกจากกัน");
  for (const g of oppGroups.values()) {
    const s = g.stones[0];
    if (after.grid[s] !== opp) continue;
    const libs = after.group(s).libs.size;
    if (libs === 1) out.push(`อะตาริ (บีบให้เหลือลมหายใจ 1) หมาก${colorName(opp)} ${g.stones.length} เม็ด`);
    else if (libs === 2 && g.libs.size > 2) out.push(`กดดันหมาก${colorName(opp)} ให้เหลือลมหายใจ 2`);
  }
  const mine = after.group(i);
  if (mine.libs.size === 1 && !captured.length) out.push("⚠️ หมากตัวเองเหลือลมหายใจ 1 (เสี่ยงถูกกิน)");
  // distance to nearest stone → big point / tenuki
  let nearest = 99;
  for (let j = 0; j < board.grid.length; j++) {
    if (board.grid[j] === EMPTY) continue;
    const d = Math.abs((j % board.size) - x) + Math.abs(((j / board.size) | 0) - y);
    nearest = Math.min(nearest, d);
  }
  if (nearest >= 5) out.push("จับจุดใหญ่ที่ยังว่างอยู่ (big point) ก่อนที่อีกฝ่ายจะยึด");
  return out;
}

// Flood groups with average ownership from the group owner's perspective.
export function groupStatus(board, ownership) {
  if (!ownership) return [];
  const seen = new Uint8Array(board.grid.length), res = [];
  for (let i = 0; i < board.grid.length; i++) {
    const c = board.grid[i];
    if (c === EMPTY || seen[i]) continue;
    const g = board.group(i);
    g.stones.forEach((s) => (seen[s] = 1));
    let sum = 0;
    for (const s of g.stones) sum += c === BLACK ? ownership[s] : -ownership[s];
    const own = sum / g.stones.length;
    const s0 = g.stones[Math.floor(g.stones.length / 2)];
    const x = s0 % board.size, y = (s0 / board.size) | 0;
    let status = "strong";
    if (own < -0.6) status = "dead";
    else if (own < 0.35) status = "weak";
    res.push({ color: c, size: g.stones.length, own, status, libs: g.libs.size,
      at: toGTP(x, y, board.size), region: regionName(x, y, board.size), stones: g.stones });
  }
  return res;
}

export function territory(ownership, size) {
  if (!ownership) return null;
  let b = 0, w = 0;
  for (const o of ownership) { if (o > 0.5) b++; else if (o < -0.5) w++; }
  return { b, w, total: size * size };
}

export function pvText(pv, firstColor, max = 8) {
  if (!pv || !pv.length) return "";
  let c = firstColor;
  return pv.slice(0, max).map((m) => { const s = `${c === BLACK ? "⚫" : "⚪"}${m}`; c = other(c); return s; }).join(" → ");
}

export function classify(loss) {
  if (loss <= 0.4) return { key: "best", label: "ยอดเยี่ยม", emoji: "🌟" };
  if (loss <= 1.2) return { key: "good", label: "ดี", emoji: "👍" };
  if (loss <= 3) return { key: "ok", label: "ไม่แม่นยำ", emoji: "🤔" };
  if (loss <= 7) return { key: "mistake", label: "พลาด", emoji: "⚠️" };
  return { key: "blunder", label: "พลาดหนัก", emoji: "❌" };
}

// Detailed explanation of why KataGo recommends `mi` for `color`.
export function explainMove(board, mi, color, analysis) {
  const size = board.size;
  const lines = [];
  const p = fromGTP(mi.move, size);
  if (!p) {
    lines.push("การผ่านเป็นท่าที่ดีที่สุด — ไม่มีจุดไหนเพิ่มแต้มได้แล้ว");
    return lines;
  }
  lines.push(`📍 ${where(mi.move, size)}`);
  for (const t of tactics(board, p.x, p.y, color)) lines.push(`• ${t}`);
  // Which groups does this move touch/help/attack (via ownership of nearby weak groups)?
  const groups = groupStatus(board, analysis.ownership);
  for (const g of groups) {
    if (g.status === "strong") continue;
    const near = g.stones.some((s) => Math.abs((s % size) - p.x) + Math.abs(((s / size) | 0) - p.y) <= 2);
    if (!near) continue;
    if (g.color === color) lines.push(`• เสริมความแข็งแรงให้กลุ่มหมาก${colorName(color)}ที่${g.region} (${g.size} เม็ด) ซึ่งกำลังอ่อนแอ`);
    else lines.push(`• โจมตีกลุ่มหมาก${colorName(g.color)}ที่${g.region} (${g.size} เม็ด) ที่ยังไม่มีชีวิตแน่นอน`);
  }
  const reply = mi.pv && mi.pv[1];
  if (reply) lines.push(`• ถ้าเล่นตรงนี้ คาดว่าอีกฝ่ายจะตอบที่ ${reply} (${where(reply, size)})`);
  lines.push(`• ลำดับที่ AI อ่านไว้: ${pvText(mi.pv, color)}`);
  lines.push(`• ผลลัพธ์: โอกาสชนะ ${pct(wrFor(mi, color))}, แต้ม ${pts(scoreFor(mi, color))}`);
  return lines;
}

// Situation summary for `color` (the human).
export function situation(board, analysis, color) {
  const size = board.size, out = [];
  const r = analysis.rootInfo;
  const wr = wrFor(r, color), sc = scoreFor(r, color);
  let mood;
  if (wr > 0.9) mood = "คุณได้เปรียบมาก รักษาความได้เปรียบ เล่นให้ปลอดภัย";
  else if (wr > 0.65) mood = "คุณนำอยู่ แต่ยังต้องระวัง";
  else if (wr > 0.35) mood = "เกมยังสูสี";
  else if (wr > 0.1) mood = "คุณตามหลัง ต้องหาจังหวะสร้างความซับซ้อนหรือโจมตี";
  else mood = "คุณเสียเปรียบมาก ต้องเสี่ยงเพื่อพลิกเกม";
  out.push(`📊 โอกาสชนะของคุณ ${pct(wr)} · แต้ม ${pts(sc)} — ${mood}`);
  const t = territory(analysis.ownership, size);
  if (t) out.push(`🗺️ พื้นที่ที่ค่อนข้างแน่นอน: ดำ ~${t.b} จุด · ขาว ~${t.w} จุด`);
  const groups = groupStatus(board, analysis.ownership).filter((g) => g.size >= 2 || g.status === "dead");
  for (const g of groups.filter((g) => g.color === color && g.status !== "strong").slice(0, 3)) {
    out.push(g.status === "dead"
      ? `💀 กลุ่มหมากของคุณที่${g.region} (${g.at}, ${g.size} เม็ด) น่าจะตายแล้ว — อย่าเสียหมากเพิ่มถ้าช่วยไม่ได้`
      : `🆘 กลุ่มหมากของคุณที่${g.region} (${g.at}, ${g.size} เม็ด) ยังอ่อนแอ — ควรดูแล`);
  }
  for (const g of groups.filter((g) => g.color !== color && g.status !== "strong").slice(0, 3)) {
    out.push(g.status === "dead"
      ? `🎯 กลุ่มหมากของ AI ที่${g.region} (${g.at}, ${g.size} เม็ด) น่าจะตายแล้ว`
      : `🎯 กลุ่มหมากของ AI ที่${g.region} (${g.at}, ${g.size} เม็ด) ยังอ่อนแอ — เป็นเป้าโจมตี`);
  }
  return out;
}

export function boardAscii(board) {
  const s = board.size, L = "ABCDEFGHJKLMNOPQRST".slice(0, s);
  const rows = [`   ${L.split("").join(" ")}`];
  for (let y = 0; y < s; y++) {
    let row = String(s - y).padStart(2) + " ";
    for (let x = 0; x < s; x++) {
      const c = board.get(x, y);
      row += (c === BLACK ? "X" : c === WHITE ? "O" : ".") + " ";
    }
    rows.push(row.trimEnd());
  }
  return rows.join("\n");
}

export { Board };
