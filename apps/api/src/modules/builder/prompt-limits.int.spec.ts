import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockModelAdapter } from '@nuzm/adapter-model';
import { mockModelHandler, PROMPT_LIMITS } from '@nuzm/domain';
import { RunService } from '../ai';
import { setupAiEnv, type AiEnv, type Row } from '../ai/testing/ai-harness';

/**
 * Customer manual testing (2026-11-26): a website description longer than 600 characters was cut to 600 characters by the start screen and the API, and the preview showed the
 * starter site titled with the first words of the description. A description of up to 30,000 characters is now accepted, reaches the model WHOLE (as data), one
 * character more is refused (never cut), and the generated site is named after the business, not after the project name taken from the description.
 * Mock model: proves the plumbing, not generation quality.
 */
let e: AiEnv;
let runs: RunService;
const seen: string[] = [];
const A = () => e.org.A!;
const j = (r: { json(): unknown }) => r.json() as Row;

beforeAll(async () => {
  e = await setupAiEnv();
  runs = e.app.get(RunService);
  await e.enableMock('mock-model', {
    adapter: new MockModelAdapter({
      id: 'mock-model',
      handler: (req) => {
        seen.push(JSON.stringify(req));
        return mockModelHandler(req);
      },
    }),
  });
  await e.fund(A(), '100000000');
  await e.call('alice', 'PUT', '/v1/ai/budgets', { org: {} }, A(), { 'if-match': '"0"' });
}, 120_000);
afterAll(() => e.h.close());

async function website(name: string) {
  const p = j(
    await e.call('alice', 'POST', '/v1/builder/projects', {
      type: 'website',
      name,
      locale: ['ar', 'en'],
    }),
  );
  const sid = (await e.call('alice', 'POST', '/v1/ai/sessions', { title: name })).json()
    .id as string;
  return { p, sid };
}
/** A description of exactly `n` characters whose LAST words are a marker: if anything cuts the text, the marker is gone. */
const description = (n: number) => {
  const tail = ' END-MARKER-7Q';
  const head =
    'Create a premium website for a digital marketing agency called VERTEX Media in Riyadh. ';
  return (head + 'x'.repeat(n)).slice(0, n - tail.length) + tail;
};

describe('a long website description (mock model: SIMULATED)', () => {
  it(`${PROMPT_LIMITS.projectPromptChars} characters are accepted and reach the model whole; the starter is reported as a starter`, async () => {
    const { p, sid } = await website('limits-long');
    const before = j(await e.call('alice', 'GET', `/v1/builder/projects/${p.id}`));
    expect(before.versionSource).toBe('system'); // the console shows the run state, not this starter, as long as it is the head
    const text = description(PROMPT_LIMITS.projectPromptChars);
    expect(text).toHaveLength(30_000);
    const res = await e.call('alice', 'POST', '/v1/ai/runs', {
      sessionId: sid,
      kind: 'website',
      projectId: p.id,
      input: { description: text },
    });
    expect(res.statusCode, res.body).toBe(202);
    const run = j(res);
    const stored = await e.sql(
      `SELECT input->>'description' AS d, operation_id FROM ai.runs WHERE id=$1`,
      [run.id],
    );
    expect(stored[0]!.d).toBe(text); // stored whole
    seen.length = 0;
    await runs.runOne(A(), stored[0]!.operation_id as string);
    const requirementsCall = seen.find((s) => s.includes('requirements'));
    expect(requirementsCall, 'the requirements call reached the model').toBeDefined();
    expect(requirementsCall).toContain('END-MARKER-7Q'); // the end of the description reached the model
    expect(requirementsCall).not.toContain('were not included');
    const waiting = j(await e.call('alice', 'GET', `/v1/ai/runs/${run.id}`));
    expect(waiting.state, JSON.stringify(waiting.error)).toBe('waiting_approval');
    // the architecture call also had the whole description next to the summary
    expect(seen.some((s) => s.includes('architecture') && s.includes('END-MARKER-7Q'))).toBe(true);

    expect(
      (
        await e.call('dave', 'POST', `/v1/ai/runs/${run.id}/approvals`, {
          approvalId: waiting.pendingApproval.id,
          decision: 'approve',
        })
      ).statusCode,
    ).toBe(200);
    const op2 = (await e.sql(`SELECT operation_id FROM ai.runs WHERE id=$1`, [run.id]))[0]!
      .operation_id as string; // resuming after the approval runs under the run's current operation
    await runs.runOne(A(), op2);
    const done = j(await e.call('alice', 'GET', `/v1/ai/runs/${run.id}`));
    expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
    const after = j(await e.call('alice', 'GET', `/v1/builder/projects/${p.id}`));
    expect(after.versionSource).toBe('ai');
    // the site is named after the business of the requirements, not after the project name
    const req = (
      await e.sql(
        `SELECT checkpoint->'requirements'->>'businessName' AS n FROM ai.runs WHERE id=$1`,
        [run.id],
      )
    )[0]!.n as string;
    const brand = (after.siteModel as { brand: { name: Record<string, string> } }).brand.name;
    expect(Object.values(brand)).toContain(req.trim());
    expect(Object.values(brand)).not.toContain('limits-long');
  });

  it('one character more is refused with a validation error; nothing is cut and no run is created', async () => {
    const { p, sid } = await website('limits-over');
    const n = (
      await e.sql(`SELECT count(*)::int AS n FROM ai.runs WHERE project_id=$1`, [p.id])
    )[0]!.n;
    const res = await e.call('alice', 'POST', '/v1/ai/runs', {
      sessionId: sid,
      kind: 'website',
      projectId: p.id,
      input: { description: description(PROMPT_LIMITS.projectPromptChars + 1) },
    });
    expect(res.statusCode).toBe(422);
    expect(j(res).code).toBe('validation_failed');
    expect(
      (await e.sql(`SELECT count(*)::int AS n FROM ai.runs WHERE project_id=$1`, [p.id]))[0]!.n,
    ).toBe(n);
  });

  it(`a follow-up change instruction of ${PROMPT_LIMITS.chatMessageChars} characters is accepted, one more is refused`, async () => {
    const { p, sid } = await website('limits-edit');
    const ok = await e.call('alice', 'POST', '/v1/ai/runs', {
      sessionId: sid,
      kind: 'edit',
      projectId: p.id,
      input: { instruction: 'y'.repeat(PROMPT_LIMITS.chatMessageChars) },
    });
    expect(ok.statusCode, ok.body).toBe(202);
    const other = await website('limits-edit-over'); // a project with no active run: the refusal below is the length, nothing else
    const over = await e.call('alice', 'POST', '/v1/ai/runs', {
      sessionId: other.sid,
      kind: 'edit',
      projectId: other.p.id,
      input: { instruction: 'y'.repeat(PROMPT_LIMITS.chatMessageChars + 1) },
    });
    expect(over.statusCode).toBe(422);
  });

  it(`a chat message of ${PROMPT_LIMITS.chatMessageChars} characters is stored whole, one more is refused`, async () => {
    const sid = (await e.call('alice', 'POST', '/v1/ai/sessions', { title: 'limits-chat' })).json()
      .id as string;
    const ok = await e.call('alice', 'POST', `/v1/ai/sessions/${sid}/messages`, {
      content: 'z'.repeat(PROMPT_LIMITS.chatMessageChars),
    });
    expect(ok.statusCode, ok.body).toBe(201);
    const over = await e.call('alice', 'POST', `/v1/ai/sessions/${sid}/messages`, {
      content: 'z'.repeat(PROMPT_LIMITS.chatMessageChars + 1),
    });
    expect(over.statusCode).toBe(422);
  });
});
