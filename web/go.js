// Go rules: board state, captures, suicide, simple ko, GTP coordinates.
export const EMPTY = 0, BLACK = 1, WHITE = 2;
const LETTERS = "ABCDEFGHJKLMNOPQRST";

export const other = (c) => (c === BLACK ? WHITE : BLACK);
export const colorChar = (c) => (c === BLACK ? "B" : "W");
export const charColor = (s) => (s === "B" ? BLACK : WHITE);

export function toGTP(x, y, size) {
  return LETTERS[x] + (size - y);
}
export function fromGTP(s, size) {
  if (!s || s.toLowerCase() === "pass") return null;
  const x = LETTERS.indexOf(s[0].toUpperCase());
  const y = size - parseInt(s.slice(1), 10);
  return { x, y };
}

export function starPoints(size) {
  if (size === 19) return [3, 9, 15].flatMap((a) => [3, 9, 15].map((b) => [a, b]));
  if (size === 13) return [[3, 3], [3, 9], [9, 3], [9, 9], [6, 6]];
  return [[2, 2], [2, 6], [6, 2], [6, 6], [4, 4]];
}

// Standard fixed handicap placement (GTP order), returns [x,y] list.
export function handicapPoints(size, n) {
  if (n < 2) return [];
  const e = size >= 13 ? 3 : 2, m = (size - 1) / 2, f = size - 1 - e;
  const pts = [[f, e], [e, f], [f, f], [e, e]];
  const sides = [[e, m], [f, m]], tb = [[m, e], [m, f]], c = [m, m];
  if (n <= 4) return pts.slice(0, n);
  if (n === 5) return [...pts, c];
  if (n === 6) return [...pts, ...sides];
  if (n === 7) return [...pts, ...sides, c];
  if (n === 8) return [...pts, ...sides, ...tb];
  return [...pts, ...sides, ...tb, c];
}

export class Board {
  constructor(size) {
    this.size = size;
    this.grid = new Int8Array(size * size);
    this.ko = -1;
    this.captures = { [BLACK]: 0, [WHITE]: 0 };
  }
  clone() {
    const b = new Board(this.size);
    b.grid.set(this.grid);
    b.ko = this.ko;
    b.captures = { ...this.captures };
    return b;
  }
  idx(x, y) { return y * this.size + x; }
  get(x, y) { return this.grid[this.idx(x, y)]; }
  neighbors(i) {
    const s = this.size, x = i % s, y = (i / s) | 0, out = [];
    if (x > 0) out.push(i - 1);
    if (x < s - 1) out.push(i + 1);
    if (y > 0) out.push(i - s);
    if (y < s - 1) out.push(i + s);
    return out;
  }
  // Returns {stones:[idx], libs:Set(idx)}
  group(i) {
    const color = this.grid[i], stones = [], libs = new Set(), seen = new Set([i]), stack = [i];
    while (stack.length) {
      const p = stack.pop();
      stones.push(p);
      for (const n of this.neighbors(p)) {
        const c = this.grid[n];
        if (c === EMPTY) libs.add(n);
        else if (c === color && !seen.has(n)) { seen.add(n); stack.push(n); }
      }
    }
    return { stones, libs };
  }
  isLegal(x, y, color) {
    const i = this.idx(x, y);
    if (this.grid[i] !== EMPTY || i === this.ko) return false;
    const t = this.clone();
    return t._place(i, color) !== null;
  }
  _place(i, color) {
    this.grid[i] = color;
    const opp = other(color);
    let captured = [];
    for (const n of this.neighbors(i)) {
      if (this.grid[n] === opp) {
        const g = this.group(n);
        if (g.libs.size === 0) {
          for (const s of g.stones) this.grid[s] = EMPTY;
          captured = captured.concat(g.stones);
        }
      }
    }
    const own = this.group(i);
    if (own.libs.size === 0) { this.grid[i] = EMPTY; return null; } // suicide
    const uniq = [...new Set(captured)];
    this.ko = uniq.length === 1 && own.stones.length === 1 && own.libs.size === 1 ? uniq[0] : -1;
    this.captures[color] += uniq.length;
    return uniq;
  }
  // Play a move; returns captured indices array or null if illegal.
  play(x, y, color) {
    const i = this.idx(x, y);
    if (this.grid[i] !== EMPTY || i === this.ko) return null;
    const before = this.clone();
    const res = this._place(i, color);
    if (res === null) { Object.assign(this, before); return null; }
    return res;
  }
  pass() { this.ko = -1; }
}
