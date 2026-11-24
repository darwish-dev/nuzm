import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockModelAdapter } from '@nuzm/adapter-model';
import { mockModelHandler } from '@nuzm/domain';
import { RunService } from '../ai';
import { setupAiEnv, type AiEnv, type Row } from '../ai/testing/ai-harness';
import { VersionArtifactService } from './internal/artifact.service';
import { buildWebsiteEvidence, validateWebsiteEvidence } from './internal/qa/evidence';

/**
 * T1 part 1 HARNESS, SIMULATED: the two synthetic briefs (one Arabic, one English) go through the real `website` run kind (requirements → architecture → plan approval →
 * per-page copy → assembled model → new version) with the MOCK model, and the stored result is judged by the QA gates and written up as an evidence record. This proves the
 * plumbing, the gates and the evidence honesty. It does NOT prove generation quality: only a real model through the same path can, and the record produced here is labelled
 * SIMULATED by construction. Briefs are synthetic: no customer data.
 */
const BRIEFS = [
  {
    id: 'synthetic-ar-bakery',
    locale: 'ar' as const,
    text: 'مخبز عائلي في الرياض يقدم خبزاً طازجاً وحلويات شرقية، مع خدمة توصيل وطلبات مسبقة للمناسبات. نريد موقعاً بصفحات: الرئيسية، من نحن، منتجاتنا، الأسئلة الشائعة، تواصل معنا.',
  },
  {
    id: 'synthetic-en-clinic',
    locale: 'en' as const,
    text: 'A small dental clinic in Jeddah offering check-ups, whitening and braces, with online appointment requests. We want pages: home, about, services, pricing, contact.',
  },
];

let e: AiEnv;
let runs: RunService;
const A = () => e.org.A!;
const j = (r: { json(): unknown }) => r.json() as Row;

beforeAll(async () => {
  e = await setupAiEnv();
  runs = e.app.get(RunService);
  await e.enableMock('mock-model', {
    adapter: new MockModelAdapter({ id: 'mock-model', handler: (req) => mockModelHandler(req) }),
  });
  await e.fund(A(), '100000000');
  await e.call('alice', 'PUT', '/v1/ai/budgets', { org: {} }, A(), { 'if-match': '"0"' });
}, 120_000);
afterAll(() => e.h.close());

describe('T1 part 1 harness (mock model: SIMULATED)', () => {
  for (const b of BRIEFS)
    it(`${b.id}: brief → run → stored version → QA → evidence record that cannot claim to be live`, async () => {
      const p = j(
        await e.call('alice', 'POST', '/v1/builder/projects', {
          type: 'website',
          name: b.id,
          locale: ['ar', 'en'],
          templateId: 'landing',
        }),
      );
      const sid = (await e.call('alice', 'POST', '/v1/ai/sessions', { title: b.id })).json()
        .id as string;
      const run = j(
        await e.call('alice', 'POST', '/v1/ai/runs', {
          sessionId: sid,
          kind: 'website',
          projectId: p.id,
          input: { description: b.text.slice(0, 600) },
        }),
      );
      const op = async () =>
        (await e.sql(`SELECT operation_id FROM ai.runs WHERE id=$1`, [run.id]))[0]!
          .operation_id as string;
      const t0 = Date.now();
      await runs.runOne(A(), await op());
      const waiting = j(await e.call('alice', 'GET', `/v1/ai/runs/${run.id}`));
      expect(waiting.state).toBe('waiting_approval');
      expect(
        (
          await e.call('dave', 'POST', `/v1/ai/runs/${run.id}/approvals`, {
            approvalId: waiting.pendingApproval.id,
            decision: 'approve',
          })
        ).statusCode,
      ).toBe(200);
      await runs.runOne(A(), await op());
      const done = j(await e.call('alice', 'GET', `/v1/ai/runs/${run.id}`));
      expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
      // the run reports what QA found on the stored files (reporting only: it never changes the run's outcome)
      const result = done.result as Row | undefined;
      const qaInRun = result?.qa as Row | undefined;
      expect(qaInRun, 'the run result carries the QA summary').toBeDefined();
      expect(typeof qaInRun!.artifactHash).toBe('string');

      const art = e.app.get(VersionArtifactService);
      const headId = (
        await e.sql(`SELECT head_version_id FROM builder.projects WHERE id=$1`, [p.id])
      )[0]!.head_version_id as string;
      const { report } = await art.qa(A(), p.id as string, headId, { axe: 'off', minPages: 1 });
      expect(report.rootHash).toBe(qaInRun!.artifactHash);
      expect(report.locales).toEqual(['ar', 'en']);

      const ev = buildWebsiteEvidence({
        id: `${b.id}-sim`,
        createdAt: new Date().toISOString(),
        brief: b,
        model: { id: 'mock-model', provider: 'mock', simulated: true },
        // an attempt to over-claim: the builder must refuse it
        claim: 'LIVE-VERIFIED',
        approvalRef: 'none',
        run: {
          id: run.id as string,
          state: String(done.state),
          tokensIn: Number((done.usage as Row | undefined)?.tokensIn ?? 0),
          tokensOut: Number((done.usage as Row | undefined)?.tokensOut ?? 0),
          costMinor: 0,
          currency: 'SAR',
          durationMs: Date.now() - t0,
        },
        qa: report,
      });
      expect(ev.label).toBe('SIMULATED');
      expect(validateWebsiteEvidence(ev)).toEqual([]);
      // honest status of what the mock produced against the acceptance criteria (informational: a real model is the subject of W1)
      console.log(
        `[T1-sim] ${b.id}: pages/locale=${JSON.stringify(ev.artifact.pagesPerLocale)} failing gates=${
          report.gates
            .filter((g) => g.status === 'fail')
            .map((g) => `${g.gate}(${g.findings.filter((f) => f.severity === 'error').length})`)
            .join(',') || 'none'
        } label=${ev.label}`,
      );
    }, 120_000);
});
