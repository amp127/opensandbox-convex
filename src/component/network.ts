// Egress control: the sandbox's network policy and its credential vault.
// Both need the server's [egress] sidecar (Docker: network_mode = "bridge").
import { v } from "convex/values";
import { action, type ActionCtx } from "./_generated/server.js";
import { checkIdentity, connection, lifecycle, requireRow } from "./access.js";
import { errorData, osError } from "./errors.js";
import { checkBounded, checkNetworkPolicy, checkRules, normalizePolicy } from "./remote.js";
import type { Connection } from "./urls.js";
import { identity, networkPolicyValidator, networkRuleValidator, type NetworkPolicy } from "./validators.js";

const policyStatusValidator = v.object({
  status: v.optional(v.string()),
  mode: v.optional(v.string()),
  enforcementMode: v.optional(v.string()),
  reason: v.optional(v.string()),
  policy: v.optional(
    v.object({
      defaultAction: v.optional(v.string()),
      egress: v.array(v.object({ action: v.string(), target: v.string(), ports: v.optional(v.array(v.number())) })),
    }),
  ),
});

type PolicyStatus = {
  status?: string;
  mode?: string;
  enforcementMode?: string;
  reason?: string;
  policy?: { defaultAction?: string; egress: Array<{ action: string; target: string; ports?: number[] }> };
};

function parsePolicyStatus(body: unknown): PolicyStatus {
  const record = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const out: PolicyStatus = {};
  for (const name of ["status", "mode", "enforcementMode", "reason"] as const) {
    if (typeof record[name] === "string") out[name] = (record[name] as string).slice(0, 500);
  }
  const policy = record.policy as { defaultAction?: unknown; egress?: unknown } | undefined;
  if (policy && typeof policy === "object") {
    const egress = Array.isArray(policy.egress) ? policy.egress : [];
    out.policy = {
      egress: egress
        .filter((rule): rule is Record<string, unknown> => !!rule && typeof rule === "object")
        .map((rule) => {
          const parsed: { action: string; target: string; ports?: number[] } = {
            action: String(rule.action ?? ""),
            target: String(rule.target ?? ""),
          };
          if (Array.isArray(rule.ports)) parsed.ports = rule.ports.filter((port): port is number => typeof port === "number");
          return parsed;
        }),
    };
    if (typeof policy.defaultAction === "string") out.policy.defaultAction = policy.defaultAction;
  }
  return out;
}

/** The policy lives in the sandbox's egress sidecar; without one the server answers 5xx. */
async function policyCall(conn: Connection, method: "GET" | "PUT" | "PATCH" | "DELETE", path: string, json?: unknown) {
  try {
    const { body } = await lifecycle(conn, method, path, json === undefined ? {} : { json });
    const parsed = parsePolicyStatus(body);
    // Some server versions answer a change without the resulting policy. Read it back.
    if (method !== "GET" && parsed.policy === undefined) return await policyCall(conn, "GET", path);
    return parsed;
  } catch (error) {
    const data = errorData(error);
    if (data && (data.status === 502 || data.status === 503 || data.status === 501)) {
      throw osError(
        "unsupported",
        "This sandbox has no egress sidecar. Create it with a networkPolicy (the server needs an [egress] image and bridge networking).",
        { status: data.status, remoteCode: data.remoteCode },
      );
    }
    throw error;
  }
}

async function sandboxPath(ctx: ActionCtx, ownerId: string, key: string, suffix: string) {
  checkIdentity(ownerId, key);
  const conn = connection();
  const row = await requireRow(ctx, ownerId, key);
  return { conn, path: `/sandboxes/${encodeURIComponent(row.sandboxId)}${suffix}` };
}

export const getPolicy = action({
  args: identity,
  returns: policyStatusValidator,
  handler: async (ctx, args) => {
    const { conn, path } = await sandboxPath(ctx, args.ownerId, args.key, "/networkpolicy");
    return await policyCall(conn, "GET", path);
  },
});

export const replacePolicy = action({
  args: { ...identity, policy: networkPolicyValidator },
  returns: policyStatusValidator,
  handler: async (ctx, args) => {
    checkNetworkPolicy(args.policy as NetworkPolicy);
    const { conn, path } = await sandboxPath(ctx, args.ownerId, args.key, "/networkpolicy");
    return await policyCall(conn, "PUT", path, normalizePolicy(args.policy));
  },
});

/** Add rules, or replace the rule for a target that already has one. */
export const patchRules = action({
  args: { ...identity, rules: v.array(networkRuleValidator) },
  returns: policyStatusValidator,
  handler: async (ctx, args) => {
    if (args.rules.length === 0) throw osError("invalid_argument", "Pass at least one rule.");
    checkRules(args.rules);
    const { conn, path } = await sandboxPath(ctx, args.ownerId, args.key, "/networkpolicy");
    return await policyCall(conn, "PATCH", path, args.rules);
  },
});

export const deleteRules = action({
  args: { ...identity, targets: v.array(v.string()) },
  returns: policyStatusValidator,
  handler: async (ctx, args) => {
    if (args.targets.length === 0 || args.targets.length > 500) {
      throw osError("invalid_argument", "Pass 1 to 500 targets.");
    }
    for (const target of args.targets) checkBounded("target", target, 512);
    const { conn, path } = await sandboxPath(ctx, args.ownerId, args.key, "/networkpolicy");
    return await policyCall(conn, "DELETE", path, args.targets);
  },
});

// ---------------------------------------------------------------------------
// Credential vault: secrets the egress proxy injects into matching requests,
// so the sandbox never sees them. Create the sandbox with credentialProxy.
// ---------------------------------------------------------------------------

const credentialValidator = v.object({
  name: v.string(),
  source: v.object({
    type: v.union(v.literal("inline"), v.literal("exchange")),
    value: v.optional(v.string()),
    endpoint: v.optional(v.string()),
  }),
});

const bindingValidator = v.object({
  name: v.string(),
  match: v.object({
    hosts: v.array(v.string()),
    schemes: v.optional(v.array(v.union(v.literal("https"), v.literal("http")))),
    ports: v.optional(v.array(v.number())),
    methods: v.optional(v.array(v.string())),
    paths: v.optional(v.array(v.string())),
  }),
  auth: v.object({
    type: v.optional(
      v.union(v.literal("bearer"), v.literal("basic"), v.literal("apiKey"), v.literal("customHeaders"), v.literal("passthrough")),
    ),
    credential: v.optional(v.string()),
    name: v.optional(v.string()),
    headers: v.optional(v.array(v.object({ name: v.string(), credential: v.string() }))),
    substitutions: v.optional(
      v.array(
        v.object({
          credential: v.string(),
          placeholder: v.string(),
          in: v.array(v.union(v.literal("path"), v.literal("query"), v.literal("header"), v.literal("body"))),
        }),
      ),
    ),
  }),
});

/** What the server reports back. Secret values are never returned. */
const vaultStateValidator = v.object({
  revision: v.number(),
  credentials: v.array(v.object({ name: v.string(), sourceType: v.string(), revision: v.number() })),
  bindings: v.array(v.object({ name: v.string(), revision: v.number(), hosts: v.optional(v.array(v.string())) })),
});

type VaultState = {
  revision: number;
  credentials: Array<{ name: string; sourceType: string; revision: number }>;
  bindings: Array<{ name: string; revision: number; hosts?: string[] }>;
};

function parseVault(body: unknown): VaultState {
  const record = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const credentials = Array.isArray(record.credentials) ? record.credentials : [];
  const bindings = Array.isArray(record.bindings) ? record.bindings : [];
  return {
    revision: typeof record.revision === "number" ? record.revision : 0,
    credentials: credentials
      .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
      .map((item) => ({
        name: String(item.name ?? ""),
        sourceType: String(item.sourceType ?? ""),
        revision: typeof item.revision === "number" ? item.revision : 0,
      })),
    bindings: bindings
      .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
      .map((item) => {
        const out: { name: string; revision: number; hosts?: string[] } = {
          name: String(item.name ?? ""),
          revision: typeof item.revision === "number" ? item.revision : 0,
        };
        const hosts = (item.match as { hosts?: unknown } | undefined)?.hosts;
        if (Array.isArray(hosts)) out.hosts = hosts.filter((host): host is string => typeof host === "string");
        return out;
      }),
  };
}

function checkVaultNames(items: Array<{ name: string }>, what: string) {
  if (items.length > 100) throw osError("invalid_argument", `At most 100 ${what}.`);
  for (const item of items) checkBounded(`${what} name`, item.name, 128);
}

export const createVault = action({
  args: { ...identity, credentials: v.array(credentialValidator), bindings: v.array(bindingValidator) },
  returns: vaultStateValidator,
  handler: async (ctx, args) => {
    checkVaultNames(args.credentials, "credentials");
    checkVaultNames(args.bindings, "bindings");
    const { conn, path } = await sandboxPath(ctx, args.ownerId, args.key, "/credential-vault");
    const { body } = await lifecycle(conn, "POST", path, {
      json: { credentials: args.credentials, bindings: args.bindings },
    });
    return parseVault(body);
  },
});

export const getVault = action({
  args: identity,
  returns: v.union(vaultStateValidator, v.null()),
  handler: async (ctx, args) => {
    const { conn, path } = await sandboxPath(ctx, args.ownerId, args.key, "/credential-vault");
    try {
      const { body } = await lifecycle(conn, "GET", path);
      return parseVault(body);
    } catch (error) {
      if (errorData(error)?.status === 404) return null;
      throw error;
    }
  },
});

const mutationSet = <T extends typeof credentialValidator | typeof bindingValidator>(item: T) =>
  v.optional(
    v.object({ add: v.optional(v.array(item)), replace: v.optional(v.array(item)), delete: v.optional(v.array(v.string())) }),
  );

export const patchVault = action({
  args: {
    ...identity,
    /** Reject the patch if the vault changed since this revision. */
    expectedRevision: v.optional(v.number()),
    credentials: mutationSet(credentialValidator),
    bindings: mutationSet(bindingValidator),
  },
  returns: vaultStateValidator,
  handler: async (ctx, args) => {
    for (const set of [args.credentials, args.bindings]) {
      checkVaultNames([...(set?.add ?? []), ...(set?.replace ?? [])], "entries");
    }
    const json: Record<string, unknown> = {};
    if (args.expectedRevision !== undefined) json.expectedRevision = args.expectedRevision;
    if (args.credentials) json.credentials = args.credentials;
    if (args.bindings) json.bindings = args.bindings;
    const { conn, path } = await sandboxPath(ctx, args.ownerId, args.key, "/credential-vault");
    const { body } = await lifecycle(conn, "PATCH", path, { json });
    return parseVault(body);
  },
});

export const deleteVault = action({
  args: identity,
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const { conn, path } = await sandboxPath(ctx, args.ownerId, args.key, "/credential-vault");
    try {
      await lifecycle(conn, "DELETE", path);
    } catch (error) {
      if (errorData(error)?.status !== 404) throw error;
    }
    return null;
  },
});
