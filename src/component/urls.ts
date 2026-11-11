import { osError, type OpenSandboxErrorCode } from "./errors.js";

/** execd listens here inside the sandbox. The lifecycle API maps it to a reachable URL. */
export const EXECD_PORT = 44772;

export const DEFAULT_TIMEOUT_SECONDS = 600;
/** Upper bound the component accepts for `timeoutSeconds`. The server may enforce a lower one. */
export const MAX_TIMEOUT_SECONDS = 365 * 86_400;
export const DEFAULT_READY_TIMEOUT_SECONDS = 60;
export const MAX_READY_TIMEOUT_SECONDS = 300;
/**
 * The Docker runtime pulls the image inside POST /sandboxes, so the request can
 * take minutes on a cold host. The Convex action limit is 10 minutes.
 */
export const DEFAULT_CREATE_REQUEST_TIMEOUT_SECONDS = 300;
export const MAX_CREATE_REQUEST_TIMEOUT_SECONDS = 480;
export const DEFAULT_ENTRYPOINT = ["tail", "-f", "/dev/null"];
export const DEFAULT_RESOURCE_LIMITS: Record<string, string> = { cpu: "1", memory: "2Gi" };

/** A create that is still `creating` with no id is adopted, not duplicated, after this. */
export const STALE_CREATE_MS = 10 * 60_000;

export const MAX_COMMAND_CHARS = 100_000;
export const MAX_EXEC_TIMEOUT_MS = 9 * 60_000;
export const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
/** Characters of stdout (and separately stderr) returned from one call. */
export const MAX_OUTPUT_CHARS = 1024 * 1024;
/** Bytes of a command event stream read before the component stops reading. */
export const MAX_STREAM_BYTES = 4 * 1024 * 1024;
export const MAX_WRITE_BYTES = 8 * 1024 * 1024;
export const MAX_READ_BYTES = 8 * 1024 * 1024;
/** Stored on execution rows, only with retainOutput. */
export const STORED_INPUT_CHARS = 4_096;
export const STORED_OUTPUT_CHARS = 65_536;

/** Metadata keys this component writes on every sandbox it creates. Label-safe by construction. */
export const META_TOKEN = "convex-token";
export const META_OWNER = "convex-owner";
export const META_KEY = "convex-key";
export const META_MANAGED = "convex-managed";
/** Every key the component reserves. Callers may not set or patch these. */
export const RESERVED_META_KEYS = new Set([META_TOKEN, META_OWNER, META_KEY, META_MANAGED]);
/** Older releases wrote these. Still recognized on adoption. */
export const LEGACY_META_TOKEN = "osb.convex.token";

export interface Connection {
  apiKey: string;
  /** Origin plus any path prefix, without `/v1`. */
  origin: string;
  protocol: "http" | "https";
}

export function resolveConnection(raw: {
  OPENSANDBOX_API_KEY?: string;
  OPENSANDBOX_DOMAIN?: string;
  OPENSANDBOX_PROTOCOL?: string;
}): Connection {
  const apiKey = raw.OPENSANDBOX_API_KEY?.trim() ?? "";
  if (!apiKey) {
    throw osError(
      "config",
      "OPENSANDBOX_API_KEY is not set. Set it on the deployment and pass it to the component in convex.config.ts.",
    );
  }
  const domain = raw.OPENSANDBOX_DOMAIN?.trim() ?? "";
  if (!domain) {
    throw osError(
      "config",
      "OPENSANDBOX_DOMAIN is not set. Pass the OpenSandbox server, for example localhost:8080.",
    );
  }
  const protocolOverride = raw.OPENSANDBOX_PROTOCOL?.trim().toLowerCase() || undefined;
  if (protocolOverride && protocolOverride !== "http" && protocolOverride !== "https") {
    throw osError("config", "OPENSANDBOX_PROTOCOL must be http or https.");
  }

  let input = domain;
  if (!/^https?:\/\//i.test(input)) {
    const host = input.split("/")[0] ?? "";
    const hostname = host.startsWith("[")
      ? host.slice(1, host.indexOf("]"))
      : host.replace(/:\d+$/, "");
    const local = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    input = `${protocolOverride ?? (local ? "http" : "https")}://${input}`;
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw osError("config", "OPENSANDBOX_DOMAIN is not a valid host or URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw osError("config", "OPENSANDBOX_DOMAIN must use http or https.");
  }
  if (url.username || url.password || url.hash || url.search) {
    throw osError("config", "OPENSANDBOX_DOMAIN must not include credentials, a query, or a hash.");
  }
  let path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/v1")) path = path.slice(0, -3);
  return {
    apiKey,
    origin: `${url.origin}${path}`,
    protocol: url.protocol === "https:" ? "https" : "http",
  };
}

export type QueryValue = string | number | boolean | undefined | null | ReadonlyArray<string>;

/** Append a path and query to a base URL that may already carry a path prefix or query. */
export function joinUrl(base: string, path: string, query?: Record<string, QueryValue>): string {
  const url = new URL(base);
  const prefix = url.pathname.replace(/\/+$/, "");
  url.pathname = `${prefix}${path.startsWith("/") ? path : `/${path}`}`;
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, item);
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/** A lifecycle API URL: `{origin}/v1{path}`. */
export function apiUrl(origin: string, path: string, query?: Record<string, QueryValue>): string {
  return joinUrl(origin, `/v1${path.startsWith("/") ? path : `/${path}`}`, query);
}

/** Turn the lifecycle `endpoint` field (host[:port][/path], no scheme) into a base URL. */
export function endpointBaseUrl(protocol: "http" | "https", endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed) throw osError("invalid_response", "OpenSandbox returned an empty endpoint.");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `${protocol}://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw osError("invalid_response", "OpenSandbox returned an endpoint that is not a URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw osError("invalid_response", "OpenSandbox returned an endpoint that is not http(s).");
  }
  if (url.username || url.password) {
    throw osError("invalid_response", "OpenSandbox returned an endpoint with credentials in it.");
  }
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export function requireText(
  name: string,
  value: string,
  max: number,
  code: OpenSandboxErrorCode = "invalid_argument",
): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw osError(code, `${name} is required and must not start or end with whitespace.`);
  }
  if (value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw osError(code, `${name} must be ${max} characters or fewer, without control characters.`);
  }
  return value;
}

export function requireInt(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw osError("invalid_argument", `${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}
