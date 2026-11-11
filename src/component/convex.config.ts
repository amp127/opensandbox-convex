import { defineComponent } from "convex/server";
import { v } from "convex/values";

export default defineComponent("opensandbox", {
  // Components cannot read the app's environment. The app passes these down
  // from convex.config.ts. The API key never travels in function arguments.
  env: {
    /** OpenSandbox API key, sent as the OPEN-SANDBOX-API-KEY header. */
    OPENSANDBOX_API_KEY: v.string(),
    /**
     * Lifecycle server. A host such as `localhost:8080`, or a full URL
     * (`http://localhost:8080`, `https://sandbox.example.com`). A path prefix
     * is kept; a trailing `/v1` is stripped because the component adds it.
     */
    OPENSANDBOX_DOMAIN: v.string(),
    /**
     * `http` or `https`. Used only when OPENSANDBOX_DOMAIN has no scheme.
     * Localhost defaults to http; anything else defaults to https.
     */
    OPENSANDBOX_PROTOCOL: v.optional(v.string()),
  },
});
