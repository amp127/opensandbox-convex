import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server.js";
import type { Doc } from "./_generated/dataModel.js";
import { executionFields, executionKind, executionStatus } from "./schema.js";
import { identity } from "./validators.js";
import { STORED_INPUT_CHARS, STORED_OUTPUT_CHARS, requireInt } from "./urls.js";

export const executionValidator = v.object({
  executionId: v.string(),
  ownerId: v.string(),
  key: v.string(),
  sandboxId: v.string(),
  commandId: v.optional(v.string()),
  sessionId: v.optional(v.string()),
  language: v.optional(v.string()),
  kind: executionKind,
  status: executionStatus,
  exitCode: v.optional(v.number()),
  timeoutMs: v.optional(v.number()),
  input: v.optional(v.string()),
  stdout: v.optional(v.string()),
  stderr: v.optional(v.string()),
  outputTruncated: v.optional(v.boolean()),
  error: v.optional(v.string()),
  startedAt: v.number(),
  finishedAt: v.optional(v.number()),
});

function present<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function toPublic(row: Doc<"executions">) {
  return present({
    executionId: row._id as string,
    ownerId: row.ownerId,
    key: row.key,
    sandboxId: row.sandboxId,
    commandId: row.commandId,
    sessionId: row.sessionId,
    language: row.language,
    kind: row.kind,
    status: row.status,
    exitCode: row.exitCode,
    timeoutMs: row.timeoutMs,
    input: row.input,
    stdout: row.stdout,
    stderr: row.stderr,
    outputTruncated: row.outputTruncated,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  });
}

export const get = query({
  args: { executionId: v.string(), ownerId: v.string() },
  returns: v.union(executionValidator, v.null()),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("executions", args.executionId);
    if (!id) return null;
    const row = await ctx.db.get(id);
    if (!row || row.ownerId !== args.ownerId) return null;
    return toPublic(row);
  },
});

export const list = query({
  args: { ...identity, limit: v.optional(v.number()) },
  returns: v.array(executionValidator),
  handler: async (ctx, args) => {
    const limit = requireInt("limit", args.limit ?? 50, 1, 500);
    const rows = await ctx.db
      .query("executions")
      .withIndex("by_owner_key_started", (q) => q.eq("ownerId", args.ownerId).eq("key", args.key))
      .order("desc")
      .take(limit);
    return rows.map(toPublic);
  },
});

export const listPaginated = query({
  args: { ownerId: v.string(), key: v.optional(v.string()), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(executionValidator),
  handler: async (ctx, args) => {
    const page = args.key !== undefined
      ? await ctx.db
          .query("executions")
          .withIndex("by_owner_key_started", (q) => q.eq("ownerId", args.ownerId).eq("key", args.key!))
          .order("desc")
          .paginate(args.paginationOpts)
      : await ctx.db
          .query("executions")
          .withIndex("by_owner_started", (q) => q.eq("ownerId", args.ownerId))
          .order("desc")
          .paginate(args.paginationOpts);
    return { ...page, page: page.page.map(toPublic) };
  },
});

/**
 * Delete execution rows that started before `olderThanMs` ago. With no ownerId
 * it purges every owner. Deletes at most `limit` rows per call; `hasMore`
 * says whether to call again.
 */
export const purge = mutation({
  args: {
    ownerId: v.optional(v.string()),
    key: v.optional(v.string()),
    olderThanMs: v.number(),
    limit: v.optional(v.number()),
  },
  returns: v.object({ deleted: v.number(), hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    requireInt("olderThanMs", args.olderThanMs, 0, 3650 * 86_400_000);
    const limit = requireInt("limit", args.limit ?? 500, 1, 4000);
    const cutoff = Date.now() - args.olderThanMs;
    const ownerId = args.ownerId;
    const key = args.key;
    const rows =
      ownerId !== undefined && key !== undefined
        ? await ctx.db
            .query("executions")
            .withIndex("by_owner_key_started", (q) => q.eq("ownerId", ownerId).eq("key", key).lte("startedAt", cutoff))
            .take(limit + 1)
        : ownerId !== undefined
          ? await ctx.db
              .query("executions")
              .withIndex("by_owner_started", (q) => q.eq("ownerId", ownerId).lte("startedAt", cutoff))
              .take(limit + 1)
          : await ctx.db
              .query("executions")
              .withIndex("by_started", (q) => q.lte("startedAt", cutoff))
              .take(limit + 1);
    const batch = rows.slice(0, limit);
    for (const row of batch) await ctx.db.delete(row._id);
    return { deleted: batch.length, hasMore: rows.length > limit };
  },
});

export const record = internalMutation({
  args: { ...executionFields, retainOutput: v.boolean() },
  returns: v.string(),
  handler: async (ctx, args) => {
    const { retainOutput, input, stdout, stderr, ...rest } = args;
    const id = await ctx.db.insert("executions", {
      ...rest,
      input: retainOutput ? input?.slice(0, STORED_INPUT_CHARS) : undefined,
      stdout: retainOutput ? stdout?.slice(0, STORED_OUTPUT_CHARS) : undefined,
      stderr: retainOutput ? stderr?.slice(0, STORED_OUTPUT_CHARS) : undefined,
      outputTruncated:
        retainOutput &&
        (args.outputTruncated === true ||
          (stdout?.length ?? 0) > STORED_OUTPUT_CHARS ||
          (stderr?.length ?? 0) > STORED_OUTPUT_CHARS)
          ? true
          : args.outputTruncated,
    });
    const sandbox = await ctx.db
      .query("sandboxes")
      .withIndex("by_owner_key", (q) => q.eq("ownerId", args.ownerId).eq("key", args.key))
      .unique();
    if (sandbox && sandbox.sandboxId === args.sandboxId) await ctx.db.patch(sandbox._id, { lastActiveAt: Date.now() });
    return id;
  },
});

/** Update the row for a spawned command after a status poll. */
export const observe = internalMutation({
  args: {
    ownerId: v.string(),
    key: v.string(),
    sandboxId: v.string(),
    commandId: v.string(),
    status: executionStatus,
    exitCode: v.optional(v.number()),
    error: v.optional(v.string()),
    /** Output read by this poll. Appended when `append`, else replaces. */
    output: v.optional(v.string()),
    append: v.boolean(),
    outputTruncated: v.optional(v.boolean()),
    retainOutput: v.boolean(),
    finishedAt: v.optional(v.number()),
  },
  returns: v.union(executionValidator, v.null()),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("executions")
      .withIndex("by_command", (q) => q.eq("commandId", args.commandId))
      .take(10);
    const row = rows.find((item) => item.ownerId === args.ownerId && item.key === args.key && item.sandboxId === args.sandboxId);
    if (!row) return null;
    const patch: Partial<Doc<"executions">> = {
      status: args.status,
      exitCode: args.exitCode,
      error: args.error,
      finishedAt: row.finishedAt ?? args.finishedAt,
    };
    if (args.retainOutput && args.output !== undefined) {
      const combined = args.append ? (row.stdout ?? "") + args.output : args.output;
      patch.stdout = combined.slice(0, STORED_OUTPUT_CHARS);
      patch.outputTruncated = args.outputTruncated || combined.length > STORED_OUTPUT_CHARS || row.outputTruncated || undefined;
    }
    await ctx.db.patch(row._id, patch);
    const updated = await ctx.db.get(row._id);
    return updated ? toPublic(updated) : null;
  },
});
