import { describe, expect, it } from 'vitest';
import { scanArtifact } from './scan';

const WF = {
  schemaVersion: 1,
  start: 'a',
  steps: [{ id: 'a', type: 'transform', params: { output: { x: '{{ input.n }}' } } }],
};
const scan = (
  type: 'website-template' | 'app-template' | 'workflow-template',
  content: unknown,
  sbomPresent = true,
) =>
  scanArtifact({
    type,
    content: Buffer.from(typeof content === 'string' ? content : JSON.stringify(content)),
    sbomPresent,
  });
const rules = (r: ReturnType<typeof scan>) => r.findings.map((f) => f.rule);

describe('marketplace scans (rule set v1)', () => {
  it('a clean workflow template and a clean website template pass', () => {
    expect(scan('workflow-template', WF).verdict).toBe('clean');
    const site = {
      'package.json': { license: 'MIT', dependencies: { react: '18.3.1' } },
      'index.html': '<h1>Hello</h1>',
    };
    expect(scan('website-template', site).verdict).toBe('clean');
  });
  it('detects secrets without ever quoting them', () => {
    for (const s of [
      'AKIAABCDEFGHIJKLMNOP',
      '-----BEGIN RSA PRIVATE KEY-----\nabc',
      'sk_live_abcdefghijklmnop',
      'ghp_' + 'a'.repeat(36),
      'nzk_abcdefghijkl',
      'password = "hunter2hunter2"',
      'vault://dev/tenant-x',
    ]) {
      const r = scan('workflow-template', { ...WF, note: s });
      expect(rules(r), s).toContain('secret');
      expect(JSON.stringify(r.findings)).not.toContain(s);
    }
  });
  it('detects malware signatures, miners and obfuscation', () => {
    for (const s of [
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
      'eval(atob("YWxlcnQoMSk="))',
      'stratum+tcp://pool.example:3333',
      'new Function(atob("x"))',
    ])
      expect(
        rules(scan('website-template', { 'package.json': { license: 'MIT' }, js: s })),
        s,
      ).toContain('malware');
  });
  it('detects personal data (IBAN, national id, mobile, card, real-looking email) but not example data', () => {
    for (const s of [
      'SA0380000000608010167519',
      'id 1098765432',
      '+966512345678',
      '4111 1111 1111 1111',
      'ahmed@gmail.com',
    ])
      expect(rules(scan('workflow-template', { ...WF, note: s })), s).toContain('pii');
    expect(rules(scan('workflow-template', { ...WF, note: 'user@example.com' }))).not.toContain(
      'pii',
    );
  });
  it('checks dependencies, licence and the SBOM', () => {
    expect(
      rules(
        scan('app-template', {
          'package.json': { license: 'MIT', dependencies: { 'flatmap-stream': '0.1.1' } },
        }),
      ),
    ).toContain('dependency');
    expect(
      rules(scan('app-template', { 'package.json': { license: 'GPL-3.0', dependencies: {} } })),
    ).toContain('licence');
    expect(rules(scan('app-template', { 'package.json': { dependencies: {} } }))).toContain(
      'licence',
    );
    expect(
      rules(scan('website-template', { 'package.json': { license: 'MIT' } }, false)),
    ).toContain('sbom');
  });
  it('a workflow template must be a valid definition with no connectors', () => {
    expect(rules(scan('workflow-template', 'not json'))).toContain('workflow');
    expect(rules(scan('workflow-template', { schemaVersion: 1, start: 'x', steps: [] }))).toContain(
      'workflow',
    );
    const withConn = {
      schemaVersion: 1,
      start: 'a',
      steps: [
        {
          id: 'a',
          type: 'http_request',
          params: {
            method: 'GET',
            url: 'https://a.example.com',
            connectorId: '0190a000-0000-7000-8000-000000000001',
          },
        },
      ],
    };
    const r = scan('workflow-template', withConn);
    expect(r.verdict).toBe('flagged');
    expect(r.findings.some((f) => /connectors/.test(f.detail))).toBe(true);
  });
  it('is deterministic and reports size and hash', () => {
    const a = scan('workflow-template', WF);
    const b = scan('workflow-template', WF);
    expect(a).toEqual(b);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.rulesetVersion).toBeTruthy();
  });
});
