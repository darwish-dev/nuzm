/** Hosting server forms (admin → Hosting → Servers): request bodies built from the forms. Pure, so they are tested without a browser. */
const NAME = /^[a-z0-9][a-z0-9-]{1,62}$/;
const FQDN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const PIN = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const KEY = /^[A-Za-z0-9]{8,64}:[\x21-\x7E]{8,128}$/;

export type RegisterError = 'name' | 'instance';
export function registerBody(f: {
  name: string;
  instance: string;
}):
  | { ok: true; body: { name: string; computeInstanceId: string } }
  | { ok: false; error: RegisterError } {
  const name = f.name.trim().toLowerCase();
  if (!NAME.test(name)) return { ok: false, error: 'name' };
  const instance = f.instance.trim();
  if (instance === '' || instance.length > 200) return { ok: false, error: 'instance' };
  return { ok: true, body: { name, computeInstanceId: instance } };
}

export interface PanelForm {
  host: string;
  port: string;
  tlsPinSha256: string;
  accessKey: string;
  vaultRef: string;
}
export type PanelError = 'host' | 'port' | 'pin' | 'key' | 'both';
export function panelFormOf(
  n: { panelHost?: string | null; panelPort?: number | null } | null,
): PanelForm {
  return {
    host: n?.panelHost ?? '',
    port: String(n?.panelPort ?? 8083),
    tlsPinSha256: '',
    accessKey: '',
    vaultRef: '',
  };
}
export function panelBody(
  f: PanelForm,
): { ok: true; body: Record<string, unknown> } | { ok: false; error: PanelError } {
  const host = f.host.trim().toLowerCase();
  if (!FQDN.test(host)) return { ok: false, error: 'host' };
  const port = Number(f.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'port' };
  const pin = f.tlsPinSha256.trim().toUpperCase();
  if (pin !== '' && !PIN.test(pin)) return { ok: false, error: 'pin' };
  const key = f.accessKey.trim();
  const vault = f.vaultRef.trim();
  if (key !== '' && vault !== '') return { ok: false, error: 'both' };
  if (key !== '' && !KEY.test(key)) return { ok: false, error: 'key' };
  if (vault !== '' && !/^vault:\/\/\S+$/.test(vault)) return { ok: false, error: 'key' };
  return {
    ok: true,
    body: {
      host,
      port,
      ...(pin !== '' ? { tlsPinSha256: pin } : {}),
      ...(key !== '' ? { credentials: { accessKey: key } } : {}),
      ...(vault !== '' ? { vaultRef: vault } : {}),
    },
  };
}

/** Which of the four setup steps is done, from what the node reports (registered is always true for a listed node). */
export function setupSteps(n: {
  panelConfigured: boolean;
  lastInventoryAt?: string | null;
  health: string;
  status: string;
}): { register: boolean; connect: boolean; test: boolean; activate: boolean } {
  return {
    register: true,
    connect: n.panelConfigured,
    test: n.panelConfigured && !!n.lastInventoryAt && n.health === 'healthy',
    activate: n.status === 'active',
  };
}
