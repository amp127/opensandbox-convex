import { v, type Infer } from "convex/values";

export const identity = { ownerId: v.string(), key: v.string() };

export const platformValidator = v.object({
  os: v.union(v.literal("linux"), v.literal("windows")),
  arch: v.union(v.literal("amd64"), v.literal("arm64")),
});

export const networkRuleValidator = v.object({
  action: v.union(v.literal("allow"), v.literal("deny")),
  /** Domain (`pypi.org`), wildcard (`*.example.com`), IP, or CIDR. */
  target: v.string(),
  ports: v.optional(v.array(v.number())),
});

export const networkPolicyValidator = v.object({
  /** Default `deny`, like the official SDK. */
  defaultAction: v.optional(v.union(v.literal("allow"), v.literal("deny"))),
  egress: v.optional(v.array(networkRuleValidator)),
});

export const volumeValidator = v.object({
  name: v.string(),
  mountPath: v.string(),
  readOnly: v.optional(v.boolean()),
  subPath: v.optional(v.string()),
  host: v.optional(v.object({ path: v.string() })),
  pvc: v.optional(
    v.object({
      claimName: v.string(),
      createIfNotExists: v.optional(v.boolean()),
      deleteOnSandboxTermination: v.optional(v.boolean()),
      storageClass: v.optional(v.union(v.string(), v.null())),
      storage: v.optional(v.union(v.string(), v.null())),
      accessModes: v.optional(v.array(v.string())),
    }),
  ),
  ossfs: v.optional(
    v.object({
      bucket: v.string(),
      endpoint: v.string(),
      version: v.optional(v.union(v.literal("1.0"), v.literal("2.0"))),
      options: v.optional(v.array(v.string())),
      accessKeyId: v.string(),
      accessKeySecret: v.string(),
    }),
  ),
});

const hookValidator = v.object({
  command: v.array(v.string()),
  timeoutSeconds: v.optional(v.number()),
});

export const lifecycleValidator = v.object({
  preStart: v.optional(hookValidator),
  periodic: v.optional(
    v.array(
      v.object({
        name: v.string(),
        schedule: v.string(),
        command: v.array(v.string()),
        timeoutSeconds: v.optional(v.number()),
      }),
    ),
  ),
  idlePolicy: v.optional(
    v.object({
      idleTimeoutSeconds: v.optional(v.number()),
      onIdle: v.optional(v.literal("pause")),
      wakeOnAccess: v.optional(v.boolean()),
      activeProbe: v.optional(
        v.object({ port: v.number(), path: v.string(), timeoutSeconds: v.optional(v.number()) }),
      ),
    }),
  ),
  renewalPolicy: v.optional(v.object({ extendSeconds: v.number() })),
});

export const imageAuthValidator = v.object({ username: v.string(), password: v.string() });

/** Everything POST /sandboxes accepts, minus the source, which is checked separately. */
export const createOptionFields = {
  /** Container image, for example `python:3.11`. */
  image: v.optional(v.string()),
  /** Private registry credentials. Sent once; never stored. */
  imageAuth: v.optional(imageAuthValidator),
  /** Restore from a snapshot this owner took (see `snapshot`). */
  snapshotId: v.optional(v.string()),
  /** Allow a snapshot id this component has no record of, for snapshots made outside it. */
  allowUntrackedSnapshot: v.optional(v.boolean()),
  /** fsb golden-image template (Kubernetes fast-sandbox runtime only). */
  templateId: v.optional(v.string()),
  entrypoint: v.optional(v.array(v.string())),
  /** Seconds until OpenSandbox terminates it. `null` disables expiration. Default 600. */
  timeoutSeconds: v.optional(v.union(v.number(), v.null())),
  resourceLimits: v.optional(v.record(v.string(), v.string())),
  resourceRequests: v.optional(v.record(v.string(), v.string())),
  env: v.optional(v.record(v.string(), v.string())),
  metadata: v.optional(v.record(v.string(), v.string())),
  platform: v.optional(platformValidator),
  networkPolicy: v.optional(networkPolicyValidator),
  /** Inject per-request credentials at the egress proxy (see `credentialVault`). */
  credentialProxy: v.optional(v.boolean()),
  /** Require the secure-access header on ingress (Kubernetes gateway mode). */
  secureAccess: v.optional(v.boolean()),
  volumes: v.optional(v.array(volumeValidator)),
  lifecycle: v.optional(lifecycleValidator),
  /** Opaque provider keys, for example `poolRef`. */
  extensions: v.optional(v.record(v.string(), v.string())),
};

export const createOptions = v.object(createOptionFields);
export type CreateOptions = Infer<typeof createOptions>;
export type NetworkRule = Infer<typeof networkRuleValidator>;
export type NetworkPolicy = Infer<typeof networkPolicyValidator>;

/** How a component call reaches execd and the ingress. */
export const accessFields = {
  /** Use the lifecycle server's deprecated proxy instead of the ingress endpoint. */
  useServerProxy: v.optional(v.boolean()),
};
