export interface Config {
  port: number;
  store: 'memory' | 'pg';
  databaseUrl: string | null;
  sessionSecret: string;
  notifyUrl: string | null;
  notifyToken: string | null;
}
/** Configuration comes from the environment only; no secret has a default and none is ever logged. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const store = env['STORE'] === 'memory' ? 'memory' : 'pg';
  const secret = env['SESSION_SECRET'] ?? '';
  if (secret.length < 32) throw new Error('SESSION_SECRET must be set (at least 32 characters)');
  if (store === 'pg' && !env['DATABASE_URL']) throw new Error('DATABASE_URL must be set');
  return {
    port: Number(env['PORT'] ?? 8080),
    store,
    databaseUrl: env['DATABASE_URL'] ?? null,
    sessionSecret: secret,
    notifyUrl: env['NOTIFY_URL'] ?? null,
    notifyToken: env['NOTIFY_TOKEN'] ?? null,
  };
}
