// Shared plumbing for actions: config, the caller's sandbox row, a fresh
// state read, and how to reach execd.
import type { ActionCtx } from "./_generated/server.js";
import { env } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { errorData, osError } from "./errors.js";
import { parseEndpoint, parseSandbox, userMetadata, type RemoteSandbox } from "./remote.js";
import type { LoadedSandbox, RemoteFields, Sandbox } from "./store.js";
import { sendJson, type SendOptions } from "./transport.js";
import {
  EXECD_PORT,
  apiUrl,
  endpointBaseUrl,
  joinUrl,
  requireText,
  resolveConnection,
  sameOrigin,
  type Connection,
  type QueryValue,
} from "./urls.js";

export function connection(): Connection {
  return resolveConnection(env);
}

export function checkIdentity(ownerId: string, key: string): void {
  requireText("ownerId", ownerId, 512);
  requireText("key", key, 256);
}

export function remoteFields(remote: RemoteSandbox): RemoteFields {
  const fields: RemoteFields = { sandboxId: remote.sandboxId, state: remote.state, metadata: userMetadata(remote.metadata) };
  for (const name of [
    "image",
    "snapshotId",
    "entrypoint",
    "platform",
    "expiresAt",
    "remoteCreatedAt",
    "lastTransitionAt",
    "reason",
    "message",
  ] as const) {
    if (remote[name] !== undefined) (fields as Record<string, unknown>)[name] = remote[name];
  }
  return fields;
}

/** Call the lifecycle API with the API key. */
export async function lifecycle(
  conn: Connection,
  method: SendOptions["method"],
  path: string,
  options: { json?: unknown; query?: Record<string, QueryValue>; timeoutMs?: number } = {},
) {
  return await sendJson({
    url: apiUrl(conn.origin, path, options.query),
    method,
    apiKey: conn.apiKey,
    json: options.json,
    timeoutMs: options.timeoutMs ?? 30_000,
  });
}

export async function readRemote(conn: Connection, sandboxId: string): Promise<RemoteSandbox> {
  const { body } = await lifecycle(conn, "GET", `/sandboxes/${encodeURIComponent(sandboxId)}`);
  return parseSandbox(body);
}

export async function loadRow(ctx: ActionCtx, ownerId: string, key: string): Promise<LoadedSandbox | null> {
  return await ctx.runQuery(internal.store.load, { ownerId, key });
}

export async function requireRow(ctx: ActionCtx, ownerId: string, key: string): Promise<LoadedSandbox & { sandboxId: string }> {
  const row = await loadRow(ctx, ownerId, key);
  if (!row?.sandboxId) throw osError("not_found", "No sandbox for this owner and key.");
  return row as LoadedSandbox & { sandboxId: string };
}

/** Read the sandbox from OpenSandbox and store it. A 404 marks the row Terminated. */
export async function sync(
  ctx: ActionCtx,
  conn: Connection,
  row: { ownerId: string; key: string; token: string; sandboxId: string },
): Promise<Sandbox> {
  try {
    const remote = await readRemote(conn, row.sandboxId);
    const { sandbox } = await ctx.runMutation(internal.store.applyRemote, {
      ownerId: row.ownerId,
      key: row.key,
      token: row.token,
      remote: remoteFields(remote),
    });
    if (!sandbox) throw osError("not_found", "No sandbox for this owner and key.");
    return sandbox;
  } catch (error) {
    if (errorData(error)?.code === "not_found" && errorData(error)?.status === 404) {
      const marked = await ctx.runMutation(internal.store.markTerminated, {
        ownerId: row.ownerId,
        key: row.key,
        sandboxId: row.sandboxId,
        reason: "NotFound",
      });
      if (marked) return marked;
    }
    throw error;
  }
}

/**
 * The caller's sandbox, ready for execd. The stored state can lag (a pause or
 * expiry made elsewhere), so anything other than Running is re-read once
 * before the call is refused.
 */
export async function requireRunning(
  ctx: ActionCtx,
  conn: Connection,
  ownerId: string,
  key: string,
): Promise<{ sandboxId: string; token: string }> {
  checkIdentity(ownerId, key);
  const row = await requireRow(ctx, ownerId, key);
  if (row.state === "Running") return { sandboxId: row.sandboxId, token: row.token };
  if (row.state === "Terminated") {
    throw osError("not_ready", "The sandbox is Terminated.", { state: row.state });
  }
  const current = await sync(ctx, conn, row);
  if (current.state !== "Running" || current.sandboxId !== row.sandboxId) {
    throw osError("not_ready", `The sandbox is ${current.state}, not Running.`, { state: current.state });
  }
  return { sandboxId: row.sandboxId, token: row.token };
}

export interface Target {
  baseUrl: string;
  headers: Record<string, string>;
  /** Present only when the target is the lifecycle server's own proxy. */
  apiKey?: string;
  /** Re-checks the sandbox when execd cannot be reached. */
  onUnreachable?: () => Promise<void>;
}

/** Resolve a sandbox port to a URL plus the headers it needs. */
export async function resolvePort(
  conn: Connection,
  sandboxId: string,
  port: number,
  options: { useServerProxy?: boolean; expires?: number } = {},
): Promise<Target> {
  const { body } = await lifecycle(conn, "GET", `/sandboxes/${encodeURIComponent(sandboxId)}/endpoints/${port}`, {
    query: {
      use_server_proxy: options.useServerProxy ? "true" : undefined,
      expires: options.expires !== undefined ? String(options.expires) : undefined,
    },
    timeoutMs: 20_000,
  });
  const endpoint = parseEndpoint(body);
  const baseUrl = endpointBaseUrl(conn.protocol, endpoint.endpoint);
  // The server proxy lives on the lifecycle origin and, on multi-tenant
  // servers, authenticates with the API key. Never send the key elsewhere.
  const apiKey = options.useServerProxy && sameOrigin(baseUrl, conn.origin) ? conn.apiKey : undefined;
  return { baseUrl, headers: endpoint.headers, apiKey };
}

export async function execdTarget(conn: Connection, sandboxId: string, useServerProxy?: boolean): Promise<Target> {
  return await resolvePort(conn, sandboxId, EXECD_PORT, { useServerProxy });
}

/** Options for a call to execd at `target`. */
export function execdCall(
  conn: Connection,
  target: Target,
  method: SendOptions["method"],
  path: string,
  extra: Omit<SendOptions, "url" | "method" | "apiKey" | "scrubKey" | "headers" | "timeoutMs"> & {
    query?: Record<string, QueryValue>;
    headers?: Record<string, string>;
    timeoutMs?: number;
  } = {},
): SendOptions {
  const { query, headers, timeoutMs, ...rest } = extra;
  return {
    ...rest,
    url: joinUrl(target.baseUrl, path, query),
    method,
    headers: { ...target.headers, ...headers },
    apiKey: target.apiKey,
    scrubKey: conn.apiKey,
    timeoutMs: timeoutMs ?? 30_000,
    onUnreachable: target.onUnreachable,
  };
}

/** Everything an execd-backed action needs, in one call. */
export async function openExecd(
  ctx: ActionCtx,
  ownerId: string,
  key: string,
  useServerProxy?: boolean,
): Promise<{ conn: Connection; sandboxId: string; target: Target }> {
  const conn = connection();
  const { sandboxId, token } = await requireRunning(ctx, conn, ownerId, key);
  const target = await execdTarget(conn, sandboxId, useServerProxy);
  // The row said Running. If execd is unreachable, find out whether that is still true.
  target.onUnreachable = async () => {
    const current = await sync(ctx, conn, { ownerId, key, token, sandboxId });
    if (current.state !== "Running") {
      throw osError("not_ready", `The sandbox is ${current.state}, not Running.`, { state: current.state });
    }
  };
  return { conn, sandboxId, target };
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
