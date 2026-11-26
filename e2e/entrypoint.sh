#!/bin/bash
# bash and not sh: `wait -n` ("tell me when EITHER of these dies") is a bash
# builtin, and the image has bash. Polling two pids in a loop was the dash
# alternative and it is worse.
#
# Two processes, one container: the demo on loopback, and a raw TCP forwarder
# from the published port to it. See the comment on socat in the Dockerfile for
# why the hop has to end at 127.0.0.1.
#
# `set -e` and an explicit trap rather than an init system: if either half
# dies, the container should die with it so `docker compose` says so, instead
# of sitting there serving half a demo.
set -e

DEMO_PORT="${DK_PORT:-8771}"
PUBLIC_PORT="${DK_PUBLIC_PORT:-8770}"

python3 examples/contacts/server.py &
demo=$!
trap 'kill "$demo" 2>/dev/null; exit' INT TERM

# Wait for it, rather than racing socat against interpreter startup.
i=0
while [ "$i" -lt 100 ]; do
  if python3 -c "
import socket, sys
s = socket.socket()
s.settimeout(0.3)
sys.exit(0 if s.connect_ex(('127.0.0.1', $DEMO_PORT)) == 0 else 1)
"; then
    break
  fi
  kill -0 "$demo" 2>/dev/null || { echo "demo exited before it listened" >&2; exit 1; }
  i=$((i + 1))
  sleep 0.2
done

# `fork` so more than one browser tab works, and `reuseaddr` so a restart does
# not wait out TIME_WAIT.
socat "TCP-LISTEN:$PUBLIC_PORT,fork,reuseaddr" "TCP:127.0.0.1:$DEMO_PORT" &
proxy=$!
trap 'kill "$demo" "$proxy" 2>/dev/null; exit' INT TERM

# Whichever exits first takes the container with it.
wait -n "$demo" "$proxy"
kill "$demo" "$proxy" 2>/dev/null || true
