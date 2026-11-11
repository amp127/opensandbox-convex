// Relays browser requests to a port inside a sandbox. The server proxy is
// gated by the API key, so a browser cannot open it directly; this HTTP
// action adds the key on the server side and streams the answer back.
//   GET {CONVEX_SITE_URL}/preview/<visitor>/<key>/<port>/<path>
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { ownerOf, sandboxes } from "./demo";

const http = httpRouter();

const DROP_RESPONSE_HEADERS = new Set(["set-cookie", "content-encoding", "content-length", "transfer-encoding", "connection"]);

http.route({
  pathPrefix: "/preview/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const [, , visitor, key, portText, ...rest] = url.pathname.split("/");
    const port = Number(portText);
    if (!visitor || !key || !Number.isInteger(port) || port < 1 || port > 65535) {
      return new Response("Not found", { status: 404 });
    }
    let ownerId: string;
    try {
      ownerId = ownerOf(visitor);
    } catch {
      return new Response("Not found", { status: 404 });
    }
    let endpoint;
    try {
      endpoint = await sandboxes.endpoint(ctx, { ownerId, key, port });
    } catch {
      return new Response("The sandbox is not running.", { status: 502 });
    }
    const headers: Record<string, string> = { ...endpoint.headers };
    // The key stays here, in the backend. The browser never sees it.
    if (endpoint.viaServerProxy) headers["OPEN-SANDBOX-API-KEY"] = process.env.OPENSANDBOX_API_KEY ?? "";
    const upstream = await fetch(`${endpoint.url}/${rest.join("/")}${url.search}`, { headers }).catch(() => null);
    if (!upstream) return new Response("The sandbox did not answer.", { status: 502 });
    const out = new Headers();
    upstream.headers.forEach((value, name) => {
      if (!DROP_RESPONSE_HEADERS.has(name.toLowerCase())) out.set(name, value);
    });
    out.set("cache-control", "no-store");
    return new Response(upstream.body, { status: upstream.status, headers: out });
  }),
});

export default http;
