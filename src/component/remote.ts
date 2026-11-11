import { osError, scrub } from "./errors.js";
import type { CreateOptions, NetworkPolicy, NetworkRule } from "./validators.js";
import {
  DEFAULT_ENTRYPOINT,
  DEFAULT_RESOURCE_LIMITS,
  DEFAULT_TIMEOUT_SECONDS,
  LEGACY_META_TOKEN,
  MAX_TIMEOUT_SECONDS,
  META_KEY,
  META_MANAGED,
  META_OWNER,
  META_TOKEN,
  RESERVED_META_KEYS,
} from "./urls.js";

// ---------------------------------------------------------------------------
// Metadata. OpenSandbox stores metadata as Kubernetes labels on every runtime
// (Docker validates the same rules): keys are `[prefix/]name`, values are at
// most 63 characters of `[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?`.
// ---------------------------------------------------------------------------

const DNS_LABEL = "[a-z0-9]([-a-z0-9]*[a-z0-9])?";
const DNS_SUBDOMAIN = new RegExp(`^(?:${DNS_LABEL}\\.)*${DNS_LABEL}$`);
const LABEL_NAME = /^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/;
const LABEL_VALUE = /^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$/;
const SERVER_RESERVED_PREFIX = "opensandbox.io/";

export function isLabelKey(key: string): boolean {
  let name = key;
  if (key.includes("/")) {
    const [prefix, rest] = [key.slice(0, key.indexOf("/")), key.slice(key.indexOf("/") + 1)];
    if (!prefix || !rest || prefix.length > 253 || !DNS_SUBDOMAIN.test(prefix)) return false;
    name = rest;
  }
  return name.length <= 63 && LABEL_NAME.test(name);
}

export function isLabelValue(value: string): boolean {
  return value.length <= 63 && LABEL_VALUE.test(value);
}

export function checkMetadataKey(key: string): void {
  if (RESERVED_META_KEYS.has(key) || key === LEGACY_META_TOKEN || key.startsWith(SERVER_RESERVED_PREFIX)) {
    throw osError("invalid_argument", `Metadata key ${JSON.stringify(key)} is reserved.`);
  }
  if (!isLabelKey(key)) {
    throw osError(
      "invalid_argument",
      `Metadata key ${JSON.stringify(key)} is not a valid label key: a name of up to 63 characters ` +
        "matching [A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?, optionally after a DNS-subdomain prefix and /.",
    );
  }
}

export function checkMetadataValue(key: string, value: string): void {
  if (typeof value !== "string" || !isLabelValue(value)) {
    throw osError(
      "invalid_argument",
      `Metadata value for ${JSON.stringify(key)} must be at most 63 characters, start and end with a ` +
        "letter or digit, and contain only letters, digits, '-', '_', or '.'.",
    );
  }
}

export function checkMetadata(metadata: Record<string, string>): void {
  const entries = Object.entries(metadata);
  if (entries.length > 64) throw osError("invalid_argument", "metadata accepts at most 64 entries.");
  for (const [key, value] of entries) {
    checkMetadataKey(key);
    checkMetadataValue(key, value);
  }
}

/**
 * Owner and key are free-form (an auth subject can hold `|` or exceed 63
 * characters), so the component labels sandboxes with a digest of them.
 */
export async function labelDigest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes.slice(0, 20), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Create request
// ---------------------------------------------------------------------------

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESOURCE_NAME = /^[A-Za-z][A-Za-z0-9./-]*$/;
const VOLUME_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export function validateCreate(args: CreateOptions): void {
  const sources = [args.image, args.snapshotId, args.templateId].filter((item) => item !== undefined).length;
  const pool = args.extensions?.poolRef !== undefined;
  if (sources > 1) throw osError("invalid_argument", "Pass only one of image, snapshotId, or templateId.");
  if (sources === 0 && !pool) {
    throw osError("invalid_argument", "Pass one of image, snapshotId, or templateId (or extensions.poolRef).");
  }
  if (args.image !== undefined) checkBounded("image", args.image, 1024);
  if (args.imageAuth !== undefined) {
    if (args.image === undefined) throw osError("invalid_argument", "imageAuth requires image.");
    checkBounded("imageAuth.username", args.imageAuth.username, 512);
    if (!args.imageAuth.password || args.imageAuth.password.length > 8192) {
      throw osError("invalid_argument", "imageAuth.password must be 1 to 8192 characters.");
    }
  }
  if (args.snapshotId !== undefined) checkBounded("snapshotId", args.snapshotId, 256);
  if (args.templateId !== undefined) checkBounded("templateId", args.templateId, 256);
  if (args.entrypoint !== undefined) checkArgv("entrypoint", args.entrypoint);
  if (args.timeoutSeconds !== undefined && args.timeoutSeconds !== null) {
    checkInt("timeoutSeconds", args.timeoutSeconds, 60, MAX_TIMEOUT_SECONDS);
  }
  if (args.resourceLimits !== undefined) checkRecord("resourceLimits", args.resourceLimits, 16, RESOURCE_NAME, 64);
  if (args.resourceRequests !== undefined) {
    checkRecord("resourceRequests", args.resourceRequests, 16, RESOURCE_NAME, 64);
  }
  if (args.env !== undefined) checkRecord("env", args.env, 256, ENV_NAME, 32_768);
  if (args.metadata !== undefined) checkMetadata(args.metadata);
  if (args.networkPolicy !== undefined) checkNetworkPolicy(args.networkPolicy);
  if (args.volumes !== undefined) checkVolumes(args.volumes);
  if (args.lifecycle !== undefined) checkLifecycle(args.lifecycle);
  if (args.extensions !== undefined) checkRecord("extensions", args.extensions, 32, /^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 1024);
}

export interface Ownership {
  token: string;
  ownerDigest: string;
  keyDigest: string;
}

export function buildCreateBody(args: CreateOptions, ownership: Ownership): Record<string, unknown> {
  validateCreate(args);
  const body: Record<string, unknown> = {
    resourceLimits: args.resourceLimits ?? DEFAULT_RESOURCE_LIMITS,
    metadata: {
      ...args.metadata,
      [META_TOKEN]: ownership.token,
      [META_OWNER]: ownership.ownerDigest,
      [META_KEY]: ownership.keyDigest,
      [META_MANAGED]: "true",
    },
  };
  // Omitting `timeout` is how the API disables expiration.
  const timeout = args.timeoutSeconds === undefined ? DEFAULT_TIMEOUT_SECONDS : args.timeoutSeconds;
  if (timeout !== null) body.timeout = timeout;
  if (args.image !== undefined) {
    body.image = args.imageAuth ? { uri: args.image, auth: args.imageAuth } : { uri: args.image };
    // The API requires an entrypoint with an image.
    body.entrypoint = args.entrypoint ?? DEFAULT_ENTRYPOINT;
  } else if (args.entrypoint !== undefined) {
    body.entrypoint = args.entrypoint;
  }
  if (args.snapshotId !== undefined) body.snapshotId = args.snapshotId;
  if (args.templateId !== undefined) body.templateId = args.templateId;
  if (args.resourceRequests !== undefined) body.resourceRequests = args.resourceRequests;
  if (args.env && Object.keys(args.env).length > 0) body.env = args.env;
  if (args.platform !== undefined) body.platform = args.platform;
  if (args.networkPolicy !== undefined) body.networkPolicy = normalizePolicy(args.networkPolicy);
  if (args.credentialProxy !== undefined) body.credentialProxy = { enabled: args.credentialProxy };
  if (args.secureAccess !== undefined) body.secureAccess = args.secureAccess;
  if (args.volumes !== undefined && args.volumes.length > 0) body.volumes = args.volumes;
  if (args.lifecycle !== undefined) body.lifecycle = args.lifecycle;
  if (args.extensions !== undefined && Object.keys(args.extensions).length > 0) body.extensions = args.extensions;
  return body;
}

export function normalizePolicy(policy: NetworkPolicy): Record<string, unknown> {
  return { defaultAction: policy.defaultAction ?? "deny", egress: policy.egress ?? [] };
}

export function checkNetworkPolicy(policy: NetworkPolicy): void {
  if (policy.egress !== undefined) checkRules(policy.egress);
}

export function checkRules(rules: NetworkRule[]): void {
  if (rules.length > 500) throw osError("invalid_argument", "A network policy accepts at most 500 rules.");
  for (const rule of rules) {
    checkBounded("network rule target", rule.target, 512);
    for (const port of rule.ports ?? []) checkInt("network rule port", port, 1, 65535);
  }
}

function checkVolumes(volumes: NonNullable<CreateOptions["volumes"]>): void {
  if (volumes.length > 32) throw osError("invalid_argument", "volumes accepts at most 32 entries.");
  const names = new Set<string>();
  for (const volume of volumes) {
    if (!VOLUME_NAME.test(volume.name) || volume.name.length > 63) {
      throw osError("invalid_argument", `Volume name ${JSON.stringify(volume.name)} must be a DNS label.`);
    }
    if (names.has(volume.name)) throw osError("invalid_argument", `Volume name ${volume.name} is repeated.`);
    names.add(volume.name);
    if (!volume.mountPath.startsWith("/")) {
      throw osError("invalid_argument", `Volume ${volume.name} mountPath must be absolute.`);
    }
    const backends = [volume.host, volume.pvc, volume.ossfs].filter((item) => item !== undefined).length;
    if (backends !== 1) {
      throw osError("invalid_argument", `Volume ${volume.name} must set exactly one of host, pvc, or ossfs.`);
    }
    if (volume.host && !/^(\/|[A-Za-z]:[\\/])/.test(volume.host.path)) {
      throw osError("invalid_argument", `Volume ${volume.name} host.path must be absolute.`);
    }
  }
}

function checkLifecycle(lifecycle: NonNullable<CreateOptions["lifecycle"]>): void {
  if (lifecycle.preStart) {
    checkArgv("lifecycle.preStart.command", lifecycle.preStart.command);
    if (lifecycle.preStart.timeoutSeconds !== undefined) {
      checkInt("lifecycle.preStart.timeoutSeconds", lifecycle.preStart.timeoutSeconds, 1, 10_800);
    }
  }
  for (const hook of lifecycle.periodic ?? []) {
    checkBounded("lifecycle.periodic.name", hook.name, 63);
    checkBounded("lifecycle.periodic.schedule", hook.schedule, 128);
    checkArgv("lifecycle.periodic.command", hook.command);
    if (hook.timeoutSeconds !== undefined) checkInt("lifecycle.periodic.timeoutSeconds", hook.timeoutSeconds, 1, 300);
  }
  const idle = lifecycle.idlePolicy;
  if (idle?.idleTimeoutSeconds !== undefined) checkInt("idlePolicy.idleTimeoutSeconds", idle.idleTimeoutSeconds, 30, 86_400);
  if (idle?.activeProbe) {
    checkInt("idlePolicy.activeProbe.port", idle.activeProbe.port, 1, 65535);
    if (!idle.activeProbe.path.startsWith("/") || idle.activeProbe.path.length > 512) {
      throw osError("invalid_argument", "idlePolicy.activeProbe.path must start with / and be at most 512 characters.");
    }
    if (idle.activeProbe.timeoutSeconds !== undefined) {
      checkInt("idlePolicy.activeProbe.timeoutSeconds", idle.activeProbe.timeoutSeconds, 1, 10);
    }
  }
  if (lifecycle.renewalPolicy) {
    checkInt("renewalPolicy.extendSeconds", lifecycle.renewalPolicy.extendSeconds, 300, 86_400);
  }
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface RemoteSandbox {
  sandboxId: string;
  state: string;
  image?: string;
  snapshotId?: string;
  entrypoint?: string[];
  expiresAt?: string;
  remoteCreatedAt?: string;
  reason?: string;
  message?: string;
  lastTransitionAt?: string;
  platform?: { os: string; arch: string };
  metadata: Record<string, string>;
}

export function parseSandbox(body: unknown): RemoteSandbox {
  if (!body || typeof body !== "object") {
    throw osError("invalid_response", "OpenSandbox returned a sandbox that is not an object.");
  }
  const record = body as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0 || record.id.length > 256) {
    throw osError("invalid_response", "OpenSandbox returned a sandbox without an id.");
  }
  let state = "Pending";
  let reason: string | undefined;
  let message: string | undefined;
  let lastTransitionAt: string | undefined;
  if (record.status && typeof record.status === "object") {
    const status = record.status as Record<string, unknown>;
    if (typeof status.state === "string" && status.state.length > 0 && status.state.length <= 64) {
      state = status.state;
    }
    if (typeof status.reason === "string" && status.reason) reason = scrub(status.reason);
    if (typeof status.message === "string" && status.message) message = scrub(status.message);
    lastTransitionAt = shortString(status.lastTransitionAt, 64);
  }
  const platform =
    record.platform && typeof record.platform === "object"
      ? (record.platform as { os?: unknown; arch?: unknown })
      : undefined;
  return omitUndefined({
    sandboxId: record.id,
    state,
    image: imageUri(record.image),
    snapshotId: shortString(record.snapshotId, 256),
    entrypoint: stringList(record.entrypoint),
    expiresAt: shortString(record.expiresAt, 64),
    remoteCreatedAt: shortString(record.createdAt, 64),
    reason,
    message,
    lastTransitionAt,
    platform:
      platform && typeof platform.os === "string" && typeof platform.arch === "string"
        ? { os: platform.os.slice(0, 32), arch: platform.arch.slice(0, 32) }
        : undefined,
    metadata: stringRecord(record.metadata),
  });
}

export function tokenOf(remote: RemoteSandbox): string | undefined {
  return remote.metadata[META_TOKEN] ?? remote.metadata[LEGACY_META_TOKEN];
}

/** Metadata the caller set, without the component's own keys. */
export function userMetadata(metadata: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (RESERVED_META_KEYS.has(key) || key === LEGACY_META_TOKEN || key.startsWith("osb.convex.")) continue;
    out[key] = value;
  }
  return out;
}

export interface RemoteSnapshot {
  snapshotId: string;
  sandboxId: string;
  name?: string;
  state: string;
  reason?: string;
  message?: string;
  remoteCreatedAt?: string;
}

export function parseSnapshot(body: unknown): RemoteSnapshot {
  if (!body || typeof body !== "object") {
    throw osError("invalid_response", "OpenSandbox returned a snapshot that is not an object.");
  }
  const record = body as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id || record.id.length > 256) {
    throw osError("invalid_response", "OpenSandbox returned a snapshot without an id.");
  }
  const status = (record.status && typeof record.status === "object" ? record.status : {}) as Record<string, unknown>;
  return omitUndefined({
    snapshotId: record.id,
    sandboxId: typeof record.sandboxId === "string" ? record.sandboxId.slice(0, 256) : "",
    name: shortString(record.name, 256),
    state: typeof status.state === "string" && status.state ? status.state.slice(0, 64) : "Creating",
    reason: typeof status.reason === "string" && status.reason ? scrub(status.reason) : undefined,
    message: typeof status.message === "string" && status.message ? scrub(status.message) : undefined,
    remoteCreatedAt: shortString(record.createdAt, 64),
  });
}

export function parseEndpoint(body: unknown): { endpoint: string; headers: Record<string, string> } {
  if (!body || typeof body !== "object") {
    throw osError("invalid_response", "OpenSandbox returned an endpoint that is not an object.");
  }
  const endpoint = (body as { endpoint?: unknown }).endpoint;
  if (typeof endpoint !== "string" || endpoint.trim().length === 0) {
    throw osError("invalid_response", "OpenSandbox returned an endpoint without a URL.");
  }
  return { endpoint: endpoint.trim(), headers: headerRecord((body as { headers?: unknown }).headers) };
}

export interface FileInfo {
  path: string;
  type: string;
  size: number;
  /** Permission bits, for example 0o644 (420). */
  mode: number;
  owner: string;
  group: string;
  modifiedAt?: string;
  createdAt?: string;
}

export function parseFileInfo(value: unknown): FileInfo | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.path !== "string" || !record.path) return null;
  return omitUndefined({
    path: record.path,
    type: typeof record.type === "string" ? record.type : "file",
    size: typeof record.size === "number" && Number.isFinite(record.size) ? record.size : 0,
    mode: typeof record.mode === "number" ? modeFromWire(record.mode) : 0,
    owner: typeof record.owner === "string" ? record.owner : "",
    group: typeof record.group === "string" ? record.group : "",
    modifiedAt: shortString(record.modified_at, 64),
    createdAt: shortString(record.created_at, 64),
  });
}

/**
 * execd writes and reads `mode` as octal digits in a decimal number: 755 means
 * rwxr-xr-x. The component's API takes real permission bits (0o755 === 493).
 */
export function modeToWire(mode: number): number {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
    throw osError("invalid_argument", "mode must be permission bits from 0 to 0o7777, for example 0o644.");
  }
  return Number(mode.toString(8));
}

export function modeFromWire(wire: number): number {
  if (!Number.isInteger(wire) || wire < 0) return 0;
  const digits = String(wire);
  return /^[0-7]+$/.test(digits) ? parseInt(digits, 8) : 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function omitUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function imageUri(value: unknown): string | undefined {
  if (typeof value === "string") return shortString(value, 1024);
  if (!value || typeof value !== "object") return undefined;
  return shortString((value as { uri?: unknown }).uri, 1024);
}

function shortString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > max) return undefined;
  return value;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return undefined;
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length > 4096) return undefined;
    items.push(item);
  }
  return items;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value).slice(0, 128)) {
    if (typeof item === "string" && key.length <= 317 && item.length <= 256 && !key.startsWith("$")) out[key] = item;
  }
  return out;
}

const FORBIDDEN_HEADERS = new Set(["open-sandbox-api-key", "host", "content-length", "connection", "transfer-encoding"]);

function headerRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(key)) continue;
    if (FORBIDDEN_HEADERS.has(key.toLowerCase())) continue;
    if (typeof item !== "string" || item.length > 8192 || /[\r\n\u0000]/.test(item)) continue;
    out[key] = item;
  }
  return out;
}

export function checkBounded(name: string, value: string, max: number): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw osError("invalid_argument", `${name} must be 1 to ${max} characters, without control characters.`);
  }
}

export function checkInt(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw osError("invalid_argument", `${name} must be an integer from ${min} to ${max}.`);
  }
}

export function checkArgv(name: string, value: string[]): void {
  if (value.length === 0 || value.length > 256) {
    throw osError("invalid_argument", `${name} must have 1 to 256 arguments.`);
  }
  if (!value[0]) throw osError("invalid_argument", `${name} must start with a non-empty executable.`);
  for (const part of value) {
    if (typeof part !== "string" || part.length > 32_768 || part.includes("\u0000")) {
      throw osError("invalid_argument", `${name} arguments must be strings of at most 32768 characters, without NUL.`);
    }
  }
}

export function checkRecord(
  name: string,
  value: Record<string, string>,
  maxKeys: number,
  keyPattern: RegExp,
  maxValue: number,
): void {
  const entries = Object.entries(value);
  if (entries.length > maxKeys) {
    throw osError("invalid_argument", `${name} accepts at most ${maxKeys} entries.`);
  }
  for (const [key, item] of entries) {
    if (!keyPattern.test(key) || key.length > 256) {
      throw osError("invalid_argument", `${name} key ${JSON.stringify(key)} is not allowed.`);
    }
    if (typeof item !== "string" || item.length > maxValue || item.includes("\u0000")) {
      throw osError("invalid_argument", `${name}.${key} is too long or contains NUL.`);
    }
  }
}
