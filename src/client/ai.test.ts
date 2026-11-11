import { describe, expect, test, vi } from "vitest";
import { createAiSdkTools } from "./ai.js";
import type { OpenSandbox, RunActionCtx } from "./index.js";

type Execute = (input: unknown, options: unknown) => Promise<unknown>;

function stub() {
  const calls: Array<[string, unknown]> = [];
  const record = (name: string, value: unknown) => async (_ctx: unknown, args: unknown) => {
    calls.push([name, args]);
    return value;
  };
  const sandboxes = {
    create: vi.fn(record("create", { state: "Running" })),
    exec: record("exec", { status: "succeeded", exitCode: 0, stdout: "x".repeat(50), stderr: "" }),
    runCode: record("runCode", { status: "succeeded", stdout: "hi\n", stderr: "", results: [{ text: "42" }] }),
    readFile: record("readFile", { text: "file text", truncated: false }),
    writeFile: record("writeFile", { path: "/a", sizeBytes: 3 }),
    listFiles: record("listFiles", [{ path: "/a", type: "file", size: 3, mode: 0o644, owner: "root", group: "root" }]),
    previewUrl: record("previewUrl", "https://preview.example/"),
  };
  return { sandboxes: sandboxes as unknown as OpenSandbox, calls, create: sandboxes.create };
}

const ctx = {} as RunActionCtx;
const run = (tool: unknown, input: unknown) => (tool as { execute: Execute }).execute(input, { toolCallId: "1", messages: [] });

describe("createAiSdkTools", () => {
  test("offers only the tools asked for, with approval settings passed through", () => {
    const { sandboxes } = stub();
    const tools = createAiSdkTools(sandboxes, ctx, {
      ownerId: "u",
      key: "k",
      tools: { runCommand: {}, writeFile: { needsApproval: true }, readFile: false },
    });
    expect(Object.keys(tools).sort()).toEqual(["runCommand", "writeFile"]);
    expect((tools.writeFile as { needsApproval?: unknown }).needsApproval).toBe(true);
  });

  test("creates the sandbox once, on first use, then runs against it", async () => {
    const { sandboxes, calls, create } = stub();
    const tools = createAiSdkTools(sandboxes, ctx, {
      ownerId: "u",
      key: "thread:1",
      create: { image: "python:3.12" },
      maxOutputChars: 10,
      tools: { runCommand: {}, listFiles: {}, runCode: {} },
    });
    const first = (await run(tools.runCommand, { command: "ls" })) as { stdout: string };
    await run(tools.listFiles, { path: "/" });
    const code = (await run(tools.runCode, { code: "6*7" })) as { results: Array<{ text: string }> };
    expect(create).toHaveBeenCalledTimes(1);
    expect(calls[0]).toEqual(["create", { image: "python:3.12", ownerId: "u", key: "thread:1" }]);
    expect(calls[1]).toEqual(["exec", { ownerId: "u", key: "thread:1", command: "ls" }]);
    // Output handed to the model is clipped.
    expect(first.stdout.startsWith("xxxxxxxxxx\n[... 40 more characters]")).toBe(true);
    expect(code.results).toEqual([{ text: "42" }]);
  });

  test("a failed create is retried on the next call", async () => {
    const { sandboxes, create } = stub();
    create.mockRejectedValueOnce(new Error("boom"));
    const tools = createAiSdkTools(sandboxes, ctx, { ownerId: "u", key: "k", create: { image: "x" }, tools: { readFile: {} } });
    await expect(run(tools.readFile, { path: "/a" })).rejects.toThrow("boom");
    expect(await run(tools.readFile, { path: "/a" })).toEqual({ text: "file text", truncated: false });
    expect(create).toHaveBeenCalledTimes(2);
  });
});
