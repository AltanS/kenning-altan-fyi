// Starts and stops the production build of the app on 127.0.0.1, inside the
// ts-dev toolbox. Production mode matters: the service worker only registers in
// a production bundle (`import.meta.env.PROD`).
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { sleep } from './cdp.mjs';

const repo = new URL('../../', import.meta.url).pathname;

function listeningPid(port) {
  try {
    const out = execFileSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' });
    const match = out.match(/pid=(\d+)/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

export function portInUse(port) {
  return execFileSync('ss', ['-ltnH', `sport = :${port}`], { encoding: 'utf8' }).trim() !== '';
}

export async function startApp({ port, publicOrigin, dbName, logFile }) {
  if (portInUse(port)) {
    throw new Error(`Port ${port} is already in use. A stale server would make this run test an old build.`);
  }
  const { openSync } = await import('node:fs');
  const out = openSync(logFile, 'w');
  const env = [
    'CI=true',
    'NODE_ENV=production',
    `PORT=${port}`,
    `HMR_PORT=${port + 1000}`,
    `DB_NAME=${dbName}`,
    `APP_URL=${publicOrigin}`,
    // Not secrets: a throwaway value for a throwaway database.
    `SESSION_SECRET=${randomBytes(24).toString('hex')}`,
    // Production refuses to boot without a pigeon config. These point nowhere.
    'PIGEON_API_KEY=offline-check-dummy',
    'PIGEON_BASE_URL=http://127.0.0.1:9',
    // No model call may be paid for by this harness.
    'OPENROUTER_API_KEY=disabled',
    'OPENAI_API_KEY=disabled',
    'ANTHROPIC_API_KEY=disabled',
  ];
  const child = spawn(
    'toolbox',
    ['run', '-c', 'ts-dev', 'env', ...env, 'node', '--import', 'tsx', '--import', './scripts/offline-check/bind-localhost.mjs', './server.ts'],
    { cwd: repo, stdio: ['ignore', out, out], detached: true },
  );
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });

  const deadline = Date.now() + 90000;
  for (;;) {
    if (exited) throw new Error(`The app exited during start. See ${logFile}`);
    if (Date.now() > deadline) throw new Error(`The app did not answer in 90 s. See ${logFile}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthcheck`);
      if (res.ok) break;
    } catch {
      // not up yet
    }
    await sleep(500);
  }

  return {
    pid: () => listeningPid(port),
    async stop() {
      const pid = listeningPid(port);
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // already gone
      }
      if (pid) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // already gone
        }
      }
      const until = Date.now() + 12000;
      while (portInUse(port) && Date.now() < until) await sleep(250);
      if (portInUse(port)) {
        const left = listeningPid(port);
        if (left) process.kill(left, 'SIGKILL');
        await sleep(500);
      }
    },
  };
}
