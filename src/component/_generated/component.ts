/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    code: {
      createContext: FunctionReference<
        "action",
        "internal",
        {
          key: string;
          language?: string;
          ownerId: string;
          useServerProxy?: boolean;
        },
        { contextId: string; language: string },
        Name
      >;
      deleteContext: FunctionReference<
        "action",
        "internal",
        {
          contextId?: string;
          key: string;
          language?: string;
          ownerId: string;
          useServerProxy?: boolean;
        },
        null,
        Name
      >;
      interrupt: FunctionReference<
        "action",
        "internal",
        {
          executionId: string;
          key: string;
          ownerId: string;
          useServerProxy?: boolean;
        },
        null,
        Name
      >;
      listContexts: FunctionReference<
        "action",
        "internal",
        {
          key: string;
          language?: string;
          ownerId: string;
          useServerProxy?: boolean;
        },
        Array<{ contextId: string; language: string }>,
        Name
      >;
      run: FunctionReference<
        "action",
        "internal",
        {
          code: string;
          contextId?: string;
          key: string;
          language?: string;
          ownerId: string;
          retainOutput?: boolean;
          timeoutMs?: number;
          useServerProxy?: boolean;
        },
        {
          commandId?: string;
          durationMs: number;
          error?: string;
          exception?: { name: string; traceback: Array<string>; value: string };
          executionCount?: number;
          executionId: string;
          exitCode?: number;
          outputTruncated: boolean;
          results: Array<Record<string, any>>;
          status:
            | "running"
            | "succeeded"
            | "failed"
            | "timed_out"
            | "interrupted"
            | "error"
            | "unknown";
          stderr: string;
          stdout: string;
        },
        Name
      >;
    };
    exec: {
      createSession: FunctionReference<
        "action",
        "internal",
        {
          cwd?: string;
          key: string;
          ownerId: string;
          useServerProxy?: boolean;
        },
        { sessionId: string },
        Name
      >;
      deleteSession: FunctionReference<
        "action",
        "internal",
        {
          key: string;
          ownerId: string;
          sessionId: string;
          useServerProxy?: boolean;
        },
        null,
        Name
      >;
      interrupt: FunctionReference<
        "action",
        "internal",
        {
          commandId: string;
          key: string;
          ownerId: string;
          useServerProxy?: boolean;
        },
        null,
        Name
      >;
      run: FunctionReference<
        "action",
        "internal",
        {
          command: string | Array<string>;
          cwd?: string;
          env?: Record<string, string>;
          gid?: number;
          key: string;
          ownerId: string;
          retainOutput?: boolean;
          timeoutMs?: number;
          uid?: number;
          useServerProxy?: boolean;
        },
        {
          commandId?: string;
          durationMs: number;
          error?: string;
          executionId: string;
          exitCode?: number;
          outputTruncated: boolean;
          status:
            | "running"
            | "succeeded"
            | "failed"
            | "timed_out"
            | "interrupted"
            | "error"
            | "unknown";
          stderr: string;
          stdout: string;
        },
        Name
      >;
      runInSession: FunctionReference<
        "action",
        "internal",
        {
          command: string;
          cwd?: string;
          key: string;
          ownerId: string;
          retainOutput?: boolean;
          sessionId: string;
          timeoutMs?: number;
          useServerProxy?: boolean;
        },
        {
          commandId?: string;
          durationMs: number;
          error?: string;
          executionId: string;
          exitCode?: number;
          outputTruncated: boolean;
          status:
            | "running"
            | "succeeded"
            | "failed"
            | "timed_out"
            | "interrupted"
            | "error"
            | "unknown";
          stderr: string;
          stdout: string;
        },
        Name
      >;
      spawn: FunctionReference<
        "action",
        "internal",
        {
          command: string | Array<string>;
          cwd?: string;
          env?: Record<string, string>;
          gid?: number;
          key: string;
          ownerId: string;
          retainOutput?: boolean;
          timeoutMs?: number;
          uid?: number;
          useServerProxy?: boolean;
        },
        {
          commandId?: string;
          durationMs: number;
          error?: string;
          executionId: string;
          exitCode?: number;
          outputTruncated: boolean;
          status:
            | "running"
            | "succeeded"
            | "failed"
            | "timed_out"
            | "interrupted"
            | "error"
            | "unknown";
          stderr: string;
          stdout: string;
        },
        Name
      >;
      status: FunctionReference<
        "action",
        "internal",
        {
          commandId: string;
          cursor?: number;
          key: string;
          ownerId: string;
          retainOutput?: boolean;
          statusOnly?: boolean;
          useServerProxy?: boolean;
        },
        {
          commandId: string;
          cursor?: number;
          error?: string;
          exitCode?: number;
          finishedAt?: string;
          output: string;
          outputTruncated: boolean;
          running: boolean;
          startedAt?: string;
          status:
            | "running"
            | "succeeded"
            | "failed"
            | "timed_out"
            | "interrupted"
            | "error"
            | "unknown";
        },
        Name
      >;
    };
    executions: {
      get: FunctionReference<
        "query",
        "internal",
        { executionId: string; ownerId: string },
        {
          commandId?: string;
          error?: string;
          executionId: string;
          exitCode?: number;
          finishedAt?: number;
          input?: string;
          key: string;
          kind: "exec" | "spawn" | "session" | "code";
          language?: string;
          outputTruncated?: boolean;
          ownerId: string;
          sandboxId: string;
          sessionId?: string;
          startedAt: number;
          status:
            | "running"
            | "succeeded"
            | "failed"
            | "timed_out"
            | "interrupted"
            | "error"
            | "unknown";
          stderr?: string;
          stdout?: string;
          timeoutMs?: number;
        } | null,
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        { key: string; limit?: number; ownerId: string },
        Array<{
          commandId?: string;
          error?: string;
          executionId: string;
          exitCode?: number;
          finishedAt?: number;
          input?: string;
          key: string;
          kind: "exec" | "spawn" | "session" | "code";
          language?: string;
          outputTruncated?: boolean;
          ownerId: string;
          sandboxId: string;
          sessionId?: string;
          startedAt: number;
          status:
            | "running"
            | "succeeded"
            | "failed"
            | "timed_out"
            | "interrupted"
            | "error"
            | "unknown";
          stderr?: string;
          stdout?: string;
          timeoutMs?: number;
        }>,
        Name
      >;
      listPaginated: FunctionReference<
        "query",
        "internal",
        {
          key?: string;
          ownerId: string;
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            commandId?: string;
            error?: string;
            executionId: string;
            exitCode?: number;
            finishedAt?: number;
            input?: string;
            key: string;
            kind: "exec" | "spawn" | "session" | "code";
            language?: string;
            outputTruncated?: boolean;
            ownerId: string;
            sandboxId: string;
            sessionId?: string;
            startedAt: number;
            status:
              | "running"
              | "succeeded"
              | "failed"
              | "timed_out"
              | "interrupted"
              | "error"
              | "unknown";
            stderr?: string;
            stdout?: string;
            timeoutMs?: number;
          }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        },
        Name
      >;
      purge: FunctionReference<
        "mutation",
        "internal",
        { key?: string; limit?: number; olderThanMs: number; ownerId?: string },
        { deleted: number; hasMore: boolean },
        Name
      >;
    };
    files: {
      endpoint: FunctionReference<
        "action",
        "internal",
        {
          expiresAt?: number;
          key: string;
          ownerId: string;
          port: number;
          useServerProxy?: boolean;
        },
        {
          expiresAt?: number;
          headers: Record<string, string>;
          port: number;
          url: string;
          viaServerProxy: boolean;
        },
        Name
      >;
      exists: FunctionReference<
        "action",
        "internal",
        {
          key: string;
          ownerId: string;
          path: string;
          useServerProxy?: boolean;
        },
        boolean,
        Name
      >;
      info: FunctionReference<
        "action",
        "internal",
        {
          key: string;
          ownerId: string;
          paths: Array<string>;
          useServerProxy?: boolean;
        },
        Array<{
          createdAt?: string;
          group: string;
          mode: number;
          modifiedAt?: string;
          owner: string;
          path: string;
          size: number;
          type: string;
        }>,
        Name
      >;
      list: FunctionReference<
        "action",
        "internal",
        {
          depth?: number;
          key: string;
          ownerId: string;
          path: string;
          useServerProxy?: boolean;
        },
        Array<{
          createdAt?: string;
          group: string;
          mode: number;
          modifiedAt?: string;
          owner: string;
          path: string;
          size: number;
          type: string;
        }>,
        Name
      >;
      makeDirs: FunctionReference<
        "action",
        "internal",
        {
          dirs: Array<{
            group?: string;
            mode?: number;
            owner?: string;
            path: string;
          }>;
          key: string;
          ownerId: string;
          useServerProxy?: boolean;
        },
        null,
        Name
      >;
      move: FunctionReference<
        "action",
        "internal",
        {
          key: string;
          moves: Array<{ from: string; to: string }>;
          ownerId: string;
          useServerProxy?: boolean;
        },
        null,
        Name
      >;
      read: FunctionReference<
        "action",
        "internal",
        {
          encoding?: "bytes" | "text";
          key: string;
          lines?: { count: number; fromLine: number };
          maxBytes?: number;
          offset?: number;
          ownerId: string;
          path: string;
          useServerProxy?: boolean;
        },
        {
          bytes?: ArrayBuffer;
          path: string;
          sizeBytes: number;
          text?: string;
          truncated: boolean;
        },
        Name
      >;
      remove: FunctionReference<
        "action",
        "internal",
        {
          key: string;
          ownerId: string;
          paths: Array<string>;
          recursive?: boolean;
          useServerProxy?: boolean;
        },
        null,
        Name
      >;
      replace: FunctionReference<
        "action",
        "internal",
        {
          edits: Array<{ find: string; path: string; replaceWith: string }>;
          key: string;
          ownerId: string;
          useServerProxy?: boolean;
        },
        Array<{ path: string; replacedCount?: number }>,
        Name
      >;
      search: FunctionReference<
        "action",
        "internal",
        {
          key: string;
          ownerId: string;
          path: string;
          pattern?: string;
          useServerProxy?: boolean;
        },
        Array<{
          createdAt?: string;
          group: string;
          mode: number;
          modifiedAt?: string;
          owner: string;
          path: string;
          size: number;
          type: string;
        }>,
        Name
      >;
      setPermissions: FunctionReference<
        "action",
        "internal",
        {
          entries: Array<{
            group?: string;
            mode?: number;
            owner?: string;
            path: string;
          }>;
          key: string;
          ownerId: string;
          useServerProxy?: boolean;
        },
        null,
        Name
      >;
      write: FunctionReference<
        "action",
        "internal",
        {
          files: Array<{
            content: string | ArrayBuffer;
            group?: string;
            mode?: number;
            owner?: string;
            path: string;
          }>;
          key: string;
          ownerId: string;
          useServerProxy?: boolean;
        },
        Array<{ path: string; sizeBytes: number }>,
        Name
      >;
    };
    network: {
      createVault: FunctionReference<
        "action",
        "internal",
        {
          bindings: Array<{
            auth: {
              credential?: string;
              headers?: Array<{ credential: string; name: string }>;
              name?: string;
              substitutions?: Array<{
                credential: string;
                in: Array<"path" | "query" | "header" | "body">;
                placeholder: string;
              }>;
              type?:
                "bearer" | "basic" | "apiKey" | "customHeaders" | "passthrough";
            };
            match: {
              hosts: Array<string>;
              methods?: Array<string>;
              paths?: Array<string>;
              ports?: Array<number>;
              schemes?: Array<"https" | "http">;
            };
            name: string;
          }>;
          credentials: Array<{
            name: string;
            source: {
              endpoint?: string;
              type: "inline" | "exchange";
              value?: string;
            };
          }>;
          key: string;
          ownerId: string;
        },
        {
          bindings: Array<{
            hosts?: Array<string>;
            name: string;
            revision: number;
          }>;
          credentials: Array<{
            name: string;
            revision: number;
            sourceType: string;
          }>;
          revision: number;
        },
        Name
      >;
      deleteRules: FunctionReference<
        "action",
        "internal",
        { key: string; ownerId: string; targets: Array<string> },
        {
          enforcementMode?: string;
          mode?: string;
          policy?: {
            defaultAction?: string;
            egress: Array<{
              action: string;
              ports?: Array<number>;
              target: string;
            }>;
          };
          reason?: string;
          status?: string;
        },
        Name
      >;
      deleteVault: FunctionReference<
        "action",
        "internal",
        { key: string; ownerId: string },
        null,
        Name
      >;
      getPolicy: FunctionReference<
        "action",
        "internal",
        { key: string; ownerId: string },
        {
          enforcementMode?: string;
          mode?: string;
          policy?: {
            defaultAction?: string;
            egress: Array<{
              action: string;
              ports?: Array<number>;
              target: string;
            }>;
          };
          reason?: string;
          status?: string;
        },
        Name
      >;
      getVault: FunctionReference<
        "action",
        "internal",
        { key: string; ownerId: string },
        {
          bindings: Array<{
            hosts?: Array<string>;
            name: string;
            revision: number;
          }>;
          credentials: Array<{
            name: string;
            revision: number;
            sourceType: string;
          }>;
          revision: number;
        } | null,
        Name
      >;
      patchRules: FunctionReference<
        "action",
        "internal",
        {
          key: string;
          ownerId: string;
          rules: Array<{
            action: "allow" | "deny";
            ports?: Array<number>;
            target: string;
          }>;
        },
        {
          enforcementMode?: string;
          mode?: string;
          policy?: {
            defaultAction?: string;
            egress: Array<{
              action: string;
              ports?: Array<number>;
              target: string;
            }>;
          };
          reason?: string;
          status?: string;
        },
        Name
      >;
      patchVault: FunctionReference<
        "action",
        "internal",
        {
          bindings?: {
            add?: Array<{
              auth: {
                credential?: string;
                headers?: Array<{ credential: string; name: string }>;
                name?: string;
                substitutions?: Array<{
                  credential: string;
                  in: Array<"path" | "query" | "header" | "body">;
                  placeholder: string;
                }>;
                type?:
                  | "bearer"
                  | "basic"
                  | "apiKey"
                  | "customHeaders"
                  | "passthrough";
              };
              match: {
                hosts: Array<string>;
                methods?: Array<string>;
                paths?: Array<string>;
                ports?: Array<number>;
                schemes?: Array<"https" | "http">;
              };
              name: string;
            }>;
            delete?: Array<string>;
            replace?: Array<{
              auth: {
                credential?: string;
                headers?: Array<{ credential: string; name: string }>;
                name?: string;
                substitutions?: Array<{
                  credential: string;
                  in: Array<"path" | "query" | "header" | "body">;
                  placeholder: string;
                }>;
                type?:
                  | "bearer"
                  | "basic"
                  | "apiKey"
                  | "customHeaders"
                  | "passthrough";
              };
              match: {
                hosts: Array<string>;
                methods?: Array<string>;
                paths?: Array<string>;
                ports?: Array<number>;
                schemes?: Array<"https" | "http">;
              };
              name: string;
            }>;
          };
          credentials?: {
            add?: Array<{
              name: string;
              source: {
                endpoint?: string;
                type: "inline" | "exchange";
                value?: string;
              };
            }>;
            delete?: Array<string>;
            replace?: Array<{
              name: string;
              source: {
                endpoint?: string;
                type: "inline" | "exchange";
                value?: string;
              };
            }>;
          };
          expectedRevision?: number;
          key: string;
          ownerId: string;
        },
        {
          bindings: Array<{
            hosts?: Array<string>;
            name: string;
            revision: number;
          }>;
          credentials: Array<{
            name: string;
            revision: number;
            sourceType: string;
          }>;
          revision: number;
        },
        Name
      >;
      replacePolicy: FunctionReference<
        "action",
        "internal",
        {
          key: string;
          ownerId: string;
          policy: {
            defaultAction?: "allow" | "deny";
            egress?: Array<{
              action: "allow" | "deny";
              ports?: Array<number>;
              target: string;
            }>;
          };
        },
        {
          enforcementMode?: string;
          mode?: string;
          policy?: {
            defaultAction?: string;
            egress: Array<{
              action: string;
              ports?: Array<number>;
              target: string;
            }>;
          };
          reason?: string;
          status?: string;
        },
        Name
      >;
    };
    observe: {
      diagnosticContext: FunctionReference<
        "action",
        "internal",
        { key: string; ownerId: string },
        {
          backendIdentifiers: Record<string, string>;
          backendType: string;
          sandboxId: string;
          state?: string;
        },
        Name
      >;
      diagnostics: FunctionReference<
        "action",
        "internal",
        {
          key: string;
          kind: "logs" | "events";
          ownerId: string;
          scope?: string;
        },
        {
          content?: string;
          contentType: string;
          contentUrl?: string;
          kind: string;
          scope: string;
          truncated: boolean;
          warnings: Array<string>;
        },
        Name
      >;
      metrics: FunctionReference<
        "action",
        "internal",
        { key: string; ownerId: string; useServerProxy?: boolean },
        {
          cpuCount: number;
          cpuUsedPercent: number;
          memoryTotalMiB: number;
          memoryUsedMiB: number;
          timestamp: number;
        },
        Name
      >;
      ping: FunctionReference<
        "action",
        "internal",
        { key: string; ownerId: string; useServerProxy?: boolean },
        boolean,
        Name
      >;
    };
    sandboxes: {
      create: FunctionReference<
        "action",
        "internal",
        {
          allowUntrackedSnapshot?: boolean;
          codeInterpreter?: boolean;
          createRequestTimeoutSeconds?: number;
          credentialProxy?: boolean;
          entrypoint?: Array<string>;
          env?: Record<string, string>;
          extensions?: Record<string, string>;
          image?: string;
          imageAuth?: { password: string; username: string };
          key: string;
          lifecycle?: {
            idlePolicy?: {
              activeProbe?: {
                path: string;
                port: number;
                timeoutSeconds?: number;
              };
              idleTimeoutSeconds?: number;
              onIdle?: "pause";
              wakeOnAccess?: boolean;
            };
            periodic?: Array<{
              command: Array<string>;
              name: string;
              schedule: string;
              timeoutSeconds?: number;
            }>;
            preStart?: { command: Array<string>; timeoutSeconds?: number };
            renewalPolicy?: { extendSeconds: number };
          };
          metadata?: Record<string, string>;
          networkPolicy?: {
            defaultAction?: "allow" | "deny";
            egress?: Array<{
              action: "allow" | "deny";
              ports?: Array<number>;
              target: string;
            }>;
          };
          ownerId: string;
          platform?: { arch: "amd64" | "arm64"; os: "linux" | "windows" };
          readyTimeoutSeconds?: number;
          resourceLimits?: Record<string, string>;
          resourceRequests?: Record<string, string>;
          resumeIfPaused?: boolean;
          secureAccess?: boolean;
          skipHealthCheck?: boolean;
          snapshotId?: string;
          templateId?: string;
          timeoutSeconds?: number | null;
          useServerProxy?: boolean;
          volumes?: Array<{
            host?: { path: string };
            mountPath: string;
            name: string;
            ossfs?: {
              accessKeyId: string;
              accessKeySecret: string;
              bucket: string;
              endpoint: string;
              options?: Array<string>;
              version?: "1.0" | "2.0";
            };
            pvc?: {
              accessModes?: Array<string>;
              claimName: string;
              createIfNotExists?: boolean;
              deleteOnSandboxTermination?: boolean;
              storage?: string | null;
              storageClass?: string | null;
            };
            readOnly?: boolean;
            subPath?: string;
          }>;
        },
        {
          entrypoint?: Array<string>;
          expiresAt?: string;
          image?: string;
          key: string;
          lastActiveAt?: number;
          lastError?: string;
          lastTransitionAt?: string;
          message?: string;
          metadata?: Record<string, string>;
          ownerId: string;
          platform?: { arch: string; os: string };
          reason?: string;
          remoteCreatedAt?: string;
          sandboxId?: string;
          snapshotId?: string;
          state: string;
          syncedAt?: number;
          templateId?: string;
          updatedAt: number;
        },
        Name
      >;
      destroy: FunctionReference<
        "action",
        "internal",
        { key: string; ownerId: string },
        {
          entrypoint?: Array<string>;
          expiresAt?: string;
          image?: string;
          key: string;
          lastActiveAt?: number;
          lastError?: string;
          lastTransitionAt?: string;
          message?: string;
          metadata?: Record<string, string>;
          ownerId: string;
          platform?: { arch: string; os: string };
          reason?: string;
          remoteCreatedAt?: string;
          sandboxId?: string;
          snapshotId?: string;
          state: string;
          syncedAt?: number;
          templateId?: string;
          updatedAt: number;
        },
        Name
      >;
      fork: FunctionReference<
        "action",
        "internal",
        {
          key: string;
          name?: string;
          newKey: string;
          options?: {
            entrypoint?: Array<string>;
            env?: Record<string, string>;
            lifecycle?: {
              idlePolicy?: {
                activeProbe?: {
                  path: string;
                  port: number;
                  timeoutSeconds?: number;
                };
                idleTimeoutSeconds?: number;
                onIdle?: "pause";
                wakeOnAccess?: boolean;
              };
              periodic?: Array<{
                command: Array<string>;
                name: string;
                schedule: string;
                timeoutSeconds?: number;
              }>;
              preStart?: { command: Array<string>; timeoutSeconds?: number };
              renewalPolicy?: { extendSeconds: number };
            };
            metadata?: Record<string, string>;
            networkPolicy?: {
              defaultAction?: "allow" | "deny";
              egress?: Array<{
                action: "allow" | "deny";
                ports?: Array<number>;
                target: string;
              }>;
            };
            readyTimeoutSeconds?: number;
            resourceLimits?: Record<string, string>;
            resourceRequests?: Record<string, string>;
            secureAccess?: boolean;
            skipHealthCheck?: boolean;
            timeoutSeconds?: number | null;
          };
          ownerId: string;
          snapshotTimeoutSeconds?: number;
          useServerProxy?: boolean;
        },
        {
          sandbox: {
            entrypoint?: Array<string>;
            expiresAt?: string;
            image?: string;
            key: string;
            lastActiveAt?: number;
            lastError?: string;
            lastTransitionAt?: string;
            message?: string;
            metadata?: Record<string, string>;
            ownerId: string;
            platform?: { arch: string; os: string };
            reason?: string;
            remoteCreatedAt?: string;
            sandboxId?: string;
            snapshotId?: string;
            state: string;
            syncedAt?: number;
            templateId?: string;
            updatedAt: number;
          };
          snapshotId: string;
        },
        Name
      >;
      get: FunctionReference<
        "query",
        "internal",
        { key: string; ownerId: string },
        {
          entrypoint?: Array<string>;
          expiresAt?: string;
          image?: string;
          key: string;
          lastActiveAt?: number;
          lastError?: string;
          lastTransitionAt?: string;
          message?: string;
          metadata?: Record<string, string>;
          ownerId: string;
          platform?: { arch: string; os: string };
          reason?: string;
          remoteCreatedAt?: string;
          sandboxId?: string;
          snapshotId?: string;
          state: string;
          syncedAt?: number;
          templateId?: string;
          updatedAt: number;
        } | null,
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        { includeTerminated?: boolean; limit?: number; ownerId: string },
        Array<{
          entrypoint?: Array<string>;
          expiresAt?: string;
          image?: string;
          key: string;
          lastActiveAt?: number;
          lastError?: string;
          lastTransitionAt?: string;
          message?: string;
          metadata?: Record<string, string>;
          ownerId: string;
          platform?: { arch: string; os: string };
          reason?: string;
          remoteCreatedAt?: string;
          sandboxId?: string;
          snapshotId?: string;
          state: string;
          syncedAt?: number;
          templateId?: string;
          updatedAt: number;
        }>,
        Name
      >;
      listPaginated: FunctionReference<
        "query",
        "internal",
        {
          ownerId: string;
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            entrypoint?: Array<string>;
            expiresAt?: string;
            image?: string;
            key: string;
            lastActiveAt?: number;
            lastError?: string;
            lastTransitionAt?: string;
            message?: string;
            metadata?: Record<string, string>;
            ownerId: string;
            platform?: { arch: string; os: string };
            reason?: string;
            remoteCreatedAt?: string;
            sandboxId?: string;
            snapshotId?: string;
            state: string;
            syncedAt?: number;
            templateId?: string;
            updatedAt: number;
          }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        },
        Name
      >;
      patchMetadata: FunctionReference<
        "action",
        "internal",
        { key: string; ownerId: string; patch: Record<string, string | null> },
        {
          entrypoint?: Array<string>;
          expiresAt?: string;
          image?: string;
          key: string;
          lastActiveAt?: number;
          lastError?: string;
          lastTransitionAt?: string;
          message?: string;
          metadata?: Record<string, string>;
          ownerId: string;
          platform?: { arch: string; os: string };
          reason?: string;
          remoteCreatedAt?: string;
          sandboxId?: string;
          snapshotId?: string;
          state: string;
          syncedAt?: number;
          templateId?: string;
          updatedAt: number;
        },
        Name
      >;
      pause: FunctionReference<
        "action",
        "internal",
        { key: string; ownerId: string; waitSeconds?: number },
        {
          entrypoint?: Array<string>;
          expiresAt?: string;
          image?: string;
          key: string;
          lastActiveAt?: number;
          lastError?: string;
          lastTransitionAt?: string;
          message?: string;
          metadata?: Record<string, string>;
          ownerId: string;
          platform?: { arch: string; os: string };
          reason?: string;
          remoteCreatedAt?: string;
          sandboxId?: string;
          snapshotId?: string;
          state: string;
          syncedAt?: number;
          templateId?: string;
          updatedAt: number;
        },
        Name
      >;
      reconcile: FunctionReference<
        "action",
        "internal",
        { destroyOrphans?: boolean; ownerId: string },
        {
          errors: Array<{ key: string; message: string }>;
          orphans: Array<{
            destroyed: boolean;
            sandboxId: string;
            state: string;
          }>;
          refreshed: Array<{
            entrypoint?: Array<string>;
            expiresAt?: string;
            image?: string;
            key: string;
            lastActiveAt?: number;
            lastError?: string;
            lastTransitionAt?: string;
            message?: string;
            metadata?: Record<string, string>;
            ownerId: string;
            platform?: { arch: string; os: string };
            reason?: string;
            remoteCreatedAt?: string;
            sandboxId?: string;
            snapshotId?: string;
            state: string;
            syncedAt?: number;
            templateId?: string;
            updatedAt: number;
          }>;
        },
        Name
      >;
      refresh: FunctionReference<
        "action",
        "internal",
        { key: string; ownerId: string },
        {
          entrypoint?: Array<string>;
          expiresAt?: string;
          image?: string;
          key: string;
          lastActiveAt?: number;
          lastError?: string;
          lastTransitionAt?: string;
          message?: string;
          metadata?: Record<string, string>;
          ownerId: string;
          platform?: { arch: string; os: string };
          reason?: string;
          remoteCreatedAt?: string;
          sandboxId?: string;
          snapshotId?: string;
          state: string;
          syncedAt?: number;
          templateId?: string;
          updatedAt: number;
        },
        Name
      >;
      renew: FunctionReference<
        "action",
        "internal",
        {
          additionalSeconds?: number;
          expiresAt?: string;
          key: string;
          ownerId: string;
          timeoutSeconds?: number;
        },
        {
          entrypoint?: Array<string>;
          expiresAt?: string;
          image?: string;
          key: string;
          lastActiveAt?: number;
          lastError?: string;
          lastTransitionAt?: string;
          message?: string;
          metadata?: Record<string, string>;
          ownerId: string;
          platform?: { arch: string; os: string };
          reason?: string;
          remoteCreatedAt?: string;
          sandboxId?: string;
          snapshotId?: string;
          state: string;
          syncedAt?: number;
          templateId?: string;
          updatedAt: number;
        },
        Name
      >;
      resume: FunctionReference<
        "action",
        "internal",
        {
          key: string;
          ownerId: string;
          skipHealthCheck?: boolean;
          useServerProxy?: boolean;
          waitSeconds?: number;
        },
        {
          entrypoint?: Array<string>;
          expiresAt?: string;
          image?: string;
          key: string;
          lastActiveAt?: number;
          lastError?: string;
          lastTransitionAt?: string;
          message?: string;
          metadata?: Record<string, string>;
          ownerId: string;
          platform?: { arch: string; os: string };
          reason?: string;
          remoteCreatedAt?: string;
          sandboxId?: string;
          snapshotId?: string;
          state: string;
          syncedAt?: number;
          templateId?: string;
          updatedAt: number;
        },
        Name
      >;
      sweep: FunctionReference<
        "action",
        "internal",
        {
          deleteTerminatedAfterMs?: number;
          dryRun?: boolean;
          idleMs?: number;
          limit?: number;
          ownerId?: string;
        },
        {
          checked: number;
          destroyed: Array<{ key: string; ownerId: string; reason: string }>;
          errors: Array<{ key: string; message: string; ownerId: string }>;
          rowsDeleted: number;
          terminated: number;
        },
        Name
      >;
    };
    snapshots: {
      create: FunctionReference<
        "action",
        "internal",
        { key: string; name?: string; ownerId: string; waitSeconds?: number },
        {
          key: string;
          message?: string;
          name?: string;
          ownerId: string;
          reason?: string;
          remoteCreatedAt?: string;
          sandboxId: string;
          snapshotId: string;
          state: string;
          updatedAt: number;
        },
        Name
      >;
      get: FunctionReference<
        "query",
        "internal",
        { ownerId: string; snapshotId: string },
        {
          key: string;
          message?: string;
          name?: string;
          ownerId: string;
          reason?: string;
          remoteCreatedAt?: string;
          sandboxId: string;
          snapshotId: string;
          state: string;
          updatedAt: number;
        } | null,
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        { key?: string; limit?: number; ownerId: string },
        Array<{
          key: string;
          message?: string;
          name?: string;
          ownerId: string;
          reason?: string;
          remoteCreatedAt?: string;
          sandboxId: string;
          snapshotId: string;
          state: string;
          updatedAt: number;
        }>,
        Name
      >;
      refresh: FunctionReference<
        "action",
        "internal",
        { ownerId: string; snapshotId: string },
        {
          key: string;
          message?: string;
          name?: string;
          ownerId: string;
          reason?: string;
          remoteCreatedAt?: string;
          sandboxId: string;
          snapshotId: string;
          state: string;
          updatedAt: number;
        },
        Name
      >;
      remove: FunctionReference<
        "action",
        "internal",
        { ownerId: string; snapshotId: string },
        null,
        Name
      >;
    };
  };
