import { internalAction } from "./_generated/server";
import { sandboxes } from "./demo";

export const run = internalAction({
  args: {},
  handler: async (ctx) => {
    const sweep = await sandboxes.sweep(ctx, {
      pauseIdleMs: 15 * 60_000,
      idleMs: 60 * 60_000,
      protectMetadata: { persist: "true" },
      deleteTerminatedAfterMs: 86_400_000,
      limit: 200,
    });
    let purged = 0;
    for (let round = 0; round < 10; round += 1) {
      const result = await sandboxes.purgeExecutions(ctx, { olderThanMs: 7 * 86_400_000 });
      purged += result.deleted;
      if (!result.hasMore) break;
    }
    return { ...sweep, executionsPurged: purged };
  },
});
