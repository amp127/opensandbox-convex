// Commands: foreground runs, background runs, status and logs, interrupt,
// and persistent bash sessions. All go through execd inside the sandbox.
import { v } from "convex/values";
import { action, type ActionCtx } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { execdCall, openExecd, type Target } from "./access.js";
import { errorData, osError, outcomeUnknown } from "./errors.js";
import { checkArgv, checkRecord } from "./remote.js";
import { executionStatus } from "./schema.js";
import { foldEvents, runStatus, type FoldedRun, type RunStatus } from "./sse.js";
import { sendBytes, sendEventStream, sendJson, type StreamResult } from "./transport.js";
import { identity } from "./validators.js";
import {
  DEFAULT_EXEC_TIMEOUT_MS,
  MAX_COMMAND_CHARS,
  MAX_EXEC_TIMEOUT_MS,
  MAX_OUTPUT_CHARS,
  requireInt,
  requireText,
  type Connection,
} from "./urls.js";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const commandValidator = v.union(v.string(), v.array(v.string()));

const runArgs = {
  ...identity,
  /** Shell text (run with bash -c) or an argv array (run directly, no shell). */
  command: commandValidator,
  cwd: v.optional(v.string()),
  env: v.optional(v.record(v.string(), v.string())),
  /** Kill the process after this many ms. exec: 1 to 540000, default 60000. spawn: optional, no default. */
  timeoutMs: v.optional(v.number()),
  /** Run as this Linux user id. */
  uid: v.optional(v.number()),
  /** Run as this group id. Requires uid. */
  gid: v.optional(v.number()),
  retainOutput: v.optional(v.boolean()),
  useServerProxy: v.optional(v.boolean()),
};

export const runResultValidator = v.object({
  executionId: v.string(),
  commandId: v.optional(v.string()),
  status: executionStatus,
  exitCode: v.optional(v.number()),
  stdout: v.string(),
  stderr: v.string(),
  outputTruncated: v.boolean(),
  error: v.optional(v.string()),
  durationMs: v.number(),
});

export type RunResult = {
  executionId: string;
  commandId?: string;
  status: RunStatus;
  exitCode?: number;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  error?: string;
  durationMs: number;
};

type RunArgs = {
  ownerId: string;
  key: string;
  command: string | string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  uid?: number;
  gid?: number;
  retainOutput?: boolean;
  useServerProxy?: boolean;
};

export function checkCommand(command: string | string[]): string {
  if (typeof command === "string") {
    if (!command.trim() || command.length > MAX_COMMAND_CHARS || command.includes("\u0000")) {
      throw osError("invalid_argument", `command must be 1 to ${MAX_COMMAND_CHARS} characters, without NUL.`);
    }
    return command;
  }
  checkArgv("command", command);
  if (command.reduce((total, part) => total + part.length + 1, 0) > MAX_COMMAND_CHARS) {
    throw osError("invalid_argument", `command must be at most ${MAX_COMMAND_CHARS} characters in total.`);
  }
  return command.map((part) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`)).join(" ");
}

export function checkCwd(cwd: string | undefined): void {
  if (cwd !== undefined && (cwd.length === 0 || cwd.length > 4096 || cwd.includes("\u0000"))) {
    throw osError("invalid_argument", "cwd must be 1 to 4096 characters, without NUL.");
  }
}

function buildRunBody(args: RunArgs, background: boolean, timeoutMs: number | undefined): Record<string, unknown> {
  checkCommand(args.command);
  checkCwd(args.cwd);
  if (args.env) checkRecord("env", args.env, 256, ENV_NAME, 32_768);
  if (args.uid !== undefined) requireInt("uid", args.uid, 0, 4_294_967_294);
  if (args.gid !== undefined) {
    if (args.uid === undefined) throw osError("invalid_argument", "gid requires uid.");
    requireInt("gid", args.gid, 0, 4_294_967_294);
  }
  const body: Record<string, unknown> = typeof args.command === "string" ? { command: args.command } : { argv: args.command };
  if (args.cwd !== undefined) body.cwd = args.cwd;
  if (args.env && Object.keys(args.env).length > 0) body.envs = args.env;
  if (timeoutMs !== undefined) body.timeout = timeoutMs;
  if (args.uid !== undefined) body.uid = args.uid;
  if (args.gid !== undefined) body.gid = args.gid;
  if (background) body.background = true;
  return body;
}

function describeError(run: FoldedRun): string | undefined {
  if (!run.error) return undefined;
  if (run.error.name === "CommandExecError" && /^-?\d+$/.test(run.error.value.trim())) return undefined;
  return `${run.error.name}: ${run.error.value}`.slice(0, 2_000);
}

/** Send a run request, fold the stream, and record an execution row. */
export async function streamRun(
  ctx: ActionCtx,
  args: {
    ownerId: string;
    key: string;
    retainOutput?: boolean;
    conn: Connection;
    sandboxId: string;
    target: Target;
    path: string;
    body: Record<string, unknown>;
    kind: "exec" | "spawn" | "session" | "code";
    input: string;
    timeoutMs?: number;
    sessionId?: string;
    language?: string;
    /** Where to send DELETE ?id= when the deadline passes. Only for runs execd will not time out. */
    interruptPath?: string;
    /** Override how long to read the stream. */
    readTimeoutMs?: number;
  },
): Promise<RunResult & { run: FoldedRun }> {
  const startedAt = Date.now();
  const background = args.kind === "spawn";
  const readTimeout =
    args.readTimeoutMs ?? (background ? 30_000 : (args.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS) + 15_000);
  const base = {
    ownerId: args.ownerId,
    key: args.key,
    sandboxId: args.sandboxId,
    kind: args.kind,
    timeoutMs: args.timeoutMs,
    input: args.input,
    sessionId: args.sessionId,
    language: args.language,
    startedAt,
    retainOutput: args.retainOutput === true,
  };
  let streamed: StreamResult;
  const send = async (json: Record<string, unknown>) =>
    await sendEventStream({
      ...execdCall(args.conn, args.target, "POST", args.path, { timeoutMs: Math.min(readTimeout, 570_000) }),
      json,
      // Commands and sessions: execd drains the output pipes before the
      // terminal event, so stop there (execd can hold the connection ~1 s
      // after it). Code: the Jupyter path can send a cell's output after
      // execution_complete, so read until the stream closes.
      stopAfter: args.kind === "code" ? "end" : "terminal",
    });
  try {
    try {
      streamed = await send(args.body);
    } catch (error) {
      // execd before argv support (1.1.x) rejects it as a missing `command`.
      // execd validated the request before starting anything, so a retry
      // with the argv shell-quoted cannot run the command twice.
      const data = errorData(error);
      const argv = args.body.argv;
      if (!Array.isArray(argv) || data?.code !== "invalid_argument" || !/command/i.test(data.message)) throw error;
      const { argv: _argv, ...rest } = args.body;
      streamed = await send({ ...rest, command: checkCommand(argv as string[]) });
    }
  } catch (error) {
    // The run may still be going. Record what is known, then report.
    await ctx.runMutation(internal.executions.record, {
      ...base,
      status: outcomeUnknown(error) ? "unknown" : "error",
      error: errorData(error)?.message ?? "The run failed.",
      finishedAt: Date.now(),
    });
    throw error;
  }
  const run = foldEvents(streamed.events, MAX_OUTPUT_CHARS);
  if (streamed.timedOut && !run.ended && run.id !== undefined && args.interruptPath) {
    // execd has no deadline for this kind of run. Stop it rather than leave it going.
    await sendJson(
      execdCall(args.conn, args.target, "DELETE", args.interruptPath, { query: { id: run.id }, timeoutMs: 10_000 }),
    ).catch(() => undefined);
  }
  const durationMs = Date.now() - startedAt;
  let status: RunStatus;
  let error = describeError(run);
  if (background) {
    status = run.error ? "error" : run.id ? "running" : "unknown";
  } else if (!run.ended && streamed.timedOut) {
    status = "timed_out";
    error = args.interruptPath
      ? "The run passed its timeout and was interrupted."
      : "No exit status arrived before the deadline. The run may still be going.";
  } else if (!run.ended) {
    status = "unknown";
    error = streamed.overflowed
      ? "Output passed the stream cap; the component stopped reading. The run may still be going."
      : "The stream ended without an exit status. The run may still be going.";
  } else {
    status = runStatus(run, durationMs, args.timeoutMs);
  }
  const truncated = run.truncated || streamed.overflowed;
  const executionId = await ctx.runMutation(internal.executions.record, {
    ...base,
    commandId: run.id,
    status,
    exitCode: run.exitCode,
    stdout: run.stdout,
    stderr: run.stderr,
    outputTruncated: truncated || undefined,
    error,
    finishedAt: status === "running" ? undefined : Date.now(),
  });
  const result: RunResult & { run: FoldedRun } = {
    executionId,
    status,
    stdout: run.stdout,
    stderr: run.stderr,
    outputTruncated: truncated,
    durationMs,
    run,
  };
  if (run.id !== undefined) result.commandId = run.id;
  if (run.exitCode !== undefined) result.exitCode = run.exitCode;
  if (error !== undefined) result.error = error;
  return result;
}

function publicResult(result: RunResult & { run?: FoldedRun }): RunResult {
  const { run: _run, ...rest } = result;
  return rest;
}

export const run = action({
  args: runArgs,
  returns: runResultValidator,
  handler: async (ctx, args): Promise<RunResult> => {
    const timeoutMs = requireInt("timeoutMs", args.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS, 1, MAX_EXEC_TIMEOUT_MS);
    const body = buildRunBody(args, false, timeoutMs);
    const { conn, sandboxId, target } = await openExecd(ctx, args.ownerId, args.key, args.useServerProxy);
    return publicResult(
      await streamRun(ctx, {
        ...args,
        conn,
        sandboxId,
        target,
        path: "/command",
        body,
        kind: "exec",
        input: checkCommand(args.command),
        timeoutMs,
      }),
    );
  },
});

export const spawn = action({
  args: runArgs,
  returns: runResultValidator,
  handler: async (ctx, args): Promise<RunResult> => {
    const timeoutMs =
      args.timeoutMs === undefined ? undefined : requireInt("timeoutMs", args.timeoutMs, 1, 365 * 86_400_000);
    const body = buildRunBody(args, true, timeoutMs);
    const { conn, sandboxId, target } = await openExecd(ctx, args.ownerId, args.key, args.useServerProxy);
    const result = await streamRun(ctx, {
      ...args,
      conn,
      sandboxId,
      target,
      path: "/command",
      body,
      kind: "spawn",
      input: checkCommand(args.command),
      timeoutMs,
    });
    if (result.status !== "running") {
      throw osError("failed", result.error ?? "execd did not start the command.", { state: result.status });
    }
    return publicResult(result);
  },
});

export const commandStateValidator = v.object({
  commandId: v.string(),
  running: v.boolean(),
  status: executionStatus,
  exitCode: v.optional(v.number()),
  error: v.optional(v.string()),
  startedAt: v.optional(v.string()),
  finishedAt: v.optional(v.string()),
  /** stdout and stderr, interleaved as execd recorded them. */
  output: v.string(),
  outputTruncated: v.boolean(),
  /** Pass back as `cursor` to read only newer output. */
  cursor: v.optional(v.number()),
});

export const status = action({
  args: {
    ...identity,
    commandId: v.string(),
    /** Line cursor from a previous call. Omit to read all output. */
    cursor: v.optional(v.number()),
    /** Skip the log read and return status only. */
    statusOnly: v.optional(v.boolean()),
    retainOutput: v.optional(v.boolean()),
    useServerProxy: v.optional(v.boolean()),
  },
  returns: commandStateValidator,
  handler: async (ctx, args) => {
    requireText("commandId", args.commandId, 256);
    if (args.cursor !== undefined) requireInt("cursor", args.cursor, 0, Number.MAX_SAFE_INTEGER);
    const { conn, sandboxId, target } = await openExecd(ctx, args.ownerId, args.key, args.useServerProxy);
    const { body } = await sendJson(
      execdCall(conn, target, "GET", `/command/status/${encodeURIComponent(args.commandId)}`, { timeoutMs: 20_000 }),
    );
    if (!body || typeof body !== "object") {
      throw osError("invalid_response", "OpenSandbox returned a command status that is not an object.");
    }
    const remote = body as {
      running?: unknown;
      exit_code?: unknown;
      error?: unknown;
      started_at?: unknown;
      finished_at?: unknown;
    };
    const running = remote.running === true;
    const exitCode = typeof remote.exit_code === "number" ? remote.exit_code : undefined;
    const error = typeof remote.error === "string" && remote.error ? remote.error.slice(0, 2_000) : undefined;
    const statusName: RunStatus = running
      ? "running"
      : exitCode === 0
        ? "succeeded"
        : error && /signal: (killed|terminated|interrupt)/i.test(error)
          ? "interrupted"
          : error && /timeout|deadline/i.test(error)
            ? "timed_out"
            : exitCode !== undefined
              ? "failed"
              : error
                ? "error"
                : "unknown";
    let output = "";
    let outputTruncated = false;
    let cursor: number | undefined;
    if (args.statusOnly !== true) {
      const logs = await sendBytes(
        execdCall(conn, target, "GET", `/command/${encodeURIComponent(args.commandId)}/logs`, {
          query: { cursor: args.cursor },
          accept: "text/plain",
          timeoutMs: 30_000,
          maxBytes: MAX_OUTPUT_CHARS,
          onOverflow: "truncate",
        }),
      );
      output = new TextDecoder().decode(logs.bytes);
      outputTruncated = logs.truncated;
      const header = logs.headers.get("EXECD-COMMANDS-TAIL-CURSOR");
      if (header && /^\d+$/.test(header) && !logs.truncated) cursor = Number(header);
    }
    await ctx.runMutation(internal.executions.observe, {
      ownerId: args.ownerId,
      key: args.key,
      sandboxId,
      commandId: args.commandId,
      status: statusName,
      exitCode,
      error,
      output: args.statusOnly ? undefined : output,
      append: args.cursor !== undefined,
      outputTruncated: outputTruncated || undefined,
      retainOutput: args.retainOutput === true,
      finishedAt: running ? undefined : Date.now(),
    });
    const result: {
      commandId: string;
      running: boolean;
      status: RunStatus;
      output: string;
      outputTruncated: boolean;
      exitCode?: number;
      error?: string;
      startedAt?: string;
      finishedAt?: string;
      cursor?: number;
    } = { commandId: args.commandId, running, status: statusName, output, outputTruncated };
    if (exitCode !== undefined) result.exitCode = exitCode;
    if (error !== undefined) result.error = error;
    if (typeof remote.started_at === "string") result.startedAt = remote.started_at;
    if (typeof remote.finished_at === "string") result.finishedAt = remote.finished_at;
    if (cursor !== undefined) result.cursor = cursor;
    return result;
  },
});

/** Signal a running command (foreground or background) to stop. */
export const interrupt = action({
  args: { ...identity, commandId: v.string(), useServerProxy: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    requireText("commandId", args.commandId, 256);
    const { conn, target } = await openExecd(ctx, args.ownerId, args.key, args.useServerProxy);
    await sendJson(execdCall(conn, target, "DELETE", "/command", { query: { id: args.commandId }, timeoutMs: 20_000 }));
    return null;
  },
});

// ---------------------------------------------------------------------------
// Bash sessions: a shell whose cwd and environment persist across runs.
// ---------------------------------------------------------------------------

export const createSession = action({
  args: { ...identity, cwd: v.optional(v.string()), useServerProxy: v.optional(v.boolean()) },
  returns: v.object({ sessionId: v.string() }),
  handler: async (ctx, args) => {
    checkCwd(args.cwd);
    const { conn, target } = await openExecd(ctx, args.ownerId, args.key, args.useServerProxy);
    const { body } = await sendJson({
      ...execdCall(conn, target, "POST", "/session", { timeoutMs: 30_000 }),
      json: args.cwd !== undefined ? { cwd: args.cwd } : {},
    });
    const sessionId = (body as { session_id?: unknown } | null)?.session_id;
    if (typeof sessionId !== "string" || !sessionId) {
      throw osError("invalid_response", "execd did not return a session id.");
    }
    return { sessionId: sessionId.slice(0, 256) };
  },
});

export const runInSession = action({
  args: {
    ...identity,
    sessionId: v.string(),
    command: v.string(),
    cwd: v.optional(v.string()),
    timeoutMs: v.optional(v.number()),
    retainOutput: v.optional(v.boolean()),
    useServerProxy: v.optional(v.boolean()),
  },
  returns: runResultValidator,
  handler: async (ctx, args): Promise<RunResult> => {
    requireText("sessionId", args.sessionId, 256);
    checkCommand(args.command);
    checkCwd(args.cwd);
    const timeoutMs = requireInt("timeoutMs", args.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS, 1, MAX_EXEC_TIMEOUT_MS);
    const { conn, sandboxId, target } = await openExecd(ctx, args.ownerId, args.key, args.useServerProxy);
    const body: Record<string, unknown> = { command: args.command, timeout: timeoutMs };
    if (args.cwd !== undefined) body.cwd = args.cwd;
    return publicResult(
      await streamRun(ctx, {
        ...args,
        conn,
        sandboxId,
        target,
        path: `/session/${encodeURIComponent(args.sessionId)}/run`,
        body,
        kind: "session",
        input: args.command,
        timeoutMs,
      }),
    );
  },
});

export const deleteSession = action({
  args: { ...identity, sessionId: v.string(), useServerProxy: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    requireText("sessionId", args.sessionId, 256);
    const { conn, target } = await openExecd(ctx, args.ownerId, args.key, args.useServerProxy);
    try {
      await sendJson(execdCall(conn, target, "DELETE", `/session/${encodeURIComponent(args.sessionId)}`));
    } catch (error) {
      if (errorData(error)?.status !== 404) throw error;
    }
    return null;
  },
});
