/**
 * Starts the servers of `playwright.config.ts` (API, web console, admin console) EXACTLY as Playwright would, and keeps them running until SIGTERM/SIGINT, so specs can be iterated
 * on without paying the start-up of three servers on every run (`E2E_REUSE_SERVERS=1 playwright test ...`, driven by `scripts/e2e-stack.sh`). The commands and environments are read
 * from the config itself: there is one definition. Ports and database come from the same `E2E_*` variables as the tests.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import config from './playwright.config';

type Server = { command: string; url?: string; env?: Record<string, string> };
const servers = (config.webServer ?? []) as unknown as Server[];
const children: ChildProcess[] = [];
const stop = () => {
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

async function up(url: string, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${url} did not come up in ${ms} ms`);
}

async function main() {
  for (const s of servers) {
    const c = spawn(s.command, {
      shell: true,
      stdio: 'inherit',
      env: { ...process.env, ...s.env },
    });
    children.push(c);
    c.on('exit', (code) => {
      process.stderr.write(`dev-stack: a server exited (${code}); stopping\n`);
      stop();
    });
    if (s.url) await up(s.url, Number(process.env.E2E_SERVER_TIMEOUT_MS) || 600_000);
  }
  process.stdout.write('dev-stack: all servers are up\n');
}
main().catch((e) => {
  process.stderr.write(`dev-stack: ${e instanceof Error ? e.message : String(e)}\n`);
  stop();
});
