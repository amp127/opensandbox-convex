// Filesystem and ingress. File calls go through execd; `endpoint` asks the
// lifecycle API for a port's public route.
import { v } from "convex/values";
import { action, type ActionCtx } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { checkIdentity, connection, execdCall, openExecd, requireRunning, resolvePort } from "./access.js";
import { osError, scrub } from "./errors.js";
import { modeToWire, parseFileInfo, type FileInfo } from "./remote.js";
import { sendBytes, sendJson } from "./transport.js";
import { identity } from "./validators.js";
import { MAX_READ_BYTES, MAX_TRANSFER_BYTES, MAX_WRITE_BYTES, joinUrl, requireInt } from "./urls.js";

const access = { ...identity, useServerProxy: v.optional(v.boolean()) };

export const fileInfoValidator = v.object({
  path: v.string(),
  type: v.string(),
  size: v.number(),
  /** Permission bits, for example 0o644. */
  mode: v.number(),
  owner: v.string(),
  group: v.string(),
  modifiedAt: v.optional(v.string()),
  createdAt: v.optional(v.string()),
});

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function checkPath(path: string, name = "path"): void {
  if (typeof path !== "string" || path.length === 0 || path.length > 4096 || path.includes("\u0000")) {
    throw osError("invalid_argument", `${name} must be 1 to 4096 characters, without NUL.`);
  }
}

function checkPaths(paths: string[]): void {
  if (paths.length === 0 || paths.length > 1000) throw osError("invalid_argument", "Pass 1 to 1000 paths.");
  for (const path of paths) checkPath(path);
}

function checkOwnerName(name: string | undefined, field: string): void {
  if (name !== undefined && !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(name)) {
    throw osError("invalid_argument", `${field} must be a user or group name.`);
  }
}

async function touch(ctx: ActionCtx, ownerId: string, key: string, sandboxId: string) {
  await ctx.runMutation(internal.store.touch, { ownerId, key, sandboxId }).catch(() => undefined);
}

function infoList(body: unknown): FileInfo[] {
  if (!Array.isArray(body)) return [];
  return body.map(parseFileInfo).filter((item): item is FileInfo => item !== null);
}

export const read = action({
  args: {
    ...access,
    path: v.string(),
    /** Bytes to read, 1 to 8 MiB. Longer files are cut and `truncated` is set. Default 8 MiB. */
    maxBytes: v.optional(v.number()),
    /** Read from this byte offset (HTTP Range). */
    offset: v.optional(v.number()),
    /** Read this many lines from line `fromLine` (1-based) instead of bytes. */
    lines: v.optional(v.object({ fromLine: v.number(), count: v.number() })),
    /** `bytes` (default) or `text` (UTF-8). */
    encoding: v.optional(v.union(v.literal("bytes"), v.literal("text"))),
  },
  returns: v.object({
    path: v.string(),
    bytes: v.optional(v.bytes()),
    text: v.optional(v.string()),
    sizeBytes: v.number(),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    checkPath(args.path);
    const maxBytes = requireInt("maxBytes", args.maxBytes ?? MAX_READ_BYTES, 1, MAX_READ_BYTES);
    if (args.offset !== undefined && args.lines !== undefined) {
      throw osError("invalid_argument", "Pass offset or lines, not both.");
    }
    const headers: Record<string, string> = {};
    const query: Record<string, string | undefined> = { path: args.path };
    if (args.offset !== undefined) {
      requireInt("offset", args.offset, 0, Number.MAX_SAFE_INTEGER);
      headers.Range = `bytes=${args.offset}-${args.offset + maxBytes - 1}`;
    }
    if (args.lines !== undefined) {
      query.offset = String(requireInt("lines.fromLine", args.lines.fromLine, 1, Number.MAX_SAFE_INTEGER));
      query.limit = String(requireInt("lines.count", args.lines.count, 1, 1_000_000));
    }
    const { conn, sandboxId, target } = await openExecd(ctx, args.ownerId, args.key, args.useServerProxy);
    const response = await sendBytes(
      execdCall(conn, target, "GET", "/files/download", {
        query,
        headers,
        accept: "*/*",
        timeoutMs: 120_000,
        maxBytes,
        onOverflow: "truncate",
      }),
    );
    await touch(ctx, args.ownerId, args.key, sandboxId);
    const result: { path: string; bytes?: ArrayBuffer; text?: string; sizeBytes: number; truncated: boolean } = {
      path: args.path,
      sizeBytes: response.bytes.byteLength,
      truncated: response.truncated,
    };
    if (args.encoding === "text" || args.lines !== undefined) result.text = new TextDecoder().decode(response.bytes);
    else result.bytes = exactBuffer(response.bytes);
    return result;
  },
});

const writeEntry = v.object({
  path: v.string(),
  content: v.union(v.string(), v.bytes()),
  /** Permission bits, for example 0o644. Default: execd's default (0o755 for new files). */
  mode: v.optional(v.number()),
  owner: v.optional(v.string()),
  group: v.optional(v.string()),
});

export const write = action({
  args: { ...access, files: v.array(writeEntry) },
  returns: v.array(v.object({ path: v.string(), sizeBytes: v.number() })),
  handler: async (ctx, args) => {
    if (args.files.length === 0 || args.files.length > 100) {
      throw osError("invalid_argument", "Pass 1 to 100 files.");
    }
    const form = new FormData();
    const written: Array<{ path: string; sizeBytes: number }> = [];
    let total = 0;
    for (const file of args.files) {
      checkPath(file.path);
      checkOwnerName(file.owner, "owner");
      checkOwnerName(file.group, "group");
      const data = typeof file.content === "string" ? new TextEncoder().encode(file.content) : new Uint8Array(file.content);
      total += data.byteLength;
      if (total > MAX_WRITE_BYTES) {
        throw osError("too_large", `One write is limited to ${MAX_WRITE_BYTES} bytes in total.`);
      }
      const metadata: Record<string, unknown> = { path: file.path };
      if (file.mode !== undefined) metadata.mode = modeToWire(file.mode);
      if (file.owner !== undefined) metadata.owner = file.owner;
      if (file.group !== undefined) metadata.group = file.group;
      // execd reads both parts as file parts, so both need a filename.
      form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata");
      const name = file.path.split("/").filter(Boolean).pop() ?? "file";
      form.append("file", new Blob([exactBuffer(data)], { type: "application/octet-stream" }), name);
      written.push({ path: file.path, sizeBytes: data.byteLength });
    }
    const { conn, sandboxId, target } = await openExecd(ctx, args.ownerId, args.key, args.useServerProxy);
    await sendJson({ ...execdCall(conn, target, "POST", "/files/upload", { timeoutMs: 180_000 }), form });
    await touch(ctx, args.ownerId, args.key, sandboxId);
    return written;
  },
});

export const info = action({
  args: { ...access, paths: v.array(v.string()) },
  returns: v.array(fileInfoValidator),
  handler: async (ctx, args) => {
    checkPaths(args.paths);
    const { conn, target } = await openExecd(ctx, args.ownerId, args.key, args.useServerProxy);
    const { body } = await sendJson(execdCall(conn, target, "GET", "/files/info", { query: { path: args.paths } }));
    if (!body || typeof body !== "object") return [];
    return Object.values(body as Record<string, unknown>)
      .map(parseFileInfo)
      .filter((item): item is FileInfo => item !== null);
  },
});

export const exists = action({
  args: { ...access, path: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    checkPath(args.path);
    const { conn, target } = await openExecd(ctx, args.ownerId, args.key, args.useServerProxy);
    try {
      const { body } = await sendJson(execdCall(conn, target, "GET", "/files/info", { query: { path: [args.path] } }));
      return !!body && typeof body === "object" && Object.keys(body).length > 0;
    } catch (error) {
      const status = (error as { data?: { status?: number } }).data?.status;
      // execd answers 404 for a missing path, and some versions 500 with "no such file".
      if (status === 404 || (status === 500 && /no such file|not exist/i.test((error as Error).message))) return false;
      throw error;
    }
  },
});

export const list = action({
  args: { ...access, path: v.string(), depth: v.optional(v.number()) },
  returns: v.array(fileInfoValidator),
  handler: async (ctx, args) => {
    checkPath(args.path);
    const depth = requireInt("depth", args.depth ?? 1, 1, 32);
    const { conn, target } = await openExecd(ctx, args.ownerId, args.key, args.useServerProxy);
    const { body } = await sendJson(
      execdCall(conn, target, "GET", "/directories/list", { query: { path: args.path, depth }, timeoutMs: 60_000 }),
    );
    return infoList(body);
  },
});

export const search = action({
  args: { ...access, path: v.string(), pattern: v.optional(v.string()) },
  returns: v.array(fileInfoValidator),
  handler: async (ctx, args) => {
    checkPath(args.path);
    if (args.pattern !== undefined) checkPath(args.pattern, "pattern");
    const { conn, target } = await openExecd(ctx, args.ownerId, args.key, args.useServerProxy);
    const { body } = await sendJson(
      execdCall(conn, target, "GET", "/files/search", {
        query: { path: args.path, pattern: args.pattern },
        timeoutMs: 120_000,
      }),
    );
    return infoList(body);
  },
});

export const remove = action({
  args: {
    ...access,
    paths: v.array(v.string()),
    /** Remove directories and everything under them (rm -rf). Files otherwise. */
    recursive: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    checkPaths(args.paths);
    const { conn, sandboxId, target } = await openExecd(ctx, args.ownerId, args.key, args.useServerProxy);
    await sendJson(
      execdCall(conn, target, "DELETE", args.recursive ? "/directories" : "/files", {
        query: { path: args.paths },
        timeoutMs: 120_000,
      }),
    );
    await touch(ctx, args.ownerId, args.key, sandboxId);
    return null;
  },
});

const permissionFields = {
  mode: v.optional(v.number()),
  owner: v.optional(v.string()),
  group: v.optional(v.string()),
};

function wirePermission(entry: { mode?: number; owner?: string; group?: string }, defaultMode: number) {
  checkOwnerName(entry.owner, "owner");
  checkOwnerName(entry.group, "group");
  const out: Record<string, unknown> = { mode: modeToWire(entry.mode ?? defaultMode) };
  if (entry.owner !== undefined) out.owner = entry.owner;
  if (entry.group !== undefined) out.group = entry.group;
  return out;
}

export const makeDirs = action({
  args: { ...access, dirs: v.array(v.object({ path: v.string(), ...permissionFields })) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    checkPaths(args.dirs.map((dir) => dir.path));
    const body: Record<string, unknown> = {};
    for (const dir of args.dirs) body[dir.path] = wirePermission(dir, 0o755);
    const { conn, target } = await openExecd(ctx, args.ownerId, args.key, args.useServerProxy);
    await sendJson({ ...execdCall(conn, target, "POST", "/directories"), json: body });
    return null;
  },
});

export const move = action({
  args: { ...access, moves: v.array(v.object({ from: v.string(), to: v.string() })) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    if (args.moves.length === 0 || args.moves.length > 1000) throw osError("invalid_argument", "Pass 1 to 1000 moves.");
    for (const item of args.moves) {
      checkPath(item.from, "from");
      checkPath(item.to, "to");
    }
    const { conn, target } = await openExecd(ctx, args.ownerId, args.key, args.useServerProxy);
    await sendJson({
      ...execdCall(conn, target, "POST", "/files/mv"),
      json: args.moves.map((item) => ({ src: item.from, dest: item.to })),
    });
    return null;
  },
});

export const setPermissions = action({
  args: { ...access, entries: v.array(v.object({ path: v.string(), ...permissionFields })) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    checkPaths(args.entries.map((entry) => entry.path));
    const body: Record<string, unknown> = {};
    for (const entry of args.entries) {
      if (entry.mode === undefined) {
        throw osError("invalid_argument", `mode is required for ${entry.path}; execd always applies it.`);
      }
      body[entry.path] = wirePermission(entry, entry.mode);
    }
    const { conn, target } = await openExecd(ctx, args.ownerId, args.key, args.useServerProxy);
    await sendJson({ ...execdCall(conn, target, "POST", "/files/permissions"), json: body });
    return null;
  },
});

export const replace = action({
  args: {
    ...access,
    /** Replace every occurrence of `find` with `replaceWith` in each file. */
    edits: v.array(v.object({ path: v.string(), find: v.string(), replaceWith: v.string() })),
  },
  returns: v.array(v.object({ path: v.string(), replacedCount: v.optional(v.number()) })),
  handler: async (ctx, args) => {
    checkPaths(args.edits.map((edit) => edit.path));
    const body: Record<string, { old: string; new: string }> = {};
    for (const edit of args.edits) {
      if (!edit.find) throw osError("invalid_argument", `find must not be empty for ${edit.path}.`);
      if (body[edit.path]) throw osError("invalid_argument", `Only one edit per path: ${edit.path}.`);
      body[edit.path] = { old: edit.find, new: edit.replaceWith };
    }
    const { conn, sandboxId, target } = await openExecd(ctx, args.ownerId, args.key, args.useServerProxy);
    const { body: counts } = await sendJson({
      ...execdCall(conn, target, "POST", "/files/replace", { query: { verbose: "true" }, timeoutMs: 120_000 }),
      json: body,
    });
    await touch(ctx, args.ownerId, args.key, sandboxId);
    return args.edits.map((edit) => {
      const count = (counts as Record<string, { replacedCount?: unknown }> | null)?.[edit.path]?.replacedCount;
      return typeof count === "number" ? { path: edit.path, replacedCount: count } : { path: edit.path };
    });
  },
});

// ---------------------------------------------------------------------------
// URL transfers. The bytes move between Convex and the sandbox inside this
// action; they never pass through function arguments, so the 8 MiB write cap
// does not apply. Built for Convex file storage: ctx.storage.getUrl() in, and
// ctx.storage.generateUploadUrl() out (see the client's copyFromStorage and
// copyToStorage).
// ---------------------------------------------------------------------------

function checkTransferUrl(url: string, name: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw osError("invalid_argument", `${name} is not a URL.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw osError("invalid_argument", `${name} must be http or https.`);
  }
  if (parsed.username || parsed.password) throw osError("invalid_argument", `${name} must not contain credentials.`);
}

function transferCap(maxBytes: number | undefined): number {
  return requireInt("maxBytes", maxBytes ?? MAX_TRANSFER_BYTES, 1, MAX_TRANSFER_BYTES);
}

/**
 * Pass a response body through, counting bytes and failing past `maxBytes`.
 * Nothing is buffered: memory stays flat whatever the file size.
 */
function counted(body: ReadableStream<Uint8Array>, maxBytes: number, prefix?: Uint8Array, suffix?: Uint8Array) {
  const count = { bytes: 0 };
  const reader = body.getReader();
  let started = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        if (prefix) {
          controller.enqueue(prefix);
          return;
        }
      }
      const { done, value } = await reader.read();
      if (done) {
        if (suffix) controller.enqueue(suffix);
        controller.close();
        return;
      }
      count.bytes += value.byteLength;
      if (count.bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        controller.error(osError("too_large", `The file is larger than ${maxBytes} bytes.`));
        return;
      }
      controller.enqueue(value);
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  return { stream, count };
}

async function streamingFetch(url: string, init: RequestInit, timeoutMs: number, secret: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // duplex is required for a streamed request body; older type libraries do not know it.
    const response = await fetch(url, { ...init, signal: controller.signal, duplex: "half" } as RequestInit);
    return response;
  } catch (error) {
    const data = (error as { data?: unknown }).data;
    if (data) throw error;
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      throw osError("timeout", "The transfer did not finish before the deadline.");
    }
    throw osError("network", scrub(error instanceof Error ? error.message : "The transfer failed.", secret));
  } finally {
    clearTimeout(timer);
  }
}

async function failFrom(response: Response, what: string): Promise<never> {
  const text = await response.text().catch(() => "");
  let message = `${what} answered HTTP ${response.status}.`;
  try {
    const body = JSON.parse(text) as { message?: unknown };
    if (typeof body.message === "string") message = `${what}: ${body.message}`;
  } catch {
    // not JSON
  }
  const code = response.status === 404 ? "not_found" : response.status === 413 ? "too_large" : response.status >= 500 ? "unavailable" : "invalid_argument";
  throw osError(code, scrub(message), { status: response.status });
}

/**
 * Download `url` and write it into the sandbox at `path`, streaming: the file
 * is never held in memory. Only pass URLs your app produced (a storage URL,
 * say); the component fetches whatever it gets, without the API key.
 */
export const importFromUrl = action({
  args: {
    ...access,
    url: v.string(),
    path: v.string(),
    mode: v.optional(v.number()),
    owner: v.optional(v.string()),
    group: v.optional(v.string()),
    /** Default and maximum 1 GiB. */
    maxBytes: v.optional(v.number()),
  },
  returns: v.object({ path: v.string(), sizeBytes: v.number() }),
  handler: async (ctx, args) => {
    checkPath(args.path);
    checkTransferUrl(args.url, "url");
    checkOwnerName(args.owner, "owner");
    checkOwnerName(args.group, "group");
    const maxBytes = transferCap(args.maxBytes);
    const { conn, sandboxId, target } = await openExecd(ctx, args.ownerId, args.key, args.useServerProxy);
    const source = await streamingFetch(args.url, { method: "GET" }, 600_000, conn.apiKey);
    if (!source.ok || !source.body) await failFrom(source, "The source URL");
    const declared = Number(source.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await source.body?.cancel().catch(() => undefined);
      throw osError("too_large", `The file is ${declared} bytes; the limit is ${maxBytes}.`);
    }

    const metadata: Record<string, unknown> = { path: args.path };
    if (args.mode !== undefined) metadata.mode = modeToWire(args.mode);
    if (args.owner !== undefined) metadata.owner = args.owner;
    if (args.group !== undefined) metadata.group = args.group;
    // execd reads both parts as file parts, so both carry a filename.
    const boundary = `----opensandbox-convex-${crypto.randomUUID()}`;
    const filename = (args.path.split("/").filter(Boolean).pop() ?? "file").replace(/["\\\r\n]/g, "_");
    const encoder = new TextEncoder();
    const head = encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="metadata"; filename="metadata"\r\n` +
        `Content-Type: application/json\r\n\r\n${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    );
    const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
    const { stream, count } = counted(source.body!, maxBytes, head, tail);
    const upload = await streamingFetch(
      joinUrl(target.baseUrl, "/files/upload"),
      {
        method: "POST",
        headers: {
          ...target.headers,
          ...(target.apiKey ? { "OPEN-SANDBOX-API-KEY": target.apiKey } : {}),
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        body: stream,
      },
      600_000,
      conn.apiKey,
    );
    if (!upload.ok) await failFrom(upload, "execd");
    await upload.body?.cancel().catch(() => undefined);
    await touch(ctx, args.ownerId, args.key, sandboxId);
    return { path: args.path, sizeBytes: count.bytes };
  },
});

/**
 * Stream `path` from the sandbox to `uploadUrl` (a Convex
 * ctx.storage.generateUploadUrl() URL). Returns `storageId` when the upload
 * target is Convex storage.
 */
export const exportToUploadUrl = action({
  args: {
    ...access,
    path: v.string(),
    uploadUrl: v.string(),
    contentType: v.optional(v.string()),
    maxBytes: v.optional(v.number()),
  },
  returns: v.object({ path: v.string(), sizeBytes: v.number(), storageId: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    checkPath(args.path);
    checkTransferUrl(args.uploadUrl, "uploadUrl");
    const contentType = args.contentType ?? "application/octet-stream";
    if (!/^[\w.+-]+\/[\w.+-]+(;[\w\s=.+-]*)?$/.test(contentType)) {
      throw osError("invalid_argument", "contentType must be a media type such as text/plain.");
    }
    const maxBytes = transferCap(args.maxBytes);
    const { conn, sandboxId, target } = await openExecd(ctx, args.ownerId, args.key, args.useServerProxy);
    const download = await streamingFetch(
      joinUrl(target.baseUrl, "/files/download", { path: args.path }),
      { method: "GET", headers: { ...target.headers, ...(target.apiKey ? { "OPEN-SANDBOX-API-KEY": target.apiKey } : {}) } },
      600_000,
      conn.apiKey,
    );
    if (!download.ok || !download.body) await failFrom(download, "execd");
    const { stream, count } = counted(download.body!, maxBytes);
    const upload = await streamingFetch(
      args.uploadUrl,
      { method: "POST", headers: { "content-type": contentType }, body: stream },
      600_000,
      conn.apiKey,
    );
    if (!upload.ok) await failFrom(upload, "The upload URL");
    const text = await upload.text();
    let storageId: string | undefined;
    try {
      const parsed = JSON.parse(text) as { storageId?: unknown };
      if (typeof parsed.storageId === "string") storageId = parsed.storageId;
    } catch {
      // Not JSON: an upload target other than Convex storage.
    }
    await touch(ctx, args.ownerId, args.key, sandboxId);
    const result: { path: string; sizeBytes: number; storageId?: string } = { path: args.path, sizeBytes: count.bytes };
    if (storageId !== undefined) result.storageId = storageId;
    return result;
  },
});

export const endpoint = action({
  args: {
    ...access,
    port: v.number(),
    /**
     * Ask for a signed route that stops working at this Unix time (seconds).
     * Needs the ingress gateway with secure_access configured.
     */
    expiresAt: v.optional(v.number()),
  },
  returns: v.object({
    url: v.string(),
    headers: v.record(v.string(), v.string()),
    port: v.number(),
    expiresAt: v.optional(v.number()),
    /**
     * True when the URL is the lifecycle server's proxy. If your server (or
     * the TLS proxy in front of it) requires the API key on that path, a
     * browser cannot open it directly: relay it through your own backend.
     */
    viaServerProxy: v.boolean(),
  }),
  handler: async (ctx, args) => {
    checkIdentity(args.ownerId, args.key);
    requireInt("port", args.port, 1, 65535);
    if (args.expiresAt !== undefined) {
      requireInt("expiresAt", args.expiresAt, Math.floor(Date.now() / 1000) + 1, Number.MAX_SAFE_INTEGER);
      if (args.useServerProxy) throw osError("invalid_argument", "Signed endpoints cannot use the server proxy.");
    }
    const conn = connection();
    const { sandboxId } = await requireRunning(ctx, conn, args.ownerId, args.key);
    const target = await resolvePort(conn, sandboxId, args.port, {
      useServerProxy: args.useServerProxy,
      expires: args.expiresAt,
    });
    const result: {
      url: string;
      headers: Record<string, string>;
      port: number;
      expiresAt?: number;
      viaServerProxy: boolean;
    } = {
      url: target.baseUrl,
      headers: target.headers,
      port: args.port,
      viaServerProxy: target.apiKey !== undefined,
    };
    if (args.expiresAt !== undefined) result.expiresAt = args.expiresAt;
    return result;
  },
});
