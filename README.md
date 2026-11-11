# OpenSandbox for Convex

Give every user or agent in your Convex app its own [OpenSandbox](https://github.com/alibaba/OpenSandbox) sandbox: an isolated container for commands, code, and files, on Docker or Kubernetes you run yourself. The component drives the OpenSandbox lifecycle API and each sandbox's execd from Convex actions. It keeps sandboxes, snapshots, and command history in tables, so your UI follows them reactively.

- **One sandbox per identity.** Sandboxes are keyed by `(ownerId, key)`. A repeated `create` returns the same sandbox, resuming it if it is paused. A create whose response was lost is found again by a token in its metadata, not duplicated. A create that loses a race with `destroy` deletes what it made.
- **Owner-scoped snapshots.** Snapshot ids are global on the server. The component records which owner took each one, and only that owner can restore, read, or delete it.
- **The API key stays on the server.** It is a component environment variable. It is never written to a table, returned, or put in an error. It is sent only to the lifecycle origin, never to a sandbox.
- **No SDK.** Plain `fetch` in Convex's default runtime. Wire behavior is checked against the upstream server, execd, and SDK sources.

**Connecting to a server:** read [docs/connection-guide.md](docs/connection-guide.md) first. On a public host, execd is unauthenticated, so the guide sets up the server proxy behind TLS.

## Install

```sh
npm install opensandbox-convex
npx convex env set OPENSANDBOX_API_KEY your-key
npx convex env set OPENSANDBOX_DOMAIN https://sandbox.example.com
```

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import { v } from "convex/values";
import opensandbox from "opensandbox-convex/convex.config.js";

const app = defineApp({
  env: {
    OPENSANDBOX_API_KEY: v.string(),
    OPENSANDBOX_DOMAIN: v.string(),
    OPENSANDBOX_PROTOCOL: v.optional(v.string()),
  },
});
app.use(opensandbox, {
  env: {
    OPENSANDBOX_API_KEY: app.env.OPENSANDBOX_API_KEY,
    OPENSANDBOX_DOMAIN: app.env.OPENSANDBOX_DOMAIN,
    OPENSANDBOX_PROTOCOL: app.env.OPENSANDBOX_PROTOCOL,
  },
});
export default app;
```

## Usage

```ts
// convex/sandboxes.ts
import { OpenSandbox } from "opensandbox-convex";
import { v } from "convex/values";
import { action, query } from "./_generated/server";
import { components } from "./_generated/api";

const sandboxes = new OpenSandbox(components.opensandbox, { useServerProxy: true });

async function owner(ctx: { auth: { getUserIdentity(): Promise<{ subject: string } | null> } }) {
  const user = await ctx.auth.getUserIdentity();
  if (!user) throw new Error("Not signed in");
  return user.subject;
}

export const start = action({
  args: {},
  handler: async (ctx) =>
    await sandboxes.create(ctx, { ownerId: await owner(ctx), key: "workspace", image: "python:3.12", timeoutSeconds: 1800 }),
});

export const run = action({
  args: { command: v.string() },
  handler: async (ctx, { command }) =>
    await sandboxes.exec(ctx, { ownerId: await owner(ctx), key: "workspace", command }),
});

export const mine = query({
  args: {},
  handler: async (ctx) => {
    const user = await ctx.auth.getUserIdentity();
    return user ? await sandboxes.get(ctx, { ownerId: user.subject, key: "workspace" }) : null;
  },
});
```

`ownerId` is the only tenant boundary. Derive it from `ctx.auth`, never from a client argument. The component does not check auth itself. Any string works as `ownerId` and `key`: the component labels sandboxes with a digest of them, because OpenSandbox metadata must be label-safe.

### Client options

| Option | Default | Effect |
| --- | --- | --- |
| `useServerProxy` | `false` | Reach execd and preview ports through the lifecycle server instead of each sandbox's published endpoint. Use it whenever the server is on a public network. See the connection guide. |
| `retainOutput` | `false` | Store command text (4 KB) and output (64 KB per stream) on execution rows. Off because output can hold secrets. Return values always carry the output. |

## API

Every sandbox call names a sandbox by `{ ownerId, key }`.

### Lifecycle

| Method | What it does |
| --- | --- |
| `create` | Create, or return the existing sandbox (resumed if paused). Source: `image` (+ `imageAuth`), `snapshotId`, `templateId`, or `extensions.poolRef`. Options: `entrypoint` (default `tail -f /dev/null`), `timeoutSeconds` (default 600; `null` = no expiry), `resourceLimits` (default 1 CPU, 2 Gi), `resourceRequests`, `env`, `metadata`, `platform`, `networkPolicy`, `credentialProxy`, `secureAccess`, `volumes`, `lifecycle` (preStart and periodic hooks, idle auto-pause, renew-on-access), `extensions`. Waits for Running and a healthy execd (`readyTimeoutSeconds`, default 60, max 300). `createRequestTimeoutSeconds` (default 300) covers image pulls. `codeInterpreter` (default: on for images named `*code-interpreter*`) keeps the image's own entrypoint and also waits for Jupyter. |
| `get`, `list`, `listPaginated` | The last observation. Reactive queries. |
| `refresh` | Re-read from OpenSandbox. A sandbox gone from the server becomes `Terminated`. |
| `pause`, `resume` | `waitSeconds` 0 to 300 (default 60). Resume waits for execd again. |
| `renew` | `timeoutSeconds` from now, `additionalSeconds` past the current expiry, or `expiresAt`. |
| `patchMetadata` | JSON merge patch: a string sets a key, `null` removes it. |
| `destroy` | Delete it. The row stays as `Terminated`, and the key can be reused. |
| `fork` | Snapshot `key`, then create `newKey` from the snapshot. |
| `sweep` | Housekeeping for a cron: destroy sandboxes idle longer than `idleMs`, mark expired ones Terminated, delete old Terminated rows. `dryRun` reports only. |
| `reconcile` | Refresh every row for an owner, and list (or `destroyOrphans`) sandboxes the component created for that owner that no row links. |

### Snapshots

`snapshot` (optionally waits for Ready), `getSnapshot`, `listSnapshots`, `refreshSnapshot`, `deleteSnapshot`. Docker snapshots are image commits. Kubernetes snapshots need the server's snapshot support.

### Commands and code

| Method | What it does |
| --- | --- |
| `exec` | Run and wait. `command` is shell text, or an argv array run without a shell. `cwd`, `env`, `uid`/`gid`, `timeoutMs` (default 60 s, max 9 min). A non-zero exit resolves with `status: "failed"` and `exitCode`. A kill at the deadline is `timed_out`. |
| `spawn` | Start in the background. No timeout unless you pass one. |
| `commandStatus` | Status and output. Pass the returned `cursor` back to read only new lines. |
| `kill` | Interrupt a command. |
| `createSession`, `runInSession`, `deleteSession` | A bash shell whose working directory and environment persist between runs. |
| `runCode` | Run code in a Jupyter kernel (`language`, default python). Returns `results` (rich outputs) and `exception`. Needs an image with the code interpreter, such as `opensandbox/code-interpreter`. |
| `createCodeContext`, `listCodeContexts`, `deleteCodeContext`, `interruptCode` | Kernel contexts keep variables between `runCode` calls. |
| `getExecution`, `listExecutions`, `listExecutionsPaginated`, `purgeExecutions` | Run history. Every run gets a row: kind, status, exit code, timing. |

Run status is one of `running`, `succeeded`, `failed`, `timed_out`, `interrupted`, `error` (the run could not start, or the kernel raised outside a cell), or `unknown` (the stream ended without an exit status; the run may still be going).

### Files

| Method | What it does |
| --- | --- |
| `readFile`, `readFileBytes` | Up to 8 MiB. Longer files are cut and `truncated` is set. `offset` reads a byte range; `lines: { fromLine, count }` reads lines. |
| `writeFile`, `writeFiles` | Text or bytes, up to 100 files and 8 MiB per call. Parent directories are created. `mode` is permission bits such as `0o644`; `owner`, `group`. |
| `listFiles` | Directory entries, `depth` 1 to 32. |
| `fileInfo`, `exists`, `searchFiles` | Metadata, existence, glob search. |
| `deleteFile(s)` | Files, or directories with `recursive: true`. |
| `makeDirs`, `moveFiles`, `setPermissions`, `replaceInFiles` | mkdir -p, mv, chmod/chown, find-and-replace with counts. |

`mode` values are real permission bits (`0o755`). The component converts to execd's octal-digit encoding.

### Ingress, network, observability

| Method | What it does |
| --- | --- |
| `endpoint`, `previewUrl` | URL for a port inside the sandbox, plus the headers it requires. `expiresAt` (Unix seconds) asks for a signed route on gateway deployments. The headers can authorize access: hand them to a browser only on purpose. `viaServerProxy: true` means the URL is the lifecycle server's proxy; if your server gates it with the API key (as the connection guide does), relay it through your own backend instead of giving it to a browser. |
| `getNetworkPolicy`, `setNetworkPolicy`, `patchNetworkRules`, `deleteNetworkRules` | Egress allow and deny rules. Needs the server's egress sidecar. |
| `createCredentialVault`, `getCredentialVault`, `patchCredentialVault`, `deleteCredentialVault` | Secrets the egress proxy injects into matching requests, so the sandbox never holds them. Create the sandbox with `credentialProxy: true`. Values are write-only. |
| `metrics`, `isHealthy` | CPU and memory from execd; a ping that never throws. |
| `diagnostics`, `diagnosticContext` | Container logs and runtime events from the server. |

### AI SDK tools

```ts
import { createAiSdkTools } from "opensandbox-convex/ai";

const tools = createAiSdkTools(sandboxes, ctx, {
  ownerId: user.subject,
  key: `thread:${threadId}`,
  create: { image: "python:3.12", timeoutSeconds: 3600 },
  tools: { runCommand: {}, readFile: {}, writeFile: { needsApproval: true }, listFiles: {}, previewUrl: {} },
});
```

Each tool is opt-in, supports `needsApproval`, and creates the sandbox on first use. Install `ai` (v7) to use it.

### Housekeeping

```ts
// convex/crons.ts
crons.interval("sandbox sweep", { minutes: 15 }, internal.sandboxes.sweep);

// convex/sandboxes.ts
export const sweep = internalAction({
  args: {},
  handler: async (ctx) => {
    await sandboxes.sweep(ctx, { idleMs: 60 * 60_000, deleteTerminatedAfterMs: 7 * 86_400_000 });
    await sandboxes.purgeExecutions(ctx, { olderThanMs: 30 * 86_400_000 });
  },
});
```

## Server versions

Checked end to end against `opensandbox/server:release-1.2.0` with `execd:v1.1.0` (Docker runtime, server proxy behind TLS). The component also follows current upstream execd. Differences it handles:

- execd 1.1.x has no `argv`; an argv command is retried once as a shell-quoted string.
- execd 1.1.x sends output one line per event without line endings; the component puts `\n` back. An output whose last line had no newline gains one.
- The code interpreter can send a cell's output after `execution_complete`; code runs read to the end of the stream.

## State

`state` is OpenSandbox's own value: `Pending`, `Running`, `Pausing`, `Paused`, `Resuming`, `Stopping`, `Terminated`, `Failed`. Two more are the component's: `creating` (no id yet) and `error` (create failed before an id was saved). Calls that need execd re-read the sandbox when the stored state is not `Running`, or when execd is unreachable. So a pause or expiry made elsewhere shows up as `not_ready` with the real `state`, not as a network error.

## Errors

Errors are `ConvexError`s. `openSandboxErrorData(error)` returns `{ kind: "OpenSandboxError", code, message, status?, remoteCode?, state?, retryAfterSeconds?, requestId? }`, or null. `isOpenSandboxError(error, "not_found")` checks the code.

| Code | Meaning |
| --- | --- |
| `not_found` | No sandbox (or snapshot) for this owner, or the server has no such resource. |
| `not_ready` | The state does not allow the call. `state` says which. |
| `invalid_argument` | The arguments, or OpenSandbox, rejected the request. |
| `unauthenticated`, `forbidden` | The API key was missing, wrong, or not allowed. |
| `conflict` | OpenSandbox refused the transition, or `destroy` won a race with `create`. |
| `failed` | The sandbox, snapshot, or spawned command ended in failure. |
| `provisioning_timeout` | It did not become ready in time, or another create for this key is in flight. |
| `rate_limited` | Pool capacity or quota. See `retryAfterSeconds`. |
| `timeout`, `unavailable`, `network`, `server_error` | The call did not finish. It may have taken effect. |
| `too_large` | A write was over 8 MiB. |
| `unsupported` | The server does not implement this (for example, no egress sidecar). |
| `invalid_response` | The server answered in an unexpected shape. |
| `config` | `OPENSANDBOX_API_KEY` or `OPENSANDBOX_DOMAIN` is missing or invalid. |

## Not covered

PTY sessions are not covered: they need a WebSocket, which a request-response action cannot hold. Isolated execution sessions and fsb template management are not covered either: they are server-admin features, not per-tenant ones. Use the OpenSandbox API for those.

## Develop

```sh
npm install
npm test          # unit and component tests against a fake server that follows upstream wire behavior
npm run e2e       # against a real server; see docs/connection-guide.md
```

Register the component in [convex-test](https://docs.convex.dev/testing/convex-test) with `opensandbox-convex/test`:

```ts
import { convexTest } from "convex-test";
import opensandboxTest from "opensandbox-convex/test";

const t = convexTest(schema, modules);
opensandboxTest.register(t);
```

Stub `fetch` in tests. The component calls the global `fetch`.

## License

MIT
