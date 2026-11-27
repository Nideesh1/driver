# Releasing

Publishing is one command:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

The tag **is** the version. `packages/driverkit/package.json` and
`python/pyproject.toml` both say `0.0.0` on `main` and are rewritten from the
tag inside the workflow, so the two halves cannot drift apart and a release
cannot ship the previous version's number by accident.

`.github/workflows/release.yml` then runs every test and both typechecks,
builds both halves, and publishes:

- `driverkit` to **PyPI**
- `driverkit` to **npm**, with a provenance attestation

If anything fails, nothing publishes. A re-run of an already-published version
is skipped rather than failed, so a half-finished release can be re-run safely.

## There are no secrets

Both registries use **trusted publishing** (OIDC): GitHub proves to the
registry which repository and which workflow is asking, and the registry
decides. No token is stored anywhere, so there is no token to leak, rotate, or
find revoked at the worst moment.

That is also why the `npm` job has no `environment:` — an environment exists to
hold a secret, and here there is no secret to hold.

## One-time setup, before the first tag

Both are done in a browser, on the registries themselves, by whoever owns the
packages. Neither can be done from this repository.

**PyPI** — add a *pending publisher* at
<https://pypi.org/manage/account/publishing/>:

| field | value |
|---|---|
| PyPI project name | `driverkit` |
| Owner | `Nideesh1` |
| Repository name | `driver` |
| Workflow name | `release.yml` |
| Environment name | `pypi` |

*Pending* is the right kind: it authorises the first publish of a project that
does not exist yet. It becomes an ordinary publisher once the first release
lands.

**npm** — unlike PyPI, npm has **no pending-publisher equivalent**: the package
must already exist before a trusted publisher can be attached to it. So the
first publish of `driverkit` is a manual one, and only that one:

```sh
cd packages/driverkit && npm run build && npm publish --access public
```

from a machine logged in as the package owner. Then, on the package's settings
page on npmjs.com, add the trusted publisher: repository `Nideesh1/driver`,
workflow `release.yml`. Every release after that comes from a tag.

**Two traps, both of which cost a release if you hit them:**

- **A new trusted publisher expires if no publish succeeds within two days.**
  So configure it when you are ready to tag, not weeks ahead — and if the first
  tagged release fails for an unrelated reason, check the publisher is still
  there before assuming the failure was the workflow's.
- **npm >= 11.5.1 and Node >= 22.14.0 are required.** The runner's bundled npm
  is older, which is what the `npm install -g npm@latest` line in the workflow
  is for. A Node 22 runner with npm 10.x fails the publish with an error that
  does not mention OIDC at all.

## Checking before you tag

```sh
npm run build && npm test && (cd python && uv run python -m unittest discover -s tests -t tests)
node --test e2e/smoke.spec.mjs     # needs a demo server; see e2e/README.md
```

CI runs all of this on every push, so a green `main` is the real check. The
workflow runs it again at release time regardless, because the thing being
published is built there and not from anybody's laptop.
