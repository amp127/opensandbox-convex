// A fake OpenSandbox server (lifecycle + execd) for tests. Wire behavior
// follows the upstream sources, not the component's assumptions:
//  - execd streams events as raw JSON lines followed by a blank line
//  - a non-zero exit is an `error` event with evalue = exit code, no complete
//  - `mode` is octal digits written as a decimal number
//  - multipart upload parts must carry filenames
//  - metadata must satisfy Kubernetes label rules
import { vi } from "vitest";

export const API_KEY = "osk_test_secret_value";
export const ORIGIN = "https://os.example.com";
const LABEL_VALUE = /^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$/;

export interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
  init?: RequestInit;
}

export const STORAGE_HOST = "storage.example.com";

interface FakeSandbox {
  id: string;
  state: string;
  metadata: Record<string, string>;
  image?: string;
  snapshotId?: string;
  expiresAt?: string;
  createdAt: string;
  entrypoint: string[];
  files: Map<string, { data: Uint8Array; mode: number }>;
}

export interface FakeCommand {
  /** Events execd sends for a foreground run. Default: stdout "ok", exit 0. */
  events?: object[];
  status?: { running: boolean; exit_code?: number; error?: string };
  logs?: string;
}

export class FakeOpenSandbox {
  calls: Call[] = [];
  sandboxes = new Map<string, FakeSandbox>();
  snapshots = new Map<string, { id: string; sandboxId: string; name?: string; state: string; reads: number }>();
  /** Next run's script, keyed by command text. */
  commands = new Map<string, FakeCommand>();
  /** Make the next POST /sandboxes fail after creating (lost response). */
  loseNextCreateResponse = false;
  /** State a new sandbox reports for its first N reads. */
  pendingReads = 0;
  /** Snapshot reads before it turns Ready. */
  snapshotReadsUntilReady = 1;
  endpointHost = "ingress.example.com";
  /** Files served at https://storage.example.com/files/<name>, and uploads received at /upload. */
  storage = new Map<string, Uint8Array>();
  /** Called while POST /sandboxes is in flight, after the sandbox exists. */
  duringCreate?: () => Promise<void>;
  /** Behave like execd 1.1.x: no argv, one event per line without the line ending. */
  legacyExecd = false;
  endpointHeaders: Record<string, string> = { "OpenSandbox-Ingress-To": "secret-route" };
  private nextId = 1;

  install() {
    vi.stubEnv("OPENSANDBOX_API_KEY", API_KEY);
    vi.stubEnv("OPENSANDBOX_DOMAIN", ORIGIN);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const headers = Object.fromEntries(new Headers(init?.headers).entries());
        let body: unknown = init?.body;
        if (typeof body === "string") {
          try {
            body = JSON.parse(body) as unknown;
          } catch {
            // keep raw
          }
        }
        const call = { method: init?.method ?? "GET", url: new URL(raw), headers, body, init };
        this.calls.push(call);
        if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
        return await this.handle(call);
      }),
    );
    return this;
  }

  only(method: string, pathPart: string) {
    return this.calls.filter((call) => call.method === method && call.url.pathname.includes(pathPart));
  }

  private json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  private error(status: number, code: string, message: string) {
    return this.json({ code, message }, status);
  }

  private view(sandbox: FakeSandbox) {
    return {
      id: sandbox.id,
      status: { state: sandbox.state, reason: sandbox.state, lastTransitionAt: sandbox.createdAt },
      metadata: sandbox.metadata,
      image: sandbox.image ? { uri: sandbox.image } : undefined,
      snapshotId: sandbox.snapshotId,
      entrypoint: sandbox.entrypoint,
      expiresAt: sandbox.expiresAt,
      createdAt: sandbox.createdAt,
    };
  }

  private async handle(call: Call): Promise<Response> {
    const path = call.url.pathname;
    if (call.url.origin === ORIGIN) {
      if (path.startsWith("/v1/") && call.headers["open-sandbox-api-key"] !== API_KEY) {
        return this.error(401, "INVALID_API_KEY", "bad key");
      }
      return await this.lifecycle(call, path.replace(/^\/v1/, ""));
    }
    if (call.url.host === STORAGE_HOST) {
      if (call.headers["open-sandbox-api-key"]) throw new Error("The API key leaked to a storage URL.");
      if (call.method === "GET" && path.startsWith("/files/")) {
        const file = this.storage.get(path.slice(7));
        return file ? new Response(file as Uint8Array<ArrayBuffer>, { status: 200 }) : new Response("missing", { status: 404 });
      }
      if (call.method === "POST" && path === "/upload") {
        const bytes = new Uint8Array(await new Response(call.init?.body as BodyInit).arrayBuffer());
        const id = `kg${this.storage.size + 1}`;
        this.storage.set(id, bytes);
        return this.json({ storageId: id });
      }
      return new Response("no route", { status: 404 });
    }
    if (call.url.host === this.endpointHost) {
      for (const [name, value] of Object.entries(this.endpointHeaders)) {
        if (call.headers[name.toLowerCase()] !== value) return this.json({ error: "missing route header" }, 401);
      }
      if (call.headers["open-sandbox-api-key"]) throw new Error("The API key leaked to the ingress.");
      const match = path.match(/^\/sandboxes\/([^/]+)\/port\/(\d+)(\/.*)?$/);
      if (!match) return this.json({ error: "no route" }, 404);
      const sandbox = this.sandboxes.get(match[1]!);
      if (!sandbox || sandbox.state !== "Running") return this.json({ error: "down" }, 502);
      return await this.execd(call, sandbox, match[3] ?? "/");
    }
    throw new Error(`Unexpected fetch to ${call.url}`);
  }

  private async lifecycle(call: Call, path: string): Promise<Response> {
    if (call.method === "POST" && path === "/sandboxes") {
      const body = call.body as Record<string, unknown>;
      const metadata = (body.metadata ?? {}) as Record<string, string>;
      for (const [key, value] of Object.entries(metadata)) {
        if (!LABEL_VALUE.test(value) || value.length > 63) {
          return this.error(400, "INVALID_METADATA_LABEL", `Metadata value '${value}' for '${key}' is invalid`);
        }
      }
      if (body.image && !body.entrypoint) return this.error(400, "INVALID_ENTRYPOINT", "entrypoint required");
      const id = `sbx_${this.nextId++}`;
      const sandbox: FakeSandbox = {
        id,
        state: this.pendingReads > 0 ? "Pending" : "Running",
        metadata,
        image: (body.image as { uri?: string } | undefined)?.uri,
        snapshotId: body.snapshotId as string | undefined,
        expiresAt:
          typeof body.timeout === "number" ? new Date(Date.now() + body.timeout * 1000).toISOString() : undefined,
        createdAt: new Date().toISOString(),
        entrypoint: (body.entrypoint as string[] | undefined) ?? ["tail", "-f", "/dev/null"],
        files: new Map(),
      };
      this.sandboxes.set(id, sandbox);
      if (this.duringCreate) await this.duringCreate();
      if (this.loseNextCreateResponse) {
        this.loseNextCreateResponse = false;
        throw new TypeError("fetch failed: socket hang up");
      }
      return this.json(this.view(sandbox), 202);
    }
    if (call.method === "GET" && path === "/sandboxes") {
      const filter = call.url.searchParams.get("metadata") ?? "";
      const wanted = new URLSearchParams(filter);
      const items = [...this.sandboxes.values()].filter((sandbox) =>
        [...wanted.entries()].every(([key, value]) => sandbox.metadata[key] === value),
      );
      return this.json({
        items: items.map((item) => this.view(item)),
        pagination: { page: 1, pageSize: 20, totalItems: items.length, totalPages: 1, hasNextPage: false },
      });
    }
    let match = path.match(/^\/sandboxes\/([^/]+)$/);
    if (match) {
      const sandbox = this.sandboxes.get(match[1]!);
      if (!sandbox) return this.error(404, "NOT_FOUND", "no sandbox");
      if (call.method === "DELETE") {
        this.sandboxes.delete(sandbox.id);
        return new Response(null, { status: 204 });
      }
      if (this.pendingReads > 0) {
        this.pendingReads -= 1;
        if (this.pendingReads === 0) sandbox.state = "Running";
      }
      return this.json(this.view(sandbox));
    }
    match = path.match(/^\/sandboxes\/([^/]+)\/(pause|resume|renew-expiration|metadata|endpoints\/(\d+)|snapshots)$/);
    if (match) {
      const sandbox = this.sandboxes.get(match[1]!);
      if (!sandbox) return this.error(404, "NOT_FOUND", "no sandbox");
      const verb = match[2]!;
      if (verb === "pause") {
        if (sandbox.state !== "Running") return this.error(409, "INVALID_STATE", "not running");
        sandbox.state = "Paused";
        return new Response(null, { status: 202 });
      }
      if (verb === "resume") {
        if (sandbox.state !== "Paused") return this.error(409, "INVALID_STATE", "not paused");
        sandbox.state = "Running";
        return new Response(null, { status: 202 });
      }
      if (verb === "renew-expiration") {
        sandbox.expiresAt = (call.body as { expiresAt: string }).expiresAt;
        return this.json({ expiresAt: sandbox.expiresAt });
      }
      if (verb === "metadata") {
        for (const [key, value] of Object.entries(call.body as Record<string, string | null>)) {
          if (value === null) delete sandbox.metadata[key];
          else sandbox.metadata[key] = value;
        }
        return this.json(this.view(sandbox));
      }
      if (verb === "snapshots") {
        const id = `snap_${this.nextId++}`;
        const name = (call.body as { name?: string } | undefined)?.name;
        this.snapshots.set(id, { id, sandboxId: sandbox.id, name, state: "Creating", reads: 0 });
        return this.json({ id, sandboxId: sandbox.id, name, status: { state: "Creating" }, createdAt: sandbox.createdAt }, 202);
      }
      const port = match[3]!;
      if (call.url.searchParams.get("use_server_proxy") === "true") {
        return this.json({ endpoint: `os.example.com/v1/sandboxes/${sandbox.id}/proxy/${port}` });
      }
      return this.json({ endpoint: `${this.endpointHost}/sandboxes/${sandbox.id}/port/${port}`, headers: this.endpointHeaders });
    }
    match = path.match(/^\/snapshots\/([^/]+)$/);
    if (match) {
      const snapshot = this.snapshots.get(match[1]!);
      if (!snapshot) return this.error(404, "NOT_FOUND", "no snapshot");
      if (call.method === "DELETE") {
        this.snapshots.delete(snapshot.id);
        return new Response(null, { status: 204 });
      }
      snapshot.reads += 1;
      if (snapshot.reads >= this.snapshotReadsUntilReady) snapshot.state = "Ready";
      return this.json({ id: snapshot.id, sandboxId: snapshot.sandboxId, name: snapshot.name, status: { state: snapshot.state }, createdAt: new Date().toISOString() });
    }
    return this.error(404, "NOT_FOUND", `no route ${call.method} ${path}`);
  }

  private stream(events: object[]) {
    // execd's framing: the JSON, then a blank line. No `data:` prefix.
    const text = events.map((event) => `${JSON.stringify(event)}\n\n`).join("");
    return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  private async execd(call: Call, sandbox: FakeSandbox, path: string): Promise<Response> {
    if (path === "/ping") return new Response(null, { status: 200 });
    if (call.method === "POST" && path === "/command") {
      const body = call.body as { command?: string; argv?: string[]; background?: boolean };
      if (this.legacyExecd) {
        if (!body.command) {
          return this.json(
            { code: "INVALID_REQUEST", message: "invalid request, validation error Key: 'RunCommandRequest.Command' Error:Field validation for 'Command' failed on the 'required' tag" },
            400,
          );
        }
        return this.stream([
          { type: "init", text: "cmd_legacy" },
          { type: "stdout", text: "line one" },
          { type: "stdout", text: "line two" },
          { type: "execution_complete", execution_time: 2 },
        ]);
      }
      const text = body.command ?? body.argv?.join(" ") ?? "";
      const script = this.commands.get(text);
      if (body.background) {
        return this.stream([{ type: "init", text: "cmd_bg" }, { type: "execution_complete", execution_time: 1 }]);
      }
      return this.stream(
        script?.events ?? [
          { type: "init", text: "cmd_1" },
          { type: "stdout", text: "ok\n" },
          { type: "execution_complete", execution_time: 3 },
        ],
      );
    }
    let match = path.match(/^\/command\/status\/(.+)$/);
    if (match) {
      const script = [...this.commands.values()].find((item) => item.status);
      return this.json({ id: match[1], ...(script?.status ?? { running: true }) });
    }
    match = path.match(/^\/command\/(.+)\/logs$/);
    if (match) {
      const script = [...this.commands.values()].find((item) => item.logs !== undefined);
      return new Response(script?.logs ?? "", {
        status: 200,
        headers: { "content-type": "text/plain", "EXECD-COMMANDS-TAIL-CURSOR": "7" },
      });
    }
    if (call.method === "POST" && path === "/files/upload") {
      // FormData from files.write, or a streamed multipart body from importFromUrl.
      const form =
        call.body instanceof FormData
          ? call.body
          : await new Request("https://execd.local/upload", {
              method: "POST",
              body: call.init?.body as BodyInit,
              headers: { "content-type": call.headers["content-type"] ?? "" },
              duplex: "half",
            } as RequestInit).formData();
      const metas = form.getAll("metadata");
      const files = form.getAll("file");
      for (let index = 0; index < metas.length; index += 1) {
        const meta = metas[index] as File;
        const file = files[index] as File;
        // Go's multipart reader only treats parts with a filename as files.
        if (!meta.name || !file.name) return this.json({ code: "INVALID_FILE", message: "metadata file is missing" }, 400);
        const parsed = JSON.parse(await meta.text()) as { path: string; mode?: number };
        if (parsed.mode !== undefined && !/^[0-7]+$/.test(String(parsed.mode))) {
          return this.json({ code: "INVALID_FILE", message: "bad mode" }, 400);
        }
        sandbox.files.set(parsed.path, {
          data: new Uint8Array(await file.arrayBuffer()),
          mode: parsed.mode ?? 755,
        });
      }
      return new Response(null, { status: 200 });
    }
    if (call.method === "GET" && path === "/files/download") {
      const file = sandbox.files.get(call.url.searchParams.get("path") ?? "");
      if (!file) return this.json({ code: "FILE_NOT_FOUND", message: "no such file" }, 404);
      return new Response(file.data as Uint8Array<ArrayBuffer>, { status: 200, headers: { "content-type": "application/octet-stream" } });
    }
    if (call.method === "GET" && path === "/directories/list") {
      const dir = call.url.searchParams.get("path") ?? "/";
      return this.json(
        [...sandbox.files.entries()]
          .filter(([name]) => name.startsWith(`${dir.replace(/\/$/, "")}/`))
          .map(([name, file]) => ({
            path: name,
            type: "file",
            size: file.data.byteLength,
            mode: file.mode,
            owner: "root",
            group: "root",
            modified_at: "2026-01-01T00:00:00Z",
            created_at: "2026-01-01T00:00:00Z",
          })),
      );
    }
    if (call.method === "POST" && path === "/session") return this.json({ session_id: "sess_1" });
    if (call.method === "POST" && path === "/session/sess_1/run") {
      return this.stream([
        { type: "init", text: "run_1" },
        { type: "stdout", text: "/tmp\n" },
        { type: "execution_complete" },
      ]);
    }
    if (call.method === "POST" && path === "/code") {
      // Observed on execd 1.1.0: the first cell's execution_complete can
      // arrive before its output.
      return this.stream([
        { type: "init", text: "exec_1" },
        { type: "execution_complete", execution_time: 5 },
        { type: "stdout", text: "hi\n" },
        { type: "execution_count", execution_count: 1 },
        { type: "result", results: { text: "2" } },
      ]);
    }
    return this.json({ code: "NOT_FOUND", message: `no execd route ${path}` }, 404);
  }
}
