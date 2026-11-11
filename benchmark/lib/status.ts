/**
 * Run outcomes: which ones count as a result of the system under test, and
 * which are missing data.
 *
 * A model that runs out of steps or time on a hard query has failed that query.
 * Dropping such runs would make a condition look better the more often it gives
 * up, so they are scored as accuracy 0 ("intention to treat"). A provider
 * outage, an exhausted quota, a provider that truncated the conversation or a
 * scorer that could not reach PubMed say nothing about the system: those runs
 * are missing and have to be run (`--resume`) or scored (`--rescore`) again.
 */

import type { RunRecord, RunStatus } from "./types.js";

export const RUN_STATUSES: readonly RunStatus[] = ["ok", "no-answer", "timeout", "provider-error", "invalid", "scoring-error"];

const SCORED: ReadonlySet<RunStatus> = new Set<RunStatus>(["ok", "no-answer", "timeout"]);

/** Whether a run with this status enters means and tests (an answer, or a failure to answer scored as 0). */
export const isScored = (status: RunStatus): boolean => SCORED.has(status);

/** Whether the run failed to answer and is scored as accuracy 0. */
export const isFailure = (status: RunStatus): boolean => status === "no-answer" || status === "timeout";

/**
 * How a run ended, from its record alone (before any scoring); undefined when
 * it produced an answer to score. The agent loop writes "timeout after <n>s"
 * into `error` when the wall-clock budget ran out.
 */
export function runOutcome(run: Pick<RunRecord, "error" | "contextTruncated" | "text" | "finishReason">): Exclude<RunStatus, "ok" | "scoring-error"> | undefined {
  if (run.error) return /^timeout after\b/i.test(run.error) ? "timeout" : "provider-error";
  if (run.contextTruncated) return "invalid";
  if (String(run.text ?? "").trim() === "") return "no-answer";
  // The loop ended mid-work (still calling tools, or cut off by a length limit): whatever text
  // exists is a progress note ("let me search more"), not an answer.
  if (run.finishReason === "tool-calls" || run.finishReason === "length") return "no-answer";
  return undefined;
}

/**
 * A status read from stored data. Results written before scorer v8 used
 * `truncated` for both "no final answer" and a provider-truncated context; a
 * CSV row can't tell which, so it reads as `no-answer`, by far the commoner case.
 */
export function normalizeStatus(status: string | undefined): RunStatus {
  if (status === "truncated") return "no-answer";
  return (RUN_STATUSES as readonly string[]).includes(status ?? "") ? (status as RunStatus) : "ok";
}
