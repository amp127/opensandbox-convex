// execd streams command and code output as one JSON object per line, each
// followed by a blank line (`{...}\n\n`). Standard SSE framing (`data: {...}`)
// is accepted too, so a proxy that rewrites the stream still parses.

export interface StreamEvent {
  type?: string;
  text?: string;
  exit_code?: number | null;
  execution_time?: number;
  execution_count?: number;
  timestamp?: number;
  results?: Record<string, unknown>;
  error?: {
    ename?: string;
    evalue?: string;
    traceback?: string[];
    exit_code?: number | null;
  };
}

/**
 * Pull complete lines out of a buffer and parse the JSON ones. `rest` is the
 * unterminated tail. Lines that are not JSON objects (comments, `event:`,
 * keepalive noise) are skipped, like the official SDK does.
 */
export function takeEvents(buffer: string): { events: StreamEvent[]; rest: string } {
  const events: StreamEvent[] = [];
  let rest = buffer;
  while (true) {
    const index = rest.search(/[\r\n]/);
    if (index < 0) break;
    const line = rest.slice(0, index);
    rest = rest.slice(index + 1);
    const event = parseLine(line);
    if (event) events.push(event);
  }
  return { events, rest };
}

/** Parse whatever is left once the stream has ended. */
export function flushEvents(rest: string): StreamEvent[] {
  const event = parseLine(rest);
  return event ? [event] : [];
}

function parseLine(raw: string): StreamEvent | null {
  const line = raw.trim();
  if (!line || line.startsWith(":")) return null;
  if (/^(event|id|retry):/.test(line)) return null;
  const body = line.startsWith("data:") ? line.slice(5).trim() : line;
  if (!body || body === "[DONE]") return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as StreamEvent;
  } catch {
    // Not JSON. Skip it.
  }
  return null;
}

/** An event that ends a foreground run. */
export function isTerminal(event: StreamEvent): boolean {
  return event.type === "execution_complete" || event.type === "error";
}

export interface FoldedRun {
  /** The `init` event's text: the command id, or the code execution id. */
  id?: string;
  stdout: string;
  stderr: string;
  /** Code interpreter results, in order. `text` holds `text/plain`. */
  results: Array<Record<string, unknown>>;
  executionCount?: number;
  exitCode?: number;
  error?: { name: string; value: string; traceback: string[] };
  truncated: boolean;
  /** True once execd sent execution_complete or a terminal error. */
  ended: boolean;
  /** True once execd sent execution_complete. */
  complete: boolean;
  executionTimeMs?: number;
}

/**
 * Fold a run's events into output, results, and an exit code.
 *
 * Output framing differs by execd version. Current execd keeps each line's
 * ending in the event text. execd 1.1.x and older send one event per line with
 * the ending stripped. When no event in the run carries a line ending, the run
 * is treated as line-framed and each event gets a "\n" back. (A single
 * unterminated fragment from a current execd then gains a trailing newline;
 * that is the only ambiguous case.)
 */
export function foldEvents(events: StreamEvent[], maxChars: number): FoldedRun {
  const run: FoldedRun = { stdout: "", stderr: "", results: [], truncated: false, ended: false, complete: false };
  const parts: { stdout: string[]; stderr: string[] } = { stdout: [], stderr: [] };
  const budget = { stdout: 0, stderr: 0 };
  let completeExit: number | undefined;
  let sawLineEnding = false;
  for (const event of events) {
    switch (event.type) {
      case "init":
        if (typeof event.text === "string" && event.text && run.id === undefined) run.id = event.text.slice(0, 256);
        break;
      case "stdout":
      case "stderr": {
        const text = typeof event.text === "string" ? event.text : "";
        if (/[\r\n]/.test(text)) sawLineEnding = true;
        const stream = event.type;
        // Keep one extra character per part for a newline that may be restored.
        if (budget[stream] <= maxChars) {
          parts[stream].push(text);
          budget[stream] += text.length + 1;
        } else {
          run.truncated = true;
        }
        break;
      }
      case "result":
        if (event.results && typeof event.results === "object" && run.results.length < 100) {
          run.results.push(capResult(event.results, maxChars));
        }
        break;
      case "execution_count":
        if (typeof event.execution_count === "number") run.executionCount = event.execution_count;
        break;
      case "execution_complete":
        run.complete = true;
        run.ended = true;
        if (typeof event.exit_code === "number") completeExit = event.exit_code;
        if (typeof event.execution_time === "number") run.executionTimeMs = event.execution_time;
        break;
      case "error": {
        run.ended = true;
        const error = event.error ?? {};
        run.error = {
          name: String(error.ename ?? "Error").slice(0, 200),
          value: String(error.evalue ?? "").slice(0, 2_000),
          traceback: Array.isArray(error.traceback)
            ? error.traceback.slice(0, 50).map((line) => String(line).slice(0, 2_000))
            : [],
        };
        if (typeof error.exit_code === "number") run.exitCode = error.exit_code;
        else if (/^-?\d+$/.test(run.error.value.trim())) run.exitCode = Number(run.error.value.trim());
        break;
      }
      default:
        break;
    }
  }
  const lineFramed = !sawLineEnding;
  for (const stream of ["stdout", "stderr"] as const) {
    const joined = lineFramed ? parts[stream].map((part) => `${part}\n`).join("") : parts[stream].join("");
    if (joined.length > maxChars) {
      run[stream] = joined.slice(0, maxChars);
      run.truncated = true;
    } else {
      run[stream] = joined;
    }
  }
  // Same inference as the official SDK: an error decides the exit code,
  // otherwise a completed run exited 0 unless execd said otherwise.
  if (!run.error && run.complete) run.exitCode = completeExit ?? 0;
  return run;
}

function capResult(result: Record<string, unknown>, maxChars: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result).slice(0, 20)) {
    if (!/^[A-Za-z0-9_./+-]{1,100}$/.test(key) || key.startsWith("$")) continue;
    out[key] = typeof value === "string" ? value.slice(0, maxChars) : JSON.parse(JSON.stringify(value ?? null));
  }
  return out;
}

export type RunStatus = "running" | "succeeded" | "failed" | "timed_out" | "interrupted" | "error" | "unknown";

/**
 * Decide a foreground run's status. execd does not mark a timeout; it kills the
 * process group, so a signal exit at or past the deadline counts as timed out.
 */
export function runStatus(run: FoldedRun, elapsedMs: number, timeoutMs: number | undefined): RunStatus {
  if (run.exitCode === 0 && !run.error) return "succeeded";
  const pastDeadline = timeoutMs !== undefined && elapsedMs >= timeoutMs - 250;
  if (run.error) {
    if (run.error.name === "ContextCancelled" || /interrupt/i.test(run.error.value)) return "interrupted";
    if (pastDeadline && (run.exitCode === undefined || run.exitCode < 0 || run.exitCode >= 128)) return "timed_out";
    if (/timeout|deadline exceeded/i.test(`${run.error.name} ${run.error.value}`)) return "timed_out";
    return typeof run.exitCode === "number" && run.error.name === "CommandExecError" ? "failed" : "error";
  }
  if (typeof run.exitCode === "number") return "failed";
  return "unknown";
}
