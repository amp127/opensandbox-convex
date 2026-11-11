// The demo page's backend. A real app derives ownerId from ctx.auth; this demo
// has no sign-in, so each browser makes a random visitor id and every sandbox
// is scoped to it. Anyone with the id can use those sandboxes: fine for a
// demo, never for production.
import { ConvexError, v } from "convex/values";
import { OpenSandbox } from "opensandbox-convex";
import { action, query } from "./_generated/server";
import { components } from "./_generated/api";

export const sandboxes = new OpenSandbox(components.opensandbox, {
  useServerProxy: process.env.OPENSANDBOX_USE_SERVER_PROXY !== "false",
});

const IMAGES = {
  python: { image: "python:3.12-slim", label: "Python 3.12" },
  debian: { image: "debian:trixie", label: "Debian 13" },
  code: { image: "opensandbox/code-interpreter:latest", label: "Code interpreter" },
} as const;
const MAX_PER_VISITOR = 3;
const PREVIEW_PORT = 8000;

const visitorRef = { visitor: v.string(), key: v.string() };

export function ownerOf(visitor: string): string {
  if (!/^[a-f0-9]{32}$/.test(visitor)) throw new ConvexError("Bad visitor id.");
  return `demo:${visitor}`;
}

function ref(args: { visitor: string; key: string }) {
  if (!/^[a-z0-9-]{1,40}$/.test(args.key)) throw new ConvexError("Bad sandbox key.");
  return { ownerId: ownerOf(args.visitor), key: args.key };
}

export const images = query({
  args: {},
  handler: async () => Object.entries(IMAGES).map(([id, item]) => ({ id, ...item })),
});

export const list = query({
  args: { visitor: v.string() },
  handler: async (ctx, args) =>
    await sandboxes.list(ctx, { ownerId: ownerOf(args.visitor), includeTerminated: false, limit: 20 }),
});

export const history = query({
  args: visitorRef,
  handler: async (ctx, args) => await sandboxes.listExecutions(ctx, { ...ref(args), limit: 30 }),
});

export const snapshots = query({
  args: { visitor: v.string() },
  handler: async (ctx, args) => await sandboxes.listSnapshots(ctx, { ownerId: ownerOf(args.visitor) }),
});

export const create = action({
  args: { visitor: v.string(), image: v.union(v.literal("python"), v.literal("debian"), v.literal("code")) },
  handler: async (ctx, args) => {
    const ownerId = ownerOf(args.visitor);
    const live = await sandboxes.list(ctx, { ownerId, includeTerminated: false });
    if (live.length >= MAX_PER_VISITOR) throw new ConvexError(`The demo allows ${MAX_PER_VISITOR} sandboxes at a time.`);
    const key = `${args.image}-${Math.random().toString(36).slice(2, 7)}`;
    const started = Date.now();
    const sandbox = await sandboxes.create(ctx, {
      ownerId,
      key,
      image: IMAGES[args.image].image,
      timeoutSeconds: 1800,
      resourceLimits: { cpu: "1", memory: "1Gi" },
      metadata: { app: "demo" },
      readyTimeoutSeconds: 180,
    });
    return { key: sandbox.key, bootMs: Date.now() - started };
  },
});

export const run = action({
  args: { ...visitorRef, command: v.string(), cwd: v.optional(v.string()) },
  handler: async (ctx, args) =>
    await sandboxes.exec(ctx, { ...ref(args), command: args.command, cwd: args.cwd, timeoutMs: 120_000 }),
});

export const runCode = action({
  args: { ...visitorRef, code: v.string() },
  handler: async (ctx, args) => await sandboxes.runCode(ctx, { ...ref(args), code: args.code, timeoutMs: 120_000 }),
});

export const listFiles = action({
  args: { ...visitorRef, path: v.string() },
  handler: async (ctx, args) => {
    const entries = await sandboxes.listFiles(ctx, { ...ref(args), path: args.path });
    return entries
      .map((entry) => ({ path: entry.path, type: entry.type, size: entry.size, mode: entry.mode.toString(8) }))
      .sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === "directory" ? -1 : 1));
  },
});

export const readFile = action({
  args: { ...visitorRef, path: v.string() },
  handler: async (ctx, args) => await sandboxes.readFile(ctx, { ...ref(args), path: args.path, maxBytes: 256 * 1024 }),
});

export const writeFile = action({
  args: { ...visitorRef, path: v.string(), content: v.string() },
  handler: async (ctx, args) =>
    await sandboxes.writeFile(ctx, { ...ref(args), path: args.path, content: args.content, mode: 0o644 }),
});

export const lifecycle = action({
  args: { ...visitorRef, verb: v.union(v.literal("pause"), v.literal("resume"), v.literal("destroy"), v.literal("refresh")) },
  handler: async (ctx, args) => {
    const sb = ref(args);
    if (args.verb === "pause") return await sandboxes.pause(ctx, sb);
    if (args.verb === "resume") return await sandboxes.resume(ctx, sb);
    if (args.verb === "destroy") return await sandboxes.destroy(ctx, sb);
    return await sandboxes.refresh(ctx, sb);
  },
});

export const fork = action({
  args: visitorRef,
  handler: async (ctx, args) => {
    const sb = ref(args);
    const live = await sandboxes.list(ctx, { ownerId: sb.ownerId, includeTerminated: false });
    if (live.length >= MAX_PER_VISITOR) throw new ConvexError(`The demo allows ${MAX_PER_VISITOR} sandboxes at a time.`);
    const { sandbox } = await sandboxes.fork(ctx, {
      ...sb,
      newKey: `${args.key.split("-")[0]}-${Math.random().toString(36).slice(2, 7)}`,
      options: { timeoutSeconds: 1800, metadata: { app: "demo" } },
    });
    return { key: sandbox.key };
  },
});

export const metrics = action({
  args: visitorRef,
  handler: async (ctx, args) => await sandboxes.metrics(ctx, ref(args)),
});

/** Serve a small page from the sandbox and return the relay path that shows it. */
export const startPreview = action({
  args: visitorRef,
  handler: async (ctx, args) => {
    const sb = ref(args);
    const page = `<!doctype html><meta charset="utf-8"><title>Sandbox preview</title>
<body style="font:16px system-ui;background:#0b0d12;color:#e4e4e7;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1>Served from inside the sandbox</h1>
<p>python -m http.server on port ${PREVIEW_PORT}, relayed by a Convex HTTP action.</p>
<p style="color:#7db89e">${new Date().toISOString()}</p></div></body>`;
    const probe = await sandboxes.exec(ctx, {
      ...sb,
      command: `command -v python3 >/dev/null || { echo nopython; exit 0; }; python3 -c "import socket; socket.create_connection(('127.0.0.1', ${PREVIEW_PORT}), 1)" 2>/dev/null && echo up || echo down`,
    });
    if (probe.stdout.includes("nopython")) throw new ConvexError("The preview needs Python: use a Python or code interpreter sandbox.");
    await sandboxes.writeFile(ctx, { ...sb, path: "/tmp/site/index.html", content: page });
    if (!probe.stdout.includes("up")) {
      await sandboxes.spawn(ctx, { ...sb, command: `cd /tmp/site && python3 -m http.server ${PREVIEW_PORT}` });
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    return { path: `/preview/${args.visitor}/${args.key}/${PREVIEW_PORT}/` };
  },
});
