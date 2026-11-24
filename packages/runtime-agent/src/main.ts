#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseAgentConfig } from './config';
import { assembleAgent, AgentStartRefused } from './agent';
import { createMetricsServer, createNodeHttpsServer } from './server';

/**
 * `nuzm-runtime-agent --config /etc/nuzm/agent.json`
 * Exit codes: 0 clean stop; 2 bad configuration or usage; 3 start refused (image mismatch, not the attested node, ...). The agent never starts on a machine that is not the node it is
 * configured for (see `command-runner.ts`); a simulated launcher is possible only on a loopback listener.
 */
async function main(argv: string[]): Promise<number> {
  const i = argv.indexOf('--config');
  const file = i >= 0 ? argv[i + 1] : undefined;
  if (!file) {
    console.error('usage: nuzm-runtime-agent --config <file>');
    return 2;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    console.error('REFUSED: configuration unreadable or not JSON');
    return 2;
  }
  const parsed = parseAgentConfig(raw);
  if (!parsed.ok) {
    console.error(`REFUSED: configuration invalid: ${parsed.errors.join(', ')}`);
    return 2;
  }
  const cfg = parsed.config;
  let a;
  try {
    a = await assembleAgent(cfg);
  } catch (e) {
    if (e instanceof AgentStartRefused) {
      console.error(`REFUSED: ${e.reasons.join(', ')}`);
      return 3;
    }
    throw e;
  }
  const server = await createNodeHttpsServer(cfg, {
    handler: a.handler,
    metrics: a.metrics,
    clientFingerprints: cfg.tls.clientFingerprints,
  });
  const metricsServer = createMetricsServer(a.metrics);
  await new Promise<void>((r) => server.listen(cfg.listen.port, cfg.listen.host, r));
  await new Promise<void>((r) => metricsServer.listen(cfg.metrics.port, cfg.metrics.host, r));
  const reaper = setInterval(() => void a.service.reap().catch(() => undefined), 60_000);
  console.log(
    `nuzm-runtime-agent ${cfg.nodeId} listening on ${cfg.listen.host}:${cfg.listen.port} (launcher=${cfg.launcher})`,
  );
  return new Promise<number>((resolve) => {
    const stop = () => {
      clearInterval(reaper);
      a.service.shutdown();
      server.close();
      metricsServer.close();
      resolve(0);
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
}
if (require.main === module) void main(process.argv.slice(2)).then((c) => process.exit(c));
export { main };
