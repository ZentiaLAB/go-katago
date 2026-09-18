// Minimal SVG charts (line + bar) with hover tooltips. Colors come from CSS variables.
const NS = "http://www.w3.org/2000/svg";
const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};

function frame(box, height, legend) {
  box.innerHTML = "";
  box.classList.add("chart");
  if (legend && legend.length > 1) {
    const lg = document.createElement("div");
    lg.className = "legend";
    lg.innerHTML = legend.map((s) => `<span><i style="background:var(${s.color})${s.dash ? ";opacity:.35" : ""}"></i>${s.name}</span>`).join("");
    box.appendChild(lg);
  }
  const W = Math.max(240, box.clientWidth), H = height;
  const svg = el("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}` }, box);
  const tip = document.createElement("div");
  tip.className = "tip hidden";
  box.appendChild(tip);
  return { svg, tip, W, H };
}

function niceTicks(min, max, n = 4) {
  const span = max - min || 1, step0 = span / n, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n + 0.5) || step0;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

/**
 * series: [{name, color:'--series-1', points:[{x,y}], endLabel?:bool}]
 * opts: {height, yMin, yMax, yFmt, ref, xMin, xMax, xFmt, xTitle, tipTitle(x), bands:[{x0,x1,color}]}
 */
export function lineChart(box, series, opts = {}) {
  const { svg, tip, W, H } = frame(box, opts.height || 150, series);
  const all = series.flatMap((s) => s.points);
  const padL = 40, padR = opts.endLabels === false ? 10 : 78, padT = 8, padB = 22;
  if (!all.length) {
    el("text", { x: W / 2, y: H / 2, "text-anchor": "middle", class: "axis-t" }, svg).textContent = opts.empty || "ยังไม่มีข้อมูล";
    return;
  }
  let yMin = opts.yMin ?? Math.min(...all.map((p) => p.y)), yMax = opts.yMax ?? Math.max(...all.map((p) => p.y));
  if (opts.symmetric) { const m = Math.max(Math.abs(yMin), Math.abs(yMax), 1); yMin = -m; yMax = m; }
  if (yMax - yMin < 1e-6) { yMax += 1; yMin -= 1; }
  const xMin = opts.xMin ?? Math.min(...all.map((p) => p.x)), xMax = Math.max(opts.xMax ?? -Infinity, ...all.map((p) => p.x), xMin + 1);
  const X = (x) => padL + ((x - xMin) / (xMax - xMin)) * (W - padL - padR);
  const Y = (y) => padT + (1 - (y - yMin) / (yMax - yMin)) * (H - padT - padB);
  const fmt = opts.yFmt || ((v) => v.toFixed(0));

  for (const b of opts.bands || []) {
    const x0 = Math.max(X(b.x0), padL), x1 = Math.min(X(b.x1), W - padR);
    if (x1 > x0) el("rect", { x: x0, y: padT, width: x1 - x0, height: H - padT - padB, fill: `var(${b.color})`, opacity: 0.12 }, svg);
  }
  for (const t of niceTicks(yMin, yMax)) {
    el("line", { x1: padL, x2: W - padR, y1: Y(t), y2: Y(t), class: "grid" }, svg);
    el("text", { x: padL - 6, y: Y(t) + 4, "text-anchor": "end", class: "axis-t" }, svg).textContent = fmt(t);
  }
  if (opts.ref !== undefined) el("line", { x1: padL, x2: W - padR, y1: Y(opts.ref), y2: Y(opts.ref), class: "ref" }, svg);
  el("text", { x: padL, y: H - 5, class: "axis-t" }, svg).textContent = (opts.xFmt || String)(xMin);
  el("text", { x: W - padR, y: H - 5, "text-anchor": "end", class: "axis-t" }, svg).textContent = (opts.xFmt || String)(xMax);
  if (opts.xTitle) el("text", { x: (padL + W - padR) / 2, y: H - 5, "text-anchor": "middle", class: "axis-t" }, svg).textContent = opts.xTitle;

  const labels = [];
  for (const s of series) {
    if (!s.points.length) continue;
    const d = s.points.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join("");
    el("path", { d, fill: "none", stroke: `var(${s.color})`, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round", "stroke-dasharray": s.dash || "" }, svg);
    const last = s.points[s.points.length - 1];
    if (s.points.length === 1) el("circle", { cx: X(last.x), cy: Y(last.y), r: 4, fill: `var(${s.color})` }, svg);
    if (opts.endLabels !== false) labels.push({ y: Y(last.y), text: `${s.short || s.name} ${fmt(last.y)}`, color: s.color, x: X(last.x) });
  }
  // de-collide end labels
  labels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 13) labels[i].y = labels[i - 1].y + 13;
  for (const l of labels) {
    el("circle", { cx: W - padR + 8, cy: l.y - 4, r: 3.5, fill: `var(${l.color})` }, svg);
    el("text", { x: W - padR + 15, y: l.y, class: "end-t" }, svg).textContent = l.text;
  }

  // hover layer: crosshair + tooltip for the nearest x
  const xs = [...new Set(all.map((p) => p.x))].sort((a, b) => a - b);
  const cross = el("line", { y1: padT, y2: H - padB, class: "cross", visibility: "hidden" }, svg);
  const dots = series.map((s) => el("circle", { r: 4.5, fill: `var(${s.color})`, stroke: "var(--surface)", "stroke-width": 2, visibility: "hidden" }, svg));
  const hit = el("rect", { x: padL, y: 0, width: W - padL - padR, height: H, fill: "transparent" }, svg);
  hit.addEventListener("mousemove", (e) => {
    const r = svg.getBoundingClientRect(), mx = e.clientX - r.left;
    let best = xs[0];
    for (const x of xs) if (Math.abs(X(x) - mx) < Math.abs(X(best) - mx)) best = x;
    cross.setAttribute("x1", X(best)); cross.setAttribute("x2", X(best)); cross.setAttribute("visibility", "visible");
    const rows = [];
    series.forEach((s, i) => {
      const p = s.points.find((q) => q.x === best);
      if (!p) { dots[i].setAttribute("visibility", "hidden"); return; }
      dots[i].setAttribute("cx", X(p.x)); dots[i].setAttribute("cy", Y(p.y)); dots[i].setAttribute("visibility", "visible");
      rows.push(`<div><i style="background:var(${s.color})"></i>${s.name}<b>${fmt(p.y)}</b></div>${p.note ? `<small>${p.note}</small>` : ""}`);
    });
    tip.innerHTML = `<div class="tt">${opts.tipTitle ? opts.tipTitle(best) : best}</div>${rows.join("")}`;
    tip.classList.remove("hidden");
    const tx = X(best) + 12, flip = tx + tip.offsetWidth > W;
    tip.style.left = `${flip ? X(best) - tip.offsetWidth - 12 : tx}px`;
    tip.style.top = `${(box.querySelector(".legend")?.offsetHeight || 0) + 4}px`;
  });
  hit.addEventListener("mouseleave", () => { tip.classList.add("hidden"); cross.setAttribute("visibility", "hidden"); dots.forEach((d) => d.setAttribute("visibility", "hidden")); });
}

/** bars: [{x, y, color, tip}] — one bar per x, colored by identity. legend: [{name,color}] */
export function barChart(box, bars, opts = {}) {
  const { svg, tip, W, H } = frame(box, opts.height || 130, opts.legend);
  const padL = 40, padR = 10, padT = 8, padB = 22;
  if (!bars.length) {
    el("text", { x: W / 2, y: H / 2, "text-anchor": "middle", class: "axis-t" }, svg).textContent = opts.empty || "ยังไม่มีข้อมูล";
    return;
  }
  const yMax = Math.max(...bars.map((b) => b.y), 1e-6) * 1.08;
  const xMin = Math.min(...bars.map((b) => b.x)), xMax = Math.max(...bars.map((b) => b.x), xMin + 1);
  const n = xMax - xMin + 1, slot = (W - padL - padR) / n, bw = Math.max(2, Math.min(18, slot - 2));
  const X = (x) => padL + (x - xMin) * slot + (slot - bw) / 2;
  const Y = (y) => padT + (1 - y / yMax) * (H - padT - padB);
  const fmt = opts.yFmt || ((v) => v.toFixed(1));
  for (const t of niceTicks(0, yMax)) {
    el("line", { x1: padL, x2: W - padR, y1: Y(t), y2: Y(t), class: "grid" }, svg);
    el("text", { x: padL - 6, y: Y(t) + 4, "text-anchor": "end", class: "axis-t" }, svg).textContent = fmt(t);
  }
  el("text", { x: padL, y: H - 5, class: "axis-t" }, svg).textContent = `${opts.xLabel || ""}${xMin}`;
  el("text", { x: W - padR, y: H - 5, "text-anchor": "end", class: "axis-t" }, svg).textContent = `${opts.xLabel || ""}${xMax}`;
  const base = Y(0);
  for (const b of bars) {
    const top = Y(b.y), h = Math.max(1, base - top), r = Math.min(4, bw / 2, h);
    const x = X(b.x);
    // rounded data-end, square baseline
    const d = `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${base}Z`;
    const p = el("path", { d, fill: `var(${b.color})` }, svg);
    const hit = el("rect", { x: x - (slot - bw) / 2, y: padT, width: slot, height: H - padT - padB, fill: "transparent" }, svg);
    hit.addEventListener("mouseenter", () => {
      p.setAttribute("opacity", 0.75);
      tip.innerHTML = b.tip; tip.classList.remove("hidden");
      const tx = x + bw + 8, flip = tx + tip.offsetWidth > W;
      tip.style.left = `${flip ? x - tip.offsetWidth - 8 : tx}px`;
      tip.style.top = `${(box.querySelector(".legend")?.offsetHeight || 0) + 4}px`;
    });
    hit.addEventListener("mouseleave", () => { p.setAttribute("opacity", 1); tip.classList.add("hidden"); });
  }
  el("line", { x1: padL, x2: W - padR, y1: base, y2: base, class: "base" }, svg);
}
