# Persistent sandboxes

Sandboxes are disposable by default: they expire after 10 minutes, and nothing in them outlives them. This guide shows how to keep a sandbox, and its data, for as long as you want: a personal Debian box, a per-user workspace, or an agent's long-running project.

The recipes were run against `opensandbox/server:release-1.2.0` on the Docker runtime. Kubernetes differences are noted where they matter.

## What survives what

Persistence comes in four layers. Pick the ones you need.

| Layer | How to get it | Survives `pause` | Survives `destroy` / expiry | Survives a host or Docker restart |
| --- | --- | --- | --- | --- |
| Container filesystem (installed packages, `/etc`, `/usr`) | always there | ✔ | ✘ | ✘ |
| Memory and running processes | always there | ✔ | ✘ | ✘ |
| Named volume (`volumes[].pvc`) | mount one, e.g. at `/root` | ✔ | ✔ | ✔ |
| Snapshot (full filesystem image) | `snapshot` | n/a | ✔ | ✔ |

Two facts drive everything below:

- **OpenSandbox does not restart containers.** After a host or Docker restart, the sandbox is gone and `refresh` reports `Terminated`. Whatever lived only in the container is lost. Keep data on a volume, and keep installed software in a snapshot.
- **Snapshots do not include volumes.** A snapshot captures the container filesystem; mounted volumes stay where they are. Restore from the snapshot and mount the same volume again to get both back.

## 1. A sandbox that never expires

`timeoutSeconds: null` turns expiry off. The server's `max_sandbox_timeout_seconds` caps only sandboxes that are given a timeout, so `null` is accepted even when a cap is set.

```ts
await sandboxes.create(ctx, {
  ownerId,
  key: "debian",
  image: "debian:trixie",
  timeoutSeconds: null,                       // no expiry
  resourceLimits: { cpu: "2", memory: "4Gi" },
  metadata: { persist: "true" },              // lets sweep spare it (recipe 5)
});
```

From the command line, with no app code at all:

```sh
npx convex run --component opensandbox sandboxes:create '{
  "ownerId": "me", "key": "debian", "image": "debian:trixie",
  "timeoutSeconds": null, "resourceLimits": {"cpu": "2", "memory": "4Gi"},
  "metadata": {"persist": "true"}, "useServerProxy": true
}'
```

It runs until you `destroy` it or the host restarts. Calling `create` again with the same key returns the same sandbox, and resumes it if it is paused, so `create` doubles as "get me my box".

## 2. A home directory that survives everything

Mount a named volume over the directories that matter. On Docker, `pvc` means a Docker named volume, created on first use.

```ts
await sandboxes.create(ctx, {
  ownerId,
  key: "debian",
  image: "debian:trixie",
  timeoutSeconds: null,
  volumes: [
    { name: "home", mountPath: "/root", pvc: { claimName: "me-debian-home" } },
    { name: "projects", mountPath: "/srv/projects", pvc: { claimName: "me-projects" } },
  ],
});
```

Destroy the sandbox, create it again with the same `claimName`, and the files are still there.

**One volume per user.** Volume names must be DNS labels (lowercase letters, digits, `-`; at most 63 characters), and auth subjects are not. Derive the name from a digest:

```ts
async function homeClaim(ownerId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ownerId)));
  return `home-${Array.from(digest.slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const volumes = [{ name: "home", mountPath: "/root", pvc: { claimName: await homeClaim(ownerId) } }];
```

Never let a client choose `claimName`: whoever names a volume can mount it.

**Scratch volumes.** `deleteOnSandboxTermination: true` removes the volume when the sandbox ends, but **only if that sandbox created it**. A volume that already existed is never deleted this way. Remove leftovers on the server with `docker volume rm <name>`.

**Host directories** (`volumes[].host.path`) work too, but only under the server's `[storage] allowed_host_paths`. Prefer named volumes unless you need to see the files from the host.

## 3. Keep installed software with snapshots

Install once, snapshot, and restore from the snapshot whenever the sandbox has to be recreated.

```ts
// Set the box up and capture it.
await sandboxes.exec(ctx, {
  ownerId, key: "debian",
  command: "apt-get update && apt-get install -y git curl build-essential",
  timeoutMs: 300_000,
});
const base = await sandboxes.snapshot(ctx, { ownerId, key: "debian", name: "base", waitSeconds: 300 });
// base.state === "Ready"

// Later: recreate from it, with the same volume.
await sandboxes.destroy(ctx, { ownerId, key: "debian" });
await sandboxes.create(ctx, {
  ownerId,
  key: "debian",
  snapshotId: base.snapshotId,                // instead of image
  timeoutSeconds: null,
  volumes: [{ name: "home", mountPath: "/root", pvc: { claimName: "me-debian-home" } }],
});
// git, curl, and gcc are installed, and /root is as you left it.
```

Command line:

```sh
npx convex run --component opensandbox snapshots:create '{"ownerId":"me","key":"debian","name":"base","waitSeconds":300}'
npx convex run --component opensandbox snapshots:list '{"ownerId":"me","key":"debian"}'
```

Snapshots belong to the owner that took them. Another owner's `create({ snapshotId })` gets `not_found`. On Docker, a snapshot is an image commit and takes a few seconds. On Kubernetes, it needs the server's snapshot support, and pushing the image can take minutes.

**Refresh the snapshot after changes**, and delete the old one:

```ts
const previous = await sandboxes.listSnapshots(ctx, { ownerId, key: "debian" });
const next = await sandboxes.snapshot(ctx, { ownerId, key: "debian", name: "base", waitSeconds: 300 });
for (const old of previous) {
  if (old.snapshotId !== next.snapshotId) await sandboxes.deleteSnapshot(ctx, { ownerId, snapshotId: old.snapshotId });
}
```

**Fork** does snapshot-and-create in one call, for a second copy that leaves the first untouched:

```ts
const { sandbox } = await sandboxes.fork(ctx, { ownerId, key: "debian", newKey: "debian-experiment" });
```

## 4. A self-healing workspace

Put recipes 1 to 3 together in one action that always returns a working box. If the host restarted overnight, it rebuilds from the newest snapshot onto the same volume.

```ts
import { OpenSandbox } from "opensandbox-convex";
import { action } from "./_generated/server";
import { components } from "./_generated/api";

const sandboxes = new OpenSandbox(components.opensandbox, { useServerProxy: true });

export const workspace = action({
  args: {},
  handler: async (ctx) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) throw new Error("Not signed in");
    const ownerId = user.subject;
    const key = "workspace";

    // newest first
    const snapshots = await sandboxes.listSnapshots(ctx, { ownerId, key });
    const base = snapshots.find((s) => s.state === "Ready");

    // Returns the running box, resumes a paused one, or builds a new one.
    return await sandboxes.create(ctx, {
      ownerId,
      key,
      ...(base ? { snapshotId: base.snapshotId } : { image: "debian:trixie" }),
      timeoutSeconds: null,
      metadata: { persist: "true" },
      volumes: [{ name: "home", mountPath: "/root", pvc: { claimName: await homeClaim(ownerId) } }],
    });
  },
});
```

Call `workspace` before every session. When the box is already running, it costs a few fast calls: a row lookup and a status read from OpenSandbox.

## 5. Pause idle boxes instead of paying for them

A paused sandbox keeps memory, processes, and files, but uses no CPU. `create` and `resume` bring it back. `sweep` can pause anything idle and still destroy throwaway sandboxes, skipping the ones marked persistent:

```ts
// convex/crons.ts
crons.interval("sandbox housekeeping", { minutes: 10 }, internal.sandboxes.housekeeping);

// convex/sandboxes.ts
export const housekeeping = internalAction({
  args: {},
  handler: async (ctx) => {
    await sandboxes.sweep(ctx, {
      pauseIdleMs: 30 * 60_000,              // pause after 30 idle minutes
      idleMs: 4 * 60 * 60_000,               // destroy throwaway boxes after 4 hours
      protectMetadata: { persist: "true" },  // ...but never the persistent ones
      deleteTerminatedAfterMs: 7 * 86_400_000,
    });
  },
});
```

"Idle" means no command, code run, or file call through the component for that long. Shell sessions opened directly against execd (a PTY console, for example) do not count, so a box with only a console attached can be paused under you. Use a longer `pauseIdleMs`, or run a command now and then.

`lifecycle.idlePolicy` (server-side auto-pause with wake on access) exists, but only on Kubernetes fast sandboxes with Redis. On Docker it does nothing, so use `sweep`.

## 6. Long-lived, but not forever

When you want a box that stays while it is used and disappears when it is not:

- **Renew from your app:** keep a TTL and extend it on every visit:
  ```ts
  await sandboxes.renew(ctx, { ownerId, key, timeoutSeconds: 3600 }); // expires an hour from now
  ```
- **Renew on access, in the server:** create with `lifecycle: { renewalPolicy: { extendSeconds: 3600 } }`. The server extends the expiry whenever traffic reaches the sandbox through its proxy. This needs `[renew_intent] enabled = true` in the server config.

Either way, keep data on a volume: an expired sandbox is gone, but its volume is not.

## 7. Get a shell in it

```sh
node scripts/console.mjs <sandboxId>
```

This opens an interactive terminal over execd's PTY WebSocket, through the server proxy. It reads `OPENSANDBOX_DOMAIN` and `OPENSANDBOX_API_KEY` from the environment or the Convex deployment. Ctrl-D exits; Ctrl-] detaches and leaves the shell running. Get the sandbox id from `sandboxes.get` or `npx convex run --component opensandbox sandboxes:get '{"ownerId":"me","key":"debian"}'`.

## 8. Move files through Convex storage

Files you upload to Convex storage (from your app, or the dashboard's Files tab) can go into a sandbox, and sandbox files can come back as storage files. The bytes stream between the Convex deployment and the sandbox: no function argument limits, no buffering, up to 1 GiB.

```ts
// storage → sandbox
await sandboxes.copyFromStorage(ctx, { ownerId, key: "debian", storageId, path: "/root/inbox/data.csv" });

// sandbox → storage
const { storageId } = await sandboxes.copyToStorage(ctx, { ownerId, key: "debian", path: "/root/out/report.pdf", contentType: "application/pdf" });
```

The example app's `storage:toSandbox`, `storage:fromSandbox`, `storage:roundTrip`, and `storage:bigRoundTrip` run these from the command line. Measured on the reference setup (local Convex backend, server proxy behind TLS): 500 MB each way in about 50 s, byte-identical.

The data path is your Convex deployment, wherever it runs. With `npx convex dev` and a local backend, that is your own machine and its network connection.

## Command-line cheat sheet

Every component function can be run without app code. Add `"useServerProxy": true` to calls that reach execd when your server is set up as in the [connection guide](connection-guide.md).

```sh
C="npx convex run --component opensandbox"
$C sandboxes:get      '{"ownerId":"me","key":"debian"}'
$C sandboxes:list     '{"ownerId":"me"}'
$C sandboxes:pause    '{"ownerId":"me","key":"debian"}'
$C sandboxes:resume   '{"ownerId":"me","key":"debian","useServerProxy":true}'
$C sandboxes:renew    '{"ownerId":"me","key":"debian","timeoutSeconds":86400}'
$C sandboxes:destroy  '{"ownerId":"me","key":"debian"}'
$C exec:run           '{"ownerId":"me","key":"debian","command":"df -h /root","useServerProxy":true}'
$C snapshots:create   '{"ownerId":"me","key":"debian","name":"base","waitSeconds":300}'
$C snapshots:list     '{"ownerId":"me"}'
$C snapshots:remove   '{"ownerId":"me","snapshotId":"<id>"}'
$C sandboxes:sweep    '{"pauseIdleMs":1800000,"protectMetadata":{"persist":"true"},"dryRun":true}'
```

## Gotchas

- **A host restart ends every sandbox.** Plan for it with recipe 4.
- **Mounting over a directory hides what the image had there.** A fresh volume at `/root` starts empty: no `.bashrc` from the image. Docker copies the image's files into a *new, empty* named volume on first mount; existing volumes are used as they are.
- **The same volume can be mounted by two sandboxes at once.** Nothing locks it. Two writers on one volume is your problem to coordinate.
- **Volumes are not backed up.** Snapshots cover the container, not volumes. Back up volume data from the host (`docker run --rm -v <volume>:/v -v $PWD:/b debian tar czf /b/backup.tgz -C /v .`).
- **`destroy` never deletes a named volume that already existed**, even with `deleteOnSandboxTermination`. Remove it on the server.
