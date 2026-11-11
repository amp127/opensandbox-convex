import { errorData, osError, scrub, type OpenSandboxErrorCode } from "./errors.js";
import { flushEvents, isTerminal, takeEvents, type StreamEvent } from "./sse.js";
import { MAX_STREAM_BYTES } from "./urls.js";

const JSON_CAP = 4 * 1024 * 1024;
const USER_AGENT = "opensandbox-convex/0.2";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface SendOptions {
  url: string;
  method: Method;
  headers?: Record<string, string>;
  /** JSON request body. DELETE with a body is allowed (network policy uses it). */
  json?: unknown;
  form?: FormData;
  timeoutMs: number;
  maxBytes?: number;
  /** When the cap is reached: throw `too_large` (default) or return what was read. */
  onOverflow?: "throw" | "truncate";
  /** Sent as OPEN-SANDBOX-API-KEY. */
  apiKey?: string;
  /** Removed from error text. Defaults to apiKey. */
  scrubKey?: string;
  accept?: string;
  /**
   * Called before a network or unavailable error is thrown. It may throw a
   * better error (the sandbox is no longer Running, say).
   */
  onUnreachable?: () => Promise<void>;
}

export interface RawResponse {
  status: number;
  bytes: Uint8Array;
  truncated: boolean;
  headers: Headers;
}

export async function sendJson(options: SendOptions): Promise<{ status: number; body: unknown; headers: Headers }> {
  const response = await send(options);
  const contentType = response.headers.get("content-type") ?? "";
  if (response.bytes.byteLength === 0) return { status: response.status, body: null, headers: response.headers };
  const text = new TextDecoder().decode(response.bytes);
  const trimmed = text.trimStart();
  const looksJson = contentType.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[");
  if (!looksJson) return { status: response.status, body: null, headers: response.headers };
  try {
    return { status: response.status, body: JSON.parse(text) as unknown, headers: response.headers };
  } catch {
    throw osError("invalid_response", "OpenSandbox answered with JSON that could not be parsed.", {
      status: response.status,
    });
  }
}

export async function sendBytes(options: SendOptions): Promise<RawResponse> {
  return await send(options);
}

export interface StreamResult {
  events: StreamEvent[];
  /** The stream ended (or was cut) before a terminal event. */
  cut: boolean;
  /** The byte cap was reached. */
  overflowed: boolean;
  /** The deadline passed while reading. `events` holds what arrived first. */
  timedOut: boolean;
}

/**
 * POST a run request and read its event stream until a terminal event, the
 * end of the stream, or the byte cap. Output past the cap is dropped, not an
 * error: the run keeps going in the sandbox either way.
 */
export async function sendEventStream(
  options: SendOptions & {
    /**
     * `end`: read until the server closes the stream. A terminal event does
     * not stop reading, because execd can send a cell's output after its
     * execution_complete; after one, reading stops at most `graceMs` later.
     * `terminal`: stop at the first terminal event (background starts).
     * `init`: stop at init.
     */
    stopAfter: "end" | "terminal" | "init";
    graceMs?: number;
  },
): Promise<StreamResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const secret = options.scrubKey ?? options.apiKey;
  try {
    const response = await fetch(options.url, {
      method: options.method,
      headers: requestHeaders(options, "application/json", "text/event-stream"),
      body: options.json === undefined ? undefined : JSON.stringify(options.json),
      signal: controller.signal,
    });
    if (!response.ok) {
      const { bytes } = await readBounded(response, JSON_CAP, "truncate");
      throw httpError(response.status, bytes, response.headers, secret);
    }
    return await readEvents(response, options.stopAfter, controller.signal, options.graceMs ?? 2_000);
  } catch (error) {
    throw await explain(transportError(error, secret), options);
  } finally {
    clearTimeout(timer);
  }
}

async function explain(error: Error, options: SendOptions): Promise<Error> {
  const code = errorData(error)?.code;
  if (options.onUnreachable && (code === "unavailable" || code === "network")) {
    try {
      await options.onUnreachable();
    } catch (better) {
      return better as Error;
    }
  }
  return error;
}

async function send(options: SendOptions): Promise<RawResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const secret = options.scrubKey ?? options.apiKey;
  const contentType = options.form || options.json === undefined ? undefined : "application/json";
  try {
    const response = await fetch(options.url, {
      method: options.method,
      headers: requestHeaders(options, contentType, options.accept ?? "application/json"),
      body: options.form ?? (options.json === undefined ? undefined : JSON.stringify(options.json)),
      signal: controller.signal,
    });
    if (!response.ok) {
      const { bytes } = await readBounded(response, JSON_CAP, "truncate");
      throw httpError(response.status, bytes, response.headers, secret);
    }
    const { bytes, truncated } = await readBounded(
      response,
      options.maxBytes ?? JSON_CAP,
      options.onOverflow ?? "throw",
    );
    return { status: response.status, bytes, truncated, headers: response.headers };
  } catch (error) {
    throw await explain(transportError(error, secret), options);
  } finally {
    clearTimeout(timer);
  }
}

function requestHeaders(
  options: SendOptions,
  contentType: string | undefined,
  accept: string,
): Record<string, string> {
  const headers: Record<string, string> = { accept, "user-agent": USER_AGENT, ...options.headers };
  if (contentType) headers["content-type"] = contentType;
  if (options.apiKey) headers["OPEN-SANDBOX-API-KEY"] = options.apiKey;
  return headers;
}

async function readBounded(
  response: Response,
  maxBytes: number,
  onOverflow: "throw" | "truncate",
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength <= maxBytes) return { bytes, truncated: false };
    if (onOverflow === "throw") throw tooLarge();
    return { bytes: bytes.slice(0, maxBytes), truncated: true };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (total + value.byteLength > maxBytes) {
      await reader.cancel().catch(() => undefined);
      if (onOverflow === "throw") throw tooLarge();
      chunks.push(value.slice(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      break;
    }
    total += value.byteLength;
    chunks.push(value);
  }
  return { bytes: concat(chunks, total), truncated };
}

function tooLarge() {
  return osError("too_large", "OpenSandbox's response was larger than the component allows.");
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function readEvents(
  response: Response,
  stopAfter: "end" | "terminal" | "init",
  signal: AbortSignal,
  graceMs: number,
): Promise<StreamResult> {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: StreamEvent[] = [];
  const ended = () => events.some(isTerminal);
  const done = () =>
    stopAfter === "init"
      ? events.some((event) => event.type === "init" || isTerminal(event))
      : stopAfter === "terminal"
        ? ended()
        : false;
  if (!reader) {
    const text = decoder.decode(new Uint8Array(await response.arrayBuffer()));
    const taken = takeEvents(text);
    events.push(...taken.events, ...flushEvents(taken.rest));
    return { events, cut: !(done() || ended()), overflowed: false, timedOut: false };
  }
  let graceUntil: number | undefined;
  let total = 0;
  let overflowed = false;
  let timedOut = false;
  try {
    while (!done()) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      if (stopAfter === "end" && graceUntil === undefined && ended()) graceUntil = Date.now() + graceMs;
      try {
        if (graceUntil === undefined) {
          chunk = await reader.read();
        } else {
          const left = graceUntil - Date.now();
          if (left <= 0) break;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const late = await Promise.race([
            reader.read(),
            new Promise<null>((resolve) => {
              timer = setTimeout(() => resolve(null), left);
            }),
          ]);
          clearTimeout(timer);
          if (late === null) break;
          chunk = late;
        }
      } catch (error) {
        // Past the deadline: keep what arrived. The caller decides what it means.
        if (signal.aborted) {
          timedOut = true;
          break;
        }
        throw error;
      }
      const { done: finished, value } = chunk;
      if (finished) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_STREAM_BYTES) {
        overflowed = true;
        break;
      }
      const taken = takeEvents(buffer + decoder.decode(value, { stream: true }));
      buffer = taken.rest;
      events.push(...taken.events);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (!overflowed && !timedOut) events.push(...flushEvents(buffer + decoder.decode()));
  return { events, cut: !(done() || ended()), overflowed, timedOut };
}

export function httpError(status: number, bytes: Uint8Array, headers: Headers, secret?: string): Error {
  let remoteCode: string | undefined;
  let message = `OpenSandbox returned HTTP ${status}.`;
  if (bytes.byteLength > 0) {
    try {
      const body = JSON.parse(new TextDecoder().decode(bytes)) as {
        code?: unknown;
        message?: unknown;
        error?: unknown;
        detail?: unknown;
      };
      // Lifecycle errors are {code, message}; FastAPI validation errors put them under detail.
      const detail =
        body.detail && typeof body.detail === "object" && !Array.isArray(body.detail)
          ? (body.detail as { code?: unknown; message?: unknown })
          : undefined;
      const code = body.code ?? detail?.code;
      const text = body.message ?? detail?.message ?? body.error;
      if (typeof code === "string") remoteCode = scrub(code);
      if (typeof text === "string" && text.trim()) message = scrub(text, secret);
      else if (Array.isArray(body.detail)) message = scrub(`Invalid request: ${JSON.stringify(body.detail)}`, secret);
    } catch {
      // Not JSON. Keep the status message.
    }
  }
  const retryAfter = headers.get("retry-after");
  const retryAfterSeconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined;
  const requestId = headers.get("x-request-id")?.slice(0, 100) ?? undefined;
  return osError(codeForStatus(status, remoteCode), message, { status, remoteCode, retryAfterSeconds, requestId });
}

function codeForStatus(status: number, remoteCode?: string): OpenSandboxErrorCode {
  if (status === 400 || status === 422) return "invalid_argument";
  if (status === 401) return "unauthenticated";
  if (status === 403) return remoteCode?.includes("QUOTA") ? "rate_limited" : "forbidden";
  if (status === 404) return "not_found";
  if (status === 405 || status === 501) return "unsupported";
  if (status === 409) return "conflict";
  if (status === 408) return "timeout";
  if (status === 413) return "too_large";
  if (status === 416) return "invalid_argument";
  if (status === 429) return "rate_limited";
  if (status === 502 || status === 503 || status === 504) return "unavailable";
  if (status >= 500) return "server_error";
  return "invalid_response";
}

function transportError(error: unknown, secret?: string): Error {
  if (errorData(error)) return error as Error;
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError" || name === "TimeoutError") {
    return osError("timeout", "OpenSandbox did not answer before the deadline.");
  }
  const message = error instanceof Error ? scrub(error.message, secret) : "Network error.";
  return osError("network", message || "The request to OpenSandbox failed.");
}
