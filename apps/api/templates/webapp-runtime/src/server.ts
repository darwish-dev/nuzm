import { loadConfig } from './config.ts';
import { start } from './app.ts';

const cfg = loadConfig();
start(cfg);
console.log(JSON.stringify({ started: true, port: cfg.port, store: cfg.store }));
