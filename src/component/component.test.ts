import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import { errorData } from "./errors.js";
import { initConvexTest } from "../setup.js";
import { API_KEY, FakeOpenSandbox } from "../testing/fakeOpenSandbox.js";

// A Convex Auth subject: has `|` and is longer than a label value allows.
const OWNER = "jd7a2kq9x0m3h5tq8w1v2r4c6n9p8s7f|kh2b4n6m8q0r2t4v6x8z0a2c4e6g8i0k";
const KEY = "main";
const ref = { ownerId: OWNER, key: KEY };

let fake: FakeOpenSandbox;

beforeEach(() => {
  fake = new FakeOpenSandbox().install();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
  } catch (error) {
    expect(errorData(error)?.code).toBe(code);
    return errorData(error);
  }
  throw new Error(`Expected ${code}, but the call succeeded.`);
}

async function created() {
  const t = initConvexTest();
  const sandbox = await t.action(api.sandboxes.create, { ...ref, image: "python:3.12" });
  return { t, sandbox };
}

describe("create", () => {
  test("works for an owner id that is not a valid label, and never sends it raw", async () => {
    const { sandbox } = await created();
    expect(sandbox.state).toBe("Running");
    expect(sandbox.sandboxId).toBe("sbx_1");
    const post = fake.only("POST", "/v1/sandboxes")[0]!;
    const metadata = (post.body as { metadata: Record<string, string> }).metadata;
    expect(Object.values(metadata).join(" ")).not.toContain("|");
    expect(JSON.stringify(post.body)).not.toContain(OWNER);
    expect(post.headers["open-sandbox-api-key"]).toBe(API_KEY);
    // The health check went to the ingress with the route header, not the key.
    expect(fake.only("GET", "/ping")).toHaveLength(1);
  });

  test("is idempotent per key and does not leak the API key into rows", async () => {
    const { t } = await created();
    await t.action(api.sandboxes.create, { ...ref, image: "python:3.12" });
    expect(fake.only("POST", "/v1/sandboxes")).toHaveLength(1);
    const rows = await t.query(api.sandboxes.list, { ownerId: OWNER });
    expect(JSON.stringify(rows)).not.toContain(API_KEY);
  });

  test("waits through Pending", async () => {
    fake.pendingReads = 3;
    const { sandbox } = await created();
    expect(sandbox.state).toBe("Running");
  });

  test("a lost create response is recovered by token, not duplicated", async () => {
    fake.loseNextCreateResponse = true;
    const { sandbox } = await created();
    expect(sandbox.sandboxId).toBe("sbx_1");
    expect(fake.sandboxes.size).toBe(1);
  });

  test("resumes a paused sandbox", async () => {
    const { t } = await created();
    fake.sandboxes.get("sbx_1")!.state = "Paused";
    const again = await t.action(api.sandboxes.create, { ...ref, image: "python:3.12" });
    expect(again.state).toBe("Running");
    expect(fake.only("POST", "/resume")).toHaveLength(1);
  });

  test("refuses a snapshot this owner does not own", async () => {
    const t = initConvexTest();
    await expectCode(t.action(api.sandboxes.create, { ...ref, snapshotId: "snap_other" }), "not_found");
    expect(fake.only("POST", "/v1/sandboxes")).toHaveLength(0);
  });

  test("rejects metadata the server would reject, before calling it", async () => {
    const t = initConvexTest();
    await expectCode(t.action(api.sandboxes.create, { ...ref, image: "x", metadata: { team: "a b" } }), "invalid_argument");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("lifecycle", () => {
  test("pause and resume", async () => {
    const { t } = await created();
    expect((await t.action(api.sandboxes.pause, ref)).state).toBe("Paused");
    expect((await t.action(api.sandboxes.resume, ref)).state).toBe("Running");
  });

  test("exec refreshes a stale row instead of failing on it", async () => {
    const { t } = await created();
    fake.sandboxes.get("sbx_1")!.state = "Paused";
    const error = await expectCode(t.action(api.exec.run, { ...ref, command: "true" }), "not_ready");
    expect(error?.state).toBe("Paused");
    expect((await t.query(api.sandboxes.get, ref))?.state).toBe("Paused");
  });

  test("renew additionalSeconds refuses a sandbox with no expiration", async () => {
    const t = initConvexTest();
    await t.action(api.sandboxes.create, { ...ref, image: "x", timeoutSeconds: null });
    await expectCode(t.action(api.sandboxes.renew, { ...ref, additionalSeconds: 60 }), "invalid_argument");
    const renewed = await t.action(api.sandboxes.renew, { ...ref, timeoutSeconds: 3600 });
    expect(Date.parse(renewed.expiresAt!)).toBeGreaterThan(Date.now() + 3_500_000);
  });

  test("destroy marks Terminated, and the key can be reused", async () => {
    const { t } = await created();
    expect((await t.action(api.sandboxes.destroy, ref)).state).toBe("Terminated");
    expect(fake.sandboxes.size).toBe(0);
    const next = await t.action(api.sandboxes.create, { ...ref, image: "x" });
    expect(next.sandboxId).toBe("sbx_2");
  });

  test("a sandbox deleted elsewhere is marked Terminated on refresh", async () => {
    const { t } = await created();
    fake.sandboxes.delete("sbx_1");
    expect((await t.action(api.sandboxes.refresh, ref)).state).toBe("Terminated");
  });

  test("patchMetadata merges and hides the component's keys", async () => {
    const { t } = await created();
    const patched = await t.action(api.sandboxes.patchMetadata, { ...ref, patch: { team: "infra" } });
    expect(patched.metadata).toEqual({ team: "infra" });
    await expectCode(t.action(api.sandboxes.patchMetadata, { ...ref, patch: { "convex-owner": null } }), "invalid_argument");
  });

  test("reconcile finds a sandbox for this owner that no row links", async () => {
    const { t } = await created();
    await t.action(api.sandboxes.destroy, ref);
    // A create that crashed before linking leaves a sandbox carrying the owner digest.
    const orphan = { ...fake.sandboxes.get("sbx_1") };
    await t.action(api.sandboxes.create, { ownerId: OWNER, key: "other", image: "x" });
    const owned = fake.sandboxes.get("sbx_2")!;
    fake.sandboxes.set("sbx_9", { ...owned, id: "sbx_9", metadata: { ...owned.metadata, "convex-token": "lost" } });
    void orphan;
    const result = await t.action(api.sandboxes.reconcile, { ownerId: OWNER, destroyOrphans: true });
    expect(result.orphans).toEqual([{ sandboxId: "sbx_9", state: "Running", destroyed: true }]);
    expect(fake.sandboxes.has("sbx_9")).toBe(false);
    expect(fake.sandboxes.has("sbx_2")).toBe(true);
  });

  test("sweep destroys idle sandboxes", async () => {
    const { t } = await created();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * 3_600_000);
    const result = await t.action(api.sandboxes.sweep, { idleMs: 3_600_000 });
    vi.useRealTimers();
    expect(result.destroyed).toEqual([{ ownerId: OWNER, key: KEY, reason: "idle" }]);
    expect((await t.query(api.sandboxes.get, ref))?.state).toBe("Terminated");
  });
});

describe("commands", () => {
  test("exec parses execd's stream and records an execution", async () => {
    const { t } = await created();
    const result = await t.action(api.exec.run, { ...ref, command: "echo ok" });
    expect(result).toMatchObject({ status: "succeeded", exitCode: 0, stdout: "ok\n", commandId: "cmd_1" });
    const history = await t.query(api.executions.list, ref);
    expect(history[0]).toMatchObject({ status: "succeeded", kind: "exec" });
    expect(history[0]?.stdout).toBeUndefined();
    expect((await t.query(api.sandboxes.get, ref))?.lastActiveAt).toBeTypeOf("number");
  });

  test("a non-zero exit resolves as failed with its exit code", async () => {
    const { t } = await created();
    fake.commands.set("false", {
      events: [
        { type: "init", text: "cmd_2" },
        { type: "stderr", text: "nope\n" },
        { type: "error", error: { ename: "CommandExecError", evalue: "1", traceback: ["exit status 1"] } },
      ],
    });
    const result = await t.action(api.exec.run, { ...ref, command: "false", retainOutput: true });
    expect(result).toMatchObject({ status: "failed", exitCode: 1, stderr: "nope\n" });
    expect(result.error).toBeUndefined();
    expect((await t.query(api.executions.list, ref))[0]?.stderr).toBe("nope\n");
  });

  test("argv is sent as argv, and env/uid pass through", async () => {
    const { t } = await created();
    await t.action(api.exec.run, { ...ref, command: ["ls", "-la"], env: { A: "1" }, uid: 1000, gid: 1000 });
    const body = fake.only("POST", "/command").at(-1)!.body;
    expect(body).toMatchObject({ argv: ["ls", "-la"], envs: { A: "1" }, uid: 1000, gid: 1000, timeout: 60000 });
  });

  test("spawn sends no timeout unless asked, and status reads logs with a cursor", async () => {
    const { t } = await created();
    const spawned = await t.action(api.exec.spawn, { ...ref, command: "python -m http.server" });
    expect(spawned).toMatchObject({ status: "running", commandId: "cmd_bg" });
    expect(fake.only("POST", "/command").at(-1)!.body).not.toHaveProperty("timeout");
    fake.commands.set("bg", { status: { running: false, exit_code: 0 }, logs: "serving\n" });
    const state = await t.action(api.exec.status, { ...ref, commandId: "cmd_bg" });
    expect(state).toMatchObject({ running: false, status: "succeeded", output: "serving\n", cursor: 7 });
    expect((await t.query(api.executions.list, ref))[0]?.status).toBe("succeeded");
  });

  test("execd 1.1.x: argv falls back to a quoted command, and line endings are restored", async () => {
    const { t } = await created();
    fake.legacyExecd = true;
    const result = await t.action(api.exec.run, { ...ref, command: ["printf", "%s|", "a b"] });
    expect(result.status).toBe("succeeded");
    expect(result.stdout).toBe("line one\nline two\n");
    const sent = fake.only("POST", "/command").slice(-2).map((call) => call.body as Record<string, unknown>);
    expect(sent[0]).toHaveProperty("argv");
    expect(sent[1]).toMatchObject({ command: "printf '%s|' 'a b'" });
    expect(sent[1]).not.toHaveProperty("argv");
    // Only one execution row: the rejected attempt is not recorded.
    expect(await t.query(api.executions.list, ref)).toHaveLength(1);
  });

  test("sessions keep a shell", async () => {
    const { t } = await created();
    const { sessionId } = await t.action(api.exec.createSession, { ...ref, cwd: "/tmp" });
    const result = await t.action(api.exec.runInSession, { ...ref, sessionId, command: "pwd" });
    expect(result).toMatchObject({ status: "succeeded", stdout: "/tmp\n" });
  });

  test("runCode returns rich results", async () => {
    const { t } = await created();
    const result = await t.action(api.code.run, { ...ref, code: "print('hi'); 1+1" });
    expect(result).toMatchObject({ status: "succeeded", stdout: "hi\n", results: [{ text: "2" }], executionCount: 1 });
  });
});

describe("files", () => {
  test("write sends octal-digit modes and filenames; read returns bytes or text", async () => {
    const { t } = await created();
    await t.action(api.files.write, { ...ref, files: [{ path: "/w/a.sh", content: "#!/bin/sh\n", mode: 0o755 }] });
    expect(fake.sandboxes.get("sbx_1")!.files.get("/w/a.sh")!.mode).toBe(755);
    const text = await t.action(api.files.read, { ...ref, path: "/w/a.sh", encoding: "text" });
    expect(text).toMatchObject({ text: "#!/bin/sh\n", truncated: false, sizeBytes: 10 });
    const cut = await t.action(api.files.read, { ...ref, path: "/w/a.sh", maxBytes: 4 });
    expect(cut.truncated).toBe(true);
    expect(new Uint8Array(cut.bytes!)).toHaveLength(4);
    const listed = await t.action(api.files.list, { ...ref, path: "/w" });
    expect(listed[0]).toMatchObject({ path: "/w/a.sh", mode: 0o755, size: 10 });
  });

  test("endpoint returns the route and its headers", async () => {
    const { t } = await created();
    const endpoint = await t.action(api.files.endpoint, { ...ref, port: 8000 });
    expect(endpoint).toEqual({
      url: "https://ingress.example.com/sandboxes/sbx_1/port/8000",
      headers: { "OpenSandbox-Ingress-To": "secret-route" },
      port: 8000,
      viaServerProxy: false,
    });
  });
});

describe("snapshots and fork", () => {
  test("snapshot, then fork into a new key from it", async () => {
    const { t } = await created();
    fake.snapshotReadsUntilReady = 2;
    const forked = await t.action(api.sandboxes.fork, { ...ref, newKey: "copy", name: "cp" });
    expect(forked.sandbox).toMatchObject({ key: "copy", state: "Running", snapshotId: forked.snapshotId });
    const snapshots = await t.query(api.snapshots.list, { ownerId: OWNER });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ state: "Ready", key: KEY, name: "cp" });
    // Another owner cannot see or use it.
    expect(await t.query(api.snapshots.get, { ownerId: "someone-else", snapshotId: forked.snapshotId })).toBeNull();
    await expectCode(
      t.action(api.sandboxes.create, { ownerId: "someone-else", key: "k", snapshotId: forked.snapshotId }),
      "not_found",
    );
    await t.action(api.snapshots.remove, { ownerId: OWNER, snapshotId: forked.snapshotId });
    expect(fake.snapshots.size).toBe(0);
  });
});

describe("history", () => {
  test("purge deletes old executions in batches", async () => {
    const { t } = await created();
    await t.action(api.exec.run, { ...ref, command: "echo ok" });
    await t.action(api.exec.run, { ...ref, command: "echo ok" });
    const first = await t.mutation(api.executions.purge, { ownerId: OWNER, olderThanMs: 0, limit: 1 });
    expect(first).toEqual({ deleted: 1, hasMore: true });
    const second = await t.mutation(api.executions.purge, { olderThanMs: 0 });
    expect(second).toEqual({ deleted: 1, hasMore: false });
  });
});
