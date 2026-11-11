#!/usr/bin/env node
// End-to-end checks against a real OpenSandbox server, through the example
// app on a running Convex deployment (a local `npx convex dev` backend works).
//
//   npx convex env set OPENSANDBOX_API_KEY ...   # on the deployment
//   npx convex env set OPENSANDBOX_DOMAIN ...
//   npm run build && npx convex dev --once
//   npm run e2e
//
// Optional: E2E_IMAGE (default python:3.12-slim), E2E_CODE_IMAGE (an image
// with the code interpreter; skipped when unset), E2E_SKIP=fork,proxy,...
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

function envLocal() {
  try {
    return Object.fromEntries(
      readFileSync(".env.local", "utf8")
        .split("\n")
        .filter((line) => /^[A-Z_]+=/.test(line))
        .map((line) => line.split(/=(.*)/s).slice(0, 2)),
    );
  } catch {
    return {};
  }
}

function localAdminKey() {
  try {
    return JSON.parse(readFileSync(".convex/local/default/config.json", "utf8")).adminKey;
  } catch {
    return undefined;
  }
}

const convexUrl = process.env.CONVEX_URL ?? envLocal().CONVEX_URL;
assert(convexUrl, "CONVEX_URL is not set");
const adminKey = process.env.CONVEX_ADMIN_KEY ?? localAdminKey();
assert(adminKey, "CONVEX_ADMIN_KEY is not set and no local backend was found");
const image = process.env.E2E_IMAGE ?? "python:3.12-slim";
const codeImage = process.env.E2E_CODE_IMAGE;
// E2E_PROXY=1: reach execd through the lifecycle server (the recommended public-IP setup).
const proxy = process.env.E2E_PROXY === "1";
const skip = new Set((process.env.E2E_SKIP ?? "").split(",").filter(Boolean));

const http = new ConvexHttpClient(convexUrl);
http.setAdminAuth(adminKey);
const api = anyApi;
const runId = Date.now().toString(36);
// Deliberately not a valid label value: the component must cope.
const ownerId = `e2e|${runId}|user with spaces`;
const key = "main";

const results = [];
async function step(name, fn) {
  if (skip.has(name)) {
    results.push({ name, outcome: "skipped" });
    console.log(`- ${name}: skipped`);
    return;
  }
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, outcome: "pass", ms: Date.now() - started });
    console.log(`✓ ${name} (${Date.now() - started} ms)${detail ? `  ${detail}` : ""}`);
  } catch (error) {
    results.push({ name, outcome: "FAIL", ms: Date.now() - started, error: error.message });
    console.log(`✗ ${name} (${Date.now() - started} ms)\n    ${error.message.split("\n").join("\n    ")}`);
  }
}

async function check(name, input, k = key) {
  const result = await http.action(api.e2e.check, { ownerId, key: k, name, input, proxy });
  if (!result.ok) throw new Error(`${result.code}: ${result.message}${result.state ? ` (state ${result.state})` : ""}`);
  return result.value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log(`OpenSandbox e2e  run=${runId}  image=${image}  path=${proxy ? "server proxy" : "direct endpoints"}  convex=${convexUrl}\n`);

let created = false;
await step("create", async () => {
  const result = await http.action(api.e2e.create, { ownerId, key, image, proxy, timeoutSeconds: 1800, metadata: { suite: "e2e" } });
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  assert.equal(result.sandbox.state, "Running");
  assert.deepEqual(result.sandbox.metadata, { suite: "e2e" });
  created = true;
  return `sandbox ${result.sandbox.sandboxId}`;
});

if (!created) {
  console.log("\nCreate failed; nothing else can run.");
  process.exit(1);
}

await step("create is idempotent", async () => {
  const before = await http.query(api.e2e.get, { ownerId, key });
  const again = await http.action(api.e2e.create, { ownerId, key, image, proxy });
  assert.equal(again.ok, true);
  assert.equal(again.sandbox.sandboxId, before.sandboxId);
});

await step("exec", async () => {
  const r = await check("exec");
  assert.equal(r.status, "succeeded");
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, "hello\nLinux\n");
  assert.equal(r.stderr, "oops\n");
  return `${r.durationMs} ms`;
});

await step("exec non-zero exit", async () => {
  const r = await check("execFail");
  assert.equal(r.status, "failed");
  assert.equal(r.exitCode, 7);
  assert.equal(r.stdout, "before\n");
});

await step("exec argv (no shell)", async () => {
  const r = await check("execArgv");
  // execd 1.1.x frames output by line and drops line endings, so an
  // unterminated last line comes back with "\n" added.
  assert.equal(r.stdout.replace(/\n$/, ""), "a b|c'd|");
});

await step("exec env and cwd", async () => {
  const r = await check("execEnvCwd");
  assert.equal(r.stdout, "hi there\n/tmp\n");
});

await step("exec timeout", async () => {
  const r = await check("execTimeout");
  assert.equal(r.status, "timed_out", JSON.stringify(r));
  assert.ok(r.durationMs < 20_000);
});

await step("exec large output is capped, not fatal", async () => {
  const r = await check("execBigOutput");
  assert.equal(r.outputTruncated, true);
  return `${r.status}, ${r.stdout}`;
});

await step("spawn + incremental logs", async () => {
  const spawned = await check("spawn");
  assert.equal(spawned.status, "running");
  assert.ok(spawned.commandId);
  await sleep(1500);
  const first = await check("status", { commandId: spawned.commandId });
  await sleep(3000);
  const last = await check("status", { commandId: spawned.commandId, cursor: first.cursor });
  assert.equal(last.running, false);
  assert.equal(last.status, "succeeded");
  assert.match(first.output + last.output, /tick 1[\s\S]*tick 3/);
  return `cursor ${first.cursor} -> ${last.cursor}`;
});

await step("kill", async () => {
  const r = await check("kill");
  assert.equal(r.running, false, JSON.stringify(r));
  return r.status;
});

await step("bash session keeps state", async () => {
  const r = await check("session");
  assert.equal(r.stdout, "/var\npersisted\n");
});

await step("files", async () => {
  const r = await check("files");
  assert.equal(r.ran.split("\n")[0], "ran");
  assert.match(r.ran, /755 \/tmp\/e2e\/run\.sh/);
  assert.match(r.ran, /600 \/tmp\/e2e\/bin\.dat/);
  assert.match(r.ran, /750 \/tmp\/e2e\/dir/);
  assert.equal(r.text, "alpha\nbeta\ngamma\n");
  assert.equal(r.lines.trim(), "beta");
  assert.deepEqual(r.ranged, [10, 11, 12, 13, 14]);
  assert.equal(r.wholeLength, 256);
  assert.equal(r.wholeMatches, true);
  assert.equal(r.infoMode, "755");
  assert.deepEqual(r.found, ["/tmp/e2e/notes.txt"]);
  assert.equal(r.moved, "alpha\nBETA\ngamma\n");
  assert.equal(r.existsBefore, true);
  assert.equal(r.existsAfter, false);
  assert.equal(r.gone, false);
  return `replace -> ${JSON.stringify(r.replaced)}`;
});

await step("endpoint (preview URL reachable from Convex)", async () => {
  const r = await check("endpoint");
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.body, "e2e-page");
  return `${r.url}${r.viaServerProxy ? " (server proxy)" : ""}`;
});

await step("server proxy", async () => {
  const r = await check("proxy");
  assert.equal(r.stdout, "via-proxy\n");
});

await step("metrics + health", async () => {
  const r = await check("metrics");
  assert.equal(r.healthy, true);
  assert.ok(r.metrics.cpuCount > 0);
  return `${r.metrics.cpuCount} cpu, ${Math.round(r.metrics.memoryUsedMiB)}/${Math.round(r.metrics.memoryTotalMiB)} MiB`;
});

await step("diagnostics", async () => {
  const r = await check("diagnostics");
  return `${r.context.backendType}, logs ${r.logs.contentType}`;
});

await step("patch metadata", async () => {
  const r = await check("metadata");
  assert.deepEqual(r.metadata, { suite: "e2e", stage: "e2e" });
});

await step("renew", async () => {
  const r = await check("renew");
  assert.ok(Date.parse(r.expiresAt) > Date.now() + 1_700_000);
});

await step("network policy: no sidecar is reported clearly", async () => {
  const result = await http.action(api.e2e.check, { ownerId, key, name: "networkPolicy", proxy });
  assert.equal(result.ok, false);
  assert.equal(result.code, "unsupported", result.message);
});

await step("network policy: enforce, patch, delete", async () => {
  const made = await http.action(api.e2e.create, {
    ownerId,
    key: "net",
    image,
    proxy,
    timeoutSeconds: 900,
    networkPolicy: { defaultAction: "deny", egress: [{ action: "allow", target: "pypi.org" }] },
  });
  if (!made.ok) throw new Error(`${made.code}: ${made.message}`);
  try {
    const r = await check("network", undefined, "net");
    assert.equal(r.allowed, "ok", JSON.stringify(r));
    assert.notEqual(r.denied, "ok", JSON.stringify(r));
    assert.ok(r.patchedTargets.includes("example.com"), JSON.stringify(r));
    assert.equal(r.nowAllowed, "ok", JSON.stringify(r));
    assert.ok(!r.removedTargets.includes("example.com"), JSON.stringify(r));
    assert.notEqual(r.deniedAgain, "ok", JSON.stringify(r));
    return `${r.policy.mode ?? ""} ${r.policy.enforcementMode ?? ""}`.trim();
  } finally {
    await check("destroy", undefined, "net").catch(() => null);
  }
});

await step("pause + resume", async () => {
  const r = await check("pauseResume");
  assert.equal(r.paused, "Paused");
  assert.equal(r.blocked?.code, "not_ready");
  assert.equal(r.resumed, "Running");
  assert.equal(r.after, "back\n");
});

await step("fork (snapshot + restore)", async () => {
  const marker = `fork-${runId}`;
  await check("sh", { command: `echo ${marker} > /root/fork-marker.txt || echo ${marker} > /tmp/fork-marker.txt` });
  const f = await check("fork");
  assert.equal(f.sandbox.state, "Running");
  const read = await check("sh", { command: "cat /root/fork-marker.txt 2>/dev/null || cat /tmp/fork-marker.txt" }, `${key}-fork`);
  assert.equal(read.stdout.trim(), marker);
  const snaps = await http.query(api.e2e.snapshots, { ownerId });
  assert.equal(snaps[0].state, "Ready");
  await check("destroy", undefined, `${key}-fork`);
  return `snapshot ${f.snapshotId}`;
});

if (codeImage) {
  await step("code interpreter", async () => {
    const created = await http.action(api.e2e.create, { ownerId, key: "code", image: codeImage, proxy, timeoutSeconds: 900 });
    if (!created.ok) throw new Error(`${created.code}: ${created.message}`);
    const r = await check("runCode", undefined, "code");
    assert.equal(r.status, "succeeded", JSON.stringify(r));
    assert.equal(r.stdout, "hi\n");
    assert.equal(r.results[0]?.text, "42");
    const err = await check("runCode", { code: "1/0" }, "code");
    assert.equal(err.status, "failed");
    assert.equal(err.exception?.name, "ZeroDivisionError");
    await check("destroy", undefined, "code");
  });
} else {
  results.push({ name: "code interpreter", outcome: "skipped" });
  console.log("- code interpreter: skipped (set E2E_CODE_IMAGE)");
}

await step("execution history", async () => {
  const r = await check("history");
  assert.ok(r.length > 0);
  assert.equal(r[0].stored, true);
});

await step("reconcile finds no orphans", async () => {
  const r = await check("reconcile");
  assert.deepEqual(r.orphans, []);
  return `${r.refreshed.length} refreshed`;
});

await step("destroy", async () => {
  const r = await check("destroy");
  assert.equal(r.state, "Terminated");
  const after = await http.action(api.e2e.check, { ownerId, key, name: "exec", proxy });
  assert.equal(after.ok, false);
  assert.equal(after.code, "not_ready");
});

await http.action(api.e2e.deleteSnapshots, { ownerId }).catch(() => null);
await http.mutation(api.e2e.purge, { ownerId }).catch(() => null);

const failed = results.filter((r) => r.outcome === "FAIL");
console.log(`\n${results.filter((r) => r.outcome === "pass").length} passed, ${failed.length} failed, ${results.filter((r) => r.outcome === "skipped").length} skipped`);
process.exit(failed.length > 0 ? 1 : 0);
