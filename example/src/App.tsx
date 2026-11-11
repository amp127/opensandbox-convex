import { useAction, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import type { FunctionReference } from "convex/server";
import { Component, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../convex/_generated/api";

const REPO = "https://github.com/amp127/opensandbox-convex";
const SITE_URL = (import.meta.env.CONVEX_SITE_URL as string | undefined) ?? "";

type Sandbox = NonNullable<ReturnType<typeof useQuery<typeof api.demo.list>>>[number];
type ImageId = "python" | "debian" | "code";
type Tab = "terminal" | "files" | "code" | "preview" | "activity";

/** A random id per browser. The demo's only identity; see convex/demo.ts. */
function useVisitor(): string {
  return useMemo(() => {
    const stored = localStorage.getItem("osb-visitor");
    if (stored && /^[a-f0-9]{32}$/.test(stored)) return stored;
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    localStorage.setItem("osb-visitor", id);
    return id;
  }, []);
}

function errorText(error: unknown): string {
  if (error instanceof ConvexError) {
    const data = error.data as { message?: string } | string;
    return typeof data === "string" ? data : (data?.message ?? "Something went wrong.");
  }
  const match = error instanceof Error ? error.message.match(/"message":"([^"]+)"/) : null;
  return match?.[1] ?? (error instanceof Error ? error.message.split("\n")[0]! : "Something went wrong.");
}

/** An action plus its pending and error state. */
function useCall<F extends FunctionReference<"action">>(fn: F) {
  const run = useAction(fn);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const call = async (args: F["_args"]): Promise<F["_returnType"] | undefined> => {
    setPending(true);
    setError(undefined);
    try {
      return await run(args);
    } catch (e) {
      setError(errorText(e));
      return undefined;
    } finally {
      setPending(false);
    }
  };
  return { call, pending, error };
}

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

function remaining(expiresAt: string | undefined, now: number): string {
  if (!expiresAt) return "no expiry";
  const left = Math.max(0, Date.parse(expiresAt) - now);
  const minutes = Math.floor(left / 60_000);
  return `${minutes}:${String(Math.floor((left % 60_000) / 1000)).padStart(2, "0")} left`;
}

export function App() {
  const visitor = useVisitor();
  const images = useQuery(api.demo.images) ?? [];
  const rows = useQuery(api.demo.list, { visitor });
  const create = useCall(api.demo.create);
  const [image, setImage] = useState<ImageId>("python");
  const [selected, setSelected] = useState<string>();
  const [bootMs, setBootMs] = useState<number>();

  const live = rows ?? [];
  const current = live.find((row) => row.key === selected) ?? live[0];

  async function boot() {
    const made = await create.call({ visitor, image });
    if (made) {
      setSelected(made.key);
      setBootMs(made.bootMs);
    }
  }

  return (
    <div className="page">
      <header className="bar">
        <a className="wordmark" href={REPO}>
          <Mark />
          <span>
            opensandbox <em>for Convex</em>
          </span>
        </a>
        <nav>
          <a href={`${REPO}#readme`}>Docs</a>
          <a href={REPO}>GitHub</a>
        </nav>
      </header>

      <section className="intro">
        <span className="eyebrow">self-hosted sandboxes · live in your tables</span>
        <h1>Run real sandboxes from Convex</h1>
        <p className="lede">
          This page talks to a Convex backend with the <code>opensandbox-convex</code> component. Each sandbox is a real
          container on an OpenSandbox server. Every list and log below is a Convex query, so it updates the moment the
          sandbox does.
        </p>
        <div className="start">
          <div className="chips" role="radiogroup" aria-label="Image">
            {images.map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={image === item.id}
                className="chip"
                onClick={() => setImage(item.id as ImageId)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <button className="primary" type="button" disabled={create.pending} onClick={() => void boot()}>
            {create.pending ? "Starting…" : "Create sandbox"}
          </button>
          <CopyCommand command="npm install opensandbox-convex" />
        </div>
        {create.error && <p className="error">{create.error}</p>}
      </section>

      <main className="workbench">
        <aside className="rail">
          <h2>Your sandboxes</h2>
          {rows === undefined && <p className="muted">Loading…</p>}
          {rows !== undefined && live.length === 0 && <p className="muted">None yet. Create one above.</p>}
          {live.map((row) => (
            <SandboxCard key={row.key} row={row} active={row.key === current?.key} onSelect={() => setSelected(row.key)} />
          ))}
        </aside>
        <section className="panel">
          {current ? (
            <Boundary key={current.key}>
              <Workspace visitor={visitor} sandbox={current} bootMs={current.key === selected ? bootMs : undefined} />
            </Boundary>
          ) : (
            <Empty />
          )}
        </section>
      </main>

      <HowItWorks />
      <footer className="footer">
        <span>MIT · built on <a href="https://github.com/alibaba/OpenSandbox">OpenSandbox</a> and <a href="https://convex.dev">Convex</a></span>
        <span className="muted">Demo sandboxes pause after 15 idle minutes and expire after 30.</span>
      </footer>
    </div>
  );
}

function SandboxCard({ row, active, onSelect }: { row: Sandbox; active: boolean; onSelect: () => void }) {
  const now = useNow();
  return (
    <button type="button" className={`card${active ? " active" : ""}`} onClick={onSelect}>
      <span className="card-top">
        <span className={`dot ${row.state.toLowerCase()}`} />
        <strong>{row.key}</strong>
        <span className="state">{row.state}</span>
      </span>
      <span className="card-meta">
        <span>{row.image ?? row.snapshotId?.slice(0, 8) ?? "—"}</span>
        <span>{remaining(row.expiresAt, now)}</span>
      </span>
    </button>
  );
}

function Workspace({ visitor, sandbox, bootMs }: { visitor: string; sandbox: Sandbox; bootMs?: number }) {
  const [tab, setTab] = useState<Tab>("terminal");
  const ref = { visitor, key: sandbox.key };
  const lifecycle = useCall(api.demo.lifecycle);
  const fork = useCall(api.demo.fork);
  const metrics = useCall(api.demo.metrics);
  const [usage, setUsage] = useState<{ cpu: number; mem: string }>();
  const running = sandbox.state === "Running";

  useEffect(() => {
    if (!running) return;
    let stop = false;
    const tick = async () => {
      const m = await metrics.call(ref);
      if (m && !stop) setUsage({ cpu: Math.round(m.cpuUsedPercent), mem: `${Math.round(m.memoryUsedMiB)} MiB` });
    };
    void tick();
    const id = setInterval(() => void tick(), 10_000);
    return () => {
      stop = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, sandbox.key]);

  const tabs: Array<[Tab, string]> = [
    ["terminal", "Terminal"],
    ["files", "Files"],
    ["code", "Code"],
    ["preview", "Preview"],
    ["activity", "Activity"],
  ];
  const error = lifecycle.error ?? fork.error;

  return (
    <div className="workspace">
      <div className="ws-head">
        <div>
          <h2>
            <span className={`dot ${sandbox.state.toLowerCase()}`} /> {sandbox.key}
          </h2>
          <p className="readout">
            <span>{sandbox.state}</span>
            <span>id {sandbox.sandboxId?.slice(0, 8)}</span>
            {usage && running && (
              <>
                <span>cpu {usage.cpu}%</span>
                <span>mem {usage.mem}</span>
              </>
            )}
            {bootMs !== undefined && <span className="signal">ready in {(bootMs / 1000).toFixed(1)} s</span>}
          </p>
        </div>
        <div className="ws-actions">
          {running && (
            <button type="button" disabled={lifecycle.pending} onClick={() => void lifecycle.call({ ...ref, verb: "pause" })}>
              Pause
            </button>
          )}
          {sandbox.state === "Paused" && (
            <button type="button" disabled={lifecycle.pending} onClick={() => void lifecycle.call({ ...ref, verb: "resume" })}>
              Resume
            </button>
          )}
          <button type="button" disabled={!running || fork.pending} onClick={() => void fork.call(ref)}>
            {fork.pending ? "Forking…" : "Fork"}
          </button>
          <button type="button" className="danger" disabled={lifecycle.pending} onClick={() => void lifecycle.call({ ...ref, verb: "destroy" })}>
            Destroy
          </button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {!running && tab !== "activity" ? (
        <p className="muted pad">The sandbox is {sandbox.state}. {sandbox.state === "Paused" ? "Resume it to continue." : ""}</p>
      ) : (
        <>
          {tab === "terminal" && <Terminal visitor={visitor} sandboxKey={sandbox.key} />}
          {tab === "files" && <Files visitor={visitor} sandboxKey={sandbox.key} />}
          {tab === "code" && <Code visitor={visitor} sandboxKey={sandbox.key} isCode={sandbox.image?.includes("code-interpreter") ?? false} />}
          {tab === "preview" && <Preview visitor={visitor} sandboxKey={sandbox.key} />}
          {tab === "activity" && <Activity visitor={visitor} sandboxKey={sandbox.key} />}
        </>
      )}
    </div>
  );
}

type Line = { id: number; cwd: string; command: string; stdout: string; stderr: string; exitCode?: number; status: string; ms: number };

function Terminal({ visitor, sandboxKey }: { visitor: string; sandboxKey: string }) {
  const run = useCall(api.demo.run);
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState("");
  const [cwd, setCwd] = useState("/root");
  const [recall, setRecall] = useState<string[]>([]);
  const [recallAt, setRecallAt] = useState(-1);
  const end = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  // Keep the cursor in the prompt: back after every run finishes.
  useEffect(() => {
    if (!run.pending) field.current?.focus();
  }, [run.pending]);
  useEffect(() => {
    // Braces matter: scrollIntoView returns a Promise in recent Chrome, and an
    // effect must return nothing or a cleanup function.
    void end.current?.scrollIntoView({ block: "end" });
  }, [lines, run.pending]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const command = input.trim();
    if (!command || run.pending) return;
    setInput("");
    setRecall((r) => [command, ...r].slice(0, 50));
    setRecallAt(-1);
    if (command === "clear") return setLines([]);
    // Each command is its own process, so `cd` is tracked here.
    const cd = command.match(/^cd(?:\s+(.+))?$/);
    const actual = cd ? `cd ${cd[1] ?? "~"} && pwd` : command;
    const result = await run.call({ visitor, key: sandboxKey, command: actual, cwd });
    if (!result) return;
    if (cd && result.exitCode === 0) setCwd(result.stdout.trim());
    setLines((l) => [
      ...l,
      {
        id: Date.now(),
        cwd,
        command,
        stdout: cd && result.exitCode === 0 ? "" : result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        status: result.status,
        ms: result.durationMs,
      },
    ]);
  }

  return (
    <div
      className="terminal"
      onClick={() => {
        // Clicking the output to select text should not steal the selection.
        if (!window.getSelection()?.toString()) field.current?.focus();
      }}
    >
      <div className="term-scroll">
        {lines.length === 0 && <p className="term-hint">Try <code>uname -a</code>, <code>ls -la /</code>, or <code>pip list</code>.</p>}
        {lines.map((line) => (
          <div key={line.id} className="term-entry">
            <div className="term-cmd">
              <span className="prompt">{line.cwd} $</span> {line.command}
            </div>
            {line.stdout && <pre>{line.stdout}</pre>}
            {line.stderr && <pre className="stderr">{line.stderr}</pre>}
            {line.status !== "succeeded" && (
              <div className="term-status">
                {line.status}
                {line.exitCode !== undefined ? ` · exit ${line.exitCode}` : ""} · {line.ms} ms
              </div>
            )}
          </div>
        ))}
        {run.error && <pre className="stderr">{run.error}</pre>}
        <div ref={end} />
      </div>
      <form onSubmit={(e) => void submit(e)} className="term-input">
        <span className="prompt">{cwd} $</span>
        <input
          id="term-input"
          ref={field}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          value={input}
          // readOnly, not disabled: a disabled input loses focus and does not get it back.
          readOnly={run.pending}
          aria-busy={run.pending}
          placeholder={run.pending ? "running…" : ""}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp" && recall.length) {
              e.preventDefault();
              const next = Math.min(recall.length - 1, recallAt + 1);
              setRecallAt(next);
              setInput(recall[next]!);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              const next = recallAt - 1;
              setRecallAt(Math.max(-1, next));
              setInput(next < 0 ? "" : recall[next]!);
            }
          }}
        />
      </form>
    </div>
  );
}

type Entry = { path: string; type: string; size: number; mode: string };

function Files({ visitor, sandboxKey }: { visitor: string; sandboxKey: string }) {
  const list = useCall(api.demo.listFiles);
  const read = useCall(api.demo.readFile);
  const write = useCall(api.demo.writeFile);
  const [dir, setDir] = useState("/root");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [open, setOpen] = useState<{ path: string; text: string; truncated: boolean }>();
  const [draft, setDraft] = useState("");
  const [newName, setNewName] = useState("");

  async function load(path: string) {
    const items = await list.call({ visitor, key: sandboxKey, path });
    if (items) {
      setDir(path);
      setEntries(items);
    }
  }
  useEffect(() => {
    void load("/root");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sandboxKey]);

  async function openFile(path: string) {
    const file = await read.call({ visitor, key: sandboxKey, path });
    if (file) {
      setOpen({ path, text: file.text, truncated: file.truncated });
      setDraft(file.text);
    }
  }

  async function save(path: string, content: string) {
    if (await write.call({ visitor, key: sandboxKey, path, content })) {
      setOpen({ path, text: content, truncated: false });
      await load(dir);
    }
  }

  const parent = dir === "/" ? undefined : dir.replace(/\/[^/]+\/?$/, "") || "/";
  const name = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

  return (
    <div className="files">
      <div className="files-list">
        <div className="crumbs">
          <code>{dir}</code>
          {parent !== undefined && (
            <button type="button" onClick={() => void load(parent)}>
              ↑ up
            </button>
          )}
        </div>
        <ul>
          {entries.map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                className={open?.path === entry.path ? "active" : ""}
                onClick={() => void (entry.type === "directory" ? load(entry.path) : openFile(entry.path))}
              >
                <span>{entry.type === "directory" ? "▸ " : ""}{name(entry.path)}</span>
                <span className="muted">{entry.type === "directory" ? "" : `${entry.size} B · ${entry.mode}`}</span>
              </button>
            </li>
          ))}
          {entries.length === 0 && !list.pending && <li className="muted pad">Empty</li>}
        </ul>
        <form
          className="new-file"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newName.trim()) return;
            const path = `${dir.replace(/\/$/, "")}/${newName.trim()}`;
            setNewName("");
            void save(path, "").then(() => openFile(path));
          }}
        >
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="new-file.txt" spellCheck={false} />
          <button type="submit">Create</button>
        </form>
      </div>
      <div className="files-view">
        {open ? (
          <>
            <div className="crumbs">
              <code>{open.path}</code>
              <button type="button" disabled={write.pending || draft === open.text} onClick={() => void save(open.path, draft)}>
                {write.pending ? "Saving…" : "Save"}
              </button>
            </div>
            {open.truncated && <p className="muted pad">Showing the first 256 KB.</p>}
            <textarea value={draft} spellCheck={false} onChange={(e) => setDraft(e.target.value)} />
          </>
        ) : (
          <p className="muted pad">Pick a file to view and edit it.</p>
        )}
        {(list.error ?? read.error ?? write.error) && <p className="error">{list.error ?? read.error ?? write.error}</p>}
      </div>
    </div>
  );
}

function Code({ visitor, sandboxKey, isCode }: { visitor: string; sandboxKey: string; isCode: boolean }) {
  const runCode = useCall(api.demo.runCode);
  const [code, setCode] = useState("import platform, sys\nprint(platform.platform())\nsum(range(10**6))");
  const [result, setResult] = useState<NonNullable<Awaited<ReturnType<typeof runCode.call>>>>();
  if (!isCode) {
    return (
      <p className="muted pad">
        The code interpreter runs Jupyter kernels that keep variables between runs. Create a <strong>Code interpreter</strong>{" "}
        sandbox to use it.
      </p>
    );
  }
  return (
    <div className="code">
      <textarea value={code} spellCheck={false} onChange={(e) => setCode(e.target.value)} />
      <div className="row">
        <button
          className="primary"
          type="button"
          disabled={runCode.pending}
          onClick={async () => setResult(await runCode.call({ visitor, key: sandboxKey, code }))}
        >
          {runCode.pending ? "Running…" : "Run"}
        </button>
        <span className="muted">Variables persist between runs in the same kernel.</span>
      </div>
      {runCode.error && <p className="error">{runCode.error}</p>}
      {result && (
        <div className="code-out">
          {result.stdout && <pre>{result.stdout}</pre>}
          {result.stderr && <pre className="stderr">{result.stderr}</pre>}
          {result.results.map((item, index) => (
            <pre key={index} className="result">{typeof item.text === "string" ? item.text : JSON.stringify(item)}</pre>
          ))}
          {result.exception && (
            <pre className="stderr">
              {result.exception.name}: {result.exception.value}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function Preview({ visitor, sandboxKey }: { visitor: string; sandboxKey: string }) {
  const start = useCall(api.demo.startPreview);
  const [src, setSrc] = useState<string>();
  return (
    <div className="preview">
      <div className="row">
        <button className="primary" type="button" disabled={start.pending} onClick={async () => {
          const made = await start.call({ visitor, key: sandboxKey });
          if (made) setSrc(`${SITE_URL}${made.path}?t=${Date.now()}`);
        }}>
          {start.pending ? "Starting…" : src ? "Reload" : "Start a web server"}
        </button>
        <span className="muted">Port 8000 in the sandbox, relayed by a Convex HTTP action that holds the API key.</span>
      </div>
      {start.error && <p className="error">{start.error}</p>}
      {src && (
        <>
          <a className="muted mono" href={src} target="_blank" rel="noreferrer">{src}</a>
          <iframe title="Sandbox preview" src={src} />
        </>
      )}
    </div>
  );
}

function Activity({ visitor, sandboxKey }: { visitor: string; sandboxKey: string }) {
  const rows = useQuery(api.demo.history, { visitor, key: sandboxKey });
  return (
    <div className="activity">
      <p className="muted pad">Every run is a row in the component's table. This list is a live query.</p>
      <table>
        <thead>
          <tr><th>When</th><th>Kind</th><th>Status</th><th>Exit</th><th>Time</th></tr>
        </thead>
        <tbody>
          {(rows ?? []).map((row) => (
            <tr key={row.executionId}>
              <td>{new Date(row.startedAt).toLocaleTimeString()}</td>
              <td>{row.kind}</td>
              <td><span className={`badge ${row.status}`}>{row.status}</span></td>
              <td>{row.exitCode ?? "—"}</td>
              <td>{row.finishedAt ? `${row.finishedAt - row.startedAt} ms` : "…"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Empty() {
  return (
    <div className="empty">
      <Mark size={40} />
      <p>Create a sandbox to get a terminal, a file browser, a code interpreter, and a live preview.</p>
    </div>
  );
}

function HowItWorks() {
  const steps: Array<[string, ReactNode]> = [
    ["Create", <>An action calls <code>sandboxes.create()</code>. The component reserves a row, asks OpenSandbox for a container, and waits until execd answers.</>],
    ["Run", <><code>exec</code>, files, and code go to execd inside the sandbox through the server proxy. Output streams back into the action.</>],
    ["Watch", <>State and run history live in the component's tables, so the page reads them with <code>useQuery</code> and never polls.</>],
    ["Clean up", <>A cron calls <code>sweep()</code>: idle sandboxes pause, abandoned ones are destroyed, old history is trimmed.</>],
  ];
  return (
    <section className="how">
      <h2>How this page works</h2>
      <ol>
        {steps.map(([title, body], index) => (
          <li key={title}>
            <span className="step">0{index + 1}</span>
            <strong>{title}</strong>
            <p>{body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="copy"
      onClick={() => {
        void navigator.clipboard.writeText(command);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      <code>{command}</code>
      <span>{copied ? "copied" : "copy"}</span>
    </button>
  );
}

function Mark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="4" y="4" width="24" height="24" rx="6" fill="none" stroke="var(--signal)" strokeWidth="2.5" />
      <path d="M11 13l4 3-4 3M17 20h5" stroke="var(--fg)" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Keeps a broken panel from blanking the whole page. */
class Boundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="empty">
        <p>This panel hit an error: {this.state.error.message}</p>
        <button type="button" onClick={() => this.setState({ error: undefined })}>
          Try again
        </button>
      </div>
    );
  }
}
