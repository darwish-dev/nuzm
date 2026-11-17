import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EInvoiceAuthError } from './adapter';
import { ZatcaPipelineService } from './pipeline.service';
import { DevFileSecretStore } from './secrets';
import { SimulatedZatca } from './simulated-adapter';
import { ZatcaSubmissionService } from './submission.service';
import { ZatcaDocumentService } from './zatca-document.service';

const tmp = mkdtempSync(join(tmpdir(), 'zatca-q-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('secret store (values live in the vault, the database keeps references)', () => {
  const s = new DevFileSecretStore(join(tmp, 'v'));
  it('writes once, reads back, refuses odd references and a production profile', async () => {
    await s.put('vault://dev/zatca/csid-1-t', 'value-1');
    expect(await s.get('vault://dev/zatca/csid-1-t')).toBe('value-1');
    await expect(s.put('vault://dev/zatca/csid-1-t', 'other')).rejects.toThrow(/already exists/);
    await expect(s.get('vault://dev/zatca/../../etc/passwd')).rejects.toThrow(/reference/);
    await expect(s.put('/etc/passwd', 'x')).rejects.toThrow(/reference/);
    expect(() => new DevFileSecretStore(join(tmp, 'v2'), { NODE_ENV: 'production' })).toThrow(
      /production/,
    );
  });
});

describe('simulated server rules', () => {
  const csr = `-----BEGIN CERTIFICATE REQUEST-----\n${'A'.repeat(120)}\n-----END CERTIFICATE REQUEST-----`;
  it('needs a six-digit OTP and a CSR; compliance credentials cannot submit, production ones cannot run compliance checks', async () => {
    const sim = new SimulatedZatca();
    await expect(sim.requestComplianceCsid({ csrPem: csr, otp: '12345' })).rejects.toBeInstanceOf(
      EInvoiceAuthError,
    );
    await expect(
      sim.requestComplianceCsid({ csrPem: 'junk', otp: '123456' }),
    ).rejects.toBeInstanceOf(EInvoiceAuthError);
    const c = await sim.requestComplianceCsid({ csrPem: csr, otp: '123456' });
    const doc = {
      uuid: crypto.randomUUID(),
      hash: 'h',
      type: 'invoice' as const,
      subtype: 'simplified' as const,
      xml: '<x/>',
    };
    await expect(sim.submit({ token: c.token, secret: c.secret }, doc)).rejects.toThrow(
      /compliance credential cannot be used here/,
    );
    const p = await sim.requestProductionCsid({ token: c.token, secret: c.secret });
    await expect(sim.complianceCheck({ token: p.token, secret: p.secret }, doc)).rejects.toThrow(
      /production credential cannot be used here/,
    );
    await expect(
      sim.requestProductionCsid({ token: p.token, secret: p.secret }),
    ).rejects.toBeInstanceOf(EInvoiceAuthError);
    await expect(sim.submit({ token: p.token, secret: 'wrong' }, doc)).rejects.toThrow(
      /unknown credential/,
    );
  });
});

describe('configuration', () => {
  it('validates the queue and pipeline settings and refuses production', () => {
    expect(ZatcaSubmissionService.optsFromEnv({})).toEqual({
      maxAttempts: 6,
      baseBackoffSeconds: 60,
    });
    expect(
      ZatcaSubmissionService.optsFromEnv({ ZATCA_MAX_ATTEMPTS: '3', ZATCA_BACKOFF_SECONDS: '5' }),
    ).toEqual({ maxAttempts: 3, baseBackoffSeconds: 5 });
    for (const env of [
      { ZATCA_MAX_ATTEMPTS: '0' },
      { ZATCA_MAX_ATTEMPTS: '21' },
      { ZATCA_BACKOFF_SECONDS: '0' },
      { ZATCA_BACKOFF_SECONDS: 'x' },
    ])
      expect(() => ZatcaSubmissionService.optsFromEnv(env)).toThrow();
    expect(ZatcaPipelineService.generateFromEnv({})).toBeNull(); // no cutover date: nothing is generated automatically
    expect(
      ZatcaPipelineService.generateFromEnv({
        ZATCA_GENERATE_FROM: '2026-12-01T00:00:00Z',
      })?.toISOString(),
    ).toBe('2026-12-01T00:00:00.000Z');
    expect(() => ZatcaPipelineService.generateFromEnv({ ZATCA_GENERATE_FROM: 'soon' })).toThrow();
    expect(() => ZatcaDocumentService.modeFromEnv({ ZATCA_MODE: 'production' })).toThrow(
      /HG-03-03/,
    );
  });
});
