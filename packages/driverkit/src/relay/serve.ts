/**
 * Run the relay on its own.
 *
 *   node --experimental-strip-types packages/relay/src/serve.ts
 *   DK_PORT=7777 node --experimental-strip-types packages/relay/src/serve.ts
 *
 * Most deployments should not use this file. PROTOCOL.md's argument for SSE is
 * that the relay belongs inside a server you already run -- an extra process is
 * an extra thing to supervise. This
 * exists for the case where there is no such server yet: a local dev loop, or a
 * static page you want to drive today.
 */

import { createServer, type Server } from "node:http";
import { createRelay, type Relay, type RelayOptions } from "./relay.ts";
import { TabAuth } from "./auth.ts";

export interface ServeOptions extends RelayOptions {
  port?: number;
  /**
   * Loopback by default, and changing it takes TWO deliberate acts: a host here
   * and `allowRemote` in the relay itself. That is not redundancy. Binding
   * 0.0.0.0 is a thing people do by reflex to reach a dev server from a phone;
   * here it would publish the ability to drive the logged-in session of whoever
   * has a tab open. Requiring the second flag means nobody arrives at a
   * remotely drivable browser by muscle memory.
   */
  host?: string;
}

export function serve(options: ServeOptions = {}): Promise<{ server: Server; relay: Relay; port: number; url: string }> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  // `createRelay` itself refuses `allowRemote` without `auth` or
  // `resolvePrincipal`, so there is no second copy of that rule here to fall
  // out of step with the first. This one is only about the interface.
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && !options.allowRemote) {
    throw new Error(
      `driverkit: refusing to bind ${host} without allowRemote. A reachable relay is someone else ` +
        `driving your logged-in browser session. Read "Who is allowed to do this" in PROTOCOL.md, ` +
        `put your app's own auth in front of the relay, then pass allowRemote: true.`,
    );
  }

  const relay = createRelay(options);
  // Standalone, so an unknown path IS an error -- unlike the embedded case,
  // where `handler` returning false means "not mine, let the app answer".
  const server = createServer((req, res) => {
    if (relay.handler(req, res)) return;
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not-found", hint: "this process serves /dk/* only" }));
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      const bound = typeof addr === "object" && addr ? addr.port : port;
      resolve({ server, relay, port: bound, url: `http://${host}:${bound}` });
    });
  });
}

// Node 22.19+ sets `import.meta.main` only for the entry module, so importing
// `serve` from a test or an app does not start a server.
if ((import.meta as unknown as { main?: boolean }).main) {
  // Spread rather than `?? undefined`, because `exactOptionalPropertyTypes` is
  // on and it is right to be on here: `ServeOptions.timeoutMs` being absent
  // means "use the relay's default", and passing it explicitly as `undefined`
  // is a different statement that happens to behave the same today. An unset
  // env var must say nothing at all rather than say "no timeout".
  // DK_SECRET, not an argument: an argument is visible in `ps` to every user on
  // the box, and a secret that leaks to a shell history is a secret.
  const secret = process.env.DK_SECRET;
  const audience = process.env.DK_AUDIENCE;
  if (Boolean(secret) !== Boolean(audience)) {
    console.error(
      "driverkit relay: DK_SECRET and DK_AUDIENCE go together. The secret verifies a token; " +
        "the audience says which relay it was minted for.",
    );
    process.exit(2);
  }
  const auth = secret && audience
    ? new TabAuth({
        secret,
        audience,
        anonymous: process.env.DK_NO_ANONYMOUS !== "1",
        requireTabBinding: process.env.DK_REQUIRE_TAB_BINDING === "1",
      })
    : undefined;

  const { url } = await serve({
    port: process.env.DK_PORT ? Number(process.env.DK_PORT) : 7777,
    ...(process.env.DK_HOST ? { host: process.env.DK_HOST } : {}),
    allowRemote: process.env.DK_ALLOW_REMOTE === "1",
    ...(auth ? { auth } : {}),
    ...(process.env.DK_TIMEOUT_MS ? { timeoutMs: Number(process.env.DK_TIMEOUT_MS) } : {}),
    onError: (err) => console.error("driverkit relay:", err),
  });
  console.error(`driverkit relay on ${url}  (tabs: ${url}/dk/tabs)`);
  if (process.env.DK_ALLOW_REMOTE === "1") {
    console.error(
      `driverkit relay: allowRemote is ON. Callers are identified by tab token ` +
        `(audience ${JSON.stringify(audience)}); each sees only its own tabs.`,
    );
  } else if (auth) {
    console.error("driverkit relay: tab tokens required, loopback only.");
  }
}
