import { builderTools } from '@nuzm/domain';
import { describe, expect, it } from 'vitest';
import { LifecycleRunner } from './lifecycle.runner';
import { MemoryEnv, MemoryHost } from './lifecycle.testing';

const T = builderTools;

/** One realistic brief per product type (the ones of `planning/product-types.spec.ts`): the 14 planners still resolve and complete the whole lifecycle. */
const PROMPTS: Record<string, string> = {
  website: 'A company website with about, services and a contact form',
  landing: 'A landing page for our new product launch campaign',
  ecommerce: 'An online store to sell products with cart, checkout and orders',
  webapp: 'A web application for managing employee requests with a dashboard',
  mobile: 'A mobile app for iOS and Android to book appointments',
  flutter: 'A Flutter app with offline mode and push notifications',
  erp: 'An ERP with sales, purchasing, inventory and accounting',
  crm: 'A CRM to track customers, leads and the sales pipeline',
  saas: 'A SaaS product with subscription plans and multiple organizations',
  fullstack: 'A full-stack application to manage tasks',
  api: 'A REST API service with endpoints for products and orders',
  database: 'A database schema and data model for a clinic with migrations',
  auth: 'An authentication service with login system and password reset',
  docs: 'Generate technical documentation and a readme for the project',
};

describe('the 14 product planners inside the lifecycle', () => {
  it('covers every product type', () => {
    expect(Object.keys(PROMPTS).sort()).toEqual([...T.planning.PRODUCT_TYPES].sort());
  });
  it.each(Object.entries(PROMPTS))(
    '%s: resolves, plans, generates, reviews and asks for the deployment approval',
    async (type, prompt) => {
      const host = new MemoryHost();
      host.input.prompt = prompt;
      const env = new MemoryEnv();
      const out = await new LifecycleRunner().run(host, env);
      expect(out.artifacts.analysis?.productType).toBe(type);
      expect(out.status, JSON.stringify(out.state.failure)).toBe('waiting_approval');
      expect(out.artifacts.review?.errors).toBe(0);
      expect(env.applied).toHaveLength(1);
    },
  );
});

describe('project memory inside the loop (reads AND writes)', () => {
  it('writes what the plan settled as agent-sourced memory in the same change; a second run reads it and adds nothing it already knows', async () => {
    const env = new MemoryEnv();
    const first = new MemoryHost();
    const r1 = await new LifecycleRunner().run(first, env);
    const memText = env.files.get('nuzm.memory.json')!;
    const m1 = T.memoryFromFiles(env.files);
    expect(m1.ok).toBe(true);
    const entries = m1.ok ? T.activeEntries(m1.value) : [];
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries.every((e) => e.source === 'agent')).toBe(true);
    expect(r1.artifacts.project?.memoryEntries).toBe(0); // nothing to read the first time

    // a second lifecycle on the same project: step 2 READS the memory, step 6 does not duplicate it
    const second = new MemoryHost();
    second.runId = '0198a3c0-1111-7000-8000-000000000002';
    const r2 = await new LifecycleRunner().run(second, env);
    expect(r2.artifacts.project?.memoryEntries).toBe(entries.length);
    expect(env.files.get('nuzm.memory.json')).toBe(memText);
    // the memory file went through the validated change like every other file
    expect(env.applied[0]!.ops.some((o) => o.path === 'nuzm.memory.json' && o.op === 'add')).toBe(
      true,
    );
  });
});
