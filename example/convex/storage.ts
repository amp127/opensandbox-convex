// Move files between this app's Convex file storage and a sandbox. The bytes
// travel Convex → sandbox (or back) inside actions, never through the caller.
//
//   # upload a file in the dashboard's Files tab, then:
//   npx convex run storage:toSandbox '{"ownerId":"me","key":"debian","storageId":"<id>","path":"/root/in/file.bin"}'
//   npx convex run storage:fromSandbox '{"ownerId":"me","key":"debian","path":"/root/in/file.bin"}'
//   npx convex run storage:roundTrip '{"ownerId":"me","key":"debian","sizeBytes":5000000}'
import { v } from "convex/values";
import { OpenSandbox } from "opensandbox-convex";
import { internalAction } from "./_generated/server";
import { components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const sandboxes = new OpenSandbox(components.opensandbox, { useServerProxy: true });
const ref = { ownerId: v.string(), key: v.string() };

async function sha256(blob: Blob): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Storage → sandbox. */
export const toSandbox = internalAction({
  args: { ...ref, storageId: v.id("_storage"), path: v.string(), mode: v.optional(v.number()) },
  handler: async (ctx, args) => await sandboxes.copyFromStorage(ctx, args),
});

/** Sandbox → storage. Returns the new storage id; the file shows up in the dashboard's Files tab. */
export const fromSandbox = internalAction({
  args: { ...ref, path: v.string(), contentType: v.optional(v.string()) },
  handler: async (ctx, args) => await sandboxes.copyToStorage(ctx, args),
});

/**
 * Random bytes → storage → sandbox → storage, checking SHA-256 at both ends
 * and inside the sandbox with sha256sum. Cleans up after itself. The test
 * itself holds the file in memory twice, so keep sizeBytes under ~25 MB here;
 * the transfers stream and are not limited that way.
 */
export const roundTrip = internalAction({
  args: { ...ref, sizeBytes: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const size = args.sizeBytes ?? 1_000_000;
    const bytes = new Uint8Array(size);
    for (let offset = 0; offset < size; offset += 65_536) {
      crypto.getRandomValues(bytes.subarray(offset, Math.min(size, offset + 65_536)));
    }
    const original = new Blob([bytes]);
    const originalHash = await sha256(original);
    const path = `/tmp/storage-roundtrip-${Date.now()}.bin`;
    const timings: Record<string, number> = {};
    let started = Date.now();

    const sourceId: Id<"_storage"> = await ctx.storage.store(original);
    timings.store = Date.now() - started;

    started = Date.now();
    const sent = await sandboxes.copyFromStorage(ctx, { ownerId: args.ownerId, key: args.key, storageId: sourceId, path });
    timings.toSandbox = Date.now() - started;

    const inside = await sandboxes.exec(ctx, { ownerId: args.ownerId, key: args.key, command: `sha256sum ${path} | cut -d' ' -f1` });

    started = Date.now();
    const back = await sandboxes.copyToStorage(ctx, { ownerId: args.ownerId, key: args.key, path });
    timings.fromSandbox = Date.now() - started;

    const returned = await ctx.storage.get(back.storageId as Id<"_storage">);
    const returnedHash = returned ? await sha256(returned) : "missing";

    await sandboxes.deleteFile(ctx, { ownerId: args.ownerId, key: args.key, path });
    await ctx.storage.delete(sourceId);
    await ctx.storage.delete(back.storageId as Id<"_storage">);

    const hashes = { original: originalHash, insideSandbox: inside.stdout.trim(), storedAgain: returnedHash };
    const sizes = { original: size, sentToSandbox: sent.sizeBytes, readBack: back.sizeBytes };
    return { identical: new Set(Object.values(hashes)).size === 1, hashes, sizes, timingsMs: timings };
  },
});

/**
 * Large-file check that never holds the file in a Convex function: make
 * random bytes in the sandbox, stream them to storage, stream them back to a
 * new path, and compare sha256sum of both inside the sandbox.
 */
export const bigRoundTrip = internalAction({
  args: { ...ref, sizeMB: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const sb = { ownerId: args.ownerId, key: args.key };
    const mb = args.sizeMB ?? 200;
    const a = `/tmp/big-${Date.now()}.bin`;
    const b = `${a}.back`;
    await sandboxes.exec(ctx, { ...sb, command: `head -c ${mb}M /dev/urandom > ${a}`, timeoutMs: 120_000 });
    let started = Date.now();
    const stored = await sandboxes.copyToStorage(ctx, { ...sb, path: a });
    const toStorageMs = Date.now() - started;
    started = Date.now();
    const back = await sandboxes.copyFromStorage(ctx, { ...sb, storageId: stored.storageId, path: b });
    const toSandboxMs = Date.now() - started;
    const sums = await sandboxes.exec(ctx, { ...sb, command: `sha256sum ${a} ${b} | cut -d' ' -f1; rm -f ${a} ${b}`, timeoutMs: 120_000 });
    await ctx.storage.delete(stored.storageId as Id<"_storage">);
    const [first, second] = sums.stdout.trim().split("\n");
    return {
      sizeBytes: stored.sizeBytes,
      identical: first === second && back.sizeBytes === stored.sizeBytes,
      sha256: first,
      toStorage: { ms: toStorageMs, MBps: Math.round((mb / toStorageMs) * 1000 * 10) / 10 },
      toSandbox: { ms: toSandboxMs, MBps: Math.round((mb / toSandboxMs) * 1000 * 10) / 10 },
    };
  },
});
