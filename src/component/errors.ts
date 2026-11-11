import { ConvexError } from "convex/values";

export const ERROR_KIND = "OpenSandboxError" as const;

export type OpenSandboxErrorCode =
  | "config"
  | "invalid_argument"
  | "not_found"
  | "not_ready"
  | "conflict"
  | "unauthenticated"
  | "forbidden"
  | "failed"
  | "provisioning_timeout"
  | "rate_limited"
  | "too_large"
  | "output_too_large"
  | "server_error"
  | "unavailable"
  | "timeout"
  | "network"
  | "invalid_response"
  | "unsupported";

export type OpenSandboxErrorData = {
  kind: typeof ERROR_KIND;
  code: OpenSandboxErrorCode;
  message: string;
  /** HTTP status, when the server answered. */
  status?: number;
  /** OpenSandbox's `code` field, when it sent one. */
  remoteCode?: string;
  /** Sandbox state, for `not_ready`. */
  state?: string;
  retryAfterSeconds?: number;
  /** OpenSandbox's X-Request-ID, for correlating with server logs. */
  requestId?: string;
};

export function osError(
  code: OpenSandboxErrorCode,
  message: string,
  extra: Omit<OpenSandboxErrorData, "kind" | "code" | "message"> = {},
): ConvexError<OpenSandboxErrorData> {
  const data: OpenSandboxErrorData = { kind: ERROR_KIND, code, message };
  if (extra.status !== undefined) data.status = extra.status;
  if (extra.remoteCode !== undefined) data.remoteCode = extra.remoteCode;
  if (extra.state !== undefined) data.state = extra.state;
  if (extra.retryAfterSeconds !== undefined) data.retryAfterSeconds = extra.retryAfterSeconds;
  if (extra.requestId !== undefined) data.requestId = extra.requestId;
  return new ConvexError(data);
}

export function errorData(error: unknown): OpenSandboxErrorData | null {
  let data = (error as { data?: unknown } | null)?.data;
  // Across a function or component boundary, ConvexError data can arrive as JSON text.
  if (typeof data === "string" && data.startsWith("{")) {
    try {
      data = JSON.parse(data) as unknown;
    } catch {
      return null;
    }
  }
  if (
    typeof data === "object" &&
    data !== null &&
    (data as { kind?: unknown }).kind === ERROR_KIND
  ) {
    return data as OpenSandboxErrorData;
  }
  return null;
}

export function isOsError(error: unknown): error is ConvexError<OpenSandboxErrorData> {
  return errorData(error) !== null;
}

/** The request may have reached OpenSandbox and its outcome is unknown. */
export function outcomeUnknown(error: unknown): boolean {
  const data = errorData(error);
  if (!data) return true;
  return ["timeout", "network", "unavailable", "server_error", "invalid_response"].includes(
    data.code,
  );
}

/** Drop the API key, URLs, and newlines from text that might be stored or returned. */
export function scrub(message: string, secret?: string): string {
  let text = message;
  if (secret) text = text.split(secret).join("[redacted]");
  text = text.replace(/https?:\/\/\S+/g, "[url]");
  text = text.replace(/[\r\n\u0000]+/g, " ").trim();
  return text.slice(0, 300);
}
