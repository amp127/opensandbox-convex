# Connecting Convex to an OpenSandbox server

This guide takes a fresh Linux host with a public IP to a Convex app that runs commands in OpenSandbox sandboxes. It covers the Docker runtime. On Kubernetes, the Convex side is the same; follow the OpenSandbox Kubernetes deployment docs for the server, then start at [Configure Convex](#4-configure-convex).

## 1. Pick a topology

Every component call makes two kinds of requests:

- **Lifecycle API** (create, pause, snapshot, ...) goes to the OpenSandbox server, port 8080 by default, authenticated by `OPEN-SANDBOX-API-KEY`.
- **execd** (commands, files, code, metrics) runs inside each sandbox on port 44772. The lifecycle API tells the component where to reach it: either a host port published by Docker, or a path on the lifecycle server's built-in proxy.

Convex functions run in Convex's cloud, which has no fixed egress IP you can allowlist. That decides the setup:

| | **A. Server proxy (recommended)** | B. Direct endpoints |
| --- | --- | --- |
| Open ports | 443 only | 443, plus 40000–60000 to the world |
| execd reachable from the internet | No | **Yes, with no authentication** |
| Component option | `new OpenSandbox(..., { useServerProxy: true })` | default |
| Preview URLs (`endpoint`) | Through the proxy; need the API key | Direct `ip:port`, open to anyone |
| Throughput | All sandbox traffic passes through the server | Sandbox traffic bypasses the server |

> **Do not run B on a public IP.** The Docker runtime does not set an execd access token. Any published execd port accepts commands from anyone who finds it. The default `network_mode = "host"` is worse: execd listens on the host's own port 44772. Use B only on a private network where the Convex deployment reaches the host (a self-hosted Convex backend on the same machine or VPC, for example).

The rest of this guide sets up **A**.

## 2. Install the server

On the host (Ubuntu 22.04+ or Debian 12+, 4+ GB RAM):

```sh
# Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER" && newgrp docker

# uv, then the server
curl -LsSf https://astral.sh/uv/install.sh | sh
uv tool install opensandbox-server
opensandbox-server init-config ~/.sandbox.toml --example docker
```

Pre-pull the images so the first create does not time out pulling them:

```sh
docker pull opensandbox/execd:v1.1.0
docker pull python:3.12-slim
# Optional, for runCode:
docker pull opensandbox/code-interpreter:latest
```

## 3. Configure the server

Generate a key and keep it somewhere safe. You will give the same value to Convex.

```sh
openssl rand -hex 32
```

Edit `~/.sandbox.toml`. These keys matter; leave the rest as generated.

```toml
[server]
host = "127.0.0.1"          # only the TLS proxy below talks to it
port = 8080
api_key = "<the key you generated>"
eip = "sandbox.example.com" # the public hostname, no scheme; used in proxy URLs
max_sandbox_timeout_seconds = 86400

[proxy]
resolve_internal = true     # the server runs on the host, so it can reach bridge IPs

[runtime]
type = "docker"
execd_image = "opensandbox/execd:v1.1.0"

[docker]
network_mode = "bridge"     # one network namespace per sandbox; required for networkPolicy
publish_host = "127.0.0.1"  # never publish sandbox ports on the public interface
pids_limit = 4096
no_new_privileges = true

[storage]
# Set it explicitly. Only these host paths can be bind-mounted into sandboxes.
allowed_host_paths = ["/srv/opensandbox-volumes"]

[ingress]
mode = "direct"
```

To use `networkPolicy` or the credential vault, add an egress sidecar (it needs `network_mode = "bridge"`):

```toml
[egress]
image = "opensandbox/egress:v1.1.7"
mode = "dns+nft"
```

Run it as a service:

```ini
# /etc/systemd/system/opensandbox.service
[Unit]
Description=OpenSandbox server
After=docker.service
Requires=docker.service

[Service]
User=<your user>
ExecStart=/home/<your user>/.local/bin/opensandbox-server --config /home/<your user>/.sandbox.toml
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload && sudo systemctl enable --now opensandbox
curl -s localhost:8080/health
```

### TLS, and the API key on every path

The API key travels in a header, so the server must sit behind TLS. The proxy path (`/v1/sandboxes/{id}/proxy/{port}`) also skips the server's own key check on single-tenant servers; on Docker, only the sandbox's random id protects it. Have the TLS proxy require the key on every request. [Caddy](https://caddyserver.com) gets a certificate automatically. Point a DNS name at the host first.

```caddy
# /etc/caddy/Caddyfile
sandbox.example.com {
	@nokey not header OPEN-SANDBOX-API-KEY {$OPENSANDBOX_API_KEY}
	respond @nokey 401

	reverse_proxy 127.0.0.1:8080 {
		flush_interval -1   # stream command output as it arrives
		transport http {
			read_timeout 10m
			write_timeout 10m
		}
	}
}
```

```sh
sudo apt install -y caddy
sudo mkdir -p /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironment=OPENSANDBOX_API_KEY=%s\n' '<the key>' | sudo tee /etc/systemd/system/caddy.service.d/key.conf
sudo chmod 600 /etc/systemd/system/caddy.service.d/key.conf
sudo systemctl daemon-reload && sudo systemctl restart caddy
```

The component sends the key to proxy URLs only when they are on the same origin as `OPENSANDBOX_DOMAIN`. It never sends the key to a sandbox's own endpoint. The server strips it before forwarding to the sandbox.

Without a domain, you can still test over plain HTTP on the IP. The key then crosses the network unencrypted, so treat that key as disposable:

```toml
[server]
host = "0.0.0.0"
```

### Firewall

```sh
sudo ufw default deny incoming
sudo ufw allow 22/tcp
sudo ufw allow 443/tcp     # and 80/tcp for Caddy's certificate challenge
sudo ufw enable
```

Docker writes its own iptables rules and bypasses ufw for published ports. That is why `publish_host = "127.0.0.1"` above matters: it is what keeps sandbox ports off the internet. Check from another machine:

```sh
nmap -p 8080,40000-60000,44772 sandbox.example.com   # all should be closed or filtered
```

## 4. Configure Convex

```sh
npm install opensandbox-convex
npx convex env set OPENSANDBOX_API_KEY '<the key>'
npx convex env set OPENSANDBOX_DOMAIN 'https://sandbox.example.com'
```

`OPENSANDBOX_DOMAIN` can be a host (`sandbox.example.com`, defaults to https; `localhost` defaults to http), a URL, or a URL with a path prefix. A trailing `/v1` is removed. `OPENSANDBOX_PROTOCOL=http|https` overrides the default for a bare host.

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

```ts
// convex/sandbox.ts
import { OpenSandbox } from "opensandbox-convex";
import { components } from "./_generated/api";

export const sandboxes = new OpenSandbox(components.opensandbox, { useServerProxy: true });
```

## 5. Verify

From your machine:

```sh
KEY='<the key>'; HOST='https://sandbox.example.com'
curl -s -H "OPEN-SANDBOX-API-KEY: $KEY" "$HOST/v1/sandboxes" | head -c 300; echo   # {"items":[...
curl -s -o /dev/null -w '%{http_code}\n' "$HOST/v1/sandboxes"                        # 401 (no key)
```

Then run the component's end-to-end suite from this repository. It creates real sandboxes on the server, exercises every feature, and cleans up:

```sh
npm install && npm run build
npx convex dev --once            # a local backend is fine; it can reach the public host
npx convex env set OPENSANDBOX_API_KEY "$KEY"
npx convex env set OPENSANDBOX_DOMAIN "$HOST"
E2E_PROXY=1 npm run e2e
# Optional: E2E_CODE_IMAGE=opensandbox/code-interpreter:latest  E2E_SKIP=fork,proxy
```

## Existing Docker Compose deployments

If the server already runs from the upstream `docker-compose.example.yaml` (the server in a container, sandboxes on the host's Docker), keep that layout and harden it rather than reinstalling:

- Publish the server only on loopback: `ports: ["127.0.0.1:8090:8090"]`. Point Caddy at that port.
- Keep `publish_host` at the Docker bridge gateway (`172.17.0.1`) and `resolve_internal = false`. The containerized server reaches sandboxes through those host ports, and the bridge address keeps them off the public interface. `127.0.0.1` would break it.
- Set `[server] api_key` and `eip`. If the compose env sets `OPENSANDBOX_SERVER_API_KEY`, it overrides `api_key`; set both. Recreate with `docker compose up -d --force-recreate` so the env file is re-read.
- No domain? `<ip-with-dashes>.sslip.io` (for example `203-0-113-10.sslip.io`) resolves to the IP publicly and gets a Let's Encrypt certificate through Caddy.
- `max_sandbox_timeout_seconds` caps `timeoutSeconds` on create (not `renew`).

## Troubleshooting

Every component error is a `ConvexError`. Read it with `openSandboxErrorData(error)`.

| `code` | Likely cause |
| --- | --- |
| `config` | `OPENSANDBOX_API_KEY` or `OPENSANDBOX_DOMAIN` is not set on the deployment, or not passed in `convex.config.ts`. |
| `unauthenticated` | Wrong key, or Caddy is rejecting the request (check `/etc/systemd/system/caddy.service.d/key.conf`). |
| `network` / `timeout` on create | The domain is unreachable from Convex: DNS, firewall, or the server is down. |
| `timeout` on the first create, then a sandbox appears | The image pull took longer than `createRequestTimeoutSeconds` (default 300). Pre-pull the image. The next `create` adopts the sandbox instead of making a second one. |
| `provisioning_timeout: execd did not answer` | The sandbox is Running but its execd is unreachable. On a public host, set `useServerProxy: true`. With the proxy, check `[server] eip` and `[proxy] resolve_internal`. |
| `invalid_argument` naming metadata | Metadata keys and values must be Kubernetes label-safe: values at most 63 characters of `[A-Za-z0-9._-]`, starting and ending alphanumeric. |
| `invalid_argument` on `secureAccess` | Not supported on the Docker runtime. |
| `unsupported` / `not_found` on network policy or the vault | No `[egress]` sidecar configured, or `network_mode` is not `bridge`. |
| `not_ready` with `state: "Paused"` | Resume the sandbox first, or call `create` again (it resumes). |
| `failed` from `runCode` with a 404/500, or a hang | The image has no code interpreter, or its entrypoint was replaced. Use `opensandbox/code-interpreter` and do not pass `entrypoint`; the component keeps `/opt/code-interpreter/code-interpreter.sh` and waits for Jupyter. |
| `unsupported` from network policy calls | The sandbox was created without `networkPolicy`, so it has no egress sidecar. Policy can only be changed on sandboxes created with one. |
| Preview URL answers 401 | Your TLS proxy requires the API key on the server proxy path. `endpoint()` reports `viaServerProxy: true`; relay the request through your backend, which adds the key. |
| `forbidden` / `rate_limited` on create (Kubernetes) | Namespace quota or pool capacity; `retryAfterSeconds` says when to retry. |

Server logs: `journalctl -u opensandbox -f`. A sandbox's own logs: `sandboxes.diagnostics(ctx, { ownerId, key, kind: "logs" })`.
