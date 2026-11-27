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

**npm** — the package must exist before it can have a trusted publisher, and
trusted publishing is configured on the package's settings page on
npmjs.com: link the GitHub repository `Nideesh1/driver` and the workflow
`release.yml`. If `driverkit` has never been published, publish `0.0.1` once by
hand from a machine that is logged in, then set up trusted publishing and let
every later release come from the tag.

## Checking before you tag

```sh
npm run build && npm test && (cd python && uv run python -m unittest discover -s tests -t tests)
node --test e2e/smoke.spec.mjs     # needs a demo server; see e2e/README.md
```

CI runs all of this on every push, so a green `main` is the real check. The
workflow runs it again at release time regardless, because the thing being
published is built there and not from anybody's laptop.
