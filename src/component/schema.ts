import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * One OpenSandbox sandbox this component created, keyed by (ownerId, key).
 * The lifecycle API is the source of truth; these fields are the last
 * observation. Endpoint headers, image credentials, volume secrets, and the
 * API key are never stored.
 */
export const sandboxFields = {
  ownerId: v.string(),
  key: v.string(),
  /** Correlates a create with the sandbox's metadata if the response is lost. */
  token: v.string(),
  sandboxId: v.optional(v.string()),
  /**
   * OpenSandbox state (`Pending`, `Running`, `Paused`, ...), or `creating`
   * before an id exists, or `error` when create failed before linking.
   */
  state: v.string(),
  image: v.optional(v.string()),
  snapshotId: v.optional(v.string()),
  templateId: v.optional(v.string()),
  entrypoint: v.optional(v.array(v.string())),
  /** Metadata the caller set. The component's own keys are not included. */
  metadata: v.optional(v.record(v.string(), v.string())),
  platform: v.optional(v.object({ os: v.string(), arch: v.string() })),
  expiresAt: v.optional(v.string()),
  remoteCreatedAt: v.optional(v.string()),
  lastTransitionAt: v.optional(v.string()),
  reason: v.optional(v.string()),
  message: v.optional(v.string()),
  lastError: v.optional(v.string()),
  /** When the row last matched OpenSandbox. */
  syncedAt: v.optional(v.number()),
  /** Last command, code run, or file call through this component. Drives idle sweeps. */
  lastActiveAt: v.optional(v.number()),
  updatedAt: v.number(),
};

export const executionStatus = v.union(
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("timed_out"),
  v.literal("interrupted"),
  v.literal("error"),
  v.literal("unknown"),
);

export const executionKind = v.union(
  v.literal("exec"),
  v.literal("spawn"),
  v.literal("session"),
  v.literal("code"),
);

/** One run. Command text and output are stored only when asked. */
export const executionFields = {
  ownerId: v.string(),
  key: v.string(),
  sandboxId: v.string(),
  /** execd's id: the command id for exec/spawn, the run id for code. */
  commandId: v.optional(v.string()),
  /** Bash session id for `session`, code context id for `code`. */
  sessionId: v.optional(v.string()),
  language: v.optional(v.string()),
  kind: executionKind,
  status: executionStatus,
  exitCode: v.optional(v.number()),
  timeoutMs: v.optional(v.number()),
  /** First 4 KB of the command or code, only with retainOutput. */
  input: v.optional(v.string()),
  /** First 64 KB of stdout, only with retainOutput. */
  stdout: v.optional(v.string()),
  stderr: v.optional(v.string()),
  outputTruncated: v.optional(v.boolean()),
  error: v.optional(v.string()),
  startedAt: v.number(),
  finishedAt: v.optional(v.number()),
};

export const snapshotFields = {
  ownerId: v.string(),
  /** The sandbox key the snapshot was taken from. */
  key: v.string(),
  snapshotId: v.string(),
  sandboxId: v.string(),
  name: v.optional(v.string()),
  /** `Creating`, `Ready`, `Failed`, or `Deleted`. */
  state: v.string(),
  reason: v.optional(v.string()),
  message: v.optional(v.string()),
  remoteCreatedAt: v.optional(v.string()),
  updatedAt: v.number(),
};

export default defineSchema({
  sandboxes: defineTable(sandboxFields)
    .index("by_owner_key", ["ownerId", "key"])
    .index("by_owner", ["ownerId"])
    .index("by_sandbox", ["sandboxId"])
    .index("by_updated", ["updatedAt"]),
  executions: defineTable(executionFields)
    .index("by_owner_key_started", ["ownerId", "key", "startedAt"])
    .index("by_owner_started", ["ownerId", "startedAt"])
    .index("by_started", ["startedAt"])
    .index("by_command", ["commandId"]),
  snapshots: defineTable(snapshotFields)
    .index("by_owner", ["ownerId"])
    .index("by_owner_key", ["ownerId", "key"])
    .index("by_snapshot", ["snapshotId"]),
});
