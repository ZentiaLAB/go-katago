// Verifies every tutorial lesson against the rules engine: node tests/check_lessons.mjs
// - setup stones are on the board, don't overlap and every group has liberties
// - every accepted answer is legal and satisfies the step's check (capture count, atari, escape)
// - scripted replies are legal, and each step's first answer leads to the next step
import { Board, BLACK, WHITE, EMPTY, other, fromGTP } from "../web/go.js";
import { LESSONS, LADDER } from "../web/lessons.js";

let failures = 0;
const fail = (l, msg) => { failures++; console.log(`✗ ${l.id}: ${msg}`); };

function setup(l) {
  const b = new Board(l.size);
  for (const [color, list] of [[BLACK, l.black], [WHITE, l.white]]) {
    for (const g of list) {
      const p = fromGTP(g, l.size);
      if (!p || p.x < 0 || p.x >= l.size || p.y < 0 || p.y >= l.size) throw new Error(`off-board ${g}`);
      const i = b.idx(p.x, p.y);
      if (b.grid[i] !== EMPTY) throw new Error(`overlap at ${g}`);
      b.grid[i] = color;
    }
  }
  for (let i = 0; i < b.grid.length; i++) if (b.grid[i] !== EMPTY && b.group(i).libs.size === 0) throw new Error("setup group without liberties");
  return b;
}

// apply `g` for `color`; returns {board, captured} or null when illegal
function tryMove(b, g, color) {
  const p = fromGTP(g, b.size);
  if (!p || p.x < 0 || p.x >= b.size || p.y < 0 || p.y >= b.size) return null;
  const nb = b.clone();
  const cap = nb.play(p.x, p.y, color);
  return cap === null ? null : { board: nb, captured: cap.length, i: nb.idx(p.x, p.y) };
}

function checkStep(l, step, before, g, color) {
  const r = tryMove(before, g, color);
  if (!r) return `answer ${g} is illegal`;
  const { board, captured, i } = r;
  if (step.check === "capture" && captured < (step.min || 1)) return `answer ${g} captures ${captured} < ${step.min || 1}`;
  if (step.check === "atari") {
    const ok = board.neighbors(i).some((n) => board.grid[n] === other(color) && board.group(n).libs.size === 1);
    if (!ok) return `answer ${g} is not atari`;
  }
  if (step.check === "escape" && board.group(i).libs.size < (step.min || 3)) return `answer ${g} leaves ${board.group(i).libs.size} liberties`;
  return null;
}

for (const l of LESSONS) {
  let b;
  try { b = setup(l); } catch (e) { fail(l, e.message); continue; }
  let color = l.toPlay === "W" ? WHITE : BLACK;
  for (const [si, step] of (l.steps || []).entries()) {
    if (step.check === "ai" || step.check === "any") continue;
    if (!step.answers?.length) { fail(l, `step ${si} has no answers`); break; }
    for (const g of step.answers) {
      const err = checkStep(l, step, b, g, color);
      if (err) fail(l, `step ${si}: ${err}`);
    }
    for (const g of Object.keys(typeof step.wrong === "object" ? step.wrong : {})) {
      if (step.answers.includes(g)) fail(l, `step ${si}: ${g} is both right and wrong`);
    }
    // follow the main line: first answer, then the scripted reply
    const r = tryMove(b, step.answers[0], color);
    if (!r) break;
    b = r.board;
    if (step.reply) {
      const rr = tryMove(b, step.reply, other(color));
      if (!rr) { fail(l, `step ${si}: reply ${step.reply} is illegal`); break; }
      b = rr.board;
    } else if (si < l.steps.length - 1) {
      fail(l, `step ${si} has no reply but more steps follow`);
    }
  }
  for (const g of [...(l.marks?.circle || []), ...(l.marks?.triangle || []), ...(l.marks?.square || []), ...Object.keys(l.marks?.label || {})]) {
    const p = fromGTP(g, l.size);
    if (!p || p.x < 0 || p.x >= l.size || p.y < 0 || p.y >= l.size) fail(l, `mark off board: ${g}`);
  }
}
if (new Set(LESSONS.map((l) => l.id)).size !== LESSONS.length) { failures++; console.log("✗ duplicate lesson ids"); }
if (!LADDER.length) { failures++; console.log("✗ empty ladder"); }
console.log(failures ? `\n${failures} problem(s)` : `✓ ${LESSONS.length} lessons OK · ${LADDER.length} ladder stages`);
process.exit(failures ? 1 : 0);
