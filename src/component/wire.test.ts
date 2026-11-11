import { describe, expect, test } from "vitest";
import { errorData } from "./errors.js";
import { buildCreateBody, isLabelValue, labelDigest, modeFromWire, modeToWire, validateCreate } from "./remote.js";
import { flushEvents, foldEvents, runStatus, takeEvents } from "./sse.js";
import { apiUrl, endpointBaseUrl, joinUrl, resolveConnection } from "./urls.js";

function code(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    return errorData(error)?.code;
  }
  return undefined;
}

describe("event stream", () => {
  test("parses execd's raw JSON framing", () => {
    const wire = '{"type":"init","text":"c1"}\n\n{"type":"stdout","text":"a\\n"}\n\n{"type":"execution_complete"}\n\n';
    const { events, rest } = takeEvents(wire);
    expect(events.map((event) => event.type)).toEqual(["init", "stdout", "execution_complete"]);
    expect(rest).toBe("");
  });

  test("parses data: framing and skips comments and noise", () => {
    const { events } = takeEvents(': keepalive\nevent: x\ndata: {"type":"stdout","text":"b"}\n\nnot json\n');
    expect(events).toEqual([{ type: "stdout", text: "b" }]);
  });

  test("keeps a split line for the next chunk", () => {
    const first = takeEvents('{"type":"stdout","te');
    expect(first.events).toEqual([]);
    const second = takeEvents(`${first.rest}xt":"z"}\n`);
    expect(second.events).toEqual([{ type: "stdout", text: "z" }]);
    expect(flushEvents('{"type":"ping"}')).toEqual([{ type: "ping" }]);
  });

  test("a non-zero exit is an error event with the code in evalue", () => {
    const run = foldEvents(
      [
        { type: "init", text: "c" },
        { type: "stderr", text: "boom" },
        { type: "error", error: { ename: "CommandExecError", evalue: "3", traceback: ["exit status 3"] } },
      ],
      100,
    );
    expect(run.exitCode).toBe(3);
    expect(runStatus(run, 10, 60_000)).toBe("failed");
  });

  test("complete without exit_code means 0; exit_code wins when sent", () => {
    expect(foldEvents([{ type: "execution_complete" }], 10).exitCode).toBe(0);
    expect(foldEvents([{ type: "execution_complete", exit_code: 0 }], 10).exitCode).toBe(0);
  });

  test("a signal at the deadline is a timeout", () => {
    const run = foldEvents([{ type: "error", error: { ename: "CommandExecError", evalue: "-1", exit_code: -1 } }], 10);
    expect(runStatus(run, 5_000, 5_000)).toBe("timed_out");
    expect(runStatus(run, 100, 5_000)).toBe("failed");
  });

  test("line-framed output (execd 1.1.x) gets its line endings back", () => {
    const run = foldEvents(
      [
        { type: "stdout", text: "a" },
        { type: "stderr", text: "err" },
        { type: "stdout", text: "" },
        { type: "stdout", text: "b" },
      ],
      100,
    );
    expect(run.stdout).toBe("a\n\nb\n");
    expect(run.stderr).toBe("err\n");
    const modern = foldEvents([{ type: "stdout", text: "a\nb" }, { type: "stdout", text: "c\n" }], 100);
    expect(modern.stdout).toBe("a\nbc\n");
  });

  test("caps output and marks truncation", () => {
    const run = foldEvents([{ type: "stdout", text: "ab\ncdef" }, { type: "stdout", text: "gh" }], 4);
    expect(run.stdout).toBe("ab\nc");
    expect(run.truncated).toBe(true);
  });
});

describe("connection", () => {
  test("defaults: localhost is http, other hosts https, /v1 stripped", () => {
    expect(resolveConnection({ OPENSANDBOX_API_KEY: "k", OPENSANDBOX_DOMAIN: "localhost:8080" }).origin).toBe(
      "http://localhost:8080",
    );
    expect(resolveConnection({ OPENSANDBOX_API_KEY: "k", OPENSANDBOX_DOMAIN: "[::1]:8080" }).protocol).toBe("http");
    const remote = resolveConnection({ OPENSANDBOX_API_KEY: "k", OPENSANDBOX_DOMAIN: "1.2.3.4:8080/os/v1/" });
    expect(remote.origin).toBe("https://1.2.3.4:8080/os");
    expect(
      resolveConnection({ OPENSANDBOX_API_KEY: "k", OPENSANDBOX_DOMAIN: "1.2.3.4:8080", OPENSANDBOX_PROTOCOL: "HTTP" })
        .protocol,
    ).toBe("http");
  });

  test("rejects missing or unsafe config", () => {
    expect(code(() => resolveConnection({ OPENSANDBOX_DOMAIN: "x" }))).toBe("config");
    expect(code(() => resolveConnection({ OPENSANDBOX_API_KEY: "k", OPENSANDBOX_DOMAIN: "https://u:p@x" }))).toBe("config");
    expect(code(() => resolveConnection({ OPENSANDBOX_API_KEY: "k", OPENSANDBOX_DOMAIN: "x", OPENSANDBOX_PROTOCOL: "ftp" }))).toBe(
      "config",
    );
  });

  test("joins paths before an existing query, and repeats array params", () => {
    expect(joinUrl("http://h/base?tok=1", "/files/info", { path: ["/a", "/b"] })).toBe(
      "http://h/base/files/info?tok=1&path=%2Fa&path=%2Fb",
    );
    expect(apiUrl("http://h/pre", "/sandboxes", { page: 2 })).toBe("http://h/pre/v1/sandboxes?page=2");
  });

  test("endpoint without scheme takes the connection protocol", () => {
    expect(endpointBaseUrl("https", "gw.example.com/sandboxes/s/port/44772/")).toBe(
      "https://gw.example.com/sandboxes/s/port/44772",
    );
    expect(endpointBaseUrl("http", "1.2.3.4:40001")).toBe("http://1.2.3.4:40001");
  });
});

describe("create body", () => {
  const ownership = { token: "t-1", ownerDigest: "aa", keyDigest: "bb" };

  test("an image gets the default entrypoint; null timeout omits the field", () => {
    const body = buildCreateBody({ image: "python:3.12", timeoutSeconds: null }, ownership);
    expect(body.entrypoint).toEqual(["tail", "-f", "/dev/null"]);
    expect("timeout" in body).toBe(false);
    expect((body.metadata as Record<string, string>)["convex-token"]).toBe("t-1");
  });

  test("passes every advanced option through", () => {
    const body = buildCreateBody(
      {
        image: "img",
        imageAuth: { username: "u", password: "p" },
        platform: { os: "linux", arch: "arm64" },
        networkPolicy: { egress: [{ action: "allow", target: "pypi.org" }] },
        volumes: [{ name: "data", mountPath: "/data", pvc: { claimName: "c" } }],
        lifecycle: { idlePolicy: { idleTimeoutSeconds: 300, onIdle: "pause" } },
        secureAccess: true,
        credentialProxy: true,
        extensions: { poolRef: "p" },
        resourceRequests: { cpu: "250m" },
      },
      ownership,
    );
    expect(body.image).toEqual({ uri: "img", auth: { username: "u", password: "p" } });
    expect(body.networkPolicy).toEqual({ defaultAction: "deny", egress: [{ action: "allow", target: "pypi.org" }] });
    expect(body.credentialProxy).toEqual({ enabled: true });
    expect(body.platform).toEqual({ os: "linux", arch: "arm64" });
  });

  test("validates like the server", () => {
    expect(code(() => validateCreate({}))).toBe("invalid_argument");
    expect(code(() => validateCreate({ image: "a", snapshotId: "b" }))).toBe("invalid_argument");
    expect(code(() => validateCreate({ image: "a", metadata: { team: "has space" } }))).toBe("invalid_argument");
    expect(code(() => validateCreate({ image: "a", metadata: { "opensandbox.io/x": "y" } }))).toBe("invalid_argument");
    expect(code(() => validateCreate({ image: "a", metadata: { "convex-token": "y" } }))).toBe("invalid_argument");
    expect(code(() => validateCreate({ image: "a", volumes: [{ name: "v", mountPath: "/m" }] }))).toBe("invalid_argument");
    expect(code(() => validateCreate({ extensions: { poolRef: "p" } }))).toBeUndefined();
  });

  test("owner digests are label-safe for any owner id", async () => {
    const digest = await labelDigest("https://issuer.example|user_123|session with spaces");
    expect(isLabelValue(digest)).toBe(true);
    expect(digest).toHaveLength(40);
  });
});

describe("file modes", () => {
  test("permission bits become execd's octal digits and back", () => {
    expect(modeToWire(0o755)).toBe(755);
    expect(modeToWire(0o644)).toBe(644);
    expect(modeToWire(0o4755)).toBe(4755);
    expect(modeFromWire(644)).toBe(0o644);
    expect(modeFromWire(999)).toBe(0);
    expect(code(() => modeToWire(0o17777))).toBe("invalid_argument");
  });
});
