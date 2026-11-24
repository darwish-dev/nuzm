import { scanForSecrets } from '../secret-scan';
import { dataFence, wrapUntrusted } from '../untrusted';
import { EXEC_ENV } from './policy';

/**
 * S-AG6 (OFFLINE): secret and environment protection (ADR-067 item 2). The environment of a run is the constant `EXEC_ENV`. This module is the second wall behind `decideExec`:
 *  - `checkRunEnv` verifies, immediately before a run, that the environment about to be handed to a runtime is EXACTLY the constant (no extra, no changed, no loader variable);
 *  - `checkWorkspaceFiles` refuses to seed a workspace with secret-bearing files or content;
 *  - `screenOutput` scans a run's output for secrets and canaries and redacts it before it is stored, audited or shown to anyone;
 *  - `frameOutputForModel` is the ONLY way output reaches a model: bounded, redacted, inside a fenced untrusted-data block (output is data, never instructions).
 */
/** variables that change how a process loads code or reaches a network or a credential: refused by name, even if someone added them to the constant */
export const FORBIDDEN_ENV_NAMES: readonly RegExp[] = [
  /^LD_/i,
  /^DYLD_/i,
  /^NODE_OPTIONS$/i,
  /^NODE_EXTRA_CA_CERTS$/i,
  /^NODE_TLS_REJECT_UNAUTHORIZED$/i,
  /^NPM_CONFIG_/i,
  /^npm_config_/,
  /^(HTTP|HTTPS|ALL|NO)_PROXY$/i,
  /^(AWS|AZURE|GCP|GOOGLE|GITHUB|GITLAB|SLACK|STRIPE|OPENAI|ANTHROPIC)_/i,
  /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|PRIVATE_?KEY)/i,
  /^(DATABASE|REDIS|VAULT|KUBERNETES|DOCKER)_/i,
  /^BASH_ENV$/i,
  /^ENV$/,
  /^PYTHON(PATH|STARTUP)$/i,
  /^IFS$/,
];
export interface GuardResult {
  ok: boolean;
  reasons: string[];
}
export function checkRunEnv(env: Readonly<Record<string, unknown>>): GuardResult {
  const reasons: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (FORBIDDEN_ENV_NAMES.some((r) => r.test(k))) reasons.push('env_forbidden_name');
    if (!(k in EXEC_ENV)) reasons.push('env_member_not_in_constant');
    else if (v !== EXEC_ENV[k]) reasons.push('env_value_changed');
    if (typeof v !== 'string') reasons.push('env_value_not_string');
    else if (scanForSecrets(`${k}=${v}`).length > 0) reasons.push('env_value_looks_like_secret');
  }
  for (const k of Object.keys(EXEC_ENV)) if (!(k in env)) reasons.push('env_member_missing');
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

const SECRET_FILE_NAME = [
  /^\.env(\..*)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\..*)?$/i,
  /^\.(npmrc|netrc|pypirc|htpasswd|git-credentials|dockercfg)$/i,
  /^(credentials|secrets?)(\..*)?$/i,
  /\.tfstate(\..*)?$/i,
];
const SECRET_DIR = new Set(['.git', '.ssh', '.aws', '.gnupg', '.kube', '.docker']);
export interface WorkspaceFile {
  path: string;
  content: string;
}
/** Files that may not be copied into a run's workspace. `reasons` carries the kind, never the file content. */
export function checkWorkspaceFiles(
  files: readonly WorkspaceFile[],
  canaries: readonly string[] = [],
): { ok: boolean; refused: { path: string; reason: string }[] } {
  const refused: { path: string; reason: string }[] = [];
  for (const f of files) {
    const parts = f.path.split('/');
    const base = parts[parts.length - 1] ?? '';
    if (parts.slice(0, -1).some((p) => SECRET_DIR.has(p.toLowerCase())))
      refused.push({ path: f.path, reason: 'secret_directory' });
    else if (SECRET_FILE_NAME.some((r) => r.test(base)))
      refused.push({ path: f.path, reason: 'secret_file_name' });
    else {
      const finding = scanForSecrets(f.content, canaries)[0];
      if (finding) refused.push({ path: f.path, reason: `secret_content_${finding.kind}` });
    }
  }
  return { ok: refused.length === 0, refused };
}

export interface ScreenedOutput {
  text: string;
  redactions: number;
  /** a canary appeared in the output: an isolation failure signal, to be audited and escalated */
  canaryHit: boolean;
}
/** Replace every secret-looking span and canary with a marker. Findings are by offset; the replacement walks from the end so offsets stay valid. */
export function screenOutput(text: string, canaries: readonly string[] = []): ScreenedOutput {
  let out = text;
  let redactions = 0;
  let canaryHit = false;
  for (const c of canaries) {
    if (c.length < 8) continue;
    if (out.includes(c)) {
      canaryHit = true;
      redactions++;
      out = out.replaceAll(c, '[redacted:canary]');
    }
  }
  const PATS: { kind: string; re: RegExp }[] = [
    {
      kind: 'private_key',
      re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g,
    },
    {
      kind: 'token',
      re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bnzk_[A-Za-z0-9_-]{8,}_[A-Za-z0-9_-]{16,}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}\b|\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
    },
    { kind: 'vault', re: /\bvault:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{1,200}/g },
    {
      kind: 'assignment',
      re: /\b(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*["']?[A-Za-z0-9/+_=.-]{16,}/gi,
    },
    {
      kind: 'connection',
      re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@\S*/gi,
    },
  ];
  for (const { kind, re } of PATS) {
    out = out.replace(re, () => {
      redactions++;
      return `[redacted:${kind}]`;
    });
  }
  return { text: out, redactions, canaryHit };
}

export const MAX_MODEL_OUTPUT_CHARS = 8_000;
/** Output goes to a model only through this function: screened, bounded (head and tail kept), fenced as untrusted data. */
export function frameOutputForModel(
  o: { stdout: string; stderr: string; truncated: boolean },
  canaries: readonly string[] = [],
  fence: string = dataFence(),
): { framed: string; redactions: number; canaryHit: boolean } {
  const a = screenOutput(o.stdout, canaries);
  const b = screenOutput(o.stderr, canaries);
  const clip = (s: string) =>
    s.length <= MAX_MODEL_OUTPUT_CHARS
      ? s
      : `${s.slice(0, MAX_MODEL_OUTPUT_CHARS / 2)}\n[... ${s.length - MAX_MODEL_OUTPUT_CHARS} characters omitted ...]\n${s.slice(-MAX_MODEL_OUTPUT_CHARS / 2)}`;
  const framed = wrapUntrusted(
    [
      { label: 'stdout', text: clip(a.text) },
      { label: 'stderr', text: clip(b.text) },
      { label: 'truncated', text: o.truncated ? 'yes' : 'no' },
    ],
    fence,
  );
  return { framed, redactions: a.redactions + b.redactions, canaryHit: a.canaryHit || b.canaryHit };
}
