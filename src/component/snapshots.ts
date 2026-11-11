// Snapshots: persistent captures of a sandbox's filesystem. Snapshot ids are
// global on the server, so the component records which owner took each one
// and only lets that owner read, restore, or delete it.
import { v } from "convex/values";
import { action, query, type ActionCtx } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { checkIdentity, connection, lifecycle, requireRow, sleep } from "./access.js";
import { errorData, osError } from "./errors.js";
import { checkBounded, parseSnapshot, type RemoteSnapshot } from "./remote.js";
import { snapshotToPublic, snapshotValidator, type Snapshot } from "./store.js";
import { identity } from "./validators.js";
import { requireInt, requireText, type Connection } from "./urls.js";

export { snapshotValidator };

const SETTLED = new Set(["Ready", "Failed"]);

export const get = query({
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

export const list = query({
  args: { ownerId: v.string(), key: v.optional(v.string()), limit: v.optional(v.number()) },
  returns: v.array(snapshotValidator),
  handler: async (ctx, args) => {
    const limit = requireInt("limit", args.limit ?? 50, 1, 500);
    const rows = args.key !== undefined
      ? await ctx.db
          .query("snapshots")
          .withIndex("by_owner_key", (q) => q.eq("ownerId", args.ownerId).eq("key", args.key!))
          .order("desc")
          .take(limit)
      : await ctx.db
          .query("snapshots")
          .withIndex("by_owner", (q) => q.eq("ownerId", args.ownerId))
          .order("desc")
          .take(limit);
    return rows.map(snapshotToPublic);
  },
});

async function record(ctx: ActionCtx, ownerId: string, key: string, remote: RemoteSnapshot): Promise<Snapshot> {
  return await ctx.runMutation(internal.store.upsertSnapshot, {
    ownerId,
    key,
    snapshotId: remote.snapshotId,
    sandboxId: remote.sandboxId,
    name: remote.name,
    state: remote.state,
    reason: remote.reason,
    message: remote.message,
    remoteCreatedAt: remote.remoteCreatedAt,
  });
}

async function readSnapshot(conn: Connection, snapshotId: string): Promise<RemoteSnapshot> {
  const { body } = await lifecycle(conn, "GET", `/snapshots/${encodeURIComponent(snapshotId)}`);
  return parseSnapshot(body);
}

/** Take a snapshot of (ownerId, key) and wait up to waitSeconds for it to settle. */
export async function takeSnapshot(
  ctx: ActionCtx,
  conn: Connection,
  args: { ownerId: string; key: string; name?: string; waitSeconds: number },
): Promise<Snapshot> {
  if (args.name !== undefined) checkBounded("name", args.name, 128);
  const row = await requireRow(ctx, args.ownerId, args.key);
  const { body } = await lifecycle(conn, "POST", `/sandboxes/${encodeURIComponent(row.sandboxId)}/snapshots`, {
    json: args.name !== undefined ? { name: args.name } : {},
    timeoutMs: 120_000,
  });
  let remote = parseSnapshot(body);
  if (!remote.sandboxId) remote = { ...remote, sandboxId: row.sandboxId };
  let current = await record(ctx, args.ownerId, args.key, remote);
  const deadline = Date.now() + args.waitSeconds * 1000;
  while (!SETTLED.has(current.state) && Date.now() < deadline) {
    await sleep(Math.min(1_000, deadline - Date.now()));
    current = await record(ctx, args.ownerId, args.key, await readSnapshot(conn, remote.snapshotId));
  }
  if (current.state === "Failed") {
    throw osError("failed", current.message ?? current.reason ?? "The snapshot failed.", { state: current.state });
  }
  return current;
}

export const create = action({
  args: {
    ...identity,
    name: v.optional(v.string()),
    /** Seconds to wait for Ready, 0 to 480. Default 0: return while Creating. */
    waitSeconds: v.optional(v.number()),
  },
  returns: snapshotValidator,
  handler: async (ctx, args): Promise<Snapshot> => {
    checkIdentity(args.ownerId, args.key);
    return await takeSnapshot(ctx, connection(), {
      ownerId: args.ownerId,
      key: args.key,
      name: args.name,
      waitSeconds: requireInt("waitSeconds", args.waitSeconds ?? 0, 0, 480),
    });
  },
});

async function requireOwned(ctx: ActionCtx, ownerId: string, snapshotId: string): Promise<Snapshot> {
  requireText("ownerId", ownerId, 512);
  requireText("snapshotId", snapshotId, 256);
  const owned = await ctx.runQuery(internal.store.ownedSnapshot, { ownerId, snapshotId });
  if (!owned) throw osError("not_found", "No snapshot with that id for this owner.");
  return owned;
}

export const refresh = action({
  args: { ownerId: v.string(), snapshotId: v.string() },
  returns: snapshotValidator,
  handler: async (ctx, args): Promise<Snapshot> => {
    const owned = await requireOwned(ctx, args.ownerId, args.snapshotId);
    const conn = connection();
    try {
      return await record(ctx, owned.ownerId, owned.key, await readSnapshot(conn, owned.snapshotId));
    } catch (error) {
      if (errorData(error)?.status === 404) {
        await ctx.runMutation(internal.store.removeSnapshot, { ownerId: args.ownerId, snapshotId: args.snapshotId });
        throw osError("not_found", "The snapshot no longer exists.");
      }
      throw error;
    }
  },
});

export const remove = action({
  args: { ownerId: v.string(), snapshotId: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const owned = await requireOwned(ctx, args.ownerId, args.snapshotId);
    const conn = connection();
    try {
      await lifecycle(conn, "DELETE", `/snapshots/${encodeURIComponent(owned.snapshotId)}`, { timeoutMs: 120_000 });
    } catch (error) {
      if (errorData(error)?.status !== 404) throw error;
    }
    await ctx.runMutation(internal.store.removeSnapshot, { ownerId: args.ownerId, snapshotId: args.snapshotId });
    return null;
  },
});
