#!/usr/bin/env node
// Test-environment allocator CLI (see lib.mjs for the model).
//   node scripts/testenv/testenv.mjs acquire [--owner NAME] [--port N] [--ttl-hours N] [--no-pg]   print the lease env file path; `source` it
//   node scripts/testenv/testenv.mjs env <leaseId|port>                                            print the export lines
//   node scripts/testenv/testenv.mjs release <leaseId|port>                                        stop its cluster and delete its directory
//   node scripts/testenv/testenv.mjs renew <leaseId> [--hours N]
//   node scripts/testenv/testenv.mjs status [--json]
//   node scripts/testenv/testenv.mjs gc                                                            reap expired leases
//   node scripts/testenv/testenv.mjs check-url [URL]                                               preflight (default: $NUZM_TEST_ADMIN_URL); exit 0 ok, 3 refused
import fs from 'node:fs';
import {
  acquire,
  checkUrl,
  config,
  gc,
  leaseEnv,
  listLeases,
  release,
  renew,
  status,
  TestEnvError,
} from './lib.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name, def) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : def;
};
const has = (name) => rest.includes(`--${name}`);
const positional = rest.filter(
  (a, i) =>
    !a.startsWith('--') &&
    !(i > 0 && rest[i - 1].startsWith('--') && !['--no-pg', '--json'].includes(rest[i - 1])),
);

try {
  switch (cmd) {
    case 'acquire': {
      const lease = await acquire({
        owner: flag('owner', process.env.NUZM_SESSION || 'session'),
        port: flag('port') ? Number(flag('port')) : undefined,
        ttlHours: flag('ttl-hours') ? Number(flag('ttl-hours')) : undefined,
        pg: !has('no-pg'),
      });
      console.log(lease.envFile);
      console.error(
        `lease ${lease.id}: port ${lease.port}, owner ${lease.owner}, expires in ${Math.round((lease.expiresAt - Date.now()) / 3600e3)} h. source ${lease.envFile}`,
      );
      break;
    }
    case 'env': {
      const l = listLeases(config()).find(
        (x) => x.id === positional[0] || String(x.port) === positional[0],
      );
      if (!l) throw new TestEnvError('no_such_lease', `no lease ${positional[0]}`);
      console.log(fs.readFileSync(l.envFile, 'utf8').trimEnd());
      void leaseEnv;
      break;
    }
    case 'release': {
      const l = await release(positional[0]);
      console.log(`released ${l.id} (port ${l.port})`);
      break;
    }
    case 'renew': {
      const l = renew(positional[0], flag('hours') ? Number(flag('hours')) : undefined);
      console.log(`renewed ${l.id} until ${new Date(l.expiresAt).toISOString()}`);
      break;
    }
    case 'status': {
      const s = status();
      if (has('json')) console.log(JSON.stringify(s, null, 2));
      else if (!s.length) console.log('no leases');
      else
        for (const l of s)
          console.log(
            `${l.id}  port ${l.port}  ${l.owner}  ${l.expired ? 'EXPIRED' : `${l.expiresInMin} min left`}  cluster ${l.clusterOwned === null ? '(none)' : l.clusterOwned ? 'running' : 'NOT RUNNING'}`,
          );
      break;
    }
    case 'gc': {
      const r = await gc();
      console.log(r.length ? `reaped ${r.join(', ')}` : 'nothing to reap');
      break;
    }
    case 'check-url': {
      const l = checkUrl(positional[0] ?? process.env.NUZM_TEST_ADMIN_URL);
      console.log(l ? `ok: lease ${l.id} (port ${l.port})` : 'ok: CI policy');
      break;
    }
    default:
      console.error('usage: testenv.mjs acquire|env|release|renew|status|gc|check-url');
      process.exit(2);
  }
} catch (e) {
  if (e instanceof TestEnvError) {
    console.error(`testenv: REFUSED (${e.code}): ${e.message}`);
    process.exit(3);
  }
  throw e;
}
