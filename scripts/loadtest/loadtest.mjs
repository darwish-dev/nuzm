#!/usr/bin/env node
// Load test for a NON-PRODUCTION Nuzm stack (staging or the local isolated stack from scripts/e2e-stack.sh).
// Dependency-free (Node 22 fetch). Never point it at nuzm.dev: it creates thousands of accounts.
//
//   node scripts/loadtest/loadtest.mjs seed --base http://127.0.0.1:<web> --users 10000 --concurrency 32
//   node scripts/loadtest/loadtest.mjs run  --base http://127.0.0.1:<web> --stages 50:60,200:60,500:90 [--think 1000]
//
// seed: registers users (POST /v1/auth/register) and gives each an organization (POST /v1/organizations); writes
//       credentials to <out>/users.jsonl. Accounts are tagged `loadtest+<run>-<n>@example.test`.
// run:  ramps virtual users (VUs) stage by stage. Each VU signs in as its own seeded user and loops a weighted mix:
//       dashboard (me, orgs), domains (search, list), AI (session, chat run, poll), builder (project, files, preview,
//       change preview). Prints p50/p95/p99 and error rate per operation per stage, samples server CPU/RSS and DB
//       connections, and stops early when a stage breaches --max-error-rate or --max-p95-ms.
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(3).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') ? 'true' : all[i + 1] ?? 'true']);
    return acc;
  }, []),
);
const cmd = process.argv[2];
const BASE = (args.base ?? '').replace(/\/$/, '');
const OUT = args.out ?? '.dev-data/loadtest';
if (!BASE) throw new Error('--base is required (the web console origin of a NON-production stack)');
if (/nuzm\.dev/i.test(BASE)) throw new Error('refusing to load-test production (nuzm.dev)');
mkdirSync(OUT, { recursive: true });

// ---------- HTTP client with a cookie session ----------
class Client {
  constructor() {
    this.jar = {};
    this.orgId = undefined;
  }
  cookieHeader() {
    return Object.entries(this.jar)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
  absorb(res) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      this.jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
  }
  async req(method, path, body, { timeoutMs = 30_000 } = {}) {
    const headers = { accept: 'application/json', 'x-nuzm-realm': 'web' };
    if (Object.keys(this.jar).length) headers.cookie = this.cookieHeader();
    if (this.jar.nuzm_csrf && method !== 'GET') headers['x-csrf-token'] = this.jar.nuzm_csrf;
    if (this.orgId) headers['x-nuzm-org'] = this.orgId;
    if (method === 'POST') headers['idempotency-key'] = randomUUID();
    if (body !== undefined) headers['content-type'] = 'application/json';
    const t0 = performance.now();
    let status = 0;
    let json;
    try {
      const res = await fetch(BASE + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
      });
      status = res.status;
      this.absorb(res);
      const text = await res.text();
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
    } catch (e) {
      status = e?.name === 'TimeoutError' ? -2 : -1; // -1 network error, -2 timeout
    }
    return { status, json, ms: performance.now() - t0 };
  }
}

// ---------- stats ----------
class Stats {
  constructor() {
    this.ops = new Map();
  }
  add(op, r, expected = []) {
    let s = this.ops.get(op);
    if (!s) this.ops.set(op, (s = { lat: [], ok: 0, err: 0, codes: {} }));
    s.lat.push(r.ms);
    s.codes[r.status] = (s.codes[r.status] ?? 0) + 1;
    const good = (r.status >= 200 && r.status < 400) || expected.includes(r.status);
    good ? s.ok++ : s.err++;
    return good;
  }
  static pct(sorted, p) {
    if (!sorted.length) return 0;
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  }
  summary() {
    const rows = [];
    let ok = 0;
    let err = 0;
    const all = [];
    for (const [op, s] of [...this.ops].sort()) {
      const l = s.lat.slice().sort((a, b) => a - b);
      all.push(...s.lat);
      ok += s.ok;
      err += s.err;
      rows.push({
        op,
        n: s.ok + s.err,
        errPct: +((100 * s.err) / Math.max(1, s.ok + s.err)).toFixed(2),
        p50: Math.round(Stats.pct(l, 50)),
        p95: Math.round(Stats.pct(l, 95)),
        p99: Math.round(Stats.pct(l, 99)),
        codes: s.codes,
      });
    }
    all.sort((a, b) => a - b);
    return {
      rows,
      total: ok + err,
      errPct: +((100 * err) / Math.max(1, ok + err)).toFixed(2),
      p50: Math.round(Stats.pct(all, 50)),
      p95: Math.round(Stats.pct(all, 95)),
      p99: Math.round(Stats.pct(all, 99)),
    };
  }
}

const idOf = (j) => j?.id ?? j?.data?.id ?? j?.organization?.id ?? j?.project?.id ?? j?.run?.id;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ---------- seed ----------
async function seed() {
  const n = Number(args.users ?? 10000);
  const conc = Number(args.concurrency ?? 32);
  const run = args.tag ?? Date.now().toString(36);
  const file = join(OUT, 'users.jsonl');
  const have = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  const stats = new Stats();
  let next = have;
  let done = 0;
  const t0 = Date.now();
  const password = 'Lt-' + randomUUID(); // one throwaway password for every seeded account of this stack
  console.log(`seeding ${n - have} users (have ${have}) with concurrency ${conc} -> ${file}`);
  async function worker() {
    while (next < n) {
      const i = next++;
      const c = new Client();
      const email = `loadtest+${run}-${i}@example.test`;
      let r1 = await c.req('POST', '/v1/auth/register', { email, password, displayName: `Load ${i}`, locale: 'en' });
      // the API's per-IP signup limit (a quarter of LOGIN_RATE_PER_MINUTE): back off and retry the same account
      for (let tries = 0; r1.status === 429 && tries < 60; tries++) {
        stats.add('seed.register.throttled', r1, [429]);
        await sleep(2000 + Math.random() * 3000);
        r1 = await c.req('POST', '/v1/auth/register', { email, password, displayName: `Load ${i}`, locale: 'en' });
      }
      if (!stats.add('seed.register', r1)) {
        if (stats.ops.get('seed.register').err <= 5) console.error('register failed', r1.status, JSON.stringify(r1.json));
        continue;
      }
      const r2 = await c.req('POST', '/v1/organizations', { name: `Load Org ${run}-${i}`, country: 'SA', defaultLocale: 'en' });
      if (!stats.add('seed.createOrg', r2)) {
        if (stats.ops.get('seed.createOrg').err <= 5) console.error('org failed', r2.status, JSON.stringify(r2.json));
        continue;
      }
      appendFileSync(file, JSON.stringify({ email, password, orgId: idOf(r2.json) }) + '\n');
      if (++done % 500 === 0) console.log(`  ${have + done}/${n}  ${((done * 1000) / (Date.now() - t0)).toFixed(1)} users/s`);
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));
  const s = stats.summary();
  console.table(s.rows.map(({ codes, ...r }) => ({ ...r, codes: JSON.stringify(codes) })));
  console.log(`seeded ${done} in ${((Date.now() - t0) / 1000).toFixed(0)} s (${((done * 1000) / (Date.now() - t0)).toFixed(1)} users/s)`);
  writeFileSync(join(OUT, `seed-${run}.json`), JSON.stringify({ done, secs: (Date.now() - t0) / 1000, ...s }, null, 2));
}

// ---------- server sampling ----------
function pidsOnPort(port) {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}
function sampleServers(ports) {
  const out = {};
  for (const [name, port] of Object.entries(ports)) {
    const pids = pidsOnPort(port);
    if (!pids.length) continue;
    try {
      const ps = execFileSync('ps', ['-o', '%cpu=,rss=', '-p', pids.join(',')], { encoding: 'utf8' });
      let cpu = 0;
      let rss = 0;
      for (const line of ps.trim().split('\n')) {
        const [c, r] = line.trim().split(/\s+/).map(Number);
        cpu += c;
        rss += r;
      }
      out[name] = { cpu: Math.round(cpu), rssMb: Math.round(rss / 1024) };
    } catch {
      /* process went away */
    }
  }
  if (args['pg-url']) {
    try {
      out.pgConnections = Number(
        execFileSync(args.psql ?? 'psql', [args['pg-url'], '-Atc', 'select count(*) from pg_stat_activity'], { encoding: 'utf8' }).trim(),
      );
    } catch {
      /* ignore */
    }
  }
  return out;
}

// ---------- scenarios ----------
const LABELS = ['nuzm', 'souq', 'falcon', 'riyadh', 'najm', 'baytak', 'qamar', 'sahra', 'nakhla', 'majlis'];
// Signed-in clients are kept across stages (one per user), like real users who stay signed in.
const sessions = new Map();
async function signIn(user, stats) {
  let s = sessions.get(user.email);
  if (s) return s;
  const c = new Client();
  let r = await c.req('POST', '/v1/auth/password/login', { email: user.email, password: user.password });
  for (let tries = 0; r.status === 429 && tries < 30; tries++) {
    stats.add('auth.login.throttled', r, [429]);
    await sleep(2000 + Math.random() * 3000);
    r = await c.req('POST', '/v1/auth/password/login', { email: user.email, password: user.password });
  }
  if (!stats.add('auth.login', r)) return undefined;
  c.orgId = user.orgId;
  s = { c, st: {} };
  sessions.set(user.email, s);
  return s;
}
async function vuLoop(user, stats, stopAt, think) {
  const s = await signIn(user, stats);
  if (!s) return;
  const { c, st } = s;
  while (Date.now() < stopAt) {
    const roll = Math.random();
    if (roll < 0.35) {
      stats.add('dash.me', await c.req('GET', '/v1/me'));
      stats.add('dash.orgs', await c.req('GET', '/v1/organizations'));
    } else if (roll < 0.6) {
      const q = `${pick(LABELS)}${Math.floor(Math.random() * 100000)}`;
      stats.add('domains.search', await c.req('GET', `/v1/domains/search?q=${q}&tlds=com,net`), [429]);
      stats.add('domains.list', await c.req('GET', '/v1/domains'));
    } else if (roll < 0.8) {
      if (!st.sessionId) {
        const s = await c.req('POST', '/v1/ai/sessions', { title: 'Load test chat' });
        if (stats.add('ai.session', s)) st.sessionId = idOf(s.json);
      } else if (!st.runId) {
        const run = await c.req('POST', '/v1/ai/runs', {
          sessionId: st.sessionId,
          kind: 'chat',
          input: { description: 'A landing page for a coffee shop in Riyadh with a menu and opening hours.' },
        });
        // 409 run_active / 429 too many active runs / 402 credits are the platform's own limits, reported but expected under load
        if (stats.add('ai.run.create', run, [402, 409, 429])) st.runId = idOf(run.json);
      } else {
        const g = await c.req('GET', `/v1/ai/runs/${st.runId}`);
        stats.add('ai.run.poll', g);
        const state = g.json?.state ?? g.json?.status;
        if (!g.json || ['succeeded', 'failed', 'cancelled', 'completed', 'unsupported_capability', 'waiting_approval'].includes(state)) st.runId = undefined;
      }
    } else {
      if (!st.projectId) {
        // half the VUs build websites (site previews), half build web apps (change previews, live previews)
        st.type = Math.random() < 0.5 ? 'website' : 'webapp';
        const p = await c.req('POST', '/v1/builder/projects', { type: st.type, name: `Load ${st.type} ${randomUUID().slice(0, 8)}`, locale: ['en'] });
        if (stats.add(`builder.project.${st.type}`, p, [429])) {
          st.projectId = idOf(p.json);
          st.head = p.json?.headVersionId;
        }
      } else {
        const sub = Math.random();
        if (sub < 0.35) stats.add('builder.files', await c.req('GET', `/v1/builder/projects/${st.projectId}/files`));
        else if (st.type === 'website')
          stats.add('builder.preview', await c.req('POST', `/v1/builder/projects/${st.projectId}/previews`, { viewport: pick(['mobile', 'tablet', 'desktop']) }), [409, 429]);
        else if (sub < 0.85)
          stats.add(
            'builder.changePreview',
            await c.req('POST', `/v1/builder/projects/${st.projectId}/change-previews`, {
              baseVersion: st.head ?? null,
              patches: [{ op: 'add', path: `src/load-${Math.floor(Math.random() * 1e6)}.ts`, content: 'export const loadTest = true;\n' }],
            }),
            [409],
          );
        // live preview: spawns a child process; 404 until the app was built, 429 = the platform's 2-per-org cap
        else stats.add('builder.livePreview', await c.req('POST', `/v1/builder/projects/${st.projectId}/live-preview`, {}), [404, 409, 429]);
      }
    }
    if (think) await sleep(think * (0.5 + Math.random()));
  }
}

async function runTest() {
  const users = readFileSync(join(OUT, 'users.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const stages = (args.stages ?? '50:60,200:60,500:90,1000:90').split(',').map((s) => {
    const [vus, secs] = s.split(':').map(Number);
    return { vus, secs };
  });
  const think = Number(args.think ?? 1000);
  const maxErr = Number(args['max-error-rate'] ?? 10);
  const maxP95 = Number(args['max-p95-ms'] ?? 10_000);
  const ports = JSON.parse(args.ports ?? '{}');
  const report = { base: BASE, think, startedAt: new Date().toISOString(), seededUsers: users.length, stages: [] };
  console.log(`${users.length} seeded users; stages ${JSON.stringify(stages)}; think ${think} ms; stop at >${maxErr}% errors or p95 >${maxP95} ms`);
  // sign-in warm-up: every user the largest stage needs signs in first (password hashing is CPU-heavy), measured on its own
  const need = Math.max(...stages.map((s) => s.vus));
  if (need > users.length) throw new Error(`the largest stage wants ${need} VUs but only ${users.length} users are seeded`);
  {
    const stats = new Stats();
    const t0 = Date.now();
    let next = 0;
    const conc = Number(args['login-concurrency'] ?? 16);
    await Promise.all(Array.from({ length: conc }, async () => { while (next < need) await signIn(users[next++], stats); }));
    const s = stats.summary();
    const secs = (Date.now() - t0) / 1000;
    report.signIn = { users: need, secs: +secs.toFixed(1), perSec: +(need / secs).toFixed(1), ...s };
    console.log(`\n=== sign-in warm-up: ${need} users in ${secs.toFixed(0)} s (${(need / secs).toFixed(1)}/s), p50 ${s.p50} ms, p95 ${s.p95} ms, errors ${s.errPct}%`);
    console.table(s.rows.map(({ codes, ...r }) => ({ ...r, codes: JSON.stringify(codes) })));
  }
  for (const [si, stage] of stages.entries()) {
    if (stage.vus > users.length) throw new Error(`stage ${si} wants ${stage.vus} VUs but only ${users.length} users are seeded`);
    const stats = new Stats();
    const samples = [];
    const stopAt = Date.now() + stage.secs * 1000;
    const sampler = setInterval(() => samples.push(sampleServers(ports)), 5000);
    const offset = 0; // each stage keeps the previous stage's users (still signed in) and adds new ones
    const t0 = Date.now();
    // ramp VUs in over the first 10 s of the stage so logins don't arrive as one burst
    await Promise.all(
      Array.from({ length: stage.vus }, async (_, i) => {
        await sleep(Math.floor((i / stage.vus) * 10_000));
        await vuLoop(users[(offset + i) % users.length], stats, stopAt, think);
      }),
    );
    clearInterval(sampler);
    const s = stats.summary();
    const secs = (Date.now() - t0) / 1000;
    const peak = (k, f) => Math.max(0, ...samples.map((x) => x[k]?.[f] ?? 0));
    const server = Object.fromEntries(Object.keys(ports).map((k) => [k, { peakCpu: peak(k, 'cpu'), peakRssMb: peak(k, 'rssMb') }]));
    const pg = Math.max(0, ...samples.map((x) => x.pgConnections ?? 0));
    const entry = { ...stage, secs: +secs.toFixed(1), rps: +(s.total / secs).toFixed(1), ...s, server, peakPgConnections: pg };
    report.stages.push(entry);
    console.log(`\n=== stage ${si + 1}: ${stage.vus} VUs, ${entry.rps} req/s, errors ${s.errPct}%, p50 ${s.p50} ms, p95 ${s.p95} ms, p99 ${s.p99} ms`);
    console.log('server peaks', JSON.stringify(server), 'pg connections', pg);
    console.table(s.rows.map(({ codes, ...r }) => ({ ...r, codes: JSON.stringify(codes) })));
    writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    if (s.errPct > maxErr || s.p95 > maxP95) {
      console.log(`STOP: stage ${si + 1} breached the limits (errors ${s.errPct}% > ${maxErr}% or p95 ${s.p95} > ${maxP95} ms)`);
      report.stoppedAtStage = si + 1;
      break;
    }
  }
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`report: ${join(OUT, 'report.json')}`);
}

if (cmd === 'seed') await seed();
else if (cmd === 'run') await runTest();
else {
  console.error('usage: loadtest.mjs seed|run --base <origin> [...]');
  process.exit(2);
}
