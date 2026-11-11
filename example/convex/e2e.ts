// End-to-end harness against a real OpenSandbox server. Internal only: the
// script in scripts/e2e.mjs calls these with the deployment's admin key.
import { v } from "convex/values";
import { OpenSandbox, openSandboxErrorData } from "opensandbox-convex";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { components } from "./_generated/api";

const direct = new OpenSandbox(components.opensandbox, { retainOutput: true });
const viaProxy = new OpenSandbox(components.opensandbox, { retainOutput: true, useServerProxy: true });
let sandboxes = direct;
const proxied = viaProxy;

const ref = { ownerId: v.string(), key: v.string() };

function fail(error: unknown) {
  const data = openSandboxErrorData(error);
  return { ok: false as const, code: data?.code ?? "thrown", message: data?.message ?? String(error), state: data?.state };
}

export const create = internalAction({
  args: { ...ref, proxy: v.optional(v.boolean()), networkPolicy: v.optional(v.any()), image: v.string(), timeoutSeconds: v.optional(v.union(v.number(), v.null())), metadata: v.optional(v.record(v.string(), v.string())) },
  handler: async (ctx, { proxy, ...args }) => {
    sandboxes = proxy ? viaProxy : direct;
    try {
      return { ok: true as const, sandbox: await sandboxes.create(ctx, { ...args, readyTimeoutSeconds: 180 }) };
    } catch (error) {
      return fail(error);
    }
  },
});

export const get = internalQuery({
  args: ref,
  handler: async (ctx, args) => await sandboxes.get(ctx, args),
});

/** Run one named check. Each returns plain data so the script can assert on it. */
export const check = internalAction({
  args: { ...ref, name: v.string(), input: v.optional(v.any()), proxy: v.optional(v.boolean()) },
  handler: async (ctx, { name, input, proxy, ...sb }): Promise<unknown> => {
    sandboxes = proxy ? viaProxy : direct;
    try {
      switch (name) {
        case "exec":
          return { ok: true, value: await sandboxes.exec(ctx, { ...sb, command: "echo hello; echo oops >&2; uname -s" }) };
        case "execFail":
          return { ok: true, value: await sandboxes.exec(ctx, { ...sb, command: "echo before; exit 7" }) };
        case "execArgv":
          return { ok: true, value: await sandboxes.exec(ctx, { ...sb, command: ["printf", "%s|", "a b", "c'd"] }) };
        case "execEnvCwd":
          return {
            ok: true,
            value: await sandboxes.exec(ctx, { ...sb, command: "echo $GREETING; pwd", env: { GREETING: "hi there" }, cwd: "/tmp" }),
          };
        case "execTimeout":
          return { ok: true, value: await sandboxes.exec(ctx, { ...sb, command: "sleep 30", timeoutMs: 2000 }) };
        case "execBigOutput":
          return {
            ok: true,
            value: await sandboxes
              .exec(ctx, { ...sb, command: "head -c 3000000 /dev/zero | tr '\\0' 'x'" })
              .then((r) => ({ ...r, stdout: `${r.stdout.length} chars` })),
          };
        case "spawn":
          return {
            ok: true,
            value: await sandboxes.spawn(ctx, { ...sb, command: "for i in 1 2 3; do echo tick $i; sleep 1; done" }),
          };
        case "status":
          return { ok: true, value: await sandboxes.commandStatus(ctx, { ...sb, commandId: input.commandId, cursor: input.cursor }) };
        case "kill": {
          const spawned = await sandboxes.spawn(ctx, { ...sb, command: "sleep 300" });
          await sandboxes.kill(ctx, { ...sb, commandId: spawned.commandId! });
          await new Promise((resolve) => setTimeout(resolve, 1000));
          return { ok: true, value: await sandboxes.commandStatus(ctx, { ...sb, commandId: spawned.commandId! }) };
        }
        case "session": {
          const { sessionId } = await sandboxes.createSession(ctx, { ...sb, cwd: "/tmp" });
          await sandboxes.runInSession(ctx, { ...sb, sessionId, command: "cd /var && export X=persisted" });
          const second = await sandboxes.runInSession(ctx, { ...sb, sessionId, command: "pwd; echo $X" });
          await sandboxes.deleteSession(ctx, { ...sb, sessionId });
          return { ok: true, value: second };
        }
        case "files": {
          await sandboxes.makeDirs(ctx, { ...sb, dirs: [{ path: "/tmp/e2e/dir", mode: 0o750 }] });
          await sandboxes.writeFile(ctx, { ...sb, path: "/tmp/e2e/run.sh", content: "#!/bin/sh\necho ran\n", mode: 0o755 });
          const bytes = new Uint8Array(256).map((_, i) => i);
          await sandboxes.writeFiles(ctx, {
            ...sb,
            files: [
              { path: "/tmp/e2e/bin.dat", content: bytes, mode: 0o600 },
              { path: "/tmp/e2e/notes.txt", content: "alpha\nbeta\ngamma\n" },
            ],
          });
          const ran = await sandboxes.exec(ctx, { ...sb, command: "/tmp/e2e/run.sh && stat -c '%a %n' /tmp/e2e/run.sh /tmp/e2e/bin.dat /tmp/e2e/dir" });
          const text = await sandboxes.readFile(ctx, { ...sb, path: "/tmp/e2e/notes.txt" });
          const lines = await sandboxes.readFile(ctx, { ...sb, path: "/tmp/e2e/notes.txt", lines: { fromLine: 2, count: 1 } });
          const ranged = await sandboxes.readFileBytes(ctx, { ...sb, path: "/tmp/e2e/bin.dat", offset: 10, maxBytes: 5 });
          const whole = await sandboxes.readFileBytes(ctx, { ...sb, path: "/tmp/e2e/bin.dat" });
          const listed = await sandboxes.listFiles(ctx, { ...sb, path: "/tmp/e2e" });
          const info = await sandboxes.fileInfo(ctx, { ...sb, paths: ["/tmp/e2e/run.sh"] });
          const found = await sandboxes.searchFiles(ctx, { ...sb, path: "/tmp/e2e", pattern: "*.txt" });
          const replaced = await sandboxes.replaceInFiles(ctx, { ...sb, edits: [{ path: "/tmp/e2e/notes.txt", find: "beta", replaceWith: "BETA" }] });
          await sandboxes.moveFiles(ctx, { ...sb, moves: [{ from: "/tmp/e2e/notes.txt", to: "/tmp/e2e/dir/notes.txt" }] });
          await sandboxes.setPermissions(ctx, { ...sb, entries: [{ path: "/tmp/e2e/dir/notes.txt", mode: 0o640 }] });
          const moved = await sandboxes.readFile(ctx, { ...sb, path: "/tmp/e2e/dir/notes.txt" });
          const existsBefore = await sandboxes.exists(ctx, { ...sb, path: "/tmp/e2e/run.sh" });
          await sandboxes.deleteFile(ctx, { ...sb, path: "/tmp/e2e/run.sh" });
          const existsAfter = await sandboxes.exists(ctx, { ...sb, path: "/tmp/e2e/run.sh" });
          await sandboxes.deleteFile(ctx, { ...sb, path: "/tmp/e2e", recursive: true });
          const gone = await sandboxes.exists(ctx, { ...sb, path: "/tmp/e2e" });
          return {
            ok: true,
            value: {
              ran: ran.stdout,
              text: text.text,
              lines: lines.text,
              ranged: Array.from(new Uint8Array(ranged.bytes)),
              wholeLength: whole.sizeBytes,
              wholeMatches: Array.from(new Uint8Array(whole.bytes)).every((b, i) => b === i),
              listed: listed.map((f) => ({ path: f.path, type: f.type, mode: f.mode.toString(8) })),
              infoMode: info[0]?.mode.toString(8),
              found: found.map((f) => f.path),
              replaced,
              moved: moved.text,
              existsBefore,
              existsAfter,
              gone,
            },
          };
        }
        case "endpoint": {
          await sandboxes.spawn(ctx, { ...sb, command: "cd /tmp && echo e2e-page > index.html && python3 -m http.server 8000" });
          await new Promise((resolve) => setTimeout(resolve, 2500));
          const endpoint = await sandboxes.endpoint(ctx, { ...sb, port: 8000 });
          // A key-gated server proxy needs the key: this is what an app's own relay would add.
          const headers: Record<string, string> = { ...endpoint.headers };
          if (endpoint.viaServerProxy) headers["OPEN-SANDBOX-API-KEY"] = process.env.OPENSANDBOX_API_KEY ?? "";
          const response = await fetch(`${endpoint.url}/index.html`, { headers });
          return {
            ok: true,
            value: { url: endpoint.url, viaServerProxy: endpoint.viaServerProxy, status: response.status, body: (await response.text()).trim() },
          };
        }
        case "proxy":
          return { ok: true, value: await proxied.exec(ctx, { ...sb, command: "echo via-proxy" }) };
        case "metrics":
          return { ok: true, value: { metrics: await sandboxes.metrics(ctx, sb), healthy: await sandboxes.isHealthy(ctx, sb) } };
        case "diagnostics":
          return {
            ok: true,
            value: {
              context: await sandboxes.diagnosticContext(ctx, sb),
              logs: await sandboxes.diagnostics(ctx, { ...sb, kind: "logs" }).then((d) => ({ ...d, content: d.content?.slice(0, 200) })),
            },
          };
        case "metadata":
          return { ok: true, value: await sandboxes.patchMetadata(ctx, { ...sb, patch: { stage: "e2e", remove_me: null } }) };
        case "renew":
          return { ok: true, value: await sandboxes.renew(ctx, { ...sb, timeoutSeconds: 1800 }) };
        case "pauseResume": {
          const paused = await sandboxes.pause(ctx, { ...sb, waitSeconds: 120 });
          const blocked = await sandboxes.exec(ctx, { ...sb, command: "true" }).then(() => null, (error) => fail(error));
          const resumed = await sandboxes.resume(ctx, { ...sb, waitSeconds: 120 });
          const after = await sandboxes.exec(ctx, { ...sb, command: "echo back" });
          return { ok: true, value: { paused: paused.state, blocked, resumed: resumed.state, after: after.stdout } };
        }
        case "fork":
          return {
            ok: true,
            value: await sandboxes.fork(ctx, {
              ...sb,
              newKey: `${sb.key}-fork`,
              name: "e2e-fork",
              snapshotTimeoutSeconds: 400,
              options: { timeoutSeconds: 600, readyTimeoutSeconds: 120 },
            }),
          };
        case "sh":
          return { ok: true, value: await sandboxes.exec(ctx, { ...sb, command: String(input.command) }) };
        case "runCode":
          return { ok: true, value: await sandboxes.runCode(ctx, { ...sb, code: input?.code ?? "x = 21\nprint('hi')\nx * 2" }) };
        case "rawCode": {
          const endpoint = await sandboxes.endpoint(ctx, { ...sb, port: 44772 });
          const headers: Record<string, string> = { ...endpoint.headers, "content-type": "application/json", accept: "text/event-stream" };
          if (endpoint.viaServerProxy) headers["OPEN-SANDBOX-API-KEY"] = process.env.OPENSANDBOX_API_KEY ?? "";
          const response = await fetch(`${endpoint.url}/code`, {
            method: "POST",
            headers,
            body: JSON.stringify({ code: "print('hi')\n6*7", context: { language: "python" } }),
          });
          return { ok: true, value: { status: response.status, type: response.headers.get("content-type"), body: (await response.text()).slice(0, 3000) } };
        }
        case "networkPolicy":
          return { ok: true, value: await sandboxes.getNetworkPolicy(ctx, sb) };
        case "network": {
          const probe = (host: string) =>
            sandboxes.exec(ctx, {
              ...sb,
              timeoutMs: 20_000,
              command: `python3 -c "import urllib.request,sys; urllib.request.urlopen('https://${host}', timeout=8); print('ok')" 2>&1 | tail -1`,
            });
          const policy = await sandboxes.getNetworkPolicy(ctx, sb);
          const allowed = await probe("pypi.org");
          const denied = await probe("example.com");
          const patched = await sandboxes.patchNetworkRules(ctx, { ...sb, rules: [{ action: "allow", target: "example.com" }] });
          const nowAllowed = await probe("example.com");
          const removed = await sandboxes.deleteNetworkRules(ctx, { ...sb, targets: ["example.com"] });
          const deniedAgain = await probe("example.com");
          return {
            ok: true,
            value: {
              policy,
              allowed: allowed.stdout.trim(),
              denied: denied.stdout.trim(),
              patchedTargets: patched.policy?.egress.map((rule) => rule.target),
              nowAllowed: nowAllowed.stdout.trim(),
              removedTargets: removed.policy?.egress.map((rule) => rule.target),
              deniedAgain: deniedAgain.stdout.trim(),
            },
          };
        }
        case "history":
          return { ok: true, value: (await sandboxes.listExecutions(ctx, { ...sb, limit: 5 })).map((e) => ({ kind: e.kind, status: e.status, stored: e.stdout !== undefined })) };
        case "reconcile":
          return { ok: true, value: await sandboxes.reconcile(ctx, { ownerId: sb.ownerId }) };
        case "destroy":
          return { ok: true, value: await sandboxes.destroy(ctx, sb) };
        default:
          return { ok: false, code: "unknown_check", message: name };
      }
    } catch (error) {
      return fail(error);
    }
  },
});

export const snapshots = internalQuery({
  args: { ownerId: v.string() },
  handler: async (ctx, args) => await sandboxes.listSnapshots(ctx, args),
});

export const deleteSnapshots = internalAction({
  args: { ownerId: v.string() },
  handler: async (ctx, args) => {
    for (const snapshot of await sandboxes.listSnapshots(ctx, args)) {
      await sandboxes.deleteSnapshot(ctx, { ownerId: args.ownerId, snapshotId: snapshot.snapshotId }).catch(() => null);
    }
    return null;
  },
});

export const purge = internalMutation({
  args: { ownerId: v.string() },
  handler: async (ctx, args) => await sandboxes.purgeExecutions(ctx, { ownerId: args.ownerId, olderThanMs: 0 }),
});
