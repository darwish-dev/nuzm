/* eslint-disable -- a deliberately hostile CommonJS fixture thread (infinite loops, heap bombs); it is not application code */
'use strict';
// TEST FIXTURE ONLY (never loaded by the worker): a parser thread that misbehaves in a chosen way, to prove the sandbox contains it.
// The mode comes from workerData.fixture.mode. It speaks the sandbox protocol (`ready`, then one `result` per request).
const { parentPort, workerData } = require('node:worker_threads');
const mode = (workerData.fixture && workerData.fixture.mode) || 'ok';
const facts = () => ({
  lang: 'ts',
  imports: [],
  exports: [],
  reexports: [],
  components: [],
  directives: [],
  routeRefs: [],
  hasTheme: false,
  skipped: null,
  truncated: false,
});
const ok = (id) =>
  parentPort.postMessage({ type: 'result', id, ok: true, facts: facts(), resultBytes: 10 });
if (mode === 'never-ready') {
  // never says ready
} else if (mode === 'crash-at-start') {
  throw new Error('boom at start');
} else {
  if (mode === 'exit-at-start') process.exit(7);
  parentPort.postMessage({ type: 'ready' });
  let n = 0;
  parentPort.on('message', (req) => {
    n++;
    switch (mode) {
      case 'ok':
        return ok(req.id);
      case 'spin':
        for (;;) {
          /* a parser stuck in a tight loop */
        }
      case 'regex': {
        const s = 'a'.repeat(64) + '!';
        /(a+)+$/.test(s + s + s);
        return ok(req.id);
      }
      case 'memory': {
        const keep = [];
        for (;;) keep.push(new Array(1e6).fill(n));
      }
      case 'throw':
        throw new Error('uncaught in the thread');
      case 'exit':
        process.exit(3);
        return;
      case 'silent':
        return; // never answers
      case 'bad-shape':
        return parentPort.postMessage({
          type: 'result',
          id: req.id,
          ok: true,
          facts: { lang: 'ts', imports: 'nope' },
          resultBytes: 1,
        });
      case 'wrong-id':
        return parentPort.postMessage({
          type: 'result',
          id: req.id + 999,
          ok: true,
          facts: facts(),
          resultBytes: 1,
        });
      case 'marker':
        if (Buffer.from(req.bytes).toString().includes('SPIN')) {
          for (;;) {
            /* only marked files hang */
          }
        }
        return ok(req.id);
      case 'slow': {
        const end = Date.now() + (workerData.fixture.ms || 100);
        while (Date.now() < end) {
          /* busy */
        }
        return ok(req.id);
      }
      case 'die-after-first':
        ok(req.id);
        return setImmediate(() => process.exit(9));
      case 'echo-env':
        return parentPort.postMessage({
          type: 'result',
          id: req.id,
          ok: true,
          facts: { ...facts(), directives: Object.keys(process.env) },
          resultBytes: 1,
        });
      default:
        return ok(req.id);
    }
  });
}
