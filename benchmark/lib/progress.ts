/**
 * Live progress output for `run.ts`: what is happening right now, and how far
 * along the whole run is. Plain lines only (no cursor tricks), so it reads the
 * same in a terminal and in a `tail -f` of a redirected log.
 *
 *   ▶ [5/24] edge-case-01 · mcp · deepseek-v4.1-flash · run 1
 *     │ step 1 · calling model…
 *     │   → literature_search "acupuncture insomnia" (chinaxiv)
 *     │   ← literature_search · 1.4s · 12.3k chars
 *     │ step 1 done · 1.4k in / 210 out · tool-calls
 *     │ step 2 · calling model…
 *     │ ⋯ waiting for the model · step 2 · 20s (timeout 300s)
 *     │ step 2 done · 14.2k in / 980 out · stop
 *     │ scoring · verifying citations against PubMed…
 *   ✔ [5/24] edge-case-01 · mcp · composite 5.10 (acc 4.0 · ev 2.0 · bs 1.00) · 38s · 16.8k tok · 2 steps · 1 tool call
 *     ⏱ 5/24 done · elapsed 6m02s · ETA ~23m · 312k tok used · budget 850k (538k left, ~4 runs)
 *
 * With `--concurrency > 1` the event lines of different runs interleave, so each
 * is prefixed with its job number instead of the `│` gutter.
 *
 * Colors (on by default — see `lib/color.ts`) carry meaning, the text never
 * depends on them: cyan = tool calls, green = results/success, red = errors and
 * failed runs, yellow = waiting, forced answers, skips and low budget, dim =
 * routine bookkeeping. The composite score is green ≥ 7, yellow ≥ 4, red below.
 */

import type { RunEvent } from "./agent.js";
import type { RunRecord, ScoreRow } from "./types.js";
import { palette, type Palette } from "./color.js";

export interface ProgressOptions {
  /** Total number of jobs in the plan. */
  total: number;
  /** Parallel runs; > 1 switches to job-tagged lines. */
  concurrency: number;
  /** Only the per-job result line and the overall progress line. */
  quiet?: boolean;
  tokenBudget?: number;
  /** Per-run wall-clock timeout, shown in heartbeats. */
  timeoutMs?: number;
  /** Print a heartbeat after this much silence while a run is busy (default 20 s). */
  heartbeatMs?: number;
  /** ANSI colors (the runner passes `colorEnabled()`); off when omitted so injected test sinks get plain text. */
  color?: boolean;
  /** Sinks/clocks, injectable for tests. */
  write?: (line: string) => void;
  now?: () => number;
}

export interface JobInfo {
  /** 1-based position in the plan. */
  index: number;
  queryId: string;
  condition: string;
  model: string;
  run: number;
}

/** 1234 → "1.2k", 1_234_567 → "1.23M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** 45_000 → "45s", 252_000 → "4m12s", 3_780_000 → "1h03m". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * One-line, human-readable summary of a tool call's input. Knows the MCP and
 * web tools' argument shapes; anything else falls back to clipped JSON.
 */
export function summarizeToolInput(toolName: string, input: unknown): string {
  const a = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const db = Array.isArray(a.database) ? a.database.join("+") : typeof a.database === "string" ? a.database : undefined;
  const extras: string[] = [];
  if (db) extras.push(db);
  if (typeof a.maxResults === "number") extras.push(`max ${a.maxResults}`);
  if (Array.isArray(a.studyTypes) && a.studyTypes.length > 0) extras.push(a.studyTypes.join("/"));
  if (typeof a.minEvidenceScore === "number") extras.push(`≥${a.minEvidenceScore}`);
  const tail = extras.length > 0 ? ` (${extras.join(", ")})` : "";

  if (typeof a.query === "string") return `${toolName} "${clip(a.query, 70)}"${tail}`;
  if (Array.isArray(a.ids)) {
    const ids = a.ids.map(String);
    return `${toolName} ${ids.length <= 3 ? ids.join(", ") : `${ids.length} ids`}${tail}`;
  }
  if (typeof a.id === "string") return `${toolName} ${a.id}${typeof a.doi === "string" ? ` (doi ${a.doi})` : ""}`;
  if (typeof a.url === "string") return `${toolName} ${clip(a.url.replace(/^https?:\/\//, ""), 70)}`;
  let json = "";
  try {
    json = JSON.stringify(input) ?? "";
  } catch {
    /* unserializable input — show the name only */
  }
  return json && json !== "{}" ? `${toolName} ${clip(json, 70)}` : toolName;
}

/** Overall-progress bookkeeping, shared by every job. */
export class ProgressReporter {
  private readonly write: (line: string) => void;
  private readonly now: () => number;
  private readonly startedAt: number;
  private done = 0;
  /** Wall time and tokens of runs that actually called a model (not reused/skipped), for ETA and budget forecasts. */
  private executedMs = 0;
  private executedTokens = 0;
  private executed = 0;
  private tokensUsed = 0;
  /** @internal Shared with JobProgress. */
  readonly c: Palette;

  constructor(private readonly opts: ProgressOptions) {
    this.c = palette(Boolean(opts.color));
    this.write = opts.write ?? ((line) => console.log(line));
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
  }

  /** Start reporting one job; call exactly one of its terminal methods (`finished`, `reused`, `skipped`). */
  job(info: JobInfo): JobProgress {
    return new JobProgress(this, info, this.opts, this.write, this.now);
  }

  /** @internal Called by JobProgress when a job ends. */
  record(executedMs: number | undefined, tokens: number): void {
    this.done++;
    if (executedMs !== undefined) {
      this.executed++;
      this.executedMs += executedMs;
      this.executedTokens += tokens;
      this.tokensUsed += tokens;
    }
    this.write(`  ${this.c.dim("⏱")} ${this.overallLine()}`);
  }

  /** "5/24 done · elapsed 6m02s · ETA ~23m · 312k tok used · budget 850k (538k left, ~4 runs)". */
  overallLine(): string {
    const { c } = this;
    const { total, tokenBudget, concurrency } = this.opts;
    const parts = [c.bold(`${this.done}/${total} done`), c.dim(`elapsed ${formatDuration(this.now() - this.startedAt)}`)];
    const remaining = total - this.done;
    if (remaining > 0 && this.executed > 0 && this.executedMs > 0) {
      const eta = (this.executedMs / this.executed) * remaining / Math.max(1, concurrency);
      parts.push(`ETA ~${formatDuration(eta)}`);
    }
    parts.push(c.dim(`${formatTokens(this.tokensUsed)} tok used`));
    if (tokenBudget !== undefined) {
      const left = Math.max(0, tokenBudget - this.tokensUsed);
      const perRun = this.executed > 0 ? this.executedTokens / this.executed : 0;
      const runsLeft = perRun > 0 ? `, ~${Math.floor(left / perRun)} runs` : "";
      const text = `budget ${formatTokens(tokenBudget)} (${formatTokens(left)} left${runsLeft})`;
      // Red once spent, yellow under 20% left.
      parts.push(left === 0 ? c.red(text) : left < tokenBudget * 0.2 ? c.yellow(text) : c.dim(text));
    }
    return parts.join(c.dim(" · "));
  }
}

type Phase = { kind: "model"; step: number } | { kind: "tools"; step: number; active: Map<string, number> } | { kind: "scoring" };

/** Progress for one job: event lines, heartbeats, and the final result line. */
export class JobProgress {
  private readonly t0: number;
  private lastOutput: number;
  private phase: Phase | undefined;
  private steps = 0;
  private toolCalls = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly tag: string;
  private readonly gutter: string;
  private readonly c: Palette;

  constructor(
    private readonly parent: ProgressReporter,
    private readonly info: JobInfo,
    private readonly opts: ProgressOptions,
    private readonly write: (line: string) => void,
    private readonly now: () => number,
  ) {
    this.t0 = now();
    this.lastOutput = this.t0;
    this.c = parent.c;
    this.tag = `[${info.index}/${opts.total}]`;
    this.gutter = this.c.dim(opts.concurrency > 1 ? `  ${this.tag} ` : "  │ ");
  }

  /** Condition names in the same hues as the charts (closed-book amber, web blue, mcp green). */
  private condition(name: string): string {
    return name === "mcp" ? this.c.green(name) : name === "web-search" ? this.c.blue(name) : name === "closed-book" ? this.c.yellow(name) : name;
  }

  private get label(): string {
    return `${this.c.bold(this.info.queryId)} · ${this.condition(this.info.condition)}`;
  }

  /** Print the job header and start the heartbeat. */
  start(): void {
    const { model, run } = this.info;
    this.write(`${this.c.cyan("▶")} ${this.c.dim(this.tag)} ${this.label} · ${model} · run ${run}`);
    this.lastOutput = this.now();
    if (!this.opts.quiet) {
      const every = this.opts.heartbeatMs ?? 20_000;
      this.timer = setInterval(() => this.heartbeat(every), Math.min(every, 5_000));
      this.timer.unref?.();
    }
  }

  private line(text: string): void {
    if (this.opts.quiet) return;
    this.write(`${this.gutter}${text}`);
    this.lastOutput = this.now();
  }

  /** @internal Exposed for tests; normally driven by the interval timer. */
  heartbeat(afterMs: number): void {
    if (!this.phase || this.now() - this.lastOutput < afterMs) return;
    const total = formatDuration(this.now() - this.t0);
    const timeout = this.opts.timeoutMs ? ` / ${formatDuration(this.opts.timeoutMs)} timeout` : "";
    const p = this.phase;
    const what =
      p.kind === "model"
        ? `waiting for the model · step ${p.step + 1}`
        : p.kind === "tools"
          ? `waiting for ${[...p.active.keys()].join(", ") || "tools"} · step ${p.step + 1}`
          : "scoring (PubMed)";
    const late = this.opts.timeoutMs !== undefined && p.kind !== "scoring" && this.now() - this.t0 > this.opts.timeoutMs * 0.8;
    const text = `⋯ ${what} · run time ${total}${p.kind === "scoring" ? "" : timeout}`;
    this.line(late ? this.c.red(text) : this.c.yellow(text));
  }

  /** Feed one agent-loop event. */
  event(e: RunEvent): void {
    switch (e.type) {
      case "step-start":
        this.steps = Math.max(this.steps, e.step + 1);
        this.phase = { kind: "model", step: e.step };
        this.line(
          e.forced
            ? this.c.yellow(`step ${e.step + 1} · answer only, tools removed (${e.forced}${e.tokensSoFar ? `, ${formatTokens(e.tokensSoFar)} tok so far` : ""})…`)
            : this.c.dim(`step ${e.step + 1} · calling model…`),
        );
        return;
      case "tool-start": {
        this.toolCalls++;
        const active = this.phase?.kind === "tools" ? this.phase.active : new Map<string, number>();
        active.set(e.toolName, (active.get(e.toolName) ?? 0) + 1);
        this.phase = { kind: "tools", step: e.step, active };
        const summary = summarizeToolInput(e.toolName, e.input);
        this.line(`  ${this.c.cyan("→")} ${this.c.cyan(e.toolName)}${summary.slice(e.toolName.length)}`);
        return;
      }
      case "tool-end": {
        if (this.phase?.kind === "tools") {
          const n = (this.phase.active.get(e.toolName) ?? 1) - 1;
          if (n > 0) this.phase.active.set(e.toolName, n);
          else this.phase.active.delete(e.toolName);
        }
        const secs = `${(e.durationMs / 1000).toFixed(1)}s`;
        this.line(
          e.error
            ? this.c.red(`  ✖ ${e.toolName} · ${secs} · ${clip(e.error, 100)}`)
            : `  ${this.c.green("←")} ${e.toolName} ${this.c.dim(`· ${secs} · ${formatTokens(e.outputChars)} chars`)}`,
        );
        return;
      }
      case "step-end": {
        const tok =
          e.inputTokens !== undefined || e.outputTokens !== undefined
            ? ` · ${formatTokens(e.inputTokens ?? 0)} in / ${formatTokens(e.outputTokens ?? 0)} out`
            : "";
        const what = e.toolCalls > 0 ? `${e.toolCalls} tool call${e.toolCalls === 1 ? "" : "s"}` : e.textChars > 0 ? `answer ${formatTokens(e.textChars)} chars` : "no text";
        const finish = e.finishReason
          ? ` · ${e.finishReason === "length" || e.finishReason === "error" ? this.c.yellow(e.finishReason) : e.finishReason}`
          : "";
        this.line(this.c.dim(`step ${e.step + 1} done${tok} · ${what}`) + this.c.dim(finish));
        // Between steps the SDK is about to call the model again.
        this.phase = { kind: "model", step: e.step + 1 };
        return;
      }
    }
  }

  /** The run is over; scoring (PubMed lookups) is starting. */
  scoring(): void {
    this.phase = { kind: "scoring" };
    this.line(this.c.blue("scoring · verifying citations against PubMed…"));
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.phase = undefined;
  }

  /** Terminal: a scored result (fresh or reused record). */
  finished(row: ScoreRow, record: RunRecord, detail: { reused: boolean; reason?: string }): void {
    this.stop();
    const { c } = this;
    const ok = row.status === "ok";
    const tint = row.composite >= 7 ? c.green : row.composite >= 4 ? c.yellow : c.red;
    const score = ok
      ? `composite ${c.bold(tint(row.composite.toFixed(2)))} ${c.dim(`(acc ${row.accuracy.toFixed(1)} · ev ${row.evidence_quality.toFixed(1)} · bs ${row.bullshit_score.toFixed(2)})`)}`
      : c.red(`${row.status.toUpperCase()}: ${detail.reason ?? ""}`.trim());
    const facts = detail.reused
      ? ["reused from --resume"]
      : [
          formatDuration(record.speedS * 1000),
          `${formatTokens(record.usage.totalTokens)} tok`,
          ...(record.stepCount !== undefined ? [`${record.stepCount} step${record.stepCount === 1 ? "" : "s"}`] : []),
          `${record.toolCallCount} tool call${record.toolCallCount === 1 ? "" : "s"}`,
        ];
    this.write(`${ok ? c.green("✔") : c.red("✖")} ${c.dim(this.tag)} ${this.label} · ${score} ${c.dim(`· ${facts.join(" · ")}`)}`);
    this.parent.record(detail.reused ? undefined : this.now() - this.t0, detail.reused ? 0 : record.usage.totalTokens);
  }

  /** Terminal: not run at all. */
  skipped(reason: string): void {
    this.stop();
    this.write(`${this.c.yellow("⏭")} ${this.c.dim(this.tag)} ${this.label} · ${this.info.model} · run ${this.info.run} ${this.c.yellow(`— skipped: ${reason}`)}`);
    this.parent.record(undefined, 0);
  }
}
