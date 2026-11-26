/**
 * Start the demo on a free port, and wait until it actually answers.
 *
 * `examples/contacts/server.py` is the whole demo in one process: the page,
 * the type-stripped library sources, `/api/chat` and the relay at `/dk`. It
 * needs `python3` and nothing else, which is why the smoke test starts it
 * directly rather than through Docker -- compose is the convenience, not the
 * dependency.
 *
 * Set `DK_BASE` and nothing is started: the test drives the server already
 * listening there. That is the shape CI uses (one server, `check.mjs` and the
 * browser test both pointed at it) and the shape to use locally when a demo
 * with a real key is already up.
 */

import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** An ephemeral port the kernel just told us is free. */
async function freePort() {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(url, deadlineMs = 20_000) {
  const until = Date.now() + deadlineMs;
  let last;
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      last = `status ${res.status}`;
    } catch (err) {
      last = err.message;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`demo server never answered ${url} (${last})`);
}

/**
 * @returns {Promise<{ base: string, stop: () => Promise<void> }>}
 */
export async function startDemo() {
  const existing = process.env.DK_BASE;
  if (existing) {
    const base = existing.replace(/\/$/, "");
    await waitFor(`${base}/examples/contacts/app/`);
    return { base, stop: async () => {} };
  }

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn("python3", [path.join(ROOT, "examples", "contacts", "server.py")], {
    cwd: ROOT,
    // No key is passed on purpose. The page, all six screens and the relay
    // work without one; only `/api/chat` does not, and the tests that need it
    // skip themselves. Nothing here reads or prints a key.
    env: { ...process.env, DK_PORT: String(port), DK_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.resume();
  child.stderr.resume();

  let exited = null;
  child.on("exit", (code, signal) => (exited = `exit ${code} ${signal ?? ""}`));

  try {
    await waitFor(`${base}/examples/contacts/app/`);
  } catch (err) {
    child.kill("SIGKILL");
    throw new Error(`${err.message}${exited ? ` (server ${exited})` : ""}`);
  }

  return {
    base,
    stop: async () => {
      if (exited) return;
      child.kill("SIGTERM");
      await new Promise((r) => {
        const t = setTimeout(() => {
          child.kill("SIGKILL");
          r();
        }, 3000);
        child.on("exit", () => {
          clearTimeout(t);
          r();
        });
      });
    },
  };
}
