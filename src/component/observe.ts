// Resource metrics from execd, and diagnostics from the lifecycle server.
import { v } from "convex/values";
import { action } from "./_generated/server.js";
import { checkIdentity, connection, execdCall, lifecycle, openExecd, requireRow } from "./access.js";
import { osError } from "./errors.js";
import { sendJson } from "./transport.js";
import { identity } from "./validators.js";

export const metrics = action({
  args: { ...identity, useServerProxy: v.optional(v.boolean()) },
  returns: v.object({
    cpuCount: v.number(),
    cpuUsedPercent: v.number(),
    memoryTotalMiB: v.number(),
    memoryUsedMiB: v.number(),
    timestamp: v.number(),
  }),
  handler: async (ctx, args) => {
    const { conn, target } = await openExecd(ctx, args.ownerId, args.key, args.useServerProxy);
    const { body } = await sendJson(execdCall(conn, target, "GET", "/metrics", { timeoutMs: 15_000 }));
    const record = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const num = (name: string) => (typeof record[name] === "number" ? (record[name] as number) : 0);
    return {
      cpuCount: num("cpu_count"),
      cpuUsedPercent: num("cpu_used_pct"),
      memoryTotalMiB: num("mem_total_mib"),
      memoryUsedMiB: num("mem_total_mib") > 0 ? num("mem_used_mib") : 0,
      timestamp: num("timestamp") || Date.now(),
    };
  },
});

/** True when execd answers /ping. Never throws for an unhealthy sandbox. */
export const ping = action({
  args: { ...identity, useServerProxy: v.optional(v.boolean()) },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    try {
      const { conn, target } = await openExecd(ctx, args.ownerId, args.key, args.useServerProxy);
      await sendJson(execdCall(conn, target, "GET", "/ping", { timeoutMs: 10_000 }));
      return true;
    } catch {
      return false;
    }
  },
});

export const diagnosticContext = action({
  args: identity,
  returns: v.object({
    sandboxId: v.string(),
    state: v.optional(v.string()),
    backendType: v.string(),
    backendIdentifiers: v.record(v.string(), v.string()),
  }),
  handler: async (ctx, args) => {
    checkIdentity(args.ownerId, args.key);
    const conn = connection();
    const row = await requireRow(ctx, args.ownerId, args.key);
    const { body } = await lifecycle(conn, "GET", `/sandboxes/${encodeURIComponent(row.sandboxId)}/diagnostics/context`);
    const record = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const identifiers: Record<string, string> = {};
    if (record.backendIdentifiers && typeof record.backendIdentifiers === "object") {
      for (const [name, value] of Object.entries(record.backendIdentifiers as Record<string, unknown>)) {
        if (typeof value === "string" && !name.startsWith("$")) identifiers[name] = value;
      }
    }
    const out: { sandboxId: string; state?: string; backendType: string; backendIdentifiers: Record<string, string> } = {
      sandboxId: typeof record.sandboxId === "string" ? record.sandboxId : row.sandboxId,
      backendType: typeof record.backendType === "string" ? record.backendType : "unknown",
      backendIdentifiers: identifiers,
    };
    if (typeof record.state === "string") out.state = record.state;
    return out;
  },
});

const diagnosticContent = v.object({
  kind: v.string(),
  scope: v.string(),
  contentType: v.string(),
  /** Present when the server returned the content inline. */
  content: v.optional(v.string()),
  /** Present when the server returned a download link instead. */
  contentUrl: v.optional(v.string()),
  truncated: v.boolean(),
  warnings: v.array(v.string()),
});

/**
 * Container logs (`kind: "logs"`, scopes `container` or `all` on Docker) or
 * runtime events (`kind: "events"`, scopes `runtime` or `all` on Docker).
 */
export const diagnostics = action({
  args: { ...identity, kind: v.union(v.literal("logs"), v.literal("events")), scope: v.optional(v.string()) },
  returns: diagnosticContent,
  handler: async (ctx, args) => {
    checkIdentity(args.ownerId, args.key);
    const scope = args.scope ?? "all";
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(scope)) throw osError("invalid_argument", "scope must be a short lowercase name.");
    const conn = connection();
    const row = await requireRow(ctx, args.ownerId, args.key);
    const { body } = await lifecycle(
      conn,
      "GET",
      `/sandboxes/${encodeURIComponent(row.sandboxId)}/diagnostics/${args.kind}`,
      { query: { scope }, timeoutMs: 60_000 },
    );
    const record = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const out: {
      kind: string;
      scope: string;
      contentType: string;
      content?: string;
      contentUrl?: string;
      truncated: boolean;
      warnings: string[];
    } = {
      kind: typeof record.kind === "string" ? record.kind : args.kind,
      scope: typeof record.scope === "string" ? record.scope : scope,
      contentType: typeof record.contentType === "string" ? record.contentType : "text/plain",
      truncated: record.truncated === true,
      warnings: Array.isArray(record.warnings) ? record.warnings.filter((item): item is string => typeof item === "string") : [],
    };
    if (typeof record.content === "string") out.content = record.content.slice(0, 1024 * 1024);
    if (typeof record.contentUrl === "string") out.contentUrl = record.contentUrl;
    return out;
  },
});
