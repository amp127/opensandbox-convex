// Row storage for sandboxes and snapshots. Internal only: actions in
// sandboxes.ts and snapshots.ts call these after talking to OpenSandbox.
import { v, type Infer } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import type { Doc } from "./_generated/dataModel.js";
import { osError } from "./errors.js";
import { identity } from "./validators.js";
import { STALE_CREATE_MS } from "./urls.js";

export const sandboxValidator = v.object({
  ownerId: v.string(),
  key: v.string(),
  sandboxId: v.optional(v.string()),
  state: v.string(),
  image: v.optional(v.string()),
  snapshotId: v.optional(v.string()),
  templateId: v.optional(v.string()),
  entrypoint: v.optional(v.array(v.string())),
  metadata: v.optional(v.record(v.string(), v.string())),
  platform: v.optional(v.object({ os: v.string(), arch: v.string() })),
  expiresAt: v.optional(v.string()),
  remoteCreatedAt: v.optional(v.string()),
  lastTransitionAt: v.optional(v.string()),
  reason: v.optional(v.string()),
  message: v.optional(v.string()),
  lastError: v.optional(v.string()),
  syncedAt: v.optional(v.number()),
  lastActiveAt: v.optional(v.number()),
  updatedAt: v.number(),
});
export type Sandbox = Infer<typeof sandboxValidator>;

export const loadedValidator = v.object({ ...sandboxValidator.fields, token: v.string() });
export type LoadedSandbox = Infer<typeof loadedValidator>;

export const remoteValidator = v.object({
  sandboxId: v.string(),
  state: v.string(),
  image: v.optional(v.string()),
  snapshotId: v.optional(v.string()),
  entrypoint: v.optional(v.array(v.string())),
  metadata: v.optional(v.record(v.string(), v.string())),
  platform: v.optional(v.object({ os: v.string(), arch: v.string() })),
  expiresAt: v.optional(v.string()),
  remoteCreatedAt: v.optional(v.string()),
  lastTransitionAt: v.optional(v.string()),
  reason: v.optional(v.string()),
  message: v.optional(v.string()),
});
export type RemoteFields = Infer<typeof remoteValidator>;

export const snapshotValidator = v.object({
  ownerId: v.string(),
  key: v.string(),
  snapshotId: v.string(),
  sandboxId: v.string(),
  name: v.optional(v.string()),
  state: v.string(),
  reason: v.optional(v.string()),
  message: v.optional(v.string()),
  remoteCreatedAt: v.optional(v.string()),
  updatedAt: v.number(),
});
export type Snapshot = Infer<typeof snapshotValidator>;

/** States where the remote sandbox is gone and the key may be reused. */
export const REUSABLE = new Set(["Terminated", "Failed", "error"]);
/** States OpenSandbox moves out of on its own. */
export const TRANSIENT = new Set(["Pending", "creating", "Resuming", "Pausing", "Stopping"]);

function present<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

export function toPublic(row: Doc<"sandboxes">): Sandbox {
  return present({
    ownerId: row.ownerId,
    key: row.key,
    sandboxId: row.sandboxId,
    state: row.state,
    image: row.image,
    snapshotId: row.snapshotId,
    templateId: row.templateId,
    entrypoint: row.entrypoint,
    metadata: row.metadata,
    platform: row.platform,
    expiresAt: row.expiresAt,
    remoteCreatedAt: row.remoteCreatedAt,
    lastTransitionAt: row.lastTransitionAt,
    reason: row.reason,
    message: row.message,
    lastError: row.lastError,
    syncedAt: row.syncedAt,
    lastActiveAt: row.lastActiveAt,
    updatedAt: row.updatedAt,
  });
}

export function snapshotToPublic(row: Doc<"snapshots">): Snapshot {
  return present({
    ownerId: row.ownerId,
    key: row.key,
    snapshotId: row.snapshotId,
    sandboxId: row.sandboxId,
    name: row.name,
    state: row.state,
    reason: row.reason,
    message: row.message,
    remoteCreatedAt: row.remoteCreatedAt,
    updatedAt: row.updatedAt,
  });
}

export async function rowFor(ctx: QueryCtx | MutationCtx, ownerId: string, key: string) {
  return await ctx.db
    .query("sandboxes")
    .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("key", key))
    .unique();
}

export const load = internalQuery({
  args: identity,
  returns: v.union(loadedValidator, v.null()),
  handler: async (ctx, args) => {
    const row = await rowFor(ctx, args.ownerId, args.key);
    return row ? { ...toPublic(row), token: row.token } : null;
  },
});

export const reserve = internalMutation({
  args: { ...identity, source: v.object({ image: v.optional(v.string()), snapshotId: v.optional(v.string()), templateId: v.optional(v.string()) }) },
  returns: v.object({
    mode: v.union(v.literal("create"), v.literal("adopt"), v.literal("pending"), v.literal("ready")),
    token: v.string(),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await rowFor(ctx, args.ownerId, args.key);
    const fresh = {
      state: "creating",
      sandboxId: undefined,
      image: args.source.image,
      snapshotId: args.source.snapshotId,
      templateId: args.source.templateId,
      entrypoint: undefined,
      metadata: undefined,
      platform: undefined,
      expiresAt: undefined,
      remoteCreatedAt: undefined,
      lastTransitionAt: undefined,
      reason: undefined,
      message: undefined,
      lastError: undefined,
      syncedAt: undefined,
      lastActiveAt: undefined,
      updatedAt: now,
    };
    if (!existing) {
      const token = crypto.randomUUID();
      await ctx.db.insert("sandboxes", { ownerId: args.ownerId, key: args.key, token, ...fresh });
      return { mode: "create" as const, token };
    }
    if (existing.sandboxId && !REUSABLE.has(existing.state)) {
      return { mode: "ready" as const, token: existing.token };
    }
    if (!existing.sandboxId && existing.state === "creating") {
      if (now - existing.updatedAt < STALE_CREATE_MS) return { mode: "pending" as const, token: existing.token };
      // The create that owned this row died. Its sandbox may exist: look it up by token first.
      await ctx.db.patch(existing._id, { updatedAt: now });
      return { mode: "adopt" as const, token: existing.token };
    }
    if (!existing.sandboxId && existing.state === "error") {
      // The previous create failed before linking an id. If that failure was a
      // lost response, the sandbox exists under the old token: adopt it.
      await ctx.db.patch(existing._id, { ...fresh, token: existing.token });
      return { mode: "adopt" as const, token: existing.token };
    }
    const token = crypto.randomUUID();
    await ctx.db.patch(existing._id, { ...fresh, token });
    return { mode: "create" as const, token };
  },
});

function remotePatch(remote: RemoteFields, now: number) {
  return {
    sandboxId: remote.sandboxId,
    state: remote.state,
    entrypoint: remote.entrypoint,
    metadata: remote.metadata,
    platform: remote.platform,
    expiresAt: remote.expiresAt,
    remoteCreatedAt: remote.remoteCreatedAt,
    lastTransitionAt: remote.lastTransitionAt,
    reason: remote.reason,
    message: remote.message,
    lastError: undefined,
    syncedAt: now,
    updatedAt: now,
  };
}

/**
 * Record what OpenSandbox said. `token` proves the caller is the create that
 * owns the row, or `sandboxId` proves it is the linked sandbox. Anything else
 * is a stale action and is reported as `orphaned`, so a create that lost a
 * race with destroy can delete what it made.
 */
export const applyRemote = internalMutation({
  args: { ...identity, token: v.string(), remote: remoteValidator },
  returns: v.object({ sandbox: v.union(sandboxValidator, v.null()), orphaned: v.boolean() }),
  handler: async (ctx, args) => {
    const row = await rowFor(ctx, args.ownerId, args.key);
    if (!row) return { sandbox: null, orphaned: true };
    const linked = row.sandboxId !== undefined && row.sandboxId === args.remote.sandboxId;
    const claiming = row.token === args.token && (row.sandboxId === undefined || linked);
    if (!linked && !claiming) return { sandbox: toPublic(row), orphaned: true };
    // A sandbox the row already records as gone stays gone.
    if (linked && row.state === "Terminated" && args.remote.state !== "Terminated") {
      return { sandbox: toPublic(row), orphaned: false };
    }
    const now = Date.now();
    await ctx.db.patch(row._id, {
      ...remotePatch(args.remote, now),
      image: args.remote.image ?? row.image,
      snapshotId: args.remote.snapshotId ?? row.snapshotId,
    });
    const updated = await ctx.db.get(row._id);
    return { sandbox: updated ? toPublic(updated) : null, orphaned: false };
  },
});

export const failCreate = internalMutation({
  args: { ...identity, token: v.string(), message: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const row = await rowFor(ctx, args.ownerId, args.key);
    if (!row || row.token !== args.token || row.sandboxId) return null;
    await ctx.db.patch(row._id, { state: "error", lastError: args.message.slice(0, 500), updatedAt: Date.now() });
    return null;
  },
});

/**
 * Mark the row Terminated. When `sandboxId` is given, only that sandbox's row
 * is touched, so a slow action cannot terminate a newer sandbox on the key.
 * The token rotates, so an in-flight create sees its row was released.
 */
export const markTerminated = internalMutation({
  args: { ...identity, sandboxId: v.optional(v.string()), reason: v.optional(v.string()) },
  returns: v.union(sandboxValidator, v.null()),
  handler: async (ctx, args) => {
    const row = await rowFor(ctx, args.ownerId, args.key);
    if (!row) return null;
    if (args.sandboxId !== undefined && row.sandboxId !== args.sandboxId) return toPublic(row);
    const now = Date.now();
    await ctx.db.patch(row._id, {
      state: "Terminated",
      token: crypto.randomUUID(),
      reason: args.reason ?? row.reason,
      lastError: undefined,
      syncedAt: now,
      updatedAt: now,
    });
    const updated = await ctx.db.get(row._id);
    return updated ? toPublic(updated) : null;
  },
});

export const setFields = internalMutation({
  args: {
    ...identity,
    sandboxId: v.string(),
    expiresAt: v.optional(v.string()),
    metadata: v.optional(v.record(v.string(), v.string())),
  },
  returns: sandboxValidator,
  handler: async (ctx, args): Promise<Sandbox> => {
    const row = await rowFor(ctx, args.ownerId, args.key);
    if (!row || row.sandboxId !== args.sandboxId) throw osError("not_found", "No sandbox for this owner and key.");
    const patch: Partial<Doc<"sandboxes">> = { updatedAt: Date.now() };
    if (args.expiresAt !== undefined) patch.expiresAt = args.expiresAt;
    if (args.metadata !== undefined) patch.metadata = args.metadata;
    await ctx.db.patch(row._id, patch);
    const updated = await ctx.db.get(row._id);
    if (!updated) throw osError("not_found", "No sandbox for this owner and key.");
    return toPublic(updated);
  },
});

/** Rows for one owner, or for every owner when ownerId is omitted. Oldest update first. */
export const rowsForSweep = internalQuery({
  args: { ownerId: v.optional(v.string()), updatedBefore: v.number(), limit: v.number() },
  returns: v.array(loadedValidator),
  handler: async (ctx, args) => {
    const rows = args.ownerId
      ? await ctx.db
          .query("sandboxes")
          .withIndex("by_owner", (q) => q.eq("ownerId", args.ownerId!))
          .collect()
      : await ctx.db
          .query("sandboxes")
          .withIndex("by_updated", (q) => q.lt("updatedAt", args.updatedBefore))
          .take(args.limit);
    return rows
      .filter((row) => row.updatedAt < args.updatedBefore)
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, args.limit)
      .map((row) => ({ ...toPublic(row), token: row.token }));
  },
});

/** Delete Terminated and error rows, so `list` stays small. */
export const deleteRows = internalMutation({
  args: { ownerId: v.string(), keys: v.array(v.string()) },
  returns: v.number(),
  handler: async (ctx, args) => {
    let deleted = 0;
    for (const key of args.keys) {
      const row = await rowFor(ctx, args.ownerId, key);
      if (row && REUSABLE.has(row.state)) {
        await ctx.db.delete(row._id);
        deleted += 1;
      }
    }
    return deleted;
  },
});

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export const ownedSnapshot = internalQuery({
  args: { ownerId: v.string(), snapshotId: v.string() },
  returns: v.union(snapshotValidator, v.null()),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("snapshots")
      .withIndex("by_snapshot", (q) => q.eq("snapshotId", args.snapshotId))
      .take(10);
    const row = rows.find((item) => item.ownerId === args.ownerId);
    return row ? snapshotToPublic(row) : null;
  },
});

export const upsertSnapshot = internalMutation({
  args: {
    ownerId: v.string(),
    key: v.string(),
    snapshotId: v.string(),
    sandboxId: v.string(),
    name: v.optional(v.string()),
    state: v.string(),
    reason: v.optional(v.string()),
    message: v.optional(v.string()),
    remoteCreatedAt: v.optional(v.string()),
  },
  returns: snapshotValidator,
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("snapshots")
      .withIndex("by_snapshot", (q) => q.eq("snapshotId", args.snapshotId))
      .take(10);
    const existing = rows.find((item) => item.ownerId === args.ownerId);
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        state: args.state,
        reason: args.reason,
        message: args.message,
        name: args.name ?? existing.name,
        remoteCreatedAt: args.remoteCreatedAt ?? existing.remoteCreatedAt,
        updatedAt: now,
      });
      const updated = await ctx.db.get(existing._id);
      return snapshotToPublic(updated!);
    }
    if (rows.length > 0) throw osError("forbidden", "That snapshot belongs to another owner.");
    const id = await ctx.db.insert("snapshots", { ...args, updatedAt: now });
    return snapshotToPublic((await ctx.db.get(id))!);
  },
});

export const removeSnapshot = internalMutation({
  args: { ownerId: v.string(), snapshotId: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const rows = await ctx.db
      .query("snapshots")
      .withIndex("by_snapshot", (q) => q.eq("snapshotId", args.snapshotId))
      .take(10);
    for (const row of rows) if (row.ownerId === args.ownerId) await ctx.db.delete(row._id);
    return null;
  },
});

/** Note activity on a sandbox, for idle sweeps. Cheap: one indexed read and a patch. */
export const touch = internalMutation({
  args: { ...identity, sandboxId: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const row = await rowFor(ctx, args.ownerId, args.key);
    if (row && row.sandboxId === args.sandboxId) await ctx.db.patch(row._id, { lastActiveAt: Date.now() });
    return null;
  },
});
