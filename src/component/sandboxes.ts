// Sandbox lifecycle. Queries read the last observation. Actions call the
// OpenSandbox lifecycle API and write that observation back. Every call is
// scoped by (ownerId, key); derive ownerId from the signed-in user.
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { action, query, type ActionCtx } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { errorData, osError, outcomeUnknown } from "./errors.js";
import {
  checkIdentity,
  connection,
  execdTarget,
  lifecycle,
  loadRow,
  remoteFields,
  requireRow,
  sleep,
  sync,
} from "./access.js";
import {
  buildCreateBody,
  checkMetadataKey,
  checkMetadataValue,
  labelDigest,
  parseSandbox,
  tokenOf,
  userMetadata,
  validateCreate,
  type RemoteSandbox,
} from "./remote.js";
import { REUSABLE, TRANSIENT, sandboxValidator, toPublic, type LoadedSandbox, type Sandbox } from "./store.js";
import { takeSnapshot } from "./snapshots.js";
import { foldEvents } from "./sse.js";
import { sendEventStream, sendJson } from "./transport.js";
import { createOptionFields, identity, type CreateOptions } from "./validators.js";
import {
  DEFAULT_CREATE_REQUEST_TIMEOUT_SECONDS,
  DEFAULT_READY_TIMEOUT_SECONDS,
  MAX_CREATE_REQUEST_TIMEOUT_SECONDS,
  MAX_READY_TIMEOUT_SECONDS,
  META_MANAGED,
  META_OWNER,
  META_TOKEN,
  joinUrl,
  requireInt,
  requireText,
  type Connection,
} from "./urls.js";

export { sandboxValidator };
export type { Sandbox };

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const get = query({
  args: identity,
  returns: v.union(sandboxValidator, v.null()),
  handler: async (ctx, args): Promise<Sandbox | null> => {
    const row = await ctx.db
      .query("sandboxes")
      .withIndex("by_owner_key", (q) => q.eq("ownerId", args.ownerId).eq("key", args.key))
      .unique();
    return row ? toPublic(row) : null;
  },
});

export const list = query({
  args: { ownerId: v.string(), limit: v.optional(v.number()), includeTerminated: v.optional(v.boolean()) },
  returns: v.array(sandboxValidator),
  handler: async (ctx, args): Promise<Sandbox[]> => {
    const limit = requireInt("limit", args.limit ?? 50, 1, 500);
    const rows = [];
    for await (const row of ctx.db
      .query("sandboxes")
      .withIndex("by_owner", (q) => q.eq("ownerId", args.ownerId))
      .order("desc")) {
      if (args.includeTerminated === false && REUSABLE.has(row.state)) continue;
      rows.push(toPublic(row));
      if (rows.length >= limit) break;
    }
    return rows;
  },
});

export const listPaginated = query({
  args: { ownerId: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(sandboxValidator),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("sandboxes")
      .withIndex("by_owner", (q) => q.eq("ownerId", args.ownerId))
      .order("desc")
      .paginate(args.paginationOpts);
    return { ...page, page: page.page.map(toPublic) };
  },
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

const createArgs = {
  ...identity,
  ...createOptionFields,
  /** How long to wait for Running and a healthy execd, 1 to 300 seconds. Default 60. */
  readyTimeoutSeconds: v.optional(v.number()),
  /** Timeout for POST /sandboxes itself. Docker pulls the image inside it. Default 300. */
  createRequestTimeoutSeconds: v.optional(v.number()),
  /** Skip the execd health check (for images without execd, or pool sandboxes). */
  skipHealthCheck: v.optional(v.boolean()),
  /**
   * The image runs the code interpreter: keep its entrypoint
   * (/opt/code-interpreter/code-interpreter.sh) and wait for Jupyter as well as
   * execd. Defaults to true for images named `*code-interpreter*`.
   */
  codeInterpreter: v.optional(v.boolean()),
  /** When the existing sandbox for this key is Paused, resume it. Default true. */
  resumeIfPaused: v.optional(v.boolean()),
  useServerProxy: v.optional(v.boolean()),
};

type CreateArgs = CreateOptions & {
  ownerId: string;
  key: string;
  readyTimeoutSeconds?: number;
  createRequestTimeoutSeconds?: number;
  skipHealthCheck?: boolean;
  codeInterpreter?: boolean;
  resumeIfPaused?: boolean;
  useServerProxy?: boolean;
};

export const create = action({
  args: createArgs,
  returns: sandboxValidator,
  handler: async (ctx, args): Promise<Sandbox> => await createSandbox(ctx, args),
});

async function createSandbox(ctx: ActionCtx, input: CreateArgs): Promise<Sandbox> {
  const codeInterpreter =
    input.codeInterpreter ?? (input.image !== undefined && CODE_INTERPRETER_IMAGE.test(input.image));
  const args: CreateArgs =
    codeInterpreter && input.image !== undefined && input.entrypoint === undefined
      ? { ...input, entrypoint: CODE_INTERPRETER_ENTRYPOINT }
      : input;
  checkIdentity(args.ownerId, args.key);
  validateCreate(args);
  const budget = requireInt("readyTimeoutSeconds", args.readyTimeoutSeconds ?? DEFAULT_READY_TIMEOUT_SECONDS, 1, MAX_READY_TIMEOUT_SECONDS) * 1000;
  const requestTimeout =
    requireInt(
      "createRequestTimeoutSeconds",
      args.createRequestTimeoutSeconds ?? DEFAULT_CREATE_REQUEST_TIMEOUT_SECONDS,
      10,
      MAX_CREATE_REQUEST_TIMEOUT_SECONDS,
    ) * 1000;
  const conn = connection();
  if (args.snapshotId !== undefined && args.allowUntrackedSnapshot !== true) {
    // Snapshot ids are global on the server. Restoring one is reading its
    // owner's files, so only this owner's snapshots are allowed by default.
    const owned = await ctx.runQuery(internal.store.ownedSnapshot, { ownerId: args.ownerId, snapshotId: args.snapshotId });
    if (!owned) throw osError("not_found", "No snapshot with that id for this owner.");
    if (owned.state !== "Ready") {
      throw osError("not_ready", `The snapshot is ${owned.state}, not Ready.`, { state: owned.state });
    }
  }
  const reserved = await ctx.runMutation(internal.store.reserve, {
    ownerId: args.ownerId,
    key: args.key,
    source: { image: args.image, snapshotId: args.snapshotId, templateId: args.templateId },
  });
  const settleOptions = {
    ping: args.skipHealthCheck !== true,
    jupyter: codeInterpreter && args.skipHealthCheck !== true,
    useServerProxy: args.useServerProxy,
    budget,
  };

  if (reserved.mode === "pending") return await waitForPeer(ctx, conn, args, settleOptions);
  if (reserved.mode === "ready") {
    const row = await requireRow(ctx, args.ownerId, args.key);
    let current = await sync(ctx, conn, row);
    if (current.state === "Paused" || current.state === "Pausing") {
      if (args.resumeIfPaused === false) return current;
      current = await transition(ctx, conn, row, "resume", Math.ceil(budget / 1000));
    }
    if (REUSABLE.has(current.state)) {
      // It ended since the last observation. A Failed sandbox still holds
      // resources on the server, so delete it before making a new one.
      if (current.state === "Failed") await deleteRemote(conn, row.sandboxId).catch(() => undefined);
      return await createSandbox(ctx, args);
    }
    return await settle(ctx, conn, row, { ...settleOptions, ping: false, jupyter: false });
  }

  const ownership = {
    token: reserved.token,
    ownerDigest: await labelDigest(args.ownerId),
    keyDigest: await labelDigest(`${args.ownerId}\u0000${args.key}`),
  };
  try {
    let remote: RemoteSandbox | null = null;
    if (reserved.mode === "adopt") remote = await findByToken(conn, reserved.token);
    if (!remote) {
      const { body } = await sendJson({
        url: joinUrl(conn.origin, "/v1/sandboxes"),
        method: "POST",
        apiKey: conn.apiKey,
        json: buildCreateBody(args, ownership),
        timeoutMs: requestTimeout,
      });
      remote = parseSandbox(body);
    }
    return await link(ctx, conn, args, reserved.token, remote, settleOptions);
  } catch (error) {
    if (outcomeUnknown(error)) {
      // The request may have created a sandbox. Look for it before giving up.
      const found = await findByToken(conn, reserved.token).catch(() => null);
      if (found) return await link(ctx, conn, args, reserved.token, found, settleOptions);
    }
    await ctx.runMutation(internal.store.failCreate, {
      ownerId: args.ownerId,
      key: args.key,
      token: reserved.token,
      message: errorData(error)?.message ?? "Sandbox creation failed.",
    });
    throw error;
  }
}

/** Store a freshly created sandbox, then wait until it is usable. */
async function link(
  ctx: ActionCtx,
  conn: Connection,
  args: { ownerId: string; key: string },
  token: string,
  remote: RemoteSandbox,
  options: { ping: boolean; jupyter?: boolean; useServerProxy?: boolean; budget: number },
): Promise<Sandbox> {
  const { orphaned } = await ctx.runMutation(internal.store.applyRemote, {
    ownerId: args.ownerId,
    key: args.key,
    token,
    remote: remoteFields(remote),
  });
  if (orphaned) {
    // destroy ran while this create was in flight. Do not leave the sandbox behind.
    await deleteRemote(conn, remote.sandboxId).catch(() => undefined);
    throw osError("conflict", "The sandbox was destroyed while it was being created.");
  }
  return await settle(ctx, conn, { ...args, token, sandboxId: remote.sandboxId }, options);
}

async function findByToken(conn: Connection, token: string): Promise<RemoteSandbox | null> {
  const { body } = await lifecycle(conn, "GET", "/sandboxes", {
    query: { metadata: `${encodeURIComponent(META_TOKEN)}=${encodeURIComponent(token)}`, pageSize: 20 },
    timeoutMs: 20_000,
  });
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) throw osError("invalid_response", "OpenSandbox returned a sandbox list without items.");
  for (const item of items) {
    const sandbox = parseSandbox(item);
    if (tokenOf(sandbox) === token && !REUSABLE.has(sandbox.state)) return sandbox;
  }
  return null;
}

async function deleteRemote(conn: Connection, sandboxId: string): Promise<void> {
  try {
    await lifecycle(conn, "DELETE", `/sandboxes/${encodeURIComponent(sandboxId)}`, { timeoutMs: 60_000 });
  } catch (error) {
    if (errorData(error)?.code !== "not_found") throw error;
  }
}

async function waitForPeer(
  ctx: ActionCtx,
  conn: Connection,
  args: { ownerId: string; key: string },
  options: { ping: boolean; jupyter?: boolean; useServerProxy?: boolean; budget: number },
): Promise<Sandbox> {
  const deadline = Date.now() + options.budget;
  while (Date.now() < deadline) {
    const row = await loadRow(ctx, args.ownerId, args.key);
    if (row?.sandboxId && row.state !== "creating") {
      return await settle(ctx, conn, row as LoadedSandbox & { sandboxId: string }, {
        ...options,
        ping: false,
        budget: Math.max(1_000, deadline - Date.now()),
      });
    }
    if (!row || row.state === "error" || row.state === "Failed") {
      throw osError("failed", row?.lastError ?? row?.message ?? "Sandbox creation failed.", { state: row?.state });
    }
    await sleep(Math.min(500, deadline - Date.now()));
  }
  throw osError("provisioning_timeout", "Another create for this sandbox is still in progress.", { state: "creating" });
}

/** Poll until the sandbox leaves its transient state, then (optionally) until execd answers. */
async function settle(
  ctx: ActionCtx,
  conn: Connection,
  row: { ownerId: string; key: string; token: string; sandboxId: string },
  options: { ping: boolean; jupyter?: boolean; useServerProxy?: boolean; budget: number },
): Promise<Sandbox> {
  const deadline = Date.now() + options.budget;
  let current = await sync(ctx, conn, row);
  while (TRANSIENT.has(current.state) && current.state !== "Pausing") {
    if (Date.now() >= deadline) {
      throw osError("provisioning_timeout", `The sandbox is still ${current.state}.`, { state: current.state });
    }
    await sleep(Math.min(500, deadline - Date.now()));
    current = await sync(ctx, conn, row);
  }
  if (current.state === "Failed" || current.state === "Terminated") {
    throw osError("failed", current.message ?? current.reason ?? `OpenSandbox reports the sandbox ${current.state}.`, {
      state: current.state,
    });
  }
  if (options.ping && current.state === "Running") {
    await waitForExecd(conn, row.sandboxId, deadline, options.useServerProxy);
    if (options.jupyter) await waitForJupyter(conn, row.sandboxId, deadline, options.useServerProxy);
  }
  return current;
}

const CODE_INTERPRETER_IMAGE = /(^|\/)code-interpreter([:@]|$)/;
const CODE_INTERPRETER_ENTRYPOINT = ["/opt/code-interpreter/code-interpreter.sh"];
// Same probe as the official code-interpreter SDK: execd answers /ping before
// the entrypoint has started Jupyter, so check Jupyter's port directly.
const JUPYTER_PROBE = "bash -c 'exec 3<>/dev/tcp/127.0.0.1/${JUPYTER_PORT:-44771}' && exit 0 || exit 1";

async function waitForJupyter(conn: Connection, sandboxId: string, deadline: number, useServerProxy?: boolean) {
  do {
    try {
      const target = await execdTarget(conn, sandboxId, useServerProxy);
      const streamed = await sendEventStream({
        url: joinUrl(target.baseUrl, "/command"),
        method: "POST",
        headers: target.headers,
        apiKey: target.apiKey,
        scrubKey: conn.apiKey,
        json: { command: JUPYTER_PROBE, timeout: 5_000 },
        timeoutMs: 15_000,
        stopAfter: "terminal",
      });
      if (foldEvents(streamed.events, 1_000).exitCode === 0) return;
    } catch (error) {
      const code = errorData(error)?.code;
      if (code === "unauthenticated" || code === "forbidden" || code === "config") throw error;
    }
    await sleep(Math.min(500, deadline - Date.now()));
  } while (Date.now() < deadline);
  throw osError("provisioning_timeout", "The code interpreter (Jupyter) did not start in time.", { state: "Running" });
}

async function waitForExecd(conn: Connection, sandboxId: string, deadline: number, useServerProxy?: boolean) {
  let last = "The sandbox is up but its execution daemon did not answer.";
  do {
    try {
      // The endpoint can be published after the sandbox reports Running.
      const target = await execdTarget(conn, sandboxId, useServerProxy);
      await sendJson({
        url: joinUrl(target.baseUrl, "/ping"),
        method: "GET",
        headers: target.headers,
        apiKey: target.apiKey,
        scrubKey: conn.apiKey,
        timeoutMs: Math.max(1_000, Math.min(10_000, deadline - Date.now())),
      });
      return;
    } catch (error) {
      last = errorData(error)?.message ?? last;
      // A wrong key will not fix itself.
      const code = errorData(error)?.code;
      if (code === "unauthenticated" || code === "forbidden" || code === "config") throw error;
    }
    await sleep(Math.min(250, deadline - Date.now()));
  } while (Date.now() < deadline);
  throw osError("provisioning_timeout", `execd did not answer: ${last}`, { state: "Running" });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export const refresh = action({
  args: identity,
  returns: sandboxValidator,
  handler: async (ctx, args): Promise<Sandbox> => {
    checkIdentity(args.ownerId, args.key);
    const conn = connection();
    const row = await requireRow(ctx, args.ownerId, args.key);
    return await sync(ctx, conn, row);
  },
});

const waitArgs = {
  ...identity,
  /** Seconds to wait for the target state, 0 to 300. Default 60. 0 returns at once. */
  waitSeconds: v.optional(v.number()),
};

export const pause = action({
  args: waitArgs,
  returns: sandboxValidator,
  handler: async (ctx, args): Promise<Sandbox> => {
    checkIdentity(args.ownerId, args.key);
    const conn = connection();
    const row = await requireRow(ctx, args.ownerId, args.key);
    return await transition(ctx, conn, row, "pause", requireInt("waitSeconds", args.waitSeconds ?? 60, 0, 300));
  },
});

export const resume = action({
  args: { ...waitArgs, skipHealthCheck: v.optional(v.boolean()), useServerProxy: v.optional(v.boolean()) },
  returns: sandboxValidator,
  handler: async (ctx, args): Promise<Sandbox> => {
    checkIdentity(args.ownerId, args.key);
    const conn = connection();
    const row = await requireRow(ctx, args.ownerId, args.key);
    const waitSeconds = requireInt("waitSeconds", args.waitSeconds ?? 60, 0, 300);
    const deadline = Date.now() + waitSeconds * 1000;
    const current = await transition(ctx, conn, row, "resume", waitSeconds);
    if (current.state === "Running" && args.skipHealthCheck !== true && waitSeconds > 0) {
      // The ingress route can change across a pause.
      await waitForExecd(conn, row.sandboxId, Math.max(deadline, Date.now() + 5_000), args.useServerProxy);
    }
    return current;
  },
});

async function transition(
  ctx: ActionCtx,
  conn: Connection,
  row: LoadedSandbox & { sandboxId: string },
  verb: "pause" | "resume",
  waitSeconds: number,
): Promise<Sandbox> {
  const [from, during, target] =
    verb === "pause" ? (["Running", "Pausing", "Paused"] as const) : (["Paused", "Resuming", "Running"] as const);
  let current = await sync(ctx, conn, row);
  if (current.state === target) return current;
  if (current.state !== from && current.state !== during) {
    throw osError("not_ready", `Cannot ${verb} a sandbox that is ${current.state}.`, { state: current.state });
  }
  if (current.state === from) {
    try {
      await lifecycle(conn, "POST", `/sandboxes/${encodeURIComponent(row.sandboxId)}/${verb}`);
    } catch (error) {
      // 409 means it moved on its own (another caller, idle policy). Re-read and carry on.
      if (errorData(error)?.code !== "conflict") throw error;
    }
  }
  const deadline = Date.now() + waitSeconds * 1000;
  current = await sync(ctx, conn, row);
  while (current.state !== target) {
    if (current.state === "Failed" || current.state === "Terminated") {
      throw osError("failed", current.message ?? `OpenSandbox reports the sandbox ${current.state}.`, { state: current.state });
    }
    if (Date.now() >= deadline) return current;
    await sleep(Math.min(500, deadline - Date.now()));
    current = await sync(ctx, conn, row);
  }
  return current;
}

export const destroy = action({
  args: identity,
  returns: sandboxValidator,
  handler: async (ctx, args): Promise<Sandbox> => {
    checkIdentity(args.ownerId, args.key);
    const conn = connection();
    const row = await loadRow(ctx, args.ownerId, args.key);
    if (!row) throw osError("not_found", "No sandbox for this owner and key.");
    if (row.sandboxId && row.state !== "Terminated") {
      await deleteRemote(conn, row.sandboxId);
    } else if (!row.sandboxId && (row.state === "creating" || row.state === "error")) {
      // A create may have reached the server without linking its id.
      const found = await findByToken(conn, row.token).catch(() => null);
      if (found) await deleteRemote(conn, found.sandboxId);
    }
    const marked = await ctx.runMutation(internal.store.markTerminated, { ownerId: args.ownerId, key: args.key });
    if (!marked) throw osError("not_found", "No sandbox for this owner and key.");
    return marked;
  },
});

export const renew = action({
  args: {
    ...identity,
    /** Absolute RFC 3339 time. May shorten the expiration. */
    expiresAt: v.optional(v.string()),
    /** Extend the current expiration (or now, if later) by this much. */
    additionalSeconds: v.optional(v.number()),
    /** Set the expiration this many seconds from now, like the SDK's renew(). */
    timeoutSeconds: v.optional(v.number()),
  },
  returns: sandboxValidator,
  handler: async (ctx, args): Promise<Sandbox> => {
    checkIdentity(args.ownerId, args.key);
    const given = [args.expiresAt, args.additionalSeconds, args.timeoutSeconds].filter((item) => item !== undefined);
    if (given.length !== 1) {
      throw osError("invalid_argument", "Pass exactly one of expiresAt, additionalSeconds, or timeoutSeconds.");
    }
    const conn = connection();
    const row = await requireRow(ctx, args.ownerId, args.key);
    if (REUSABLE.has(row.state)) throw osError("not_ready", `The sandbox is ${row.state}.`, { state: row.state });
    let expiresAt: string;
    if (args.expiresAt !== undefined) {
      const parsed = Date.parse(args.expiresAt);
      if (Number.isNaN(parsed)) throw osError("invalid_argument", "expiresAt must be an RFC 3339 timestamp.");
      expiresAt = new Date(parsed).toISOString();
    } else if (args.timeoutSeconds !== undefined) {
      requireInt("timeoutSeconds", args.timeoutSeconds, 1, 365 * 86_400);
      expiresAt = new Date(Date.now() + args.timeoutSeconds * 1000).toISOString();
    } else {
      requireInt("additionalSeconds", args.additionalSeconds!, 1, 365 * 86_400);
      const current = (await sync(ctx, conn, row)).expiresAt;
      if (!current) {
        throw osError(
          "invalid_argument",
          "The sandbox has no expiration, so there is nothing to extend. Pass expiresAt or timeoutSeconds to set one.",
        );
      }
      expiresAt = new Date(Math.max(Date.parse(current), Date.now()) + args.additionalSeconds! * 1000).toISOString();
    }
    if (Date.parse(expiresAt) <= Date.now()) throw osError("invalid_argument", "The new expiration must be in the future.");
    const { body } = await lifecycle(conn, "POST", `/sandboxes/${encodeURIComponent(row.sandboxId)}/renew-expiration`, {
      json: { expiresAt },
    });
    const confirmed = typeof (body as { expiresAt?: unknown } | null)?.expiresAt === "string"
      ? (body as { expiresAt: string }).expiresAt
      : expiresAt;
    return await ctx.runMutation(internal.store.setFields, {
      ownerId: args.ownerId,
      key: args.key,
      sandboxId: row.sandboxId,
      expiresAt: confirmed,
    });
  },
});

export const patchMetadata = action({
  args: {
    ...identity,
    /** JSON Merge Patch: a string sets the key, null deletes it. */
    patch: v.record(v.string(), v.union(v.string(), v.null())),
  },
  returns: sandboxValidator,
  handler: async (ctx, args): Promise<Sandbox> => {
    checkIdentity(args.ownerId, args.key);
    const entries = Object.entries(args.patch);
    if (entries.length > 64) throw osError("invalid_argument", "patch accepts at most 64 keys.");
    for (const [key, value] of entries) {
      checkMetadataKey(key);
      if (value !== null) checkMetadataValue(key, value);
    }
    const conn = connection();
    const row = await requireRow(ctx, args.ownerId, args.key);
    const { body } = await lifecycle(conn, "PATCH", `/sandboxes/${encodeURIComponent(row.sandboxId)}/metadata`, {
      json: args.patch,
    });
    const remote = parseSandbox(body);
    return await ctx.runMutation(internal.store.setFields, {
      ownerId: args.ownerId,
      key: args.key,
      sandboxId: row.sandboxId,
      metadata: userMetadata(remote.metadata),
    });
  },
});

// ---------------------------------------------------------------------------
// Fork: snapshot one key, start another from it.
// ---------------------------------------------------------------------------

export const fork = action({
  args: {
    ...identity,
    /** The new sandbox's key. */
    newKey: v.string(),
    /** Snapshot name, kept with the snapshot. */
    name: v.optional(v.string()),
    /** Seconds to wait for the snapshot to be Ready, 1 to 480. Default 300. */
    snapshotTimeoutSeconds: v.optional(v.number()),
    /** Create options for the new sandbox. The source is the snapshot. */
    options: v.optional(
      v.object({
        entrypoint: createOptionFields.entrypoint,
        timeoutSeconds: createOptionFields.timeoutSeconds,
        resourceLimits: createOptionFields.resourceLimits,
        resourceRequests: createOptionFields.resourceRequests,
        env: createOptionFields.env,
        metadata: createOptionFields.metadata,
        networkPolicy: createOptionFields.networkPolicy,
        secureAccess: createOptionFields.secureAccess,
        lifecycle: createOptionFields.lifecycle,
        readyTimeoutSeconds: v.optional(v.number()),
        skipHealthCheck: v.optional(v.boolean()),
      }),
    ),
    useServerProxy: v.optional(v.boolean()),
  },
  returns: v.object({ snapshotId: v.string(), sandbox: sandboxValidator }),
  handler: async (ctx, args): Promise<{ snapshotId: string; sandbox: Sandbox }> => {
    checkIdentity(args.ownerId, args.newKey);
    if (args.newKey === args.key) throw osError("invalid_argument", "newKey must differ from key.");
    checkIdentity(args.ownerId, args.key);
    const snapshot = await takeSnapshot(ctx, connection(), {
      ownerId: args.ownerId,
      key: args.key,
      name: args.name,
      waitSeconds: requireInt("snapshotTimeoutSeconds", args.snapshotTimeoutSeconds ?? 300, 1, 480),
    });
    if (snapshot.state !== "Ready") {
      throw osError("provisioning_timeout", `The snapshot is still ${snapshot.state}.`, { state: snapshot.state });
    }
    const sandbox = await createSandbox(ctx, {
      ...args.options,
      ownerId: args.ownerId,
      key: args.newKey,
      snapshotId: snapshot.snapshotId,
      useServerProxy: args.useServerProxy,
    });
    return { snapshotId: snapshot.snapshotId, sandbox };
  },
});

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

type SweepResult = {
  checked: number;
  destroyed: Array<{ ownerId: string; key: string; reason: string }>;
  terminated: number;
  rowsDeleted: number;
  errors: Array<{ ownerId: string; key: string; message: string }>;
};

const sweepResult = v.object({
  checked: v.number(),
  destroyed: v.array(v.object({ ownerId: v.string(), key: v.string(), reason: v.string() })),
  terminated: v.number(),
  rowsDeleted: v.number(),
  errors: v.array(v.object({ ownerId: v.string(), key: v.string(), message: v.string() })),
});

/**
 * Destroy idle sandboxes, mark expired ones Terminated, and delete old
 * Terminated rows. Schedule it from a cron in your app. With no ownerId it
 * walks every owner, oldest update first, up to `limit` rows.
 */
export const sweep = action({
  args: {
    ownerId: v.optional(v.string()),
    /** Destroy sandboxes with no activity through this component for this long. */
    idleMs: v.optional(v.number()),
    /** Delete Terminated and error rows last updated longer ago than this. */
    deleteTerminatedAfterMs: v.optional(v.number()),
    limit: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  returns: sweepResult,
  handler: async (ctx, args): Promise<SweepResult> => {
    const limit = requireInt("limit", args.limit ?? 100, 1, 1000);
    if (args.idleMs !== undefined) requireInt("idleMs", args.idleMs, 60_000, 365 * 86_400_000);
    if (args.deleteTerminatedAfterMs !== undefined) {
      requireInt("deleteTerminatedAfterMs", args.deleteTerminatedAfterMs, 0, 3650 * 86_400_000);
    }
    const conn = connection();
    const now = Date.now();
    const rows: LoadedSandbox[] = await ctx.runQuery(internal.store.rowsForSweep, {
      ownerId: args.ownerId,
      updatedBefore: now,
      limit,
    });
    const result: SweepResult = {
      checked: rows.length,
      destroyed: [] as Array<{ ownerId: string; key: string; reason: string }>,
      terminated: 0,
      rowsDeleted: 0,
      errors: [] as Array<{ ownerId: string; key: string; message: string }>,
    };
    const deletable = new Map<string, string[]>();
    for (const row of rows) {
      try {
        if (REUSABLE.has(row.state)) {
          if (args.deleteTerminatedAfterMs !== undefined && now - row.updatedAt >= args.deleteTerminatedAfterMs) {
            deletable.set(row.ownerId, [...(deletable.get(row.ownerId) ?? []), row.key]);
          }
          continue;
        }
        if (!row.sandboxId) continue;
        const created = Date.parse(row.remoteCreatedAt ?? "");
        const lastActive = row.lastActiveAt ?? (Number.isFinite(created) ? created : row.updatedAt);
        const idleFor = now - lastActive;
        if (args.idleMs !== undefined && idleFor >= args.idleMs) {
          if (!args.dryRun) {
            await deleteRemote(conn, row.sandboxId);
            await ctx.runMutation(internal.store.markTerminated, {
              ownerId: row.ownerId,
              key: row.key,
              sandboxId: row.sandboxId,
              reason: "Idle",
            });
          }
          result.destroyed.push({ ownerId: row.ownerId, key: row.key, reason: "idle" });
          continue;
        }
        const expired = row.expiresAt !== undefined && Date.parse(row.expiresAt) <= now;
        if (expired || TRANSIENT.has(row.state)) {
          const current = args.dryRun ? row : await sync(ctx, conn, row as LoadedSandbox & { sandboxId: string });
          if (current.state === "Terminated") result.terminated += 1;
        }
      } catch (error) {
        result.errors.push({ ownerId: row.ownerId, key: row.key, message: errorData(error)?.message ?? "Sweep failed." });
      }
    }
    if (!args.dryRun) {
      for (const [ownerId, keys] of deletable) {
        result.rowsDeleted += await ctx.runMutation(internal.store.deleteRows, { ownerId, keys });
      }
    } else {
      for (const keys of deletable.values()) result.rowsDeleted += keys.length;
    }
    return result;
  },
});

/**
 * Re-read every sandbox this owner has, and find sandboxes on the server that
 * this component created for the owner but no row links (a crash between
 * create and link, or a deleted row). Orphans are destroyed when asked.
 */
export const reconcile = action({
  args: { ownerId: v.string(), destroyOrphans: v.optional(v.boolean()) },
  returns: v.object({
    refreshed: v.array(sandboxValidator),
    orphans: v.array(v.object({ sandboxId: v.string(), state: v.string(), destroyed: v.boolean() })),
    errors: v.array(v.object({ key: v.string(), message: v.string() })),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    refreshed: Sandbox[];
    orphans: Array<{ sandboxId: string; state: string; destroyed: boolean }>;
    errors: Array<{ key: string; message: string }>;
  }> => {
    requireText("ownerId", args.ownerId, 512);
    const conn = connection();
    const rows: LoadedSandbox[] = await ctx.runQuery(internal.store.rowsForSweep, {
      ownerId: args.ownerId,
      updatedBefore: Date.now() + 1,
      limit: 1000,
    });
    const refreshed: Sandbox[] = [];
    const errors: Array<{ key: string; message: string }> = [];
    const linked = new Set<string>();
    const tokens = new Set<string>();
    for (const row of rows) {
      tokens.add(row.token);
      if (!row.sandboxId) continue;
      linked.add(row.sandboxId);
      if (row.state === "Terminated") continue;
      try {
        refreshed.push(await sync(ctx, conn, row as LoadedSandbox & { sandboxId: string }));
      } catch (error) {
        errors.push({ key: row.key, message: errorData(error)?.message ?? "Refresh failed." });
      }
    }
    const ownerDigest = await labelDigest(args.ownerId);
    const orphans: Array<{ sandboxId: string; state: string; destroyed: boolean }> = [];
    for (let page = 1; page <= 20; page += 1) {
      const { body } = await lifecycle(conn, "GET", "/sandboxes", {
        query: {
          metadata: `${META_OWNER}=${ownerDigest}&${META_MANAGED}=true`,
          page,
          pageSize: 100,
        },
      });
      const items = (body as { items?: unknown } | null)?.items;
      if (!Array.isArray(items)) break;
      for (const item of items) {
        const remote = parseSandbox(item);
        if (remote.metadata[META_OWNER] !== ownerDigest) continue;
        if (linked.has(remote.sandboxId) || REUSABLE.has(remote.state)) continue;
        // A create in flight has a row whose token matches; leave it to that create.
        const token = tokenOf(remote);
        if (token && tokens.has(token) && rows.some((row) => row.token === token && row.state === "creating")) continue;
        let destroyed = false;
        if (args.destroyOrphans) {
          await deleteRemote(conn, remote.sandboxId);
          destroyed = true;
        }
        orphans.push({ sandboxId: remote.sandboxId, state: remote.state, destroyed });
      }
      const pagination = (body as { pagination?: { hasNextPage?: unknown } }).pagination;
      if (pagination?.hasNextPage !== true) break;
    }
    return { refreshed, orphans, errors };
  },
});
