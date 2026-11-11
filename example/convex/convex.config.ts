import { defineApp } from "convex/server";
import { v } from "convex/values";
import opensandbox from "opensandbox-convex/convex.config.js";

const app = defineApp({
  env: {
    OPENSANDBOX_API_KEY: v.string(),
    OPENSANDBOX_DOMAIN: v.string(),
    OPENSANDBOX_PROTOCOL: v.optional(v.string()),
  },
});

app.use(opensandbox, {
  env: {
    OPENSANDBOX_API_KEY: app.env.OPENSANDBOX_API_KEY,
    OPENSANDBOX_DOMAIN: app.env.OPENSANDBOX_DOMAIN,
    OPENSANDBOX_PROTOCOL: app.env.OPENSANDBOX_PROTOCOL,
  },
});

export default app;
