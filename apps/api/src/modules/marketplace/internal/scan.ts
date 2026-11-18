import { createHash } from 'node:crypto';
import { validateWorkflowDefinition } from '@nuzm/domain';

/**
 * Automated marketplace scans (M11 S53.2) run when a version is submitted, BEFORE a person decides. Rule set v1: secrets, malware signatures, dependency deny-list, personal data,
 * licence, SBOM presence, and (for workflow templates) the workflow schema with no connector references and no credentials. The verdict is `flagged` when any rule fires; a flagged version
 * still goes to the moderation queue (a human sees the findings) but cannot be approved without an explicit scan override reason. Findings never quote the matched value (it could be a secret).
 * This is a PATTERN scanner, not an antivirus engine: real malware scanning needs a provider (NOT VERIFIED) and the report says so.
 */
export const SCAN_RULESET = '2026-11-18.1';
export type ListingType = 'website-template' | 'app-template' | 'workflow-template';
export interface Finding {
  rule: 'secret' | 'malware' | 'dependency' | 'pii' | 'licence' | 'sbom' | 'workflow';
  severity: 'block' | 'warn';
  where: string;
  detail: string;
}
export interface ScanResult {
  rulesetVersion: string;
  verdict: 'clean' | 'flagged';
  findings: Finding[];
  bytes: number;
  sha256: string;
}

const SECRET: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/\b(sk|rk)_(live|test)_[A-Za-z0-9]{12,}/, 'payment provider secret key'],
  [/\bghp_[A-Za-z0-9]{30,}/, 'GitHub token'],
  [/\bxox[abp]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/\bnzk_[A-Za-z0-9]{12,}/, 'Nuzm API key'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'JWT'],
  [/\b(password|passwd|secret|api[_-]?key|access[_-]?token)\s*["']?\s*[:=]\s*["'][^"'\s]{8,}["']/i, 'credential assignment'],
  [/\bvault:\/\/[A-Za-z0-9/_.-]+/, 'vault reference of the publisher'],
];
const MALWARE: [RegExp, string][] = [
  [/X5O!P%@AP\[4\\PZX54\(P\^\)7CC\)7\}\$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!\$H\+H\*/, 'EICAR test signature'],
  [/\beval\s*\(\s*atob\s*\(/, 'eval of decoded payload'],
  [/\bnew\s+Function\s*\(\s*atob/, 'Function constructor on decoded payload'],
  [/\bstratum\+tcp:\/\//i, 'crypto-miner pool address'],
  [/coinhive|cryptonight|xmrig/i, 'crypto-miner reference'],
  [/\bchild_process\b[\s\S]{0,80}\b(exec|spawn)\b/, 'shell execution'],
  [/\bdocument\.write\s*\(\s*unescape\s*\(/, 'obfuscated script injection'],
];
const DENY_PACKAGES = new Set(['flatmap-stream', 'event-stream@3.3.6', 'node-ipc@10.1.1', 'node-ipc@10.1.2', 'colors@1.4.1', 'faker@6.6.6', 'ua-parser-js@0.7.29']);
const LICENCES = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'MPL-2.0']);
const luhn = (d: string) => {
  let sum = 0;
  let alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
};

function personalData(text: string): string[] {
  const out: string[] = [];
  if (/\bSA\d{2}[0-9A-Z]{20}\b/.test(text)) out.push('IBAN');
  if (/(?<![\d.])[12]\d{9}(?![\d.])/.test(text.replace(/\d{11,}/g, ''))) out.push('national or residence id number');
  if (/\+9665\d{8}\b/.test(text)) out.push('Saudi mobile number');
  for (const m of text.matchAll(/(?<!\d)(\d[ -]?){13,19}(?!\d)/g)) {
    const d = m[0].replace(/\D/g, '');
    if (d.length >= 13 && d.length <= 19 && luhn(d)) {
      out.push('payment card number');
      break;
    }
  }
  const emails = [...text.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)].filter((m) => !/(^|\.)(example\.(com|org|net)|example|test|invalid|localhost)$/i.test(m[1]!));
  if (emails.length > 0) out.push('real-looking email address');
  return out;
}

export function scanArtifact(i: { type: ListingType; content: Buffer; sbomPresent: boolean }): ScanResult {
  const text = i.content.toString('utf8');
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);
  for (const [re, what] of SECRET) if (re.test(text)) add({ rule: 'secret', severity: 'block', where: 'artifact', detail: `contains a ${what}` });
  for (const [re, what] of MALWARE) if (re.test(text)) add({ rule: 'malware', severity: 'block', where: 'artifact', detail: what });
  for (const what of personalData(text)) add({ rule: 'pii', severity: 'block', where: 'artifact', detail: `contains ${what}` });
  // dependency + licence: the artifact may carry a package.json (website/app templates) as JSON at the top level or under `package.json`
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const pkg = (parsed && typeof parsed === 'object' ? ((parsed as { 'package.json'?: unknown })['package.json'] ?? parsed) : undefined) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; license?: unknown } | undefined;
  if (pkg && typeof pkg === 'object' && ('dependencies' in pkg || 'license' in pkg || 'devDependencies' in pkg)) {
    for (const [name, ver] of Object.entries({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) })) {
      const v = String(ver).replace(/^[\^~=v]/, '');
      if (DENY_PACKAGES.has(name) || DENY_PACKAGES.has(`${name}@${v}`)) add({ rule: 'dependency', severity: 'block', where: `dependencies.${name}`, detail: 'a package on the deny-list' });
    }
    if (typeof pkg.license !== 'string' || !LICENCES.has(pkg.license)) add({ rule: 'licence', severity: 'block', where: 'package.json', detail: 'missing or unapproved licence identifier' });
  } else if (i.type !== 'workflow-template') add({ rule: 'licence', severity: 'warn', where: 'artifact', detail: 'no package manifest: the licence cannot be checked' });
  if (i.type !== 'workflow-template' && !i.sbomPresent) add({ rule: 'sbom', severity: 'block', where: 'version', detail: 'a website or app template needs an SBOM' });
  if (i.type === 'workflow-template') {
    if (parsed === undefined) add({ rule: 'workflow', severity: 'block', where: 'artifact', detail: 'a workflow template must be a JSON workflow definition' });
    else {
      const r = validateWorkflowDefinition(parsed);
      for (const e of r.errors) add({ rule: 'workflow', severity: 'block', where: e.path, detail: e.message });
      if (r.ok && r.connectorIds.length > 0) add({ rule: 'workflow', severity: 'block', where: 'steps', detail: 'a template cannot reference connectors (they belong to one organization)' });
    }
  }
  return { rulesetVersion: SCAN_RULESET, verdict: findings.some((f) => f.severity === 'block') ? 'flagged' : 'clean', findings, bytes: i.content.length, sha256: createHash('sha256').update(i.content).digest('hex') };
}
