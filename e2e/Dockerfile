# The demo, in a container, for people who do not want to think about it.
#
# Two stages because the demo page imports the library's BUILT files
# (`packages/driverkit/dist/...`), and `dist/` is gitignored -- a fresh clone
# has none. Node builds it; Python serves it. Nothing in the serving stage
# needs node, npm or a network.
#
#   docker compose -f e2e/docker-compose.yml up --build
#
# This is an ADDITION to the zero-install path, not a replacement for it:
# `npm ci && npm run build && python3 examples/contacts/server.py` on a machine
# with node and python3 does the same thing with no Docker at all.

FROM node:22-slim AS build
WORKDIR /src
# The manifests first, so a source-only change does not re-resolve npm.
COPY package.json package-lock.json tsconfig*.json ./
COPY packages/driverkit/package.json packages/driverkit/
COPY packages/eval/package.json packages/eval/
RUN npm ci
COPY packages ./packages
RUN npm run build


FROM python:3.12-slim AS demo
WORKDIR /app

# The ONLY thing installed, and it is here for one specific reason.
#
# `driverkit.relay` refuses any caller that is not on loopback unless it is
# given `allow_remote` plus a way to tell callers apart -- correctly, because a
# relay drives a logged-in browser session. `examples/contacts/server.py` has
# no knob for that, and should not grow one to suit a container.
#
# Inside a container, a request that came through a published port arrives from
# the Docker gateway, so the relay 403s the page's own SSE stream and the demo
# loads with a red dot and a console error. The fix is not to weaken the relay:
# it is to make the hop that crosses the container boundary end at 127.0.0.1.
# socat listens on 0.0.0.0 and forwards raw TCP to the demo on loopback, so the
# relay sees the peer it is entitled to insist on. Raw TCP, so the never-ending
# SSE body and the chunked POSTs pass through untouched.
RUN apt-get update \
 && apt-get install -y --no-install-recommends socat \
 && rm -rf /var/lib/apt/lists/*

# Standard library only, by design: `python/pyproject.toml` has no
# dependencies, so there is no install step and no wheel to build here. The
# relay, the client and the stdio MCP server all run off this.
COPY python ./python
COPY examples ./examples
COPY packages/driverkit/src ./packages/driverkit/src
COPY --from=build /src/packages/driverkit/dist ./packages/driverkit/dist

# The demo binds loopback, exactly as it does on a laptop. socat is what the
# outside world reaches.
ENV DK_HOST=127.0.0.1 \
    DK_PORT=8771 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

EXPOSE 8770
COPY e2e/entrypoint.sh /usr/local/bin/dk-entrypoint
RUN chmod +x /usr/local/bin/dk-entrypoint

# No key is baked in and none is required to serve the page: every screen and
# the relay work without one. `/api/chat` is the only thing that needs
# ANTHROPIC_API_KEY, and compose passes it through from the environment.
CMD ["dk-entrypoint"]
