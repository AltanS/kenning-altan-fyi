#!/bin/sh
set -e

echo "[start] Running schema migrations..."
pnpm drizzle:migrate

echo "[start] Running data migrations..."
pnpm cli data-migration run

# TWO PROCESSES IN ONE CONTAINER, ON PURPOSE.
#
# The enrichment workflow (M171/02) is a pg-boss job, and a queued job that
# nothing dequeues is a permanently pending entry page. `worker.ts` is what
# dequeues it. Bay runs ONE container for this service (group_vars/all/
# services.yml, `translate`), so the worker either shares this container or it
# does not run at all.
#
# WHY NOT `exec`. The old last line was `exec pnpm start`, which replaces this
# shell. A replaced shell cannot forward a signal to a second child and cannot
# notice one dying, so a backgrounded worker would be orphaned on every deploy
# and its shutdown would never be graceful. This supervisor keeps the shell
# alive instead.
#
# WHY A POLL AND NOT `wait -n`. The base image is alpine, so /bin/sh is BusyBox
# ash, where `wait -n` is not portable. The loop below is the POSIX equivalent:
# if either child stops existing, tear the other one down and exit non-zero so
# the container restarts as a unit. A half-dead container that still answers the
# healthcheck is the failure mode this exists to prevent.
term() {
  kill -TERM "$worker_pid" "$web_pid" 2>/dev/null || true
  wait "$worker_pid" 2>/dev/null || true
  wait "$web_pid" 2>/dev/null || true
}

# THE HEAP CAPS ARE NOT TUNING, THEY ARE WHAT MAKES TWO PROCESSES FIT.
#
# Bay gave this service 512 MB at first (`memory` in bay.toml; 768 MB since
# 2026-11-18).
# Measured on stage: the web process alone sat at 220 MiB, and adding the worker
# took the container to 485 MiB, 95% of the limit, with no headroom for the JSON
# an enrichment response carries. V8 sizes its old space generously when nothing
# tells it not to, so both processes were holding memory they did not need.
#
# Capping old space brings the pair to roughly 400 MiB and leaves real room.
# Raise these together with `memory` in bay.toml, never alone.
#
# 2026-11-18, after two heap OOMs of the web process: the limit is now 768 MB.
# Live heap after a forced GC, idle, measured locally with these caps:
#   server 123 MB (was 219 MB, a cap of 256 left it 37 MB for every request;
#                  vite.config.ts says where the 96 MB went)
#   worker  87 MB (65 MB of it is @openrouter/sdk, loaded once)
# Budget: 256 + 320 = 576 MB of old space, plus about 150 MB outside it (young
# generation, code, buffers, the two esbuild services tsx starts) per container,
# stays under 768 MB. The worker gets the larger cap because up to eight jobs
# run at once across its queues, each holding a prompt and a parsed response.
# NODE IS INVOKED DIRECTLY, NOT THROUGH pnpm, AND THAT IS A MEMORY DECISION.
#
# `pnpm worker` costs four resident node processes, not one: pnpm's launcher,
# pnpm itself, the tsx cli, and finally the program. `pnpm start` costs five,
# because cross-env adds another. Measured inside the stage container, those
# wrappers were most of the difference between 220 MiB for one service and
# 476 MiB for two, and none of them does anything after the program starts.
#
# `node --import tsx` is exactly what the tsx cli ends up executing, so this
# runs the same code with none of the scaffolding. The two package.json scripts
# stay as they are for local use, where the wrappers cost nothing that matters.
echo "[start] Starting worker..."
NODE_OPTIONS="$NODE_OPTIONS --max-old-space-size=320" node --import tsx ./worker.ts &
worker_pid=$!

echo "[start] Starting server..."
NODE_ENV=production NODE_OPTIONS="$NODE_OPTIONS --max-old-space-size=256" node --import tsx ./server.ts &
web_pid=$!

trap 'term; exit 0' TERM INT

while kill -0 "$worker_pid" 2>/dev/null && kill -0 "$web_pid" 2>/dev/null; do
  sleep 2
done

echo "[start] A child process exited, shutting the container down."
term
exit 1
