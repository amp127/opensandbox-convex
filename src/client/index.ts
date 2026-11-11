/**
 * Host-facing client for the OpenSandbox component.
 *
 * ```ts
 * import { OpenSandbox } from "opensandbox-convex";
 * import { components } from "./_generated/api";
 * const sandboxes = new OpenSandbox(components.opensandbox);
 * ```
 *
 * The API key stays in the component env. Pass an ownerId your server derived
 * from the signed-in user, never from a client argument: it is the only
 * tenant boundary.
 */
import type { FunctionArgs, FunctionReference, FunctionReturnType, PaginationOptions } from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";
import { errorData, type OpenSandboxErrorCode, type OpenSandboxErrorData } from "../component/errors.js";

export type { OpenSandboxErrorCode, OpenSandboxErrorData } from "../component/errors.js";

type Api = ComponentApi;
type Args<F extends FunctionReference<"query" | "mutation" | "action", "internal">> = FunctionArgs<F>;
type Ret<F extends FunctionReference<"query" | "mutation" | "action", "internal">> = FunctionReturnType<F>;

export type Sandbox = NonNullable<Ret<Api["sandboxes"]["get"]>>;
export type Snapshot = NonNullable<Ret<Api["snapshots"]["get"]>>;
export type Execution = NonNullable<Ret<Api["executions"]["get"]>>;
export type RunResult = Ret<Api["exec"]["run"]>;
export type CodeResult = Ret<Api["code"]["run"]>;
export type CommandState = Ret<Api["exec"]["status"]>;
export type FileInfo = Ret<Api["files"]["list"]>[number];
export type SandboxEndpoint = Ret<Api["files"]["endpoint"]>;
export type NetworkPolicyStatus = Ret<Api["network"]["getPolicy"]>;
export type CredentialVaultState = Ret<Api["network"]["createVault"]>;
export type SandboxMetrics = Ret<Api["observe"]["metrics"]>;
export type SweepResult = Ret<Api["sandboxes"]["sweep"]>;
export type ReconcileResult = Ret<Api["sandboxes"]["reconcile"]>;

type CreateArgs = Args<Api["sandboxes"]["create"]>;
export type CreateSandboxArgs = CreateArgs;
export type NetworkRule = Args<Api["network"]["patchRules"]>["rules"][number];
export type NetworkPolicy = Args<Api["network"]["replacePolicy"]>["policy"];

/** Read the structured data of an error thrown by this component, or null. */
export function openSandboxErrorData(error: unknown): OpenSandboxErrorData | null {
  return errorData(error);
}

/** True when the error came from this component, optionally with one of these codes. */
export function isOpenSandboxError(error: unknown, ...codes: OpenSandboxErrorCode[]): boolean {
  const data = errorData(error);
  return data !== null && (codes.length === 0 || codes.includes(data.code));
}

export type RunQueryCtx = {
  runQuery: <Query extends FunctionReference<"query", "internal">>(
    query: Query,
    args: Query["_args"],
  ) => Promise<FunctionReturnType<Query>>;
};
export type RunMutationCtx = RunQueryCtx & {
  runMutation: <Mutation extends FunctionReference<"mutation", "internal">>(
    mutation: Mutation,
    args: Mutation["_args"],
  ) => Promise<FunctionReturnType<Mutation>>;
};
export type RunActionCtx = RunMutationCtx & {
  runAction: <Fn extends FunctionReference<"action", "internal">>(
    action: Fn,
    args: Fn["_args"],
  ) => Promise<FunctionReturnType<Fn>>;
};

export interface SandboxRef {
  ownerId: string;
  key: string;
}

export interface OpenSandboxOptions {
  /**
   * Store the command and its output on the execution row, truncated to 4 KB
   * of input and 64 KB per stream. Off by default: output can hold secrets,
   * and truncation is not redaction. Return values always include the output.
   */
  retainOutput?: boolean;
  /**
   * Reach execd through the lifecycle server's proxy instead of the ingress
   * endpoint. Off by default. Use it when the sandboxes' endpoints are not
   * reachable from the Convex deployment (for example, Docker bridge ports
   * behind a firewall) but the lifecycle server is.
   */
  useServerProxy?: boolean;
}

type Without<T, K extends keyof never> = Omit<T, K | "useServerProxy" | "retainOutput">;

export class OpenSandbox {
  constructor(
    public readonly component: ComponentApi,
    public readonly options: OpenSandboxOptions = {},
  ) {}

  private get proxy() {
    return this.options.useServerProxy === true ? { useServerProxy: true } : {};
  }

  private get retain() {
    return this.options.retainOutput === true ? { retainOutput: true } : {};
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Create the sandbox for this key, or return the one it already has (resuming
   * it when Paused). Waits until it is Running and execd answers.
   */
  async create(ctx: RunActionCtx, args: Without<CreateArgs, never>): Promise<Sandbox> {
    return await ctx.runAction(this.component.sandboxes.create, { ...args, ...this.proxy });
  }

  /** Last observed sandbox, or null. Reactive in queries; no OpenSandbox call. */
  async get(ctx: RunQueryCtx, args: SandboxRef): Promise<Sandbox | null> {
    return await ctx.runQuery(this.component.sandboxes.get, args);
  }

  /** This owner's sandboxes, newest first (default 50, at most 500). */
  async list(
    ctx: RunQueryCtx,
    args: { ownerId: string; limit?: number; includeTerminated?: boolean },
  ): Promise<Sandbox[]> {
    return await ctx.runQuery(this.component.sandboxes.list, args);
  }

  async listPaginated(ctx: RunQueryCtx, args: { ownerId: string; paginationOpts: PaginationOptions }) {
    return await ctx.runQuery(this.component.sandboxes.listPaginated, args);
  }

  /** Re-read the sandbox from OpenSandbox. */
  async refresh(ctx: RunActionCtx, args: SandboxRef): Promise<Sandbox> {
    return await ctx.runAction(this.component.sandboxes.refresh, args);
  }

  /** Pause, keeping memory and files. `waitSeconds` 0 to 300, default 60. */
  async pause(ctx: RunActionCtx, args: SandboxRef & { waitSeconds?: number }): Promise<Sandbox> {
    return await ctx.runAction(this.component.sandboxes.pause, args);
  }

  /** Resume a paused sandbox and wait for execd. */
  async resume(
    ctx: RunActionCtx,
    args: SandboxRef & { waitSeconds?: number; skipHealthCheck?: boolean },
  ): Promise<Sandbox> {
    return await ctx.runAction(this.component.sandboxes.resume, { ...args, ...this.proxy });
  }

  /**
   * Change the expiration: `timeoutSeconds` from now, `additionalSeconds` past
   * the current one, or an absolute `expiresAt` (RFC 3339).
   */
  async renew(
    ctx: RunActionCtx,
    args: SandboxRef & { expiresAt?: string; additionalSeconds?: number; timeoutSeconds?: number },
  ): Promise<Sandbox> {
    return await ctx.runAction(this.component.sandboxes.renew, args);
  }

  /** Delete the sandbox. The row stays as `Terminated`, and the key can be reused. */
  async destroy(ctx: RunActionCtx, args: SandboxRef): Promise<Sandbox> {
    return await ctx.runAction(this.component.sandboxes.destroy, args);
  }

  /** Merge-patch the sandbox's metadata: a string sets a key, null removes it. */
  async patchMetadata(
    ctx: RunActionCtx,
    args: SandboxRef & { patch: Record<string, string | null> },
  ): Promise<Sandbox> {
    return await ctx.runAction(this.component.sandboxes.patchMetadata, args);
  }

  /** Snapshot `key` and start `newKey` from the snapshot. */
  async fork(
    ctx: RunActionCtx,
    args: Without<Args<Api["sandboxes"]["fork"]>, never>,
  ): Promise<{ snapshotId: string; sandbox: Sandbox }> {
    return await ctx.runAction(this.component.sandboxes.fork, { ...args, ...this.proxy });
  }

  /**
   * Destroy idle sandboxes, mark expired ones Terminated, and delete old
   * Terminated rows. Run it from a cron.
   */
  async sweep(ctx: RunActionCtx, args: Args<Api["sandboxes"]["sweep"]> = {}): Promise<SweepResult> {
    return await ctx.runAction(this.component.sandboxes.sweep, args);
  }

  /** Refresh every row for this owner and find (or destroy) unlinked sandboxes on the server. */
  async reconcile(ctx: RunActionCtx, args: { ownerId: string; destroyOrphans?: boolean }): Promise<ReconcileResult> {
    return await ctx.runAction(this.component.sandboxes.reconcile, args);
  }

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------

  /** Take a snapshot. `waitSeconds` (0 to 480, default 0) waits for Ready. */
  async snapshot(ctx: RunActionCtx, args: SandboxRef & { name?: string; waitSeconds?: number }): Promise<Snapshot> {
    return await ctx.runAction(this.component.snapshots.create, args);
  }

  async getSnapshot(ctx: RunQueryCtx, args: { ownerId: string; snapshotId: string }): Promise<Snapshot | null> {
    return await ctx.runQuery(this.component.snapshots.get, args);
  }

  async listSnapshots(ctx: RunQueryCtx, args: { ownerId: string; key?: string; limit?: number }): Promise<Snapshot[]> {
    return await ctx.runQuery(this.component.snapshots.list, args);
  }

  async refreshSnapshot(ctx: RunActionCtx, args: { ownerId: string; snapshotId: string }): Promise<Snapshot> {
    return await ctx.runAction(this.component.snapshots.refresh, args);
  }

  async deleteSnapshot(ctx: RunActionCtx, args: { ownerId: string; snapshotId: string }): Promise<null> {
    return await ctx.runAction(this.component.snapshots.remove, args);
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /**
   * Run a command and wait. `command` is shell text, or an argv array run
   * without a shell. A non-zero exit resolves with `status: "failed"`; it does
   * not throw. Throws when the sandbox is not Running or the request fails.
   */
  async exec(ctx: RunActionCtx, args: Without<Args<Api["exec"]["run"]>, never>): Promise<RunResult> {
    return await ctx.runAction(this.component.exec.run, { ...args, ...this.retain, ...this.proxy });
  }

  /** Start a command in the background. Poll it with `commandStatus`; stop it with `kill`. */
  async spawn(ctx: RunActionCtx, args: Without<Args<Api["exec"]["spawn"]>, never>): Promise<RunResult> {
    return await ctx.runAction(this.component.exec.spawn, { ...args, ...this.retain, ...this.proxy });
  }

  /** Status and output of a command. Pass the returned `cursor` back to read only new output. */
  async commandStatus(
    ctx: RunActionCtx,
    args: SandboxRef & { commandId: string; cursor?: number; statusOnly?: boolean },
  ): Promise<CommandState> {
    return await ctx.runAction(this.component.exec.status, { ...args, ...this.retain, ...this.proxy });
  }

  /** Interrupt a running command. */
  async kill(ctx: RunActionCtx, args: SandboxRef & { commandId: string }): Promise<null> {
    return await ctx.runAction(this.component.exec.interrupt, { ...args, ...this.proxy });
  }

  /** Start a bash session whose working directory and environment persist across runs. */
  async createSession(ctx: RunActionCtx, args: SandboxRef & { cwd?: string }): Promise<{ sessionId: string }> {
    return await ctx.runAction(this.component.exec.createSession, { ...args, ...this.proxy });
  }

  /** Run in a session. stderr is merged into stdout. */
  async runInSession(
    ctx: RunActionCtx,
    args: SandboxRef & { sessionId: string; command: string; cwd?: string; timeoutMs?: number },
  ): Promise<RunResult> {
    return await ctx.runAction(this.component.exec.runInSession, { ...args, ...this.retain, ...this.proxy });
  }

  async deleteSession(ctx: RunActionCtx, args: SandboxRef & { sessionId: string }): Promise<null> {
    return await ctx.runAction(this.component.exec.deleteSession, { ...args, ...this.proxy });
  }

  // -------------------------------------------------------------------------
  // Code interpreter (needs an image with it, such as opensandbox/code-interpreter)
  // -------------------------------------------------------------------------

  /**
   * Run code in a Jupyter kernel. An exception resolves with `status:
   * "failed"` and `exception`; rich outputs are in `results`.
   */
  async runCode(ctx: RunActionCtx, args: Without<Args<Api["code"]["run"]>, never>): Promise<CodeResult> {
    return await ctx.runAction(this.component.code.run, { ...args, ...this.retain, ...this.proxy });
  }

  /** A context keeps variables between runCode calls. */
  async createCodeContext(
    ctx: RunActionCtx,
    args: SandboxRef & { language?: string },
  ): Promise<{ contextId: string; language: string }> {
    return await ctx.runAction(this.component.code.createContext, { ...args, ...this.proxy });
  }

  async listCodeContexts(ctx: RunActionCtx, args: SandboxRef & { language?: string }) {
    return await ctx.runAction(this.component.code.listContexts, { ...args, ...this.proxy });
  }

  async deleteCodeContext(
    ctx: RunActionCtx,
    args: SandboxRef & ({ contextId: string; language?: never } | { language: string; contextId?: never }),
  ): Promise<null> {
    return await ctx.runAction(this.component.code.deleteContext, { ...args, ...this.proxy });
  }

  /** Interrupt a code run by the `commandId` its result (or init event) carried. */
  async interruptCode(ctx: RunActionCtx, args: SandboxRef & { executionId: string }): Promise<null> {
    return await ctx.runAction(this.component.code.interrupt, { ...args, ...this.proxy });
  }

  // -------------------------------------------------------------------------
  // Files
  // -------------------------------------------------------------------------

  /** Read a file as UTF-8 text. */
  async readFile(
    ctx: RunActionCtx,
    args: SandboxRef & { path: string; maxBytes?: number; offset?: number; lines?: { fromLine: number; count: number } },
  ): Promise<{ path: string; text: string; sizeBytes: number; truncated: boolean }> {
    const result = await ctx.runAction(this.component.files.read, { ...args, encoding: "text", ...this.proxy });
    return { path: result.path, text: result.text ?? "", sizeBytes: result.sizeBytes, truncated: result.truncated };
  }

  /** Read a file as bytes. */
  async readFileBytes(
    ctx: RunActionCtx,
    args: SandboxRef & { path: string; maxBytes?: number; offset?: number },
  ): Promise<{ path: string; bytes: ArrayBuffer; sizeBytes: number; truncated: boolean }> {
    const result = await ctx.runAction(this.component.files.read, { ...args, encoding: "bytes", ...this.proxy });
    return {
      path: result.path,
      bytes: result.bytes ?? new ArrayBuffer(0),
      sizeBytes: result.sizeBytes,
      truncated: result.truncated,
    };
  }

  /**
   * Write one file. A string is UTF-8. `mode` is permission bits such as
   * 0o644. Parent directories are created. At most 8 MiB.
   */
  async writeFile(
    ctx: RunActionCtx,
    args: SandboxRef & {
      path: string;
      content: string | ArrayBuffer | Uint8Array;
      mode?: number;
      owner?: string;
      group?: string;
    },
  ): Promise<{ path: string; sizeBytes: number }> {
    const { ownerId, key, ...file } = args;
    const [written] = await this.writeFiles(ctx, { ownerId, key, files: [file] });
    return written!;
  }

  /** Write up to 100 files in one request, at most 8 MiB in total. */
  async writeFiles(
    ctx: RunActionCtx,
    args: SandboxRef & {
      files: Array<{ path: string; content: string | ArrayBuffer | Uint8Array; mode?: number; owner?: string; group?: string }>;
    },
  ): Promise<Array<{ path: string; sizeBytes: number }>> {
    return await ctx.runAction(this.component.files.write, {
      ownerId: args.ownerId,
      key: args.key,
      files: args.files.map((file) => ({
        ...file,
        content: file.content instanceof Uint8Array ? exactBuffer(file.content) : file.content,
      })),
      ...this.proxy,
    });
  }

  /**
   * Copy a file from your app's Convex file storage into the sandbox. The
   * bytes stream Convex → sandbox inside a component action (up to 1 GiB);
   * they never pass through your machine, function arguments, or memory.
   */
  async copyFromStorage(
    ctx: RunActionCtx & { storage: { getUrl(storageId: never): Promise<string | null> } },
    args: SandboxRef & { storageId: string; path: string; mode?: number; owner?: string; group?: string },
  ): Promise<{ path: string; sizeBytes: number }> {
    const { storageId, ...rest } = args;
    const url = await ctx.storage.getUrl(storageId as never);
    if (!url) throw new Error(`No file in storage with id ${storageId}.`);
    return await ctx.runAction(this.component.files.importFromUrl, { ...rest, url, ...this.proxy });
  }

  /**
   * Copy a file from the sandbox into your app's Convex file storage and
   * return its storage id. Streams, up to 1 GiB.
   */
  async copyToStorage(
    ctx: RunActionCtx & { storage: { generateUploadUrl(): Promise<string> } },
    args: SandboxRef & { path: string; contentType?: string },
  ): Promise<{ storageId: string; path: string; sizeBytes: number }> {
    const uploadUrl = await ctx.storage.generateUploadUrl();
    const result = await ctx.runAction(this.component.files.exportToUploadUrl, { ...args, uploadUrl, ...this.proxy });
    if (!result.storageId) throw new Error("Convex storage did not return a storage id.");
    return { ...result, storageId: result.storageId };
  }

  /** Entries under a directory. `depth` 1 (default) lists immediate children. */
  async listFiles(ctx: RunActionCtx, args: SandboxRef & { path: string; depth?: number }): Promise<FileInfo[]> {
    return await ctx.runAction(this.component.files.list, { ...args, ...this.proxy });
  }

  async fileInfo(ctx: RunActionCtx, args: SandboxRef & { paths: string[] }): Promise<FileInfo[]> {
    return await ctx.runAction(this.component.files.info, { ...args, ...this.proxy });
  }

  async exists(ctx: RunActionCtx, args: SandboxRef & { path: string }): Promise<boolean> {
    return await ctx.runAction(this.component.files.exists, { ...args, ...this.proxy });
  }

  /** Files under `path` matching a glob (default `**`). */
  async searchFiles(ctx: RunActionCtx, args: SandboxRef & { path: string; pattern?: string }): Promise<FileInfo[]> {
    return await ctx.runAction(this.component.files.search, { ...args, ...this.proxy });
  }

  /** Delete files, or directories and their contents with `recursive: true`. */
  async deleteFiles(ctx: RunActionCtx, args: SandboxRef & { paths: string[]; recursive?: boolean }): Promise<null> {
    return await ctx.runAction(this.component.files.remove, { ...args, ...this.proxy });
  }

  async deleteFile(ctx: RunActionCtx, args: SandboxRef & { path: string; recursive?: boolean }): Promise<null> {
    const { path, ...rest } = args;
    return await this.deleteFiles(ctx, { ...rest, paths: [path] });
  }

  /** mkdir -p, with permission bits (default 0o755). */
  async makeDirs(
    ctx: RunActionCtx,
    args: SandboxRef & { dirs: Array<{ path: string; mode?: number; owner?: string; group?: string }> },
  ): Promise<null> {
    return await ctx.runAction(this.component.files.makeDirs, { ...args, ...this.proxy });
  }

  async moveFiles(ctx: RunActionCtx, args: SandboxRef & { moves: Array<{ from: string; to: string }> }): Promise<null> {
    return await ctx.runAction(this.component.files.move, { ...args, ...this.proxy });
  }

  async setPermissions(
    ctx: RunActionCtx,
    args: SandboxRef & { entries: Array<{ path: string; mode: number; owner?: string; group?: string }> },
  ): Promise<null> {
    return await ctx.runAction(this.component.files.setPermissions, { ...args, ...this.proxy });
  }

  /** Replace every occurrence of `find` in each file. Returns per-file counts. */
  async replaceInFiles(
    ctx: RunActionCtx,
    args: SandboxRef & { edits: Array<{ path: string; find: string; replaceWith: string }> },
  ) {
    return await ctx.runAction(this.component.files.replace, { ...args, ...this.proxy });
  }

  // -------------------------------------------------------------------------
  // Ingress
  // -------------------------------------------------------------------------

  /**
   * URL for a port inside the sandbox, plus the headers it needs. Those
   * headers can authorize access: hand them to a browser only on purpose.
   * `expiresAt` (Unix seconds) asks for a signed route (gateway mode).
   */
  async endpoint(ctx: RunActionCtx, args: SandboxRef & { port: number; expiresAt?: number }): Promise<SandboxEndpoint> {
    return await ctx.runAction(this.component.files.endpoint, { ...args, ...this.proxy });
  }

  /** Just the URL for a port. */
  async previewUrl(ctx: RunActionCtx, args: SandboxRef & { port: number; expiresAt?: number }): Promise<string> {
    return (await this.endpoint(ctx, args)).url;
  }

  // -------------------------------------------------------------------------
  // Network policy and credential vault (need the server's egress sidecar)
  // -------------------------------------------------------------------------

  async getNetworkPolicy(ctx: RunActionCtx, args: SandboxRef): Promise<NetworkPolicyStatus> {
    return await ctx.runAction(this.component.network.getPolicy, args);
  }

  async setNetworkPolicy(ctx: RunActionCtx, args: SandboxRef & { policy: NetworkPolicy }): Promise<NetworkPolicyStatus> {
    return await ctx.runAction(this.component.network.replacePolicy, args);
  }

  async patchNetworkRules(ctx: RunActionCtx, args: SandboxRef & { rules: NetworkRule[] }): Promise<NetworkPolicyStatus> {
    return await ctx.runAction(this.component.network.patchRules, args);
  }

  async deleteNetworkRules(ctx: RunActionCtx, args: SandboxRef & { targets: string[] }): Promise<NetworkPolicyStatus> {
    return await ctx.runAction(this.component.network.deleteRules, args);
  }

  async createCredentialVault(
    ctx: RunActionCtx,
    args: Args<Api["network"]["createVault"]>,
  ): Promise<CredentialVaultState> {
    return await ctx.runAction(this.component.network.createVault, args);
  }

  async getCredentialVault(ctx: RunActionCtx, args: SandboxRef): Promise<CredentialVaultState | null> {
    return await ctx.runAction(this.component.network.getVault, args);
  }

  async patchCredentialVault(
    ctx: RunActionCtx,
    args: Args<Api["network"]["patchVault"]>,
  ): Promise<CredentialVaultState> {
    return await ctx.runAction(this.component.network.patchVault, args);
  }

  async deleteCredentialVault(ctx: RunActionCtx, args: SandboxRef): Promise<null> {
    return await ctx.runAction(this.component.network.deleteVault, args);
  }

  // -------------------------------------------------------------------------
  // Observability
  // -------------------------------------------------------------------------

  async metrics(ctx: RunActionCtx, args: SandboxRef): Promise<SandboxMetrics> {
    return await ctx.runAction(this.component.observe.metrics, { ...args, ...this.proxy });
  }

  /** True when execd answers. Never throws for an unhealthy sandbox. */
  async isHealthy(ctx: RunActionCtx, args: SandboxRef): Promise<boolean> {
    return await ctx.runAction(this.component.observe.ping, { ...args, ...this.proxy });
  }

  async diagnostics(ctx: RunActionCtx, args: SandboxRef & { kind: "logs" | "events"; scope?: string }) {
    return await ctx.runAction(this.component.observe.diagnostics, args);
  }

  async diagnosticContext(ctx: RunActionCtx, args: SandboxRef) {
    return await ctx.runAction(this.component.observe.diagnosticContext, args);
  }

  // -------------------------------------------------------------------------
  // Execution history
  // -------------------------------------------------------------------------

  async getExecution(ctx: RunQueryCtx, args: { executionId: string; ownerId: string }): Promise<Execution | null> {
    return await ctx.runQuery(this.component.executions.get, args);
  }

  async listExecutions(ctx: RunQueryCtx, args: SandboxRef & { limit?: number }): Promise<Execution[]> {
    return await ctx.runQuery(this.component.executions.list, args);
  }

  async listExecutionsPaginated(
    ctx: RunQueryCtx,
    args: { ownerId: string; key?: string; paginationOpts: PaginationOptions },
  ) {
    return await ctx.runQuery(this.component.executions.listPaginated, args);
  }

  /** Delete execution rows older than `olderThanMs`. Call again while `hasMore`. */
  async purgeExecutions(
    ctx: RunMutationCtx,
    args: { ownerId?: string; key?: string; olderThanMs: number; limit?: number },
  ): Promise<{ deleted: number; hasMore: boolean }> {
    return await ctx.runMutation(this.component.executions.purge, args);
  }
}

function exactBuffer(content: Uint8Array): ArrayBuffer {
  return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
}
