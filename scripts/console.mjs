#!/usr/bin/env node
// Interactive shell in an OpenSandbox sandbox, over execd's PTY WebSocket,
// through the lifecycle server's proxy.
//
//   node scripts/console.mjs <sandboxId>
//
// Reads OPENSANDBOX_DOMAIN and OPENSANDBOX_API_KEY from the environment, or
// from the Convex deployment (`npx convex env get`) when they are not set.
// Exit with Ctrl-D or `exit`. Ctrl-] detaches without killing the shell.
import { execFileSync } from "node:child_process";

const sandboxId = process.argv[2];
if (!sandboxId) {
  console.error("usage: node scripts/console.mjs <sandboxId>");
  process.exit(2);
}

function setting(name) {
  if (process.env[name]) return process.env[name].trim();
  try {
    return execFileSync("npx", ["convex", "env", "get", name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

const domain = setting("OPENSANDBOX_DOMAIN").replace(/\/+$/, "").replace(/\/v1$/, "");
const apiKey = setting("OPENSANDBOX_API_KEY");
if (!domain || !apiKey) {
  console.error("Set OPENSANDBOX_DOMAIN and OPENSANDBOX_API_KEY (environment or Convex deployment).");
  process.exit(2);
}
const base = /^https?:\/\//.test(domain) ? domain : `https://${domain}`;
const headers = { "OPEN-SANDBOX-API-KEY": apiKey };

// The execd base URL through the server proxy.
const endpointRes = await fetch(`${base}/v1/sandboxes/${encodeURIComponent(sandboxId)}/endpoints/44772?use_server_proxy=true`, { headers });
if (!endpointRes.ok) {
  console.error(`endpoint lookup failed: HTTP ${endpointRes.status} ${await endpointRes.text()}`);
  process.exit(1);
}
const endpoint = await endpointRes.json();
const execd = `${new URL(base).protocol}//${endpoint.endpoint.replace(/\/+$/, "")}`;
const execdHeaders = { ...headers, ...(endpoint.headers ?? {}) };

const created = await fetch(`${execd}/pty`, {
  method: "POST",
  headers: { ...execdHeaders, "content-type": "application/json" },
  body: JSON.stringify({ cwd: "/" }),
});
if (!created.ok) {
  console.error(`could not open a PTY session: HTTP ${created.status} ${await created.text()}`);
  process.exit(1);
}
const { session_id: sessionId } = await created.json();

const interactive = process.stdin.isTTY === true;
const wsUrl = `${execd.replace(/^http/, "ws")}/pty/${encodeURIComponent(sessionId)}/ws${interactive ? "" : "?pty=0"}`;
const ws = new WebSocket(wsUrl, { headers: execdHeaders });
ws.binaryType = "arraybuffer";

let exitCode = 0;
const cleanup = async () => {
  if (interactive) process.stdin.setRawMode(false);
  await fetch(`${execd}/pty/${encodeURIComponent(sessionId)}`, { method: "DELETE", headers: execdHeaders }).catch(() => undefined);
};

const sendStdin = (bytes) => {
  if (ws.readyState !== WebSocket.OPEN) return;
  const frame = new Uint8Array(bytes.length + 1);
  frame[0] = 0x00;
  frame.set(bytes, 1);
  ws.send(frame);
};
const resize = () => {
  if (interactive && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "resize", cols: process.stdout.columns, rows: process.stdout.rows }));
  }
};

ws.addEventListener("open", () => {
  if (interactive) {
    process.stderr.write(`Connected to ${sandboxId}. Ctrl-D or "exit" to quit, Ctrl-] to detach.\r\n`);
    process.stdin.setRawMode(true);
  }
  resize();
  process.stdout.on("resize", resize);
  process.stdin.on("data", (chunk) => {
    if (interactive && chunk.length === 1 && chunk[0] === 0x1d) {
      ws.close();
      return;
    }
    sendStdin(chunk);
  });
  process.stdin.on("end", () => {
    // Piped input finished: close the shell's stdin by asking it to exit.
    if (!interactive) sendStdin(new TextEncoder().encode("exit\n"));
  });
  process.stdin.resume();
});

ws.addEventListener("message", (event) => {
  if (typeof event.data === "string") {
    const frame = JSON.parse(event.data);
    if (frame.type === "exit") {
      exitCode = typeof frame.exit_code === "number" ? frame.exit_code : 0;
      ws.close();
    } else if (frame.type === "error") {
      process.stderr.write(`\r\n[pty error] ${frame.message ?? JSON.stringify(frame)}\r\n`);
    }
    return;
  }
  const bytes = new Uint8Array(event.data);
  if (bytes[0] === 0x01) process.stdout.write(bytes.subarray(1));
  else if (bytes[0] === 0x02) process.stderr.write(bytes.subarray(1));
});

ws.addEventListener("close", async (event) => {
  await cleanup();
  if (event.code !== 1000 && event.code !== 1005 && exitCode === 0 && event.reason) {
    process.stderr.write(`\r\n[closed: ${event.code} ${event.reason}]\r\n`);
  }
  process.exit(exitCode);
});

ws.addEventListener("error", async () => {
  process.stderr.write("\r\n[websocket error]\r\n");
  await cleanup();
  process.exit(1);
});
