// Runs BEFORE Playwright (`pnpm --filter @nuzm/e2e run e2e`): the browser E2E starts its own API, identity provider and both consoles on fixed ports with
// `reuseExistingServer: false`, so a dev stack already listening there makes Playwright stop with a generic message. This says which process holds which port and
// how to run on ports of its own instead. It only READS (lsof) and never stops anything: a process on these ports is usually somebody's dev environment.
// Skip with E2E_SKIP_PREFLIGHT=1. The defaults mirror e2e/tests/env.ts.
import { execFileSync } from 'node:child_process';

const num = (v, d) => (v && Number.isInteger(Number(v)) ? Number(v) : d);
const ports = [
  ['web console', num(process.env.E2E_WEB_PORT, 3000), 'E2E_WEB_PORT'],
  ['admin console', num(process.env.E2E_ADMIN_PORT, 3001), 'E2E_ADMIN_PORT'],
  ['API', num(process.env.E2E_API_PORT, 4000), 'E2E_API_PORT'],
  ['identity provider', num(process.env.E2E_IDP_PORT, 4010), 'E2E_IDP_PORT'],
];

function holders(port) {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const found = [];
    let pid = '';
    for (const line of out.split('\n')) {
      if (line.startsWith('p')) pid = line.slice(1);
      else if (line.startsWith('c') && pid) found.push(`${line.slice(1)} (pid ${pid})`);
    }
    return found;
  } catch {
    // lsof exits 1 when nothing listens; a missing lsof means "cannot tell": Playwright's own check then applies
    return [];
  }
}

const say = (m) => process.stderr.write(`${m}\n`);
if (process.env.E2E_SKIP_PREFLIGHT === '1') process.exit(0);
const busy = ports
  .map(([what, port, env]) => ({ what, port, env, by: holders(port) }))
  .filter((b) => b.by.length);
if (busy.length === 0) process.exit(0);
say('e2e preflight: the browser E2E needs these ports free, and they are not:');
for (const b of busy) say(`  ${b.port} (${b.what}, ${b.env}) is held by ${b.by.join(', ')}`);
say(
  [
    '',
    'Nothing was stopped. Either free the ports yourself, or run the E2E on ports and a database of its own:',
    '  pnpm test:e2e:isolated',
    '(it picks free ports, creates and drops a throw-away database, and rebuilds both consoles for them; see scripts/e2e-isolated.sh)',
  ].join('\n'),
);
process.exit(1);
