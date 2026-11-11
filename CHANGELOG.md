# Changelog

## 0.2.0

A full review and rewrite against the upstream OpenSandbox server, execd, and SDK sources, verified end to end on `opensandbox/server:release-1.2.0` with `execd:v1.1.0`.

### Fixed
- Command output was never parsed: execd streams raw JSON lines, not `data:` frames.
- `create` failed for owner ids that are not Kubernetes label values (Convex Auth subjects, for one). Owner and key are now stored as digests.
- File `mode` was sent as permission bits; execd reads octal digits. `0o755` failed and `0o644` became `0420`.
- A slow create (image pull) timed out after 60 s and a retry created a second sandbox. Creates now adopt the earlier attempt by token.
- `spawn` sent a 60 s timeout, so execd killed every background server after a minute.
- `commandStatus` threw on logs over 1 MB; it now truncates and reads incrementally with a cursor.
- `useServerProxy` did not authenticate to multi-tenant servers.
- Error data arriving as JSON text made `openSandboxErrorData` return null.
- A `destroy` racing a `create` could leave a sandbox running with no row.

### Added
- Snapshots (owner-scoped), `fork`, `patchMetadata`, `renew` by `timeoutSeconds`, `sweep` (idle pause and destroy, `protectMetadata`), `reconcile`.
- argv commands, uid/gid, `kill`, bash sessions, the code interpreter (contexts, rich results), incremental logs.
- File info, list, search, delete, mkdir, move, chmod, replace, byte ranges, line reads, batch writes.
- `copyFromStorage` / `copyToStorage`: streamed transfers between Convex file storage and a sandbox, up to 1 GiB.
- Network policy, credential vault, metrics, diagnostics, signed endpoints, `viaServerProxy` on endpoints.
- `opensandbox-convex/ai`: AI SDK tools.
- Compatibility with execd 1.1.x (no argv, line-framed output) and the code interpreter's out-of-order events.
- Demo app, preview relay HTTP action, housekeeping cron, e2e suite, console script, connection and persistence guides.
