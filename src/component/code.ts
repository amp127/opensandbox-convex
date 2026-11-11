// Code interpreter: stateful Jupyter-kernel contexts inside the sandbox.
// Needs an image with the code interpreter (for example
// opensandbox/code-interpreter). Plain images answer 404 or 500 here.
import { v } from "convex/values";
import { action } from "./_generated/server.js";
import { execdCall, openExecd } from "./access.js";
import { errorData, osError } from "./errors.js";
import { runResultValidator, streamRun, type RunResult } from "./exec.js";
import { sendJson } from "./transport.js";
import { identity } from "./validators.js";
import { MAX_EXEC_TIMEOUT_MS, MAX_COMMAND_CHARS, requireInt, requireText } from "./urls.js";

const LANGUAGE = /^[a-z][a-z0-9_+-]{0,31}$/;

const contextValidator = v.object({ contextId: v.string(), language: v.string() });

function checkLanguage(language: string): void {
  if (!LANGUAGE.test(language)) {
    throw osError("invalid_argument", "language must be a lowercase name such as python, javascript, bash, or go.");
  }
}

function parseContext(value: unknown): { contextId: string; language: string } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { id?: unknown; language?: unknown };
  if (typeof record.id !== "string" || !record.id) return null;
  return { contextId: record.id.slice(0, 256), language: typeof record.language === "string" ? record.language : "" };
}

export const createContext = action({
  args: { ...identity, language: v.optional(v.string()), useServerProxy: v.optional(v.boolean()) },
  returns: contextValidator,
  handler: async (ctx, args) => {
    const language = args.language ?? "python";
    checkLanguage(language);
    const { conn, target } = await openExecd(ctx, args.ownerId, args.key, args.useServerProxy);
    const { body } = await sendJson({
      ...execdCall(conn, target, "POST", "/code/context", { timeoutMs: 60_000 }),
      json: { language },
    });
    const context = parseContext(body);
    if (!context) throw osError("invalid_response", "execd did not return a code context.");
    return { contextId: context.contextId, language: context.language || language };
  },
});

export const listContexts = action({
  args: { ...identity, language: v.optional(v.string()), useServerProxy: v.optional(v.boolean()) },
  returns: v.array(contextValidator),
  handler: async (ctx, args) => {
    const language = args.language ?? "python";
    checkLanguage(language);
    const { conn, target } = await openExecd(ctx, args.ownerId, args.key, args.useServerProxy);
    const { body } = await sendJson(execdCall(conn, target, "GET", "/code/contexts", { query: { language } }));
    if (!Array.isArray(body)) return [];
    return body.map(parseContext).filter((item): item is { contextId: string; language: string } => item !== null);
  },
});

export const deleteContext = action({
  args: {
    ...identity,
    /** One context, or every context of `language` when omitted. */
    contextId: v.optional(v.string()),
    language: v.optional(v.string()),
    useServerProxy: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    if ((args.contextId === undefined) === (args.language === undefined)) {
      throw osError("invalid_argument", "Pass exactly one of contextId or language.");
    }
    if (args.contextId !== undefined) requireText("contextId", args.contextId, 256);
    if (args.language !== undefined) checkLanguage(args.language);
    const { conn, target } = await openExecd(ctx, args.ownerId, args.key, args.useServerProxy);
    try {
      await sendJson(
        args.contextId !== undefined
          ? execdCall(conn, target, "DELETE", `/code/contexts/${encodeURIComponent(args.contextId)}`)
          : execdCall(conn, target, "DELETE", "/code/contexts", { query: { language: args.language } }),
      );
    } catch (error) {
      if (errorData(error)?.status !== 404) throw error;
    }
    return null;
  },
});

export const codeResultValidator = v.object({
  ...runResultValidator.fields,
  /** Rich results (`text`, `image/png`, `text/html`, ...), in order. */
  results: v.array(v.record(v.string(), v.any())),
  executionCount: v.optional(v.number()),
  /** Exception details when the code raised. */
  exception: v.optional(v.object({ name: v.string(), value: v.string(), traceback: v.array(v.string()) })),
});

export type CodeResult = RunResult & {
  results: Array<Record<string, unknown>>;
  executionCount?: number;
  exception?: { name: string; value: string; traceback: string[] };
};

export const run = action({
  args: {
    ...identity,
    code: v.string(),
    /** Default python. Ignored when contextId is set. */
    language: v.optional(v.string()),
    /** Run in this context so variables persist. Omit for the language's default context. */
    contextId: v.optional(v.string()),
    /** Interrupt the run after this many ms, 1 to 540000. Default 60000. */
    timeoutMs: v.optional(v.number()),
    retainOutput: v.optional(v.boolean()),
    useServerProxy: v.optional(v.boolean()),
  },
  returns: codeResultValidator,
  handler: async (ctx, args): Promise<CodeResult> => {
    if (!args.code.trim() || args.code.length > MAX_COMMAND_CHARS || args.code.includes("\u0000")) {
      throw osError("invalid_argument", `code must be 1 to ${MAX_COMMAND_CHARS} characters, without NUL.`);
    }
    const language = args.language ?? "python";
    checkLanguage(language);
    if (args.contextId !== undefined) requireText("contextId", args.contextId, 256);
    const timeoutMs = requireInt("timeoutMs", args.timeoutMs ?? 60_000, 1, MAX_EXEC_TIMEOUT_MS);
    const { conn, sandboxId, target } = await openExecd(ctx, args.ownerId, args.key, args.useServerProxy);
    const context: Record<string, string> = { language };
    if (args.contextId !== undefined) context.id = args.contextId;
    const result = await streamRun(ctx, {
      ownerId: args.ownerId,
      key: args.key,
      retainOutput: args.retainOutput,
      conn,
      sandboxId,
      target,
      path: "/code",
      body: { code: args.code, context },
      kind: "code",
      input: args.code,
      timeoutMs,
      readTimeoutMs: timeoutMs,
      interruptPath: "/code",
      sessionId: args.contextId,
      language,
    });
    const { run: folded, ...rest } = result;
    const out: CodeResult = { ...rest, results: folded.results };
    // A raised exception is a finished run with an error, not a failed transport.
    if (folded.error && rest.status !== "timed_out" && rest.status !== "interrupted") {
      out.status = "failed";
      out.exception = folded.error;
    }
    if (folded.executionCount !== undefined) out.executionCount = folded.executionCount;
    return out;
  },
});

export const interrupt = action({
  args: { ...identity, executionId: v.string(), useServerProxy: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    requireText("executionId", args.executionId, 256);
    const { conn, target } = await openExecd(ctx, args.ownerId, args.key, args.useServerProxy);
    await sendJson(execdCall(conn, target, "DELETE", "/code", { query: { id: args.executionId }, timeoutMs: 20_000 }));
    return null;
  },
});
