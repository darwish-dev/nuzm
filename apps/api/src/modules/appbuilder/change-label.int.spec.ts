import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupAiEnv, type AiEnv } from '../ai/testing/ai-harness';
import { ProjectsPort } from './internal/ports/m09';

/**
 * Regression (found by the real template-adaptation validation, 2026-11-26): a change message longer than 100 characters became a version label of up to 120,
 * which the database refuses (`project_versions_label_check`: 1..100). The change failed with an internal error and nothing was saved. A real model's summary
 * is routinely that long ("Adapt template (ADAPTIVE): " + up to 100 characters).
 */
let e: AiEnv;
beforeAll(async () => {
  process.env.APPBUILDER_KICK = 'off';
  e = await setupAiEnv();
  await e.sql(
    `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'app_builder.enabled', $1, 'true'::jsonb)`,
    [e.org.A!],
  );
}, 180_000);
afterAll(() => e.h.close());

describe('version labels from long change messages', () => {
  it.each([101, 120, 126, 500])(
    'a %i-character message saves the change; the label is its first 100 characters',
    async (n) => {
      const port = e.app.get<ProjectsPort>(ProjectsPort);
      const p = await port.create(e.org.A!, {
        type: 'webapp',
        name: `label-${randomUUID().slice(0, 6)}`,
        dataRegion: 'sa-central',
        createdBy: e.ids.alice!,
      });
      const v1 = await port.commit(e.org.A!, p.id, {
        baseVersionId: null,
        files: new Map([['README.md', '# app\n']]),
        source: 'user',
        createdBy: e.ids.alice!,
      });
      const message = `Adapt template (ADAPTIVE): ${'x'.repeat(n)}`.slice(0, n);
      const r = await e.call(
        'alice',
        'POST',
        `/v1/builder/projects/${p.id}/changes`,
        {
          baseVersion: v1.id,
          patches: [{ op: 'modify', path: 'README.md', content: '# app, changed\n' }],
          message,
        },
        e.org.A!,
      );
      expect(r.statusCode, r.body).toBe(200);
      const rows = await e.sql(
        `SELECT label FROM builder.project_versions WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [p.id],
      );
      expect(rows[0]!.label).toBe(message.slice(0, 100));
    },
  );
});
