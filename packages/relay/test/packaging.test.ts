/**
 * What `npm install driverkit` gets, asserted rather than assumed.
 *
 * Every package used to declare `{"default": "./src/index.ts"}` with
 * `files: ["src"]` and no build, so a plain `<script type="module">` -- the
 * case a zero-dependency, framework-free widget is MOST attractive for --
 * could not use the library at all, and the one example in the repository had
 * to strip TypeScript per request in its own dev server to load it. Nothing
 * failed; there was simply no test that looked at the published shape, because
 * every existing test imports `../src/*.ts` by relative path and a relative
 * path never consults `exports`.
 *
 * So this file deliberately does not import anything the way the rest of the
 * suite does. It reads each manifest and then loads the built output in a
 * SEPARATE `node` with no `--experimental-strip-types`, because a type-
 * stripping parent process is exactly the thing that would hide a regression
 * here.
 *
 * It lives in `packages/relay/test/` only because the test glob is
 * `packages/*​/test/*.test.ts` and the packaging contract belongs to no single
 * package. Nothing in it is relay-specific.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const ROOT = new URL("../../../", import.meta.url).pathname;

/** The six packages and the names they publish under. */
const PACKAGES: Array<[dir: string, name: string]> = [
  ["core", "driverkit"],
  ["agent", "@driverkit/agent"],
  ["adapters", "@driverkit/adapters"],
  ["browser", "@driverkit/browser"],
  ["relay", "@driverkit/relay"],
  ["widget", "@driverkit/widget"],
];

const manifest = (dir: string) =>
  JSON.parse(readFileSync(`${ROOT}packages/${dir}/package.json`, "utf8")) as {
    name: string;
    files: string[];
    main: string;
    module: string;
    types: string;
    exports: Record<string, { types: string; default: string }>;
    dependencies?: Record<string, string>;
  };

test("every package publishes built JavaScript, never a .ts file", () => {
  for (const [dir, name] of PACKAGES) {
    const pkg = manifest(dir);
    assert.equal(pkg.name, name);
    for (const [subpath, conditions] of Object.entries(pkg.exports)) {
      // The condition ORDER matters as much as the targets: a resolver takes
      // the first match, so a `default` ahead of `types` hands TypeScript the
      // `.js` and leaves it inferring `any` for the whole package.
      assert.deepEqual(
        Object.keys(conditions),
        ["types", "default"],
        `${name} ${subpath}: conditions must be types-then-default`,
      );
      assert.match(conditions.types, /^\.\/dist\/.+\.d\.ts$/, `${name} ${subpath} types`);
      assert.match(conditions.default, /^\.\/dist\/.+\.js$/, `${name} ${subpath} default`);
    }
    // `main` and `module` for resolvers that predate `exports`. They name the
    // same file, so there is no second entry point to drift out of step.
    assert.equal(pkg.main, "./dist/index.js");
    assert.equal(pkg.module, "./dist/index.js");
    assert.equal(pkg.types, "./dist/index.d.ts");
    assert.ok(pkg.files.includes("dist"), `${name} must publish dist`);
    assert.ok(!pkg.files.includes("src"), `${name} must not publish src`);
  }
});

test("a package that imports a sibling declares it as a dependency", () => {
  // The cross-package imports are all `import type` except one, and that does
  // NOT make them free: a `.d.ts` that says `import type { Row } from
  // "driverkit"` needs `driverkit` installed for a consumer's editor to
  // resolve `Row` at all. An undeclared type dependency is an install that
  // typechecks on the author's machine and nowhere else.
  const needs: Record<string, string[]> = {
    core: [],
    agent: ["driverkit"],
    adapters: ["driverkit"],
    browser: ["driverkit"],
    relay: ["driverkit"],
    widget: ["driverkit", "@driverkit/agent"],
  };
  for (const [dir, wanted] of Object.entries(needs)) {
    const declared = Object.keys(manifest(dir).dependencies ?? {});
    for (const dep of wanted) {
      assert.ok(declared.includes(dep), `${dir} imports ${dep} but does not depend on it`);
    }
  }
});

test("the built output loads in plain Node with no type stripping", async (t) => {
  if (!PACKAGES.every(([dir]) => existsSync(`${ROOT}packages/${dir}/dist/index.js`))) {
    t.skip("no dist/: run `npm run build` first (the root `test` script does)");
    return;
  }

  // A child `node` with no flags, importing through the bare specifiers that
  // only the `exports` maps and the workspace links can resolve. Run as a
  // subprocess on purpose: this parent was started with
  // `--experimental-strip-types`, and flags are inherited, so an in-process
  // check would prove nothing about the case this test exists for.
  const probe = [
    'import { mount } from "driverkit";',
    'import { createRelay } from "@driverkit/relay";',
    'import { serve } from "@driverkit/relay/serve";',
    'import { connect } from "@driverkit/browser";',
    'import { rowsFromTable } from "@driverkit/adapters";',
    'import { drive, commas } from "@driverkit/agent";',
    'import { mountWidget } from "@driverkit/widget";',
    // Importable is not enough. A driver mounted and a verb called, out of the
    // built files, so a package that loads but exports nothing usable fails.
    'const driver = mount({ app: "toy", visible: () => ({ where: "rows", rev: 1, rows: [{ id: "a" }] }),',
    '  verbs: [{ name: "ping", describe: "say hi", run: () => {} }] });',
    'const r = await driver.call("ping", {});',
    'if (!r.ok || r.snapshot.rev !== 1) throw new Error("the built core did not answer a call");',
    'for (const [n, v] of Object.entries({ createRelay, serve, connect, rowsFromTable, drive, commas, mountWidget }))',
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

test("only @driverkit/widget needs a bare specifier resolved at runtime", async (t) => {
  if (!PACKAGES.every(([dir]) => existsSync(`${ROOT}packages/${dir}/dist/index.js`))) {
    t.skip("no dist/: run `npm run build` first");
    return;
  }

  // The browser half of the claim. A `<script type="module">` resolves
  // relative URLs and nothing else -- no `node_modules` walk -- so a package
  // whose emitted JavaScript contains a bare specifier needs an import map
  // entry and one without is loadable from a plain URL as it stands.
  //
  // This is pinned rather than left to be rediscovered because it is the
  // difference between "copy the dist folder onto your static host" and "and
  // also write an import map". The one exception is the only cross-package
  // VALUE import in the repository: `@driverkit/widget` imports `drive` from
  // `@driverkit/agent`. Everything else between packages is `import type`,
  // which is erased outright.
  const external = new Map<string, string[]>();
  for (const [dir] of PACKAGES) {
    const found = new Set<string>();
    const out = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `import { readdirSync, readFileSync } from "node:fs";
           const d = ${JSON.stringify(`${ROOT}packages/${dir}/dist`)};
           const hits = [];
           for (const f of readdirSync(d).filter((f) => f.endsWith(".js")))
             for (const m of readFileSync(d + "/" + f, "utf8").matchAll(/^\\s*(?:import|export)[^;]*?from\\s+"([^"]+)"/gm))
               if (!m[1].startsWith(".")) hits.push(m[1]);
           console.log(JSON.stringify([...new Set(hits)]));`,
        ],
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
    });
    for (const spec of JSON.parse(out) as string[]) found.add(spec);
    if (found.size) external.set(dir, [...found].sort());
  }

  assert.deepEqual(
    Object.fromEntries(external),
    {
      // Server-side by definition; nobody loads the relay in a page. `node:crypto`
      // is the HMAC that verifies a tab token -- stdlib, not a dependency, and
      // the reason `auth.ts` does not need `jsonwebtoken` or `jose`.
      relay: ["node:crypto", "node:http"],
      widget: ["@driverkit/agent"],
    },
    "a new bare specifier in emitted JS is a new import-map entry every page needs",
  );
});
