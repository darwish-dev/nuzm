import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildEvidenceIndex, fileSecretResolver, REQUIRED_EVIDENCE, SecretFileRefused } from './qualification-tools';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nuzm-q-'));
  chmodSync(dir, 0o700);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('qualification host secret resolver', () => {
  const w = (name: string, mode = 0o600) => {
    writeFileSync(join(dir, name), 'SECRET-VALUE', { mode });
    chmodSync(join(dir, name), mode);
  };
  it('resolves only vault://qualification/<name> from a private directory outside the repository', async () => {
    w('cp-signer');
    const r = fileSecretResolver(dir, { repoRoot: '/some/other/repo' });
    expect(await r('vault://qualification/cp-signer')).toBe('SECRET-VALUE');
    for (const bad of ['vault://prod/cp-signer', 'vault://qualification/../x', '/etc/passwd', 'vault://qualification/a/b'])
      await expect(r(bad), bad).rejects.toBeInstanceOf(SecretFileRefused);
  });
  it('refuses a directory inside the repository, a group/world-readable directory or file, and a symlink', async () => {
    expect(() => fileSecretResolver(dir, { repoRoot: tmpdir() })).toThrow('secrets_dir_inside_repository');
    chmodSync(dir, 0o755);
    expect(() => fileSecretResolver(dir, { repoRoot: '/r' })).toThrow('secrets_dir_not_private');
    chmodSync(dir, 0o700);
    w('open', 0o644);
    await expect(fileSecretResolver(dir, { repoRoot: '/r' })('vault://qualification/open')).rejects.toThrow('secret_file_not_private');
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    await expect(fileSecretResolver(dir, { repoRoot: '/r' })('vault://qualification/link')).rejects.toThrow('secret_not_a_regular_file');
  });
});

describe('evidence index', () => {
  const rep = (over = {}) => JSON.stringify({ mode: 'qualify', label: 'NOT VERIFIED', reportSha256: 'a'.repeat(64), totals: { fail: 0, isolatingAttempts: 65, isolatingPass: 65, notVerified: 0 }, ...over });
  const good = (): Map<string, Buffer> => {
    const m = new Map<string, Buffer>(REQUIRED_EVIDENCE.map((n) => [n, Buffer.from('x')]));
    m.set('qualification.json', Buffer.from(rep()));
    m.set('second-run/qualification.json', Buffer.from(rep()));
    m.set('declaration.json', Buffer.from(JSON.stringify({ node: { nodeId: 'node-1' } })));
    m.set('attestation.signed.json', Buffer.from(JSON.stringify({ node: { nodeId: 'node-1' }, evidence: { label: 'LIVE-VERIFIED', escapeSuite: { reportSha256: 'a'.repeat(64) } } })));
    m.set('baseline.json', Buffer.from(JSON.stringify({ label: 'SIMULATED' })));
    m.set('conformance.json', Buffer.from(JSON.stringify({ fail: 0, skipped: 0, target: { label: 'NOT VERIFIED' } })));
    m.set('negative-tests.txt', Buffer.from('PASS N-1\nPASS N-0\n'));
    return m;
  };
  const NOW = new Date('2026-12-01T00:00:00Z');
  it('a complete, consistent set is complete (and says nothing about approval)', () => {
    const i = buildEvidenceIndex(good(), NOW);
    expect(i).toMatchObject({ complete: true, missing: [], problems: [] });
    expect(i.entries.every((e) => /^[0-9a-f]{64}$/.test(e.sha256))).toBe(true);
  });
  it('reports every missing file and each inconsistency', () => {
    const m = good();
    m.delete('inventory.txt');
    m.set('qualification.json', Buffer.from(rep({ reportSha256: 'b'.repeat(64) })));
    m.set('second-run/qualification.json', Buffer.from(rep({ totals: { fail: 1, isolatingAttempts: 65, isolatingPass: 64 } })));
    m.set('baseline.json', Buffer.from(JSON.stringify({ label: 'NOT VERIFIED' })));
    m.set('conformance.json', Buffer.from(JSON.stringify({ fail: 2, skipped: 0, target: { label: 'SIMULATED' } })));
    m.set('negative-tests.txt', Buffer.from('FAIL N-5\n'));
    m.set('bootstrap-apply.log', Buffer.from('-----BEGIN PRIVATE KEY-----\nabc'));
    const i = buildEvidenceIndex(m, NOW);
    expect(i.complete).toBe(false);
    expect(i.missing).toEqual(['inventory.txt']);
    expect(i.problems).toEqual(expect.arrayContaining([
      'attestation:report_digest_does_not_match_qualification',
      'second_run:escaped_attempts',
      'second_run:isolating_set_not_all_blocked',
      'second_run:totals_differ',
      'baseline:not_labelled_simulated',
      'conformance:not_clean',
      'conformance:ran_on_a_simulated_target',
      'negative_tests:contains_fail',
      'secret_in_evidence:bootstrap-apply.log',
    ]));
  });
  it('a SIMULATED qualification or a non-qualify mode can never be complete evidence', () => {
    const m = good();
    m.set('qualification.json', Buffer.from(rep({ mode: 'simulated', label: 'SIMULATED' })));
    expect(buildEvidenceIndex(m, NOW).problems).toEqual(expect.arrayContaining(['qualification:mode_not_qualify', 'qualification:label_simulated']));
  });
});
