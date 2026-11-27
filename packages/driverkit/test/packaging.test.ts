/**
 * What `npm install driverkit` gets, asserted rather than assumed.
 *
 * Every area used to be its own package, and the one thing that forced the
 * split was `relay`: it imports `node:http`, and a browser bundler asked to
 * resolve that fails. Six packages is a heavy answer to one import, so there
 * is one package now and `relay` lives behind a `"node"` condition in the
 * `exports` map. That trade is only sound if a browser-targeted build really
 * cannot reach it, which is what the middle of this file is about.
 *
 * So this file deliberately does not import anything the way the rest of the
 * suite does. It reads the manifest, resolves its `exports` map by the spec's
 * own algorithm under two different condition sets, and then loads the built
 * output in a SEPARATE `node` with no `--experimental-strip-types`, because a
 * type-stripping parent process is exactly the thing that would hide a
 * regression here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";

const ROOT = new URL("../../../", import.meta.url).pathname;
const PKG = `${ROOT}packages/driverkit/`;

type Target = string | null | { [condition: string]: Target };

const manifest = () =>
  JSON.parse(readFileSync(`${PKG}package.json`, "utf8")) as {
    name: string;
    files: string[];
    main: string;
    module: string;
    types: string;
    exports: Record<string, Record<string, Target>>;
    dependencies?: Record<string, string>;
  };

/** Every subpath the package publishes, and whether a page may load it. */
const ENTRIES: Array<[subpath: string, browser: boolean]> = [
  [".", true],
  ["./agent", true],
  // The honesty checker. Browser-safe and deliberately reachable from a page:
  // the place an author runs it is their own test file, which may well be a
  // test file in a browser.
  ["./check", true],
  ["./browser", true],
  ["./controls", true],
  ["./widget", true],
  // One audit sink, kept out of the way. Browser-safe because it imports
  // nothing -- not even `@opentelemetry/api`, which it takes as an argument --
  // and that is also why it is reachable from a page at all: the in-page
  // widget is the case most likely to commit data and the one with no relay.
  ["./otel", true],
  // The React panel. Browser-safe, and browser-safe for a reason worth knowing
  // before reading the tests at the bottom of this file: it imports `react`
  // nowhere, not even as a type. The React API is typed structurally and handed
  // in, exactly as `./otel` takes a `Tracer`, so this entry is as loadable from
  // a plain URL as the vanilla widget is.
  ["./react", true],
  ["./relay", false],
  ["./relay/serve", false],
];

/**
 * Node's `PACKAGE_TARGET_RESOLVE` condition walk, over a real `exports` value.
 *
 * Thirty lines of somebody else's algorithm is a thing to justify. The
 * alternative was to assert the shape of the object instead -- "`./relay` has
 * a `node` key and no `default` key" -- and that tests the spelling rather
 * than the consequence: a `browser` key added beside `node` in six months
 * would keep the shape and quietly undo the guarantee. This answers the
 * question a bundler asks, which is "given these conditions, what file do I
 * open", and `null` for an answer is the point.
 *
 * A real bundler was also run against this out of band, because a resolver
 * written in the same repository as the manifest it resolves can agree with
 * itself and be wrong. That check is not in the suite because the suite has no
 * dependencies and is not about to grow one.
 */
function resolveTarget(target: Target, conditions: Set<string>): string | null {
  if (target === null) return null;
  if (typeof target === "string") return target;
  for (const [condition, next] of Object.entries(target)) {
    if (condition === "default" || conditions.has(condition)) {
      const found = resolveTarget(next, conditions);
      if (found !== null) return found;
    }
  }
  return null;
}

/** What a browser-targeted bundler asks for: no `node`. */
const BROWSER = new Set(["import", "module", "browser", "default"]);
/** What Node asks for. */
const NODE = new Set(["node", "import", "default"]);

test("the package publishes built JavaScript, never a .ts file", () => {
  const pkg = manifest();
  assert.equal(pkg.name, "driverkit");
  assert.deepEqual(Object.keys(pkg.exports), ENTRIES.map(([subpath]) => subpath));

  for (const [subpath, browser] of ENTRIES) {
    const entry = pkg.exports[subpath]!;
    // The condition ORDER matters as much as the targets: a resolver takes the
    // first match, so a `default` ahead of `types` hands TypeScript the `.js`
    // and leaves it inferring `any` for the whole package. Under a `node`
    // condition the same rule applies one level in.
    const conditions = browser ? entry : (entry["node"] as Record<string, Target>);
    assert.deepEqual(
      Object.keys(conditions),
      ["types", "default"],
      `${subpath}: conditions must be types-then-default`,
    );
    assert.match(String(conditions["types"]), /^\.\/dist\/.+\.d\.ts$/, `${subpath} types`);
    assert.match(String(conditions["default"]), /^\.\/dist\/.+\.js$/, `${subpath} default`);
  }

  // `main` and `module` for resolvers that predate `exports`. They name the
  // same file, so there is no second entry point to drift out of step. They
  // name the CORE and not a barrel of everything: a resolver that ignores
  // `exports` must not be handed the relay.
  assert.equal(pkg.main, "./dist/core/index.js");
  assert.equal(pkg.module, "./dist/core/index.js");
  assert.equal(pkg.types, "./dist/core/index.d.ts");
  assert.ok(pkg.files.includes("dist"), "the package must publish dist");
  assert.ok(!pkg.files.includes("src"), "the package must not publish src");
  // CONTROLS.md is published and not merely committed: `driverkit/controls` is
  // the one entry whose cost needs reading about before it is imported.
  assert.ok(pkg.files.includes("CONTROLS.md"), "CONTROLS.md ships with the package");
});

test("a browser-targeted build resolves every entry except the relay", () => {
  const { exports } = manifest();

  for (const [subpath, browser] of ENTRIES) {
    const underBrowser = resolveTarget(exports[subpath]!, BROWSER);
    const underNode = resolveTarget(exports[subpath]!, NODE);

    // Node reaches everything. That is the easy half, and it is here so that a
    // mistake in the other half cannot pass by making nothing resolvable.
    assert.match(String(underNode), /^\.\/dist\/.+\.js$/, `node must resolve ${subpath}`);

    if (browser) {
      assert.match(
        String(underBrowser),
        /^\.\/dist\/.+\.js$/,
        `${subpath} must be loadable in a page: it has no node-only code`,
      );
    } else {
      // The whole point. `null` is a resolver failure -- "this package does not
      // export that subpath under these conditions" -- which a bundler reports
      // at build time with the offending import in front of it. Deliberately
      // NOT a `browser` shim resolving to an empty module: that would hand
      // somebody a `createRelay` that silently does nothing, which is strictly
      // worse than a build error. See the `//exports` note in package.json.
      assert.equal(underBrowser, null, `${subpath} must be unreachable in a page`);
    }
  }

  // And the reason it matters, read off the thing it is about: the relay's
  // emitted code names Node builtins, so resolving it in a page would not fail
  // honestly at the import -- it would fail somewhere inside a bundle.
  if (existsSync(`${PKG}dist/relay`)) {
    const relay = readdirSync(`${PKG}dist/relay`)
      .filter((f) => f.endsWith(".js"))
      .map((f) => readFileSync(`${PKG}dist/relay/${f}`, "utf8"))
      .join("\n");
    assert.match(relay, /from "node:(http|crypto)"/, "the relay is the node-only entry");
  }
});

test("the built output loads in plain Node with no type stripping", async (t) => {
  if (!existsSync(`${PKG}dist/core/index.js`)) {
    t.skip("no dist/: run `npm run build` first (the root `test` script does)");
    return;
  }

  // A child `node` with no flags, importing through the bare specifiers that
  // only the `exports` map and the workspace link can resolve. Run as a
  // subprocess on purpose: this parent was started with
  // `--experimental-strip-types`, and flags are inherited, so an in-process
  // check would prove nothing about the case this test exists for.
  const probe = [
    'import { mount } from "driverkit";',
    'import { createRelay } from "driverkit/relay";',
    'import { serve } from "driverkit/relay/serve";',
    'import { connect } from "driverkit/browser";',
    'import { controlsFromDom } from "driverkit/controls";',
    'import { drive, commas } from "driverkit/agent";',
    'import { mountWidget } from "driverkit/widget";',
    'import { checkDriver } from "driverkit/check";',
    // The audit sink. An entry point nothing else imports is the one that
    // rots, so the probe loads it out of `dist/` like the rest.
    'import { otelAudit } from "driverkit/otel";',
    // The React panel, loaded out of `dist/` with no React anywhere on disk --
    // which is the whole claim, run as a program rather than argued about. An
    // entry point nothing else imports is the one that rots.
    'import { createDriverPanel, createPanelStore, receiptLine } from "driverkit/react";',
    // Importable is not enough. A driver mounted and a verb called, out of the
    // built files, so an entry that loads but exports nothing usable fails.
    'const driver = mount({ app: "toy", visible: () => ({ where: "rows", rev: 1, rows: [{ id: "a" }] }),',
    '  verbs: [{ name: "ping", describe: "say hi", run: () => {} }] });',
    'const r = await driver.call("ping", {});',
    'if (!r.ok || r.snapshot.rev !== 1) throw new Error("the built core did not answer a call");',
    'for (const [n, v] of Object.entries({ createRelay, serve, connect, controlsFromDom, drive, commas, mountWidget, checkDriver, otelAudit, createDriverPanel, createPanelStore, receiptLine }))',
    '  if (typeof v !== "function") throw new Error(n + " is " + typeof v);',
    'console.log("ok");',
  ].join("\n");

  const out = await new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      ["--input-type=module", "--eval", probe],
      { cwd: ROOT },
      (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout)),
    );
  });
  assert.equal(out.trim(), "ok");
});

test("the emitted JavaScript names no bare specifier outside the relay", async (t) => {
  if (!existsSync(`${PKG}dist/core/index.js`)) {
    t.skip("no dist/: run `npm run build` first");
    return;
  }

  // The browser half of the claim, and one the collapse improved rather than
  // preserved. A `<script type="module">` resolves relative URLs and nothing
  // else -- there is no `node_modules` walk in a page -- so a file whose
  // emitted JavaScript contains a bare specifier needs an import map entry,
  // and one without is loadable from a plain URL as it stands.
  //
  // While the widget was its own package, `import { drive } from
  // "@driverkit/agent"` was the one line that forced every page loading the
  // widget from a static host to write an import map. One package later it is
  // a relative path and that entry is gone -- the demo's index.html used to
  // carry it and no longer does. Pinned rather than left to be rediscovered,
  // because it is the difference between "copy dist/ onto your static host"
  // and "and also write an import map".
  const external = new Map<string, string[]>();
  for (const area of readdirSync(`${PKG}dist`)) {
    const out = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `import { readdirSync, readFileSync } from "node:fs";
           const d = ${JSON.stringify(`${PKG}dist/${area}`)};
           const hits = [];
           for (const f of readdirSync(d).filter((f) => f.endsWith(".js")))
             for (const m of readFileSync(d + "/" + f, "utf8").matchAll(/^\\s*(?:import|export)[^;]*?from\\s+"([^"]+)"/gm))
               if (!m[1].startsWith(".")) hits.push(m[1]);
           console.log(JSON.stringify([...new Set(hits)]));`,
        ],
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
    });
    const found = JSON.parse(out) as string[];
    if (found.length) external.set(area, found.sort());
  }

  assert.deepEqual(
    Object.fromEntries(external),
    {
      // Server-side by definition; nobody loads the relay in a page, and the
      // `exports` map is what enforces that. `node:crypto` is the HMAC that
      // verifies a tab token -- stdlib, not a dependency, and the reason
      // `auth.ts` does not need `jsonwebtoken` or `jose`.
      relay: ["node:crypto", "node:http"],
    },
    "a bare specifier in emitted JS is an import-map entry every page would need",
  );
});

test("the one dependency is the one the relay's own declarations need", () => {
  // `@types/node` and nothing else. It is in `dependencies` rather than
  // `devDependencies` because `dist/relay/*.d.ts` re-exports `node:http` types
  // in its PUBLIC surface: a consumer who imports `driverkit/relay` without it
  // gets TS2307 on the package's own declarations. Nothing is emitted into a
  // page bundle by a types-only dependency, so the browser entries pay nothing
  // for it -- which is the only reason one package can carry both halves.
  assert.deepEqual(Object.keys(manifest().dependencies ?? {}), ["@types/node"]);
});

test("react is an optional peer and never a dependency", () => {
  // The whole promise of `./react`, in the two fields that make it: somebody
  // who installs driverkit and never imports that subpath must not find React
  // in their lockfile. `optional: true` is what stops npm installing it AND
  // what stops npm warning about a peer they correctly do not have -- without
  // it, every consumer of a library with no React would see a peer warning for
  // an entry point they are not using.
  const pkg = manifest() as unknown as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };

  assert.deepEqual(Object.keys(pkg.peerDependencies ?? {}), ["react"]);
  assert.equal(pkg.peerDependenciesMeta?.["react"]?.optional, true, "the peer must be optional");
  // `>=18` and not `*`: `useSyncExternalStore` is an 18 API and the area is
  // built on it, so a 17 that satisfied `*` would resolve and then fail at
  // render -- which is the failure a version range exists to turn into an
  // install-time warning.
  assert.match(String(pkg.peerDependencies?.["react"]), /18/);
  assert.ok(
    !Object.keys(pkg.dependencies ?? {}).includes("react"),
    "react in `dependencies` would install it for everybody",
  );
});

test("the package never imports react, so an unresolvable .d.ts is impossible", async (t) => {
  if (!existsSync(`${PKG}dist/react/index.js`)) {
    t.skip("no dist/: run `npm run build` first");
    return;
  }

  // The half `peerDependenciesMeta` does NOT buy, and the reason this entry
  // point is shaped the way it is. `optional: true` stops the install; it does
  // nothing about `import type { ReactNode } from "react"` sitting in a
  // published declaration file, which is a dangling module reference for every
  // consumer who did not install React -- and `skipLibCheck` hides it from us
  // and not from them. So nothing in the package names `react` at all: the API
  // is typed structurally in src/react/runtime.ts and passed in. The same
  // argument, and the same shape, as `./otel` taking a `Tracer`.
  //
  // Declarations AND emitted JavaScript, because the two fail differently: a
  // `.d.ts` reference breaks a consumer's typecheck, and a `.js` one breaks
  // their bundle -- or, in a page with no import map, their import.
  const named: string[] = [];
  for (const area of readdirSync(`${PKG}dist`)) {
    for (const file of readdirSync(`${PKG}dist/${area}`)) {
      if (!file.endsWith(".js") && !file.endsWith(".d.ts")) continue;
      const text = readFileSync(`${PKG}dist/${area}/${file}`, "utf8");
      // Only real module specifiers. The files discuss `react` at length in
      // their comments -- saying why they do not import it -- and a test that
      // could not tell prose from an import would forbid the explanation.
      for (const m of text.matchAll(/^\s*(?:import|export)[^;]*?from\s+"([^"]+)"/gm)) {
        if (m[1] === "react" || m[1]?.startsWith("react/")) named.push(`${area}/${file}`);
      }
    }
  }
  assert.deepEqual(named, [], "a `react` specifier would dangle for every consumer without it");
});

test("driverkit/react is absent from the module graph of someone importing only driverkit", async (t) => {
  if (!existsSync(`${PKG}dist/core/index.js`)) {
    t.skip("no dist/: run `npm run build` first");
    return;
  }

  // The fourth condition, and the one a refactor would break by accident. The
  // other three are about `react`; this is about `./react` -- an optional entry
  // point that something in `core` or `widget` imported "just for a type" would
  // be in everybody's graph, and then the structural typing above would be the
  // only thing still holding the promise up.
  //
  // Walked rather than asserted as a list of allowed imports, because the thing
  // to prove is transitive: `core -> widget -> react` is as bad as
  // `core -> react` and a one-level check would miss it.
  const reached = new Set<string>();
  const queue = ["core/index.js"];
  while (queue.length > 0) {
    const at = queue.shift()!;
    if (reached.has(at)) continue;
    reached.add(at);
    const text = readFileSync(`${PKG}dist/${at}`, "utf8");
    const dir = at.slice(0, at.lastIndexOf("/"));
    for (const m of text.matchAll(/^\s*(?:import|export)[^;]*?from\s+"(\.[^"]+)"/gm)) {
      // `new URL` resolves `../agent/index.js` against the file's own directory
      // the way a module resolver would, which hand-joining paths does not.
      const to = new URL(m[1]!, `file:///${dir}/`).pathname.replace(/^\//, "");
      if (existsSync(`${PKG}dist/${to}`)) queue.push(to);
    }
  }

  assert.ok(reached.size > 1, "the walk must actually have walked something");
  assert.deepEqual(
    [...reached].filter((f) => f.startsWith("react/")),
    [],
    "nothing reachable from the core may pull the React entry point in",
  );
  // And the walk is sound only if it finds the area when the area IS imported.
  // Without this, a typo in the regex would make the assertion above pass by
  // reaching nothing at all.
  const fromReact = readFileSync(`${PKG}dist/react/index.js`, "utf8");
  assert.match(fromReact, /from "\.\.\/agent\/index\.js"/, "the react entry does import the agent");
});
