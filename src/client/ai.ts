/**
 * AI SDK tools backed by one OpenSandbox sandbox.
 *
 * ```ts
 * import { createAiSdkTools } from "opensandbox-convex/ai";
 * const tools = createAiSdkTools(sandboxes, ctx, {
 *   ownerId: user.subject,
 *   key: `thread:${threadId}`,
 *   create: { image: "python:3.12" },
 *   tools: { runCommand: {}, readFile: {}, writeFile: { needsApproval: true }, listFiles: {} },
 * });
 * ```
 *
 * The sandbox is created (or resumed) on first use. Every tool is opt-in.
 */
import { jsonSchema, tool, type ToolSet } from "ai";
import type { CreateSandboxArgs, OpenSandbox, RunActionCtx } from "./index.js";

type Approval<Input> = boolean | ((input: Input, options: unknown) => boolean | Promise<boolean>);
interface Capability<Input> {
  needsApproval?: Approval<Input>;
}

type CommandInput = { command: string; cwd?: string; timeoutMs?: number };
type CodeInput = { code: string; language?: string };
type ReadInput = { path: string; offset?: number; maxBytes?: number };
type WriteInput = { path: string; content: string };
type ListInput = { path: string; depth?: number };
type PortInput = { port: number };

export interface AiSdkToolsOptions {
  ownerId: string;
  key: string;
  /** Create options used if the sandbox does not exist yet. Omit to require an existing sandbox. */
  create?: Omit<CreateSandboxArgs, "ownerId" | "key">;
  /** Cap on output characters handed back to the model per stream. Default 20000. */
  maxOutputChars?: number;
  tools: {
    runCommand?: false | Capability<CommandInput>;
    runCode?: false | (Capability<CodeInput> & { contextId?: string });
    readFile?: false | Capability<ReadInput>;
    writeFile?: false | Capability<WriteInput>;
    listFiles?: false | Capability<ListInput>;
    previewUrl?: false | Capability<PortInput>;
  };
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[... ${text.length - max} more characters]`;
}

export function createAiSdkTools(sandboxes: OpenSandbox, ctx: RunActionCtx, options: AiSdkToolsOptions): ToolSet {
  const ref = { ownerId: options.ownerId, key: options.key };
  const max = options.maxOutputChars ?? 20_000;
  let ready: Promise<unknown> | null = null;
  const ensure = async () => {
    if (!options.create) return;
    ready ??= sandboxes.create(ctx, { ...options.create, ...ref }).catch((error: unknown) => {
      ready = null;
      throw error;
    });
    await ready;
  };
  const tools: ToolSet = {};
  const { runCommand, runCode, readFile, writeFile, listFiles, previewUrl } = options.tools;

  if (runCommand) {
    tools.runCommand = tool({
      description: "Run a bash command in the sandbox and return its exit code, stdout, and stderr.",
      inputSchema: jsonSchema<CommandInput>({
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command." },
          cwd: { type: "string", description: "Working directory." },
          timeoutMs: { type: "number", minimum: 1000, maximum: 540000 },
        },
        required: ["command"],
        additionalProperties: false,
      }),
      needsApproval: runCommand.needsApproval,
      execute: async (input) => {
        await ensure();
        const result = await sandboxes.exec(ctx, { ...ref, ...input });
        return {
          status: result.status,
          exitCode: result.exitCode,
          stdout: clip(result.stdout, max),
          stderr: clip(result.stderr, max),
          ...(result.error ? { error: result.error } : {}),
        };
      },
    });
  }

  if (runCode) {
    tools.runCode = tool({
      description: "Run code in a persistent Jupyter kernel in the sandbox (Python by default).",
      inputSchema: jsonSchema<CodeInput>({
        type: "object",
        properties: {
          code: { type: "string" },
          language: { type: "string", description: "python, javascript, bash, ..." },
        },
        required: ["code"],
        additionalProperties: false,
      }),
      needsApproval: runCode.needsApproval,
      execute: async (input) => {
        await ensure();
        const result = await sandboxes.runCode(ctx, { ...ref, ...input, contextId: runCode.contextId });
        return {
          status: result.status,
          stdout: clip(result.stdout, max),
          stderr: clip(result.stderr, max),
          results: result.results.map((item) => (typeof item.text === "string" ? { text: clip(item.text, max) } : item)),
          ...(result.exception ? { exception: result.exception } : {}),
        };
      },
    });
  }

  if (readFile) {
    tools.readFile = tool({
      description: "Read a UTF-8 file from the sandbox.",
      inputSchema: jsonSchema<ReadInput>({
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "number", minimum: 0 },
          maxBytes: { type: "number", minimum: 1, maximum: 1048576 },
        },
        required: ["path"],
        additionalProperties: false,
      }),
      needsApproval: readFile.needsApproval,
      execute: async (input) => {
        await ensure();
        const result = await sandboxes.readFile(ctx, { ...ref, ...input, maxBytes: input.maxBytes ?? 65536 });
        return { text: clip(result.text, max), truncated: result.truncated };
      },
    });
  }

  if (writeFile) {
    tools.writeFile = tool({
      description: "Write a UTF-8 file in the sandbox, creating parent directories.",
      inputSchema: jsonSchema<WriteInput>({
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false,
      }),
      needsApproval: writeFile.needsApproval,
      execute: async (input) => {
        await ensure();
        return await sandboxes.writeFile(ctx, { ...ref, ...input, mode: 0o644 });
      },
    });
  }

  if (listFiles) {
    tools.listFiles = tool({
      description: "List a directory in the sandbox.",
      inputSchema: jsonSchema<ListInput>({
        type: "object",
        properties: { path: { type: "string" }, depth: { type: "number", minimum: 1, maximum: 5 } },
        required: ["path"],
        additionalProperties: false,
      }),
      needsApproval: listFiles.needsApproval,
      execute: async (input) => {
        await ensure();
        const entries = await sandboxes.listFiles(ctx, { ...ref, ...input });
        return entries.slice(0, 500).map((entry) => ({ path: entry.path, type: entry.type, size: entry.size }));
      },
    });
  }

  if (previewUrl) {
    tools.previewUrl = tool({
      description: "Get the URL for a server listening on a port in the sandbox.",
      inputSchema: jsonSchema<PortInput>({
        type: "object",
        properties: { port: { type: "number", minimum: 1, maximum: 65535 } },
        required: ["port"],
        additionalProperties: false,
      }),
      needsApproval: previewUrl.needsApproval,
      execute: async (input) => {
        await ensure();
        return { url: await sandboxes.previewUrl(ctx, { ...ref, ...input }) };
      },
    });
  }

  return tools;
}
