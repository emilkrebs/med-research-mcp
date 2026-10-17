/**
 * D3-powered SVG charts (spec §"Charts to Auto-Generate"). Each function
 * builds a detached SVG document (via jsdom) using d3 scales/shapes/axes and
 * the standard `selection.data().join()` pattern, then serializes it to a
 * standalone, self-contained SVG string suitable for a paper figure. Colors
 * are consistent per condition across every chart, from the colorblind-safe
 * Okabe-Ito palette.
 *
 * `scores.csv` is exported alongside these so PyData/R users can build their own.
 */

import { JSDOM } from "jsdom";
import * as d3 from "d3";
import type { ConditionId, ScoreRow } from "../types.js";
import { mean, sd } from "../stats.js";
import { speedScore, costScore } from "../scoring/composite.js";
import { WEIGHTS } from "../config.js";

type Sel<E extends Element = Element> = d3.Selection<E, unknown, null, undefined>;

const COLOR: Record<ConditionId, string> = {
  "closed-book": "#E69F00",
  "web-search": "#56B4E9",
  mcp: "#009E73",
};

const FALLBACK_COLORS = ["#CC79A7", "#F0E442", "#0072B2", "#D55E00", "#999999"];

const FONT = "ui-sans-serif,-apple-system,Segoe UI,Roboto,sans-serif";

/** Rows eligible for charts: only successful runs (failed ones would plot as fake zeros). */
function okRows(rows: ScoreRow[]): ScoreRow[] {
  return rows.filter((r) => r.status === "ok");
}

function conditions(rows: ScoreRow[]): ConditionId[] {
  return [...new Set(rows.map((r) => r.condition))];
}

function models(rows: ScoreRow[]): string[] {
  return [...new Set(rows.map((r) => r.model))];
}

function colorFor(condition: ConditionId): string {
  const c = COLOR[condition];
  if (c) return c;
  const idx = condition.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % FALLBACK_COLORS.length;
  return FALLBACK_COLORS[idx]!;
}

function pick(rows: ScoreRow[], model: string, condition: ConditionId, sel: (r: ScoreRow) => number): number[] {
  // NaN is the selector's opt-out signal (e.g. non-bullshit rows in the bullshit chart).
  return rows
    .filter((r) => r.model === model && r.condition === condition)
    .map(sel)
    .filter((v) => Number.isFinite(v));
}

// ─── SVG document scaffolding ────────────────────────────────────

/** Creates a detached, jsdom-backed SVG root and binds a d3 selection to it. */
function createSvg(width: number, height: number, title: string): Sel<SVGSVGElement> {
  const { document } = new JSDOM("<!DOCTYPE html><body></body>").window;
  const svg = d3
    .select(document.body)
    .append("svg")
    .attr("xmlns", "http://www.w3.org/2000/svg")
    .attr("width", width)
    .attr("height", height)
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("role", "img")
    .style("font-family", FONT) as Sel<SVGSVGElement>;
  svg.append("title").text(title);
  svg.append("rect").attr("width", width).attr("height", height).attr("fill", "#ffffff");
  return svg;
}

function serialize(svg: Sel<SVGSVGElement>): string {
  return (svg.node() as unknown as { outerHTML: string }).outerHTML;
}

function legend(svg: Sel<SVGSVGElement>, x: number, y: number, entries: { label: string; color: string }[]): void {
  const g = svg.append("g").attr("class", "legend");
  const item = g
    .selectAll("g")
    .data(entries)
    .join("g")
    .attr("transform", (_d, i) => `translate(${x},${y + i * 18})`);
  item
    .append("rect")
    .attr("y", -9)
    .attr("width", 11)
    .attr("height", 11)
    .attr("fill", (d) => d.color);
  item
    .append("text")
    .attr("x", 16)
    .attr("font-size", 11)
    .attr("fill", "#222")
    .text((d) => d.label);
}

/** A left y-axis rendered as light horizontal gridlines (d3-axis's tickSize grid trick). */
function yGridAxis(
  svg: Sel<SVGSVGElement>,
  pad: { l: number; t: number },
  plotW: number,
  scale: d3.ScaleLinear<number, number>,
  format?: (v: number) => string,
): void {
  const fmt = format ?? ((v: number) => String(Math.round(v * 100) / 100));
  const axis = d3
    .axisLeft(scale)
    .ticks(4)
    .tickSize(-plotW)
    .tickFormat((v) => fmt(Number(v)));
  const g = svg.append("g").attr("transform", `translate(${pad.l},0)`).call(axis) as Sel<SVGGElement>;
  g.select(".domain").remove();
  g.selectAll(".tick line").attr("stroke", "#eee");
  g.selectAll(".tick text").attr("font-size", 10).attr("fill", "#666");
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

  const x0 = d3.scaleBand<ConditionId>().domain(conds).range([pad.l, pad.l + plotW]).paddingInner(0.3);
  const x1 = d3.scaleBand<string>().domain(ms).range([0, x0.bandwidth()]).padding(0.15);
  const y = d3.scaleLinear().domain([0, spec.yMax]).range([pad.t + plotH, pad.t]);

  const svg = createSvg(W, H, spec.title);
  yGridAxis(svg, pad, plotW, y, spec.format);

  const group = svg
    .append("g")
    .selectAll("g")
    .data(conds)
    .join("g")
    .attr("transform", (c) => `translate(${x0(c)},0)`);

  group.each(function (condition) {
    const g = d3.select(this);
    const bars = ms
      .map((model) => ({ model, values: pick(rows, model, condition, spec.sel) }))
      .filter((d) => d.values.length > 0);

    const bar = g
      .selectAll("g.bar")
      .data(bars)
      .join("g")
      .attr("class", "bar")
      .attr("transform", (d) => `translate(${x1(d.model)},0)`);

    bar.each(function (d, mi) {
      const b = d3.select(this);
      const m = mean(d.values);
      const by = y(m);
      const opacity = ms.length > 1 ? 0.55 + (0.45 * mi) / (ms.length - 1) : 1;
      b.append("rect")
        .attr("y", by)
        .attr("width", x1.bandwidth())
        .attr("height", pad.t + plotH - by)
        .attr("fill", colorFor(condition))
        .attr("fill-opacity", opacity.toFixed(2));
      if (spec.errorBars) {
        const s = sd(d.values);
        const yTop = y(Math.min(spec.yMax, m + s));
        const yBot = y(Math.max(0, m - s));
        const cx = x1.bandwidth() / 2;
        b.append("line").attr("x1", cx).attr("y1", yTop).attr("x2", cx).attr("y2", yBot).attr("stroke", "#333");
        b.append("line").attr("x1", cx - 4).attr("y1", yTop).attr("x2", cx + 4).attr("y2", yTop).attr("stroke", "#333");
        b.append("line").attr("x1", cx - 4).attr("y1", yBot).attr("x2", cx + 4).attr("y2", yBot).attr("stroke", "#333");
      }
      b.append("text")
        .attr("x", x1.bandwidth() / 2)
        .attr("y", by - 4)
        .attr("font-size", 9)
        .attr("text-anchor", "middle")
        .attr("fill", "#333")
        .text(spec.format ? spec.format(m) : m.toFixed(2));
    });

    g.append("text")
      .attr("x", x0.bandwidth() / 2)
      .attr("y", pad.t + plotH + 20)
      .attr("font-size", 12)
      .attr("font-weight", 600)
      .attr("text-anchor", "middle")
      .text(condition);
  });

  svg
    .append("line")
    .attr("x1", pad.l)
    .attr("y1", pad.t + plotH)
    .attr("x2", pad.l + plotW)
    .attr("y2", pad.t + plotH)
    .attr("stroke", "#333");
  svg.append("text").attr("x", pad.l).attr("y", 26).attr("font-size", 15).attr("font-weight", 700).text(spec.title);
  legend(
    svg,
    pad.l + plotW + 24,
    pad.t + 10,
    conds.map((c) => ({ label: c, color: colorFor(c) })),
  );
  if (ms.length > 1) {
    const notesY = pad.t + 10 + conds.length * 18 + 14;
    svg
      .append("text")
      .attr("x", pad.l + plotW + 24)
      .attr("y", notesY)
      .attr("font-size", 10)
      .attr("fill", "#666")
      .text("Bars per group = models");
    ms.forEach((m, i) => {
      svg
        .append("text")
        .attr("x", pad.l + plotW + 24)
        .attr("y", notesY + 16 + i * 15)
        .attr("font-size", 10)
        .attr("fill", "#666")
        .text(`${i + 1}. ${m}`);
    });
  }
  return serialize(svg);
}

// ─── Pooled-ratio bar chart (condition × model) ─────────────────

interface PooledRatioSpec {
  title: string;
  /** Per-row numerator, summed across the group before dividing. */
  numerator: (r: ScoreRow) => number;
  /** Per-row denominator, summed across the group before dividing. */
  denominator: (r: ScoreRow) => number;
  yMax: number;
  format?: (v: number) => string;
}

/**
 * Grouped bar chart for a POOLED ratio metric, i.e. `sum(numerator) / sum(denominator)`
 * over every row in a (condition, model) group — as opposed to `groupedBars`, which
 * plots the MEAN of a per-row value. Those are different statistics: mean-of-ratios
 * (e.g. averaging each response's own fabricated/cited fraction) is not the same
 * number as the pooled ratio (summing fabricated and cited separately, then
 * dividing), especially when responses cite differing numbers of PMIDs. Fabrication
 * rate is defined pooled (see `summarizeCondition` in report/summary.ts), so it needs
 * this dedicated renderer rather than being forced through `groupedBars`.
 *
 * Visually this mirrors `groupedBars` exactly (same dimensions, scales, axis, legend,
 * per-model opacity ramp, and model-key notes) minus error bars — a pooled ratio has
 * no per-row spread to show.
 */
function pooledRatioBars(rows: ScoreRow[], spec: PooledRatioSpec): string {
  const W = 720;
  const H = 420;
  const pad = { l: 56, r: 170, t: 44, b: 60 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const ms = models(rows);
  const conds = conditions(rows);

  const x0 = d3.scaleBand<ConditionId>().domain(conds).range([pad.l, pad.l + plotW]).paddingInner(0.3);
  const x1 = d3.scaleBand<string>().domain(ms).range([0, x0.bandwidth()]).padding(0.15);
  const y = d3.scaleLinear().domain([0, spec.yMax]).range([pad.t + plotH, pad.t]);

  const svg = createSvg(W, H, spec.title);
  yGridAxis(svg, pad, plotW, y, spec.format);

  const group = svg
    .append("g")
    .selectAll("g")
    .data(conds)
    .join("g")
    .attr("transform", (c) => `translate(${x0(c)},0)`);

  group.each(function (condition) {
    const g = d3.select(this);
    const bars = ms
      .map((model) => {
        const subset = rows.filter((r) => r.model === model && r.condition === condition);
        if (subset.length === 0) return null;
        const num = subset.reduce((s, r) => s + spec.numerator(r), 0);
        const den = subset.reduce((s, r) => s + spec.denominator(r), 0);
        return { model, ratio: den > 0 ? num / den : 0 };
      })
      .filter((d): d is { model: string; ratio: number } => d !== null);

    const bar = g
      .selectAll("g.bar")
      .data(bars)
      .join("g")
      .attr("class", "bar")
      .attr("transform", (d) => `translate(${x1(d.model)},0)`);

    bar.each(function (d, mi) {
      const b = d3.select(this);
      const by = y(d.ratio);
      const opacity = ms.length > 1 ? 0.55 + (0.45 * mi) / (ms.length - 1) : 1;
      b.append("rect")
        .attr("y", by)
        .attr("width", x1.bandwidth())
        .attr("height", pad.t + plotH - by)
        .attr("fill", colorFor(condition))
        .attr("fill-opacity", opacity.toFixed(2));
      b.append("text")
        .attr("x", x1.bandwidth() / 2)
        .attr("y", by - 4)
        .attr("font-size", 9)
        .attr("text-anchor", "middle")
        .attr("fill", "#333")
        .text(spec.format ? spec.format(d.ratio) : d.ratio.toFixed(2));
    });

    g.append("text")
      .attr("x", x0.bandwidth() / 2)
      .attr("y", pad.t + plotH + 20)
      .attr("font-size", 12)
      .attr("font-weight", 600)
      .attr("text-anchor", "middle")
      .text(condition);
  });

  svg
    .append("line")
    .attr("x1", pad.l)
    .attr("y1", pad.t + plotH)
    .attr("x2", pad.l + plotW)
    .attr("y2", pad.t + plotH)
    .attr("stroke", "#333");
  svg.append("text").attr("x", pad.l).attr("y", 26).attr("font-size", 15).attr("font-weight", 700).text(spec.title);
  legend(
    svg,
    pad.l + plotW + 24,
    pad.t + 10,
    conds.map((c) => ({ label: c, color: colorFor(c) })),
  );
  if (ms.length > 1) {
    const notesY = pad.t + 10 + conds.length * 18 + 14;
    svg
      .append("text")
      .attr("x", pad.l + plotW + 24)
      .attr("y", notesY)
      .attr("font-size", 10)
      .attr("fill", "#666")
      .text("Bars per group = models");
    ms.forEach((m, i) => {
      svg
        .append("text")
        .attr("x", pad.l + plotW + 24)
        .attr("y", notesY + 16 + i * 15)
        .attr("font-size", 10)
        .attr("fill", "#666")
        .text(`${i + 1}. ${m}`);
    });
  }
  return serialize(svg);
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
    (r) => costScore(r.total_tokens),
  ];

  const angle = d3.scaleLinear().domain([0, axes.length]).range([-Math.PI / 2, 1.5 * Math.PI]);
  const radius = d3.scaleLinear().domain([0, 1]).range([0, R]);
  const line = d3
    .lineRadial<number>()
    .angle((_d, i) => angle(i))
    .radius((d) => radius(d))
    .curve(d3.curveLinearClosed);

  const svg = createSvg(W, H, "Condition radar");
  const plot = svg.append("g").attr("transform", `translate(${cx},${cy})`);

  svg
    .append("text")
    .attr("x", cx)
    .attr("y", 26)
    .attr("font-size", 15)
    .attr("font-weight", 700)
    .attr("text-anchor", "middle")
    .text("Condition profile (5 dimensions, 0–1)");

  // Rings + axes.
  plot
    .selectAll("path.ring")
    .data([0.25, 0.5, 0.75, 1])
    .join("path")
    .attr("class", "ring")
    .attr("d", (frac) => line(axes.map(() => frac)))
    .attr("fill", "none")
    .attr("stroke", "#eee");

  const axisG = plot.selectAll("g.axis").data(axes).join("g").attr("class", "axis");
  axisG
    .append("line")
    .attr("x1", 0)
    .attr("y1", 0)
    .attr("x2", (_d, i) => radius(1) * Math.cos(angle(i)))
    .attr("y2", (_d, i) => radius(1) * Math.sin(angle(i)))
    .attr("stroke", "#ddd");
  axisG
    .append("text")
    .attr("x", (_d, i) => (radius(1) + 24) * Math.cos(angle(i)))
    .attr("y", (_d, i) => (radius(1) + 24) * Math.sin(angle(i)))
    .attr("font-size", 11)
    .attr("text-anchor", "middle")
    .attr("fill", "#444")
    .text((d) => d);

  // One polygon per condition, averaged across models.
  const conds = conditions(rows);
  plot
    .selectAll("path.condition")
    .data(conds.map((condition) => ({ condition, subset: rows.filter((r) => r.condition === condition) })).filter((d) => d.subset.length > 0))
    .join("path")
    .attr("class", "condition")
    .attr("d", (d) => line(dims.map((sel) => Math.max(0, Math.min(1, mean(d.subset.map(sel).filter(Number.isFinite)))))))
    .attr("fill", (d) => colorFor(d.condition))
    .attr("fill-opacity", 0.14)
    .attr("stroke", (d) => colorFor(d.condition))
    .attr("stroke-width", 2);

  legend(
    svg,
    24,
    H - 60,
    conds.map((c) => ({ label: c, color: colorFor(c) })),
  );
  return serialize(svg);
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
  for (const r of rows) {
    if (r.pmids_valid === 0 || !Number.isFinite(r.evidence_quality)) continue; // only rows that actually cited real evidence
    const b = bucketOf(r.evidence_quality);
    const rowCounts = counts.get(r.condition);
    if (!rowCounts) continue;
    rowCounts[b] = (rowCounts[b] ?? 0) + 1;
  }
  const maxCount = Math.max(1, ...conds.flatMap((c) => counts.get(c)!));

  const x0 = d3.scaleBand<string>().domain(buckets).range([pad.l, pad.l + plotW]).paddingInner(0.3);
  const x1 = d3.scaleBand<ConditionId>().domain(conds).range([0, x0.bandwidth()]).padding(0.1);
  const y = d3.scaleLinear().domain([0, maxCount]).range([pad.t + plotH, pad.t]);

  const svg = createSvg(W, H, "Evidence histogram");
  svg
    .append("text")
    .attr("x", pad.l)
    .attr("y", 26)
    .attr("font-size", 15)
    .attr("font-weight", 700)
    .text("Evidence-quality distribution (mean design tier of cited records)");
  yGridAxis(svg, pad, plotW, y, (v) => String(Math.round(v)));

  const group = svg
    .append("g")
    .selectAll("g")
    .data(buckets)
    .join("g")
    .attr("transform", (b) => `translate(${x0(b)},0)`);

  group.each(function (bucket, bi) {
    const g = d3.select(this);
    g.selectAll("rect")
      .data(conds)
      .join("rect")
      .attr("x", (c) => x1(c)!)
      .attr("y", (c) => y(counts.get(c)![bi]!))
      .attr("width", x1.bandwidth())
      .attr("height", (c) => pad.t + plotH - y(counts.get(c)![bi]!))
      .attr("fill", (c) => colorFor(c));
    g.append("text")
      .attr("x", x0.bandwidth() / 2)
      .attr("y", pad.t + plotH + 20)
      .attr("font-size", 11)
      .attr("text-anchor", "middle")
      .text(bucket);
  });

  svg
    .append("text")
    .attr("x", pad.l + plotW / 2)
    .attr("y", H - 14)
    .attr("font-size", 11)
    .attr("text-anchor", "middle")
    .attr("fill", "#666")
    .text("design tier bucket (0–5)");
  svg
    .append("line")
    .attr("x1", pad.l)
    .attr("y1", pad.t + plotH)
    .attr("x2", pad.l + plotW)
    .attr("y2", pad.t + plotH)
    .attr("stroke", "#333");
  legend(
    svg,
    pad.l + plotW + 24,
    pad.t + 10,
    conds.map((c) => ({ label: c, color: colorFor(c) })),
  );
  return serialize(svg);
}

// ─── Speed vs accuracy scatter ──────────────────────────────────

function scatter(rows: ScoreRow[]): string {
  const W = 640;
  const H = 460;
  const pad = { l: 56, r: 160, t: 44, b: 56 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const points = rows.filter((r) => Number.isFinite(r.speed_s) && Number.isFinite(r.accuracy));
  const maxSpeed = Math.max(1, ...points.map((r) => r.speed_s));
  const x = d3.scaleLinear().domain([0, maxSpeed]).range([pad.l, pad.l + plotW]);
  const y = d3.scaleLinear().domain([0, 10]).range([pad.t + plotH, pad.t]);
  const conds = conditions(rows);

  const svg = createSvg(W, H, "Speed vs accuracy");
  svg
    .append("text")
    .attr("x", pad.l)
    .attr("y", 26)
    .attr("font-size", 15)
    .attr("font-weight", 700)
    .text("Speed vs accuracy (each dot = one run)");
  yGridAxis(svg, pad, plotW, y, (v) => String(v));

  const xAxis = svg
    .append("g")
    .attr("transform", `translate(0,${pad.t + plotH})`)
    .call(
      d3
        .axisBottom(x)
        .ticks(4)
        .tickFormat((v) => `${Number(v).toFixed(0)}s`)
        .tickSize(0),
    ) as Sel<SVGGElement>;
  xAxis.select(".domain").remove();
  xAxis.selectAll("text").attr("font-size", 10).attr("fill", "#666").attr("dy", 18);

  svg
    .append("g")
    .selectAll("circle")
    .data(points)
    .join("circle")
    .attr("cx", (r) => x(r.speed_s))
    .attr("cy", (r) => y(r.accuracy))
    .attr("r", 4)
    .attr("fill", (r) => colorFor(r.condition))
    .attr("fill-opacity", 0.65);

  // ── Compensation curves: iso-composite contours ──
  // Bullshit queries use a different composite formula (see compositeForCategory),
  // so the contours are derived from non-bullshit rows only.
  const regular = points.filter(
    (r) => r.category !== "bullshit" && Number.isFinite(r.evidence_quality) && Number.isFinite(r.bullshit_score),
  );
  if (regular.length > 0) {
    const compLevels = [3, 5, 7, 9];
    const avgEvidence = mean(regular.map((r) => r.evidence_quality)); // 0–5
    const avgBullshit = mean(regular.map((r) => r.bullshit_score)); // 0–1
    const avgCostScore = mean(regular.map((r) => costScore(r.total_tokens)).filter(Number.isFinite));
    const N = 120;
    // Derived from composite.ts: composite = 10*(wa*(acc/10) + we*(ev/5) + wb*bs + ws*ss + wc*cs)
    // Solving for acc: acc = (10/wa) * (comp/10 - we*(ev/5) - wb*bs - ws*ss - wc*cs)
    const lineGen = d3
      .line<[number, number]>()
      .x(([s]) => x(s))
      .y(([, a]) => y(a))
      .defined(([, a]) => a >= 0 && a <= 10);

    for (const comp of compLevels) {
      const pts: [number, number][] = Array.from({ length: N + 1 }, (_, i) => {
        const speed = (maxSpeed * i) / N;
        const ss = speedScore(speed);
        const acc =
          (10 / WEIGHTS.accuracy) *
          (comp / 10 -
            WEIGHTS.evidence * (avgEvidence / 5) -
            WEIGHTS.bullshit * avgBullshit -
            WEIGHTS.speed * ss -
            WEIGHTS.cost * avgCostScore);
        return [speed, acc];
      });

      const path = lineGen(pts);
      if (!path) continue;

      svg
        .append("path")
        .attr("d", path)
        .attr("stroke", "#999")
        .attr("stroke-dasharray", "4,4")
        .attr("stroke-width", 1)
        .attr("fill", "none");

      const lastVisible = [...pts].reverse().find(([, a]) => a >= 0 && a <= 10);
      if (lastVisible) {
        svg
          .append("text")
          .attr("x", x(lastVisible[0]) + 4)
          .attr("y", y(lastVisible[1]))
          .attr("font-size", 9)
          .attr("fill", "#999")
          .attr("dominant-baseline", "middle")
          .text(`comp=${comp}`);
      }
    }
  }

  svg
    .append("text")
    .attr("x", pad.l - 40)
    .attr("y", pad.t + plotH / 2)
    .attr("font-size", 11)
    .attr("text-anchor", "middle")
    .attr("fill", "#666")
    .attr("transform", `rotate(-90,${pad.l - 40},${pad.t + plotH / 2})`)
    .text("accuracy");
  svg
    .append("text")
    .attr("x", pad.l + plotW / 2)
    .attr("y", H - 12)
    .attr("font-size", 11)
    .attr("text-anchor", "middle")
    .attr("fill", "#666")
    .text("wall-clock time");
  svg
    .append("line")
    .attr("x1", pad.l)
    .attr("y1", pad.t + plotH)
    .attr("x2", pad.l + plotW)
    .attr("y2", pad.t + plotH)
    .attr("stroke", "#333");
  svg
    .append("line")
    .attr("x1", pad.l)
    .attr("y1", pad.t)
    .attr("x2", pad.l)
    .attr("y2", pad.t + plotH)
    .attr("stroke", "#333");
  legend(
    svg,
    pad.l + plotW + 20,
    pad.t + 10,
    conds.map((c) => ({ label: c, color: colorFor(c) })),
  );
  return serialize(svg);
}

/** Render every chart. Returns filename → SVG string. */
export function renderCharts(allRows: ScoreRow[]): Record<string, string> {
  const rows = okRows(allRows);
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
    // Pooled ratio (sum fabricated ÷ sum cited per group), matching summarizeCondition
    // in report/summary.ts — see `pooledRatioBars` for why this can't be `groupedBars`.
    "fabrication-rate.svg": pooledRatioBars(rows, {
      title: "Fabrication rate (invented PMIDs ÷ cited PMIDs)",
      numerator: (r) => r.pmids_fabricated,
      denominator: (r) => r.pmids_cited,
      yMax: 1,
      format: (v) => `${Math.round(v * 100)}%`,
    }),
    "evidence-histogram.svg": evidenceHistogram(rows),
    "speed-vs-accuracy-scatter.svg": scatter(rows),
  };
}

