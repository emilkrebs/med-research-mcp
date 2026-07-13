/**
 * Hand-rolled SVG charts (spec §"Charts to Auto-Generate"). No plotting
 * dependency — each function returns a standalone, self-contained SVG string on
 * a white background suitable for a paper figure. Colors are consistent per
 * condition across every chart, from the colorblind-safe Okabe-Ito palette.
 *
 * `scores.csv` is exported alongside these so PyData/R users can build their own.
 */

import type { ConditionId, ScoreRow } from "../types.js";
import { mean, sd } from "../stats.js";
import { speedScore, costScore } from "../scoring/composite.js";

const COLOR: Record<ConditionId, string> = {
  "closed-book": "#E69F00",
  "web-search": "#56B4E9",
  mcp: "#009E73",
};

const FALLBACK_COLORS = ["#CC79A7", "#F0E442", "#0072B2", "#D55E00", "#999999"];

function conditions(rows: ScoreRow[]): ConditionId[] {
  return [...new Set(rows.map((r) => r.condition))];
}

function colorFor(condition: ConditionId): string {
  const c = COLOR[condition];
  if (c) return c;
  const idx = condition.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % FALLBACK_COLORS.length;
  return FALLBACK_COLORS[idx]!;
}

const FONT = "font-family='ui-sans-serif,-apple-system,Segoe UI,Roboto,sans-serif'";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function doc(w: number, h: number, body: string, title: string): string {
  return (
    `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}' role='img'>` +
    `<title>${esc(title)}</title>` +
    `<rect width='${w}' height='${h}' fill='#ffffff'/>` +
    body +
    `</svg>`
  );
}

function text(x: number, y: number, s: string, opts: { size?: number; anchor?: string; color?: string; weight?: string } = {}): string {
  const { size = 12, anchor = "start", color = "#222", weight = "normal" } = opts;
  return `<text x='${x}' y='${y}' ${FONT} font-size='${size}' font-weight='${weight}' text-anchor='${anchor}' fill='${color}'>${esc(s)}</text>`;
}

function legend(x: number, y: number, entries: { label: string; color: string }[]): string {
  return entries
    .map((e, i) => {
      const yy = y + i * 18;
      return `<rect x='${x}' y='${yy - 9}' width='11' height='11' fill='${e.color}'/>` + text(x + 16, yy, e.label, { size: 11 });
    })
    .join("");
}

// ─── Aggregation ────────────────────────────────────────────────

function models(rows: ScoreRow[]): string[] {
  return [...new Set(rows.map((r) => r.model))];
}

function pick(rows: ScoreRow[], model: string, condition: ConditionId, sel: (r: ScoreRow) => number): number[] {
  // NaN is the selector's opt-out signal (e.g. non-bullshit rows in the bullshit chart).
  return rows
    .filter((r) => r.model === model && r.condition === condition)
    .map(sel)
    .filter((v) => Number.isFinite(v));
}

// ─── Grouped bar charts (condition × model) ─────────────────────

interface BarSpec {
  title: string;
  sel: (r: ScoreRow) => number;
  yMax: number;
  errorBars: boolean;
  format?: (v: number) => string;
}

function groupedBars(rows: ScoreRow[], spec: BarSpec): string {
  const W = 720;
  const H = 420;
  const pad = { l: 56, r: 170, t: 44, b: 60 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const ms = models(rows);
  const conds = conditions(rows);
  const groupW = plotW / Math.max(conds.length, 1);
  const barW = Math.min(48, (groupW * 0.7) / Math.max(ms.length, 1));

  const y = (v: number) => pad.t + plotH * (1 - v / spec.yMax);
  let body = "";

  // Y grid + ticks.
  for (let i = 0; i <= 4; i++) {
    const v = (spec.yMax / 4) * i;
    const yy = y(v);
    body += `<line x1='${pad.l}' y1='${yy}' x2='${pad.l + plotW}' y2='${yy}' stroke='#eee'/>`;
    body += text(pad.l - 8, yy + 4, spec.format ? spec.format(v) : String(Math.round(v * 100) / 100), { size: 10, anchor: "end", color: "#666" });
  }

  conds.forEach((condition, ci) => {
    const gx = pad.l + ci * groupW + groupW / 2;
    const clusterW = ms.length * barW + (ms.length - 1) * 6;
    ms.forEach((model, mi) => {
      const values = pick(rows, model, condition, spec.sel);
      if (values.length === 0) return;
      const m = mean(values);
      const bx = gx - clusterW / 2 + mi * (barW + 6);
      const by = y(m);
      const opacity = ms.length > 1 ? 0.55 + (0.45 * mi) / (ms.length - 1) : 1;
      body += `<rect x='${bx}' y='${by}' width='${barW}' height='${pad.t + plotH - by}' fill='${colorFor(condition)}' fill-opacity='${opacity.toFixed(2)}'/>`;
      if (spec.errorBars) {
        const s = sd(values);
        const yTop = y(Math.min(spec.yMax, m + s));
        const yBot = y(Math.max(0, m - s));
        const cx = bx + barW / 2;
        body += `<line x1='${cx}' y1='${yTop}' x2='${cx}' y2='${yBot}' stroke='#333'/>`;
        body += `<line x1='${cx - 4}' y1='${yTop}' x2='${cx + 4}' y2='${yTop}' stroke='#333'/>`;
        body += `<line x1='${cx - 4}' y1='${yBot}' x2='${cx + 4}' y2='${yBot}' stroke='#333'/>`;
      }
      body += text(bx + barW / 2, by - 4, (spec.format ? spec.format(m) : m.toFixed(2)), { size: 9, anchor: "middle", color: "#333" });
    });
    body += text(gx, pad.t + plotH + 20, condition, { size: 12, anchor: "middle", weight: "600" });
  });

  body += `<line x1='${pad.l}' y1='${pad.t + plotH}' x2='${pad.l + plotW}' y2='${pad.t + plotH}' stroke='#333'/>`;
  body += text(pad.l, 26, spec.title, { size: 15, weight: "700" });
  body += legend(
    pad.l + plotW + 24,
    pad.t + 10,
    conds.map((c) => ({ label: c, color: colorFor(c) })),
  );
  if (ms.length > 1) {
    body += text(pad.l + plotW + 24, pad.t + 10 + conds.length * 18 + 14, "Bars per group = models", { size: 10, color: "#666" });
    body += ms
      .map((m, i) => text(pad.l + plotW + 24, pad.t + 10 + conds.length * 18 + 30 + i * 15, `${i + 1}. ${m}`, { size: 10, color: "#666" }))
      .join("");
  }
  return doc(W, H, body, spec.title);
}

// ─── Radar ──────────────────────────────────────────────────────

function radar(rows: ScoreRow[]): string {
  const W = 560;
  const H = 480;
  const cx = W / 2;
  const cy = H / 2 + 10;
  const R = 150;
  const axes = ["accuracy", "evidence", "bullshit", "speed", "cost"];
  const dims: ((r: ScoreRow) => number)[] = [
    (r) => r.accuracy / 10,
    (r) => r.evidence_quality / 5,
    (r) => r.bullshit_score,
    (r) => speedScore(r.speed_s),
    (r) => costScore(r.input_tokens + r.output_tokens),
  ];
  const angle = (i: number) => -Math.PI / 2 + (2 * Math.PI * i) / axes.length;
  const point = (i: number, radius: number): [number, number] => [cx + radius * Math.cos(angle(i)), cy + radius * Math.sin(angle(i))];

  let body = text(cx, 26, "Condition profile (5 dimensions, 0–1)", { size: 15, anchor: "middle", weight: "700" });

  // Rings + axes.
  for (let ring = 1; ring <= 4; ring++) {
    const rr = (R * ring) / 4;
    const pts = axes.map((_, i) => point(i, rr).join(",")).join(" ");
    body += `<polygon points='${pts}' fill='none' stroke='#eee'/>`;
  }
  axes.forEach((label, i) => {
    const [x, yy] = point(i, R);
    body += `<line x1='${cx}' y1='${cy}' x2='${x}' y2='${yy}' stroke='#ddd'/>`;
    const [lx, ly] = point(i, R + 24);
    body += text(lx, ly, label, { size: 11, anchor: "middle", color: "#444" });
  });

  // One polygon per condition, averaged across models.
  const conds = conditions(rows);
  for (const condition of conds) {
    const subset = rows.filter((r) => r.condition === condition);
    if (subset.length === 0) continue;
    const pts = dims
      .map((sel, i) => {
        const v = Math.max(0, Math.min(1, mean(subset.map(sel))));
        return point(i, R * v).join(",");
      })
      .join(" ");
    body += `<polygon points='${pts}' fill='${colorFor(condition)}' fill-opacity='0.14' stroke='${colorFor(condition)}' stroke-width='2'/>`;
  }
  body += legend(
    24,
    H - 60,
    conds.map((c) => ({ label: c, color: colorFor(c) })),
  );
  return doc(W, H, body, "Condition radar");
}

// ─── Evidence histogram ─────────────────────────────────────────

function evidenceHistogram(rows: ScoreRow[]): string {
  const W = 720;
  const H = 420;
  const pad = { l: 56, r: 170, t: 44, b: 60 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const buckets = ["0–1", "1–2", "2–3", "3–4", "4–5"];
  const bucketOf = (v: number) => Math.min(4, Math.max(0, Math.floor(v)));

  const conds = conditions(rows);
  const counts = new Map<ConditionId, number[]>(conds.map((c) => [c, [0, 0, 0, 0, 0]]));
  let maxCount = 1;
  for (const r of rows) {
    if (r.pmids_valid === 0) continue; // only rows that actually cited real evidence
    const b = bucketOf(r.evidence_quality);
    const rowCounts = counts.get(r.condition);
    if (!rowCounts) continue;
    rowCounts[b] = (rowCounts[b] ?? 0) + 1;
  }
  for (const c of conds) maxCount = Math.max(maxCount, ...counts.get(c)!);

  const groupW = plotW / buckets.length;
  const barW = Math.min(36, (groupW * 0.7) / Math.max(conds.length, 1));
  const y = (v: number) => pad.t + plotH * (1 - v / maxCount);
  let body = text(pad.l, 26, "Evidence-quality distribution (mean score of cited PMIDs)", { size: 15, weight: "700" });

  for (let i = 0; i <= 4; i++) {
    const v = (maxCount / 4) * i;
    const yy = y(v);
    body += `<line x1='${pad.l}' y1='${yy}' x2='${pad.l + plotW}' y2='${yy}' stroke='#eee'/>`;
    body += text(pad.l - 8, yy + 4, String(Math.round(v)), { size: 10, anchor: "end", color: "#666" });
  }

  buckets.forEach((label, bi) => {
    const gx = pad.l + bi * groupW + groupW / 2;
    const clusterW = conds.length * barW + (conds.length - 1) * 4;
    conds.forEach((condition, ci) => {
      const count = counts.get(condition)![bi]!;
      const bx = gx - clusterW / 2 + ci * (barW + 4);
      const by = y(count);
      body += `<rect x='${bx}' y='${by}' width='${barW}' height='${pad.t + plotH - by}' fill='${colorFor(condition)}'/>`;
    });
    body += text(gx, pad.t + plotH + 20, label, { size: 11, anchor: "middle" });
  });
  body += text(pad.l + plotW / 2, H - 14, "evidence score bucket (0–5)", { size: 11, anchor: "middle", color: "#666" });
  body += `<line x1='${pad.l}' y1='${pad.t + plotH}' x2='${pad.l + plotW}' y2='${pad.t + plotH}' stroke='#333'/>`;
  body += legend(
    pad.l + plotW + 24,
    pad.t + 10,
    conds.map((c) => ({ label: c, color: colorFor(c) })),
  );
  return doc(W, H, body, "Evidence histogram");
}

// ─── Speed vs accuracy scatter ──────────────────────────────────

function scatter(rows: ScoreRow[]): string {
  const W = 640;
  const H = 460;
  const pad = { l: 56, r: 160, t: 44, b: 56 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const maxSpeed = Math.max(1, ...rows.map((r) => r.speed_s));
  const x = (s: number) => pad.l + plotW * (s / maxSpeed);
  const y = (a: number) => pad.t + plotH * (1 - a / 10);
  const conds = conditions(rows);

  let body = text(pad.l, 26, "Speed vs accuracy (each dot = one run)", { size: 15, weight: "700" });
  for (let i = 0; i <= 5; i++) {
    const a = 2 * i;
    const yy = y(a);
    body += `<line x1='${pad.l}' y1='${yy}' x2='${pad.l + plotW}' y2='${yy}' stroke='#eee'/>`;
    body += text(pad.l - 8, yy + 4, String(a), { size: 10, anchor: "end", color: "#666" });
  }
  for (let i = 0; i <= 4; i++) {
    const s = (maxSpeed / 4) * i;
    const xx = x(s);
    body += text(xx, pad.t + plotH + 18, `${s.toFixed(0)}s`, { size: 10, anchor: "middle", color: "#666" });
  }
  for (const r of rows) {
    body += `<circle cx='${x(r.speed_s).toFixed(1)}' cy='${y(r.accuracy).toFixed(1)}' r='4' fill='${colorFor(r.condition)}' fill-opacity='0.65'/>`;
  }
  body += text(pad.l - 40, pad.t + plotH / 2, "accuracy", { size: 11, anchor: "middle", color: "#666" });
  body += text(pad.l + plotW / 2, H - 12, "wall-clock time", { size: 11, anchor: "middle", color: "#666" });
  body += `<line x1='${pad.l}' y1='${pad.t + plotH}' x2='${pad.l + plotW}' y2='${pad.t + plotH}' stroke='#333'/>`;
  body += `<line x1='${pad.l}' y1='${pad.t}' x2='${pad.l}' y2='${pad.t + plotH}' stroke='#333'/>`;
  body += legend(
    pad.l + plotW + 20,
    pad.t + 10,
    conds.map((c) => ({ label: c, color: colorFor(c) })),
  );
  return doc(W, H, body, "Speed vs accuracy");
}

/** Render every chart. Returns filename → SVG string. */
export function renderCharts(rows: ScoreRow[]): Record<string, string> {
  return {
    "composite-bars.svg": groupedBars(rows, { title: "Composite score by condition × model", sel: (r) => r.composite, yMax: 10, errorBars: true }),
    "radar-conditions.svg": radar(rows),
    "bullshit-rate.svg": groupedBars(rows, {
      title: "Correct-rejection rate (bullshit queries)",
      sel: (r) => (r.category === "bullshit" ? r.bullshit_score : Number.NaN),
      yMax: 1,
      errorBars: false,
      format: (v) => `${Math.round(v * 100)}%`,
    }),
    "fabrication-rate.svg": groupedBars(rows, {
      title: "Fabrication rate (invented PMIDs ÷ cited PMIDs)",
      sel: (r) => (r.pmids_cited > 0 ? r.pmids_fabricated / r.pmids_cited : 0),
      yMax: 1,
      errorBars: false,
      format: (v) => `${Math.round(v * 100)}%`,
    }),
    "evidence-histogram.svg": evidenceHistogram(rows),
    "speed-vs-accuracy-scatter.svg": scatter(rows),
  };
}
