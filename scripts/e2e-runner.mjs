/**
 * A browser-E2E runner that survives the terminal (or agent session) that started it, on top of scripts/e2e-stack.sh.
 *   node scripts/e2e-runner.mjs start [--resume <runDir>]   detaches, prints the run directory, returns at once
 *   node scripts/e2e-runner.mjs status [<runDir>]           progress of a run (default: the latest)
 *   node scripts/e2e-runner.mjs stop [<runDir>]             asks a running run to stop and clean up
 * It runs EVERY spec file of e2e/tests once per project (ar, then en), one file at a time with one worker; every spec file resets the database itself, so this is
 * the full regression. Needs a leased test database (E2E_PG_PORT, scripts/testenv). Ports are fixed and dedicated (E2E_{WEB,ADMIN,API,IDP}_PORT to change them).
 * Everything is written to .dev-data/e2e-runs/<stamp>/ : status.json, progress.jsonl, health.log, logs/, json/, artifacts/, exit-code.
 * Health (database, API, API->database, both consoles) is checked before each file and while it runs. The run ABORTS when a check fails 3 times in a row, or when 5
 * files in a row fail (a shared cause makes the rest meaningless). An aborted run is incomplete and says so: it never counts as a pass.
 * Exit codes: 0 all passed, 1 test failures, 2 setup failed, 3 aborted: infrastructure, 4 aborted: consecutive failures, 5 stopped on request.
 * --resume reuses the PASSED files of an earlier run only when the commit is identical and no tracked source file is modified.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { fetch, setTimeout, clearInterval, setInterval, AbortSignal } = globalThis;
const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), '..');
const RUNS = join(ROOT, '.dev-data', 'e2e-runs');
const PGBIN = process.env.NUZM_PGBIN ?? '/usr/local/opt/postgresql@16/bin';
const PORTS = {
  E2E_WEB_PORT: process.env.E2E_WEB_PORT ?? '3320',
  E2E_ADMIN_PORT: process.env.E2E_ADMIN_PORT ?? '3321',
  E2E_API_PORT: process.env.E2E_API_PORT ?? '4320',
  E2E_IDP_PORT: process.env.E2E_IDP_PORT ?? '4330',
};
const SPEC_LIMIT_MS = 30 * 60_000;
const MAX_CONSECUTIVE_FAILED_FILES = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
const sourceDirty = () =>
  git('status', '--porcelain', '--untracked-files=no')
    .split('\n')
    .filter((l) => l && !/docs\/reports\/(screenshots|evidence)\//.test(l));

const latestRun = () => {
  if (!existsSync(RUNS)) return null;
  const all = readdirSync(RUNS).sort();
  return all.length ? join(RUNS, all[all.length - 1]) : null;
};
const readStatus = (dir) => JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8'));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function start(args) {
  if (!process.env.E2E_PG_PORT) {
    console.error(
      'e2e-runner: E2E_PG_PORT is mandatory (source a leased environment, scripts/testenv)',
    );
    process.exit(2);
  }
  const previous = latestRun();
  if (previous && existsSync(join(previous, 'status.json'))) {
    const s = readStatus(previous);
    if (!existsSync(join(previous, 'exit-code')) && s.pid && alive(s.pid)) {
      console.error(`e2e-runner: a run is already active: ${previous} (pid ${s.pid})`);
      process.exit(2);
    }
  }
  const i = args.indexOf('--resume');
  const resume = i >= 0 ? resolve(args[i + 1] ?? '') : '';
  const dir = join(RUNS, new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, ''));
  for (const d of ['logs', 'json', 'artifacts']) mkdirSync(join(dir, d), { recursive: true });
  const out = openSync(join(dir, 'runner.log'), 'a');
  // `detached` starts a new session: the run is not a child of this terminal's process group and outlives it
  const child = spawn(
    join(ROOT, 'scripts', 'heavy-slot.sh'),
    ['--weight', '4', process.execPath, SELF, '__run', dir, resume],
    { cwd: ROOT, detached: true, stdio: ['ignore', out, out], env: process.env },
  );
  child.unref();
  closeSync(out);
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ state: 'queued', pid: child.pid }));
  console.log(dir);
}

async function run(dir, resume) {
  const status = {
    state: 'preparing',
    pid: process.pid,
    revision: git('rev-parse', 'HEAD'),
    sourceModified: sourceDirty(),
    ports: PORTS,
    startedAt: new Date().toISOString(),
    total: 0,
    done: 0,
    filesPassed: 0,
    filesFailed: 0,
    tests: { passed: 0, failed: 0, skipped: 0, flaky: 0 },
    current: null,
  };
  const save = () => {
    status.updatedAt = new Date().toISOString();
    writeFileSync(join(dir, 'status.tmp'), JSON.stringify(status, null, 2));
    renameSync(join(dir, 'status.tmp'), join(dir, 'status.json'));
  };
  const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
  save();
  // keeps the Mac awake while the run lives (a sleeping machine looks like a hung test)
  if (process.platform === 'darwin')
    spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' }).unref();

  const env = {
    ...process.env,
    ...PORTS,
    NUZM_LOCAL_DEV_EXEC: '1',
    E2E_SERVER_TIMEOUT_MS: process.env.E2E_SERVER_TIMEOUT_MS ?? '900000',
  };
  delete env.AI_LIVE_PROVIDERS; // browser tests never call a real model
  delete env.ANTHROPIC_API_KEY;
  const stack = (...a) =>
    spawnSync('bash', [join(ROOT, 'scripts', 'e2e-stack.sh'), ...a], {
      cwd: ROOT,
      env,
      stdio: ['ignore', openSync(join(dir, 'logs', `stack-${a[0]}.log`), 'a'), 'inherit'],
    }).status;
  let stackUp = false;
  let finished = false;
  const finish = (code, state, why) => {
    if (finished) return;
    finished = true;
    if (stackUp) {
      const serverLog = join(ROOT, '.dev-data', 'e2e-stack', 'stack.log');
      if (existsSync(serverLog))
        writeFileSync(join(dir, 'logs', 'servers.log'), readFileSync(serverLog));
      stack('stop');
    }
    Object.assign(status, { state, why: why ?? null, exitCode: code, current: null });
    save();
    writeFileSync(join(dir, 'exit-code'), `${code}\n`);
    log(`finished: ${state}${why ? ` (${why})` : ''}, exit ${code}`);
    process.exit(code);
  };
  let stopRequested = false;
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => (stopRequested = true));
  process.on('uncaughtException', (e) => {
    log(`runner error: ${e.stack}`);
    finish(2, 'setup-failed', e.message);
  });

  log(`revision ${status.revision}; building (one package at a time)`);
  const build = spawnSync('pnpm', ['exec', 'turbo', 'run', 'build', '--concurrency=1'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', openSync(join(dir, 'logs', 'build.log'), 'a'), 'inherit'],
  });
  if (build.status !== 0) finish(2, 'setup-failed', 'build failed: logs/build.log');
  log('starting the test stack');
  if (stack('start') !== 0) finish(2, 'setup-failed', 'stack did not start: logs/stack-start.log');
  stackUp = true;
  const stackEnv = Object.fromEntries(
    readFileSync(join(ROOT, '.dev-data', 'e2e-stack', 'env'), 'utf8')
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );

  const probe = async (url, expected, headers) => {
    try {
      const r = await fetch(url, {
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
      });
      return r.status === expected ? null : `answered ${r.status}`;
    } catch (e) {
      return e.cause?.code ?? e.name;
    }
  };
  const health = async () => {
    const pg = spawnSync(
      join(PGBIN, 'psql'),
      [
        '-h',
        '127.0.0.1',
        '-p',
        stackEnv.E2E_PG_PORT,
        '-U',
        'nuzm_admin',
        '-d',
        'postgres',
        '-Atc',
        'SELECT 1',
      ],
      { env, encoding: 'utf8', timeout: 20_000 },
    );
    const api = `http://127.0.0.1:${stackEnv.E2E_API_PORT}`;
    const checks = {
      database: pg.status === 0 ? null : 'SELECT 1 failed',
      api: await probe(`${api}/healthz`, 200),
      // a made-up session cookie makes the API look the session up in the database: 401 proves the API can reach it
      apiDatabase: await probe(`${api}/v1/me`, 401, {
        cookie: 'nuzm_session=healthcheck-not-a-session',
      }),
      // `/login`, not `/ar/login`: the consoles' routes carry no language, so the prefixed form answers with a redirect
      web: await probe(`http://127.0.0.1:${stackEnv.E2E_WEB_PORT}/login`, 200),
      admin: await probe(`http://127.0.0.1:${stackEnv.E2E_ADMIN_PORT}/login`, 200),
    };
    const bad = Object.entries(checks).filter(([, v]) => v);
    appendFileSync(
      join(dir, 'health.log'),
      `${new Date().toISOString()} ${bad.length ? `FAIL ${bad.map(([k, v]) => `${k}: ${v}`).join('; ')}` : 'OK database api apiDatabase web admin'}\n`,
    );
    return bad.map(([k, v]) => `${k}: ${v}`);
  };
  /** true when healthy; false after 3 failed checks in a row (a database reset between files makes a single one fail now and then) */
  const healthyWithin = async () => {
    for (let i = 0; i < 3; i++) {
      if ((await health()).length === 0) return true;
      await sleep(15_000);
    }
    return false;
  };

  const specs = readdirSync(join(ROOT, 'e2e', 'tests'))
    .filter((f) => f.endsWith('.spec.ts'))
    .sort();
  const plan = ['ar', 'en'].flatMap((project) => specs.map((spec) => ({ project, spec })));
  status.total = plan.length;
  const reuse = new Map();
  if (resume && existsSync(join(resume, 'progress.jsonl'))) {
    const old = readStatus(resume);
    if (
      old.revision === status.revision &&
      status.sourceModified.length === 0 &&
      !old.sourceModified?.length
    )
      for (const l of readFileSync(join(resume, 'progress.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)) {
        const p = JSON.parse(l);
        if (p.result === 'passed') reuse.set(`${p.project}/${p.spec}`, p);
      }
    else
      log('resume ignored: the commit differs or source files were modified; running everything');
  }
  if (!(await healthyWithin()))
    finish(3, 'aborted-infrastructure', 'unhealthy before the first test: health.log');

  let consecutive = 0;
  status.state = 'running';
  for (const { project, spec } of plan) {
    if (stopRequested) finish(5, 'stopped', 'stop requested');
    const key = `${project}/${spec}`;
    const record = (r) => {
      appendFileSync(join(dir, 'progress.jsonl'), `${JSON.stringify({ project, spec, ...r })}\n`);
      status.done++;
      for (const k of Object.keys(status.tests)) status.tests[k] += r.tests?.[k] ?? 0;
      if (r.result === 'passed') status.filesPassed++;
      else status.filesFailed++;
      save();
      log(`${status.done}/${status.total} ${key}: ${r.result} ${JSON.stringify(r.tests ?? {})}`);
    };
    if (reuse.has(key)) {
      record({ ...reuse.get(key), reusedFrom: resume });
      continue;
    }
    if (!(await healthyWithin()))
      finish(3, 'aborted-infrastructure', `unhealthy before ${key}: health.log`);
    status.current = key;
    save();
    const name = `${project}-${spec.replace('.spec.ts', '')}`;
    const jsonFile = join(dir, 'json', `${name}.json`);
    const out = openSync(join(dir, 'logs', `${name}.log`), 'a');
    const started = Date.now();
    const child = spawn(
      'pnpm',
      [
        'exec',
        'playwright',
        'test',
        `tests/${spec}`,
        `--project=${project}`,
        '--reporter=list,json',
        `--output=${join(dir, 'artifacts', name)}`,
      ],
      {
        cwd: join(ROOT, 'e2e'),
        env: { ...env, ...stackEnv, PLAYWRIGHT_JSON_OUTPUT_NAME: jsonFile },
        detached: true,
        stdio: ['ignore', out, out],
      },
    );
    let aborted = null;
    let failures = 0;
    let checking = false;
    const kill = (why) => {
      aborted = why;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    };
    const monitor = setInterval(() => {
      if (stopRequested) return kill('stopped');
      if (Date.now() - started > SPEC_LIMIT_MS) return kill('time-limit');
      if (checking) return;
      checking = true;
      void health().then((bad) => {
        failures = bad.length ? failures + 1 : 0;
        if (failures >= 3) kill(`infrastructure: ${bad.join('; ')}`);
        checking = false;
      });
    }, 15_000);
    const exit = await new Promise((r) => child.on('exit', (c) => r(c ?? 1)));
    clearInterval(monitor);
    closeSync(out);
    let tests = null;
    if (existsSync(jsonFile) && statSync(jsonFile).size > 0) {
      const s = JSON.parse(readFileSync(jsonFile, 'utf8')).stats;
      tests = { passed: s.expected, failed: s.unexpected, skipped: s.skipped, flaky: s.flaky };
    }
    // passing needs all three: Playwright says so, its report was written, and that report holds no failure
    const passed =
      !aborted && exit === 0 && tests !== null && tests.failed === 0 && tests.flaky === 0;
    record({
      result: passed ? 'passed' : aborted ? 'aborted' : 'failed',
      exit,
      tests,
      durationMs: Date.now() - started,
      aborted,
    });
    if (aborted?.startsWith('infrastructure'))
      finish(3, 'aborted-infrastructure', `${key}: ${aborted}`);
    if (aborted === 'stopped') finish(5, 'stopped', 'stop requested');
    consecutive = passed ? 0 : consecutive + 1;
    if (consecutive >= MAX_CONSECUTIVE_FAILED_FILES)
      finish(
        4,
        'aborted-consecutive-failures',
        `${consecutive} files in a row failed; the last was ${key}`,
      );
  }
  if (status.filesFailed === 0 && status.done === status.total) finish(0, 'passed');
  finish(1, 'failed', `${status.filesFailed} of ${status.total} files failed`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'start') start(rest);
else if (cmd === '__run') await run(rest[0], rest[1]);
else if (cmd === 'status' || cmd === 'stop') {
  const dir = rest[0] ? resolve(rest[0]) : latestRun();
  if (!dir) {
    console.log('e2e-runner: no run found');
    process.exit(0);
  }
  const s = readStatus(dir);
  const running = !existsSync(join(dir, 'exit-code')) && s.pid && alive(s.pid);
  if (cmd === 'stop') {
    if (running) process.kill(-s.pid, 'SIGTERM');
    console.log(running ? 'stop requested' : 'not running');
  } else {
    console.log(dir);
    console.log(JSON.stringify({ ...s, processAlive: Boolean(running) }, null, 2));
    if (!running && !existsSync(join(dir, 'exit-code')))
      console.log('WARNING: the process is gone and left no exit code: the run did NOT complete');
  }
} else {
  console.log(
    'usage: node scripts/e2e-runner.mjs start [--resume <dir>] | status [dir] | stop [dir]',
  );
  process.exit(2);
}
