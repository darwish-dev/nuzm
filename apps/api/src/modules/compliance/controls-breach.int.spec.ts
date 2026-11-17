import 'reflect-metadata';
import type { Db } from '@nuzm/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditSink } from '../../common/audit';
import { DB } from '../../common/tokens';
import { Harness, cookieHeader, type App } from '../identity/testing/app-harness';
import { BreachService } from './internal/breach/breach.service';
import { loadBreachConfig } from './internal/breach/state';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests */
type Row = Record<string, any>;
const h = new Harness();
let app: App;
let orgA = '';
const staff: Record<string, { id: string; jar: Record<string, string> }> = {};
const jars: Record<string, Record<string, string>> = {};
let seq = 0;

const call = (
  who: string,
  method: 'GET' | 'POST',
  url: string,
  body?: object,
  key?: string | null,
) =>
  app.inject({
    method,
    url,
    headers: {
      cookie: cookieHeader(staff[who]!.jar),
      'x-csrf-token': staff[who]!.jar.nuzm_admin_csrf!,
      ...(method === 'POST' && key !== null
        ? { 'idempotency-key': key ?? `k-${++seq}-${Math.random()}` }
        : {}),
    },
    ...(body ? { payload: body } : {}),
  });
const count = async (q: string, p: unknown[] = []) => Number((await h.env.sql(q, p))[0]!.n);
const control = (id: string) => `/v1/admin/compliance/controls?controlId=${id}`;

beforeAll(async () => {
  await h.init();
  ({ app } = await h.buildApp({}, undefined, [], { realAudit: true }));
  for (const n of ['alice']) {
    const id = await h.createUser(n);
    jars[n] = await h.sessionFor(app, id);
  }
  orgA = (
    await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: { cookie: cookieHeader(jars.alice!), 'x-csrf-token': jars.alice!.nuzm_csrf! },
      payload: { name: 'Breach A' },
    })
  ).json().id;
  staff.officer = await h.platformUser(app, 'officer', ['compliance_officer']);
  staff.root = await h.platformUser(app, 'root', ['platform_admin']);
  staff.sec = await h.platformUser(app, 'sec', ['security']);
  staff.support = await h.platformUser(app, 'support', ['support']);
  // the catalog is loaded by `pnpm compliance:sync-controls` under the admin role: the tests load two controls the same way (as the owner)
  for (const [id, spec] of [
    ['CTL-TST-001', [{ type: 'automated', collector: 'db.ownership-rls-check' }]],
    ['CTL-TST-002', [{ type: 'manual', description: 'Quarterly review' }]],
  ] as const)
    await h.env.sql(
      `INSERT INTO compliance.control_catalog (control_id, title, owner_role, implementation, evidence_spec, review_cadence_days, source_digest)
       VALUES ($1, 'Test control ' || $1, 'security', '{"status":"partial","modules":["x"],"milestone":"M04"}', $2::jsonb, 90, repeat('a', 64))`,
      [id, JSON.stringify(spec)],
    );
});
afterAll(() => h.close());

describe('who may read and write the registers', () => {
  it('support staff and customers are refused everywhere; compliance officer, security and platform admin read', async () => {
    for (const u of ['controls', 'evidence', 'regulatory-validations', 'breach-cases']) {
      expect((await call('support', 'GET', `/v1/admin/compliance/${u}`)).statusCode, u).toBe(403);
      expect((await call('sec', 'GET', `/v1/admin/compliance/${u}`)).statusCode, u).toBe(200);
      expect((await call('officer', 'GET', `/v1/admin/compliance/${u}`)).statusCode, u).toBe(200);
      const customer = await app.inject({
        method: 'GET',
        url: `/v1/admin/compliance/${u}`,
        headers: { cookie: cookieHeader(jars.alice!), 'x-nuzm-org': orgA },
      });
      expect(customer.statusCode, u).toBeGreaterThanOrEqual(401); // a customer session is not an admin session
      expect(customer.statusCode, u).toBeLessThan(500);
    }
  });
  it('every write needs an Idempotency-Key', async () => {
    for (const u of ['controls', 'evidence', 'regulatory-validations', 'breach-cases']) {
      const r = await call('root', 'POST', `/v1/admin/compliance/${u}`, {}, null);
      expect(JSON.stringify(r.json()), u).toContain('idempotency_key_required');
    }
  });
});

describe('the control register', () => {
  it('lists the catalog with a status that only says what exists, and never claims compliance', async () => {
    const r = await call('officer', 'GET', '/v1/admin/compliance/controls');
    expect(r.statusCode).toBe(200);
    const items = r.json().items as Row[];
    expect(items.map((x) => x.controlId)).toEqual(['CTL-TST-001', 'CTL-TST-002']);
    for (const x of items) {
      expect(x).toMatchObject({
        claimsCompliance: false,
        applicability: 'to_confirm',
        status: 'not_mapped',
        frameworks: [],
      });
      expect(x.evidence).toMatchObject({
        total: 0,
        automated: 0,
        latestAutomated: null,
        latestReview: null,
      });
    }
    expect(JSON.stringify(r.json()).toLowerCase()).not.toMatch(/compliant|certified/);
  });
  it('filters by status, applicability, owner and control id; rejects bad filters', async () => {
    expect(
      (
        (await call('officer', 'GET', '/v1/admin/compliance/controls?status=mapped')).json()
          .items as Row[]
      ).length,
    ).toBe(0);
    expect(
      (
        (await call('officer', 'GET', '/v1/admin/compliance/controls?ownerRole=security')).json()
          .items as Row[]
      ).length,
    ).toBe(2);
    expect(
      ((await call('officer', 'GET', control('CTL-TST-002'))).json().items as Row[]).length,
    ).toBe(1);
    expect(
      (await call('officer', 'GET', '/v1/admin/compliance/controls?status=compliant')).statusCode,
    ).toBe(422);
    expect(
      (await call('officer', 'GET', '/v1/admin/compliance/controls?applicability=yes')).statusCode,
    ).toBe(422);
  });
  it('maps a control to a feature (security may too); validation, unknown control, replay, uniqueness', async () => {
    const body = {
      controlId: 'CTL-TST-001',
      module: 'tenancy',
      feature: 'forced RLS on org tables',
      evidenceRequirement: 'RLS check result',
    };
    expect((await call('support', 'POST', '/v1/admin/compliance/controls', body)).statusCode).toBe(
      403,
    );
    expect(
      (
        await call('officer', 'POST', '/v1/admin/compliance/controls', {
          ...body,
          module: 'Bad Module',
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await call('officer', 'POST', '/v1/admin/compliance/controls', {
          ...body,
          controlId: 'CTL-NOPE-999',
        })
      ).statusCode,
    ).toBe(404);
    const a = await call('sec', 'POST', '/v1/admin/compliance/controls', body, 'map-1');
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({
      controlId: 'CTL-TST-001',
      module: 'tenancy',
      createdBy: staff.sec!.id,
    });
    const again = await call('sec', 'POST', '/v1/admin/compliance/controls', body, 'map-1');
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(a.json().id);
    const other = await call('officer', 'POST', '/v1/admin/compliance/controls', body); // same triple, another key and person
    expect(other.statusCode).toBe(200);
    expect(other.json().id).toBe(a.json().id);
    expect(
      (
        await call(
          'sec',
          'POST',
          '/v1/admin/compliance/controls',
          { ...body, feature: 'other' },
          'map-1',
        )
      ).statusCode,
    ).toBe(422); // key reuse
    expect(await count(`SELECT count(*) n FROM compliance.control_mappings`)).toBe(1);
    const list = (await call('officer', 'GET', control('CTL-TST-001'))).json().items[0];
    expect(list.status).toBe('mapped');
    expect(list.mappings).toHaveLength(1);
    expect(
      await count(
        `SELECT count(*) n FROM audit.audit_logs WHERE action = 'compliance.control.mapping_changed'`,
      ),
    ).toBe(1);
  });
  it('mappings are append-only; the catalog cannot say compliant and the runtime role cannot write it', async () => {
    await expect(h.env.sql(`UPDATE compliance.control_mappings SET feature = 'x'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(h.env.sql(`DELETE FROM compliance.control_mappings`)).rejects.toThrow(
      /append-only/,
    );
    await expect(
      h.env.sql(
        `UPDATE compliance.control_catalog SET claims_compliance = true WHERE control_id = 'CTL-TST-001'`,
      ),
    ).rejects.toThrow(/claims_compliance/);
    await expect(
      h.env.sql(
        `INSERT INTO compliance.control_catalog (control_id, title, owner_role, implementation, review_cadence_days, source_digest, claims_compliance) VALUES ('CTL-TST-009','t','security','{}',90,repeat('a',64),true)`,
      ),
    ).rejects.toThrow(/claims_compliance/);
    const db = app.get<Db>(DB);
    await expect(
      db.withPlatformScope((c) =>
        c.query(`UPDATE compliance.control_catalog SET title = 'changed'`),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.withPlatformScope((c) => c.query(`DELETE FROM compliance.control_catalog`)),
    ).rejects.toThrow(/permission denied/);
    // outside the admin scope the register is invisible to the runtime role
    expect(
      (await db.withoutScope((c) => c.query(`SELECT 1 FROM compliance.control_catalog`))).rowCount,
    ).toBe(0);
  });
});

describe('evidence', () => {
  const add = (who: string, body: object, key?: string) =>
    call(who, 'POST', '/v1/admin/compliance/evidence', body, key);
  it('a person adds a document, an attestation or an external report; the caller is the named human', async () => {
    expect(
      (await add('support', { controlId: 'CTL-TST-002', type: 'attestation', note: 'x' }))
        .statusCode,
    ).toBe(403);
    const doc = await add('officer', {
      controlId: 'CTL-TST-002',
      type: 'document',
      documentRef: 'dataroom://policies/access-review-q1.pdf',
    });
    expect(doc.statusCode).toBe(201);
    expect(doc.json()).toMatchObject({
      type: 'document',
      source: 'manual',
      attestedBy: staff.officer!.id,
      collector: null,
    });
    expect(doc.json().contentHash).toMatch(/^[0-9a-f]{64}$/);
    const ext = await add('officer', {
      controlId: 'CTL-TST-002',
      type: 'external-report',
      documentRef: 'dataroom://reports/pentest.pdf',
    });
    expect(ext.statusCode).toBe(201);
    const status = async () =>
      (await call('officer', 'GET', control('CTL-TST-002'))).json().items[0];
    expect((await status()).status).toBe('evidence_collected'); // evidence exists, nobody reviewed
    const att = await add('sec', {
      controlId: 'CTL-TST-002',
      type: 'attestation',
      note: 'Reviewed the privileged access list; no exceptions',
    });
    expect(att.statusCode).toBe(201);
    const s = await status();
    expect(s.status).toBe('reviewed');
    expect(s.evidence.latestReview).toMatchObject({
      reviewerRole: 'security',
      attestedBy: staff.sec!.id,
      overdue: false,
    });
    expect(s.evidence.total).toBe(3);
  });
  it('validates: automated type is refused, documents need a reference, attestations a note, nobody attests for someone else', async () => {
    const r = await add('officer', {
      controlId: 'CTL-TST-002',
      type: 'automated',
      documentRef: 'x',
    });
    expect(r.statusCode).toBe(403);
    expect(JSON.stringify(r.json())).toContain('collectors');
    expect((await add('officer', { controlId: 'CTL-TST-002', type: 'document' })).statusCode).toBe(
      422,
    );
    expect(
      (await add('officer', { controlId: 'CTL-TST-002', type: 'attestation' })).statusCode,
    ).toBe(422);
    expect(
      (await add('officer', { controlId: 'CTL-TST-002', type: 'bogus', note: 'x' })).statusCode,
    ).toBe(422);
    expect(
      (
        await add('officer', {
          controlId: 'CTL-TST-002',
          type: 'attestation',
          note: 'x',
          attestedBy: staff.root!.id,
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (await add('officer', { controlId: 'CTL-NOPE-001', type: 'attestation', note: 'x' }))
        .statusCode,
    ).toBe(404);
    expect(
      (await add('officer', { controlId: 'bad', type: 'attestation', note: 'x' })).statusCode,
    ).toBe(422);
  });
  it('replays on the same key and refuses the key with other evidence', async () => {
    const body = {
      controlId: 'CTL-TST-002',
      type: 'document',
      documentRef: 'dataroom://x/replay.pdf',
    };
    const a = await add('officer', body, 'ev-1');
    const b = await add('officer', body, 'ev-1');
    expect([a.statusCode, b.statusCode]).toEqual([201, 200]);
    expect(b.json().id).toBe(a.json().id);
    expect(
      (await add('officer', { ...body, documentRef: 'dataroom://x/other.pdf' }, 'ev-1')).statusCode,
    ).toBe(422);
  });
  it('lists with filters and keysets', async () => {
    const all = await call('sec', 'GET', '/v1/admin/compliance/evidence?limit=2');
    expect(all.json().items).toHaveLength(2);
    expect(all.json().nextCursor).toBeTruthy();
    const next = await call(
      'sec',
      'GET',
      `/v1/admin/compliance/evidence?limit=100&cursor=${all.json().nextCursor}`,
    );
    expect(next.json().items.length).toBeGreaterThan(0);
    expect(
      (
        (await call('sec', 'GET', '/v1/admin/compliance/evidence?type=attestation')).json()
          .items as Row[]
      ).every((x) => x.type === 'attestation'),
    ).toBe(true);
    expect((await call('sec', 'GET', '/v1/admin/compliance/evidence?type=oracle')).statusCode).toBe(
      422,
    );
  });
  it('automated evidence cannot come from the runtime role; the collectors (admin role) write it once per hash; items are immutable', async () => {
    const db = app.get<Db>(DB);
    await expect(
      db.withPlatformScope((c) =>
        c.query(
          `INSERT INTO compliance.evidence_items (id, control_id, type, source, content_hash, collector) VALUES (gen_random_uuid(),'CTL-TST-001','automated','ci',repeat('b',64),'db.ownership-rls-check')`,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    const ins = (hash: string, cols = '') =>
      h.env.sql(
        `INSERT INTO compliance.evidence_items (id, control_id, type, source, content_hash, collector, collector_version ${cols}) VALUES (gen_random_uuid(),'CTL-TST-001','automated','ci',$1,'db.ownership-rls-check','1') ON CONFLICT (control_id, collector, content_hash) WHERE type = 'automated' DO NOTHING RETURNING id`,
        [hash],
      );
    expect(await ins('c'.repeat(64))).toHaveLength(1);
    expect(await ins('c'.repeat(64))).toHaveLength(0); // identical input: no second row (AC-M04-09)
    expect(await ins('d'.repeat(64))).toHaveLength(1);
    const list = (await call('sec', 'GET', control('CTL-TST-001'))).json().items[0];
    expect(list.status).toBe('mapped'.length ? 'evidence_collected' : 'x');
    expect(list.evidence).toMatchObject({ automated: 2 });
    expect(list.evidence.latestAutomated.collector).toBe('db.ownership-rls-check');
    await expect(h.env.sql(`UPDATE compliance.evidence_items SET note = 'x'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(h.env.sql(`DELETE FROM compliance.evidence_items`)).rejects.toThrow(/append-only/);
    await expect(h.env.sql(`TRUNCATE compliance.evidence_items CASCADE`)).rejects.toThrow();
  });
  it('the database refuses automated evidence without a collector or with a person, and manual evidence without one', async () => {
    const row = (type: string, extra: string, vals: string) =>
      h.env.sql(
        `INSERT INTO compliance.evidence_items (id, control_id, type, source, content_hash ${extra}) VALUES (gen_random_uuid(),'CTL-TST-001','${type}','x',repeat('e',64) ${vals})`,
      );
    await expect(row('automated', '', '')).rejects.toThrow(/check/i);
    await expect(
      row('automated', ', collector, attested_by', `, 'a.b-c', '${staff.officer!.id}'`),
    ).rejects.toThrow(/check/i);
    await expect(row('attestation', '', '')).rejects.toThrow(/check/i); // no named human
    await expect(row('document', ', attested_by', `, '${staff.officer!.id}'`)).rejects.toThrow(
      /check/i,
    ); // no document
  });
});

describe('the regulatory validation register', () => {
  const save = (who: string, body: object, key?: string) =>
    call(who, 'POST', '/v1/admin/compliance/regulatory-validations', body, key);
  it('starts with the open questions of docs/10, applicability to_confirm, nothing validated', async () => {
    const r = await call('officer', 'GET', '/v1/admin/compliance/regulatory-validations?limit=100');
    const items = r.json().items as Row[];
    expect(items.length).toBeGreaterThanOrEqual(9);
    for (const x of items)
      expect(x).toMatchObject({
        status: 'open',
        applicability: 'to_confirm',
        version: 1,
        validatedBy: null,
        createdBy: null,
      });
    expect(items.map((x) => x.validationKey)).toEqual(
      expect.arrayContaining(['pdpl-role-and-bases', 'nca-ecc', 'zatca-einvoicing-vat']),
    );
    expect(
      await count(
        `SELECT count(*) n FROM compliance.regulatory_validations WHERE status = 'validated'`,
      ),
    ).toBe(0);
  });
  it('an answer is recorded as a new version; validated needs a document, a decided applicability and a person', async () => {
    expect(
      (
        await save('sec', {
          validationKey: 'nca-ecc',
          status: 'answered',
          answer: 'x',
          baseVersion: 1,
        })
      ).statusCode,
    ).toBe(403); // not the compliance register's maintainer
    expect(
      (await save('officer', { validationKey: 'nca-ecc', status: 'answered', baseVersion: 1 }))
        .statusCode,
    ).toBe(422); // answer needed
    const answered = await save(
      'officer',
      {
        validationKey: 'nca-ecc',
        status: 'answered',
        answer: 'Counsel believes the ECC applies at group level',
        applicability: 'applicable',
        baseVersion: 1,
      },
      'v-1',
    );
    expect(answered.statusCode).toBe(201);
    expect(answered.json()).toMatchObject({
      version: 2,
      status: 'answered',
      createdBy: staff.officer!.id,
      validatedBy: null,
    });
    // validated without evidence: refused by the API with the registered error
    const noDoc = await save('officer', {
      validationKey: 'nca-ecc',
      status: 'validated',
      applicability: 'applicable',
      baseVersion: 2,
    });
    expect(noDoc.statusCode).toBe(422);
    expect(JSON.stringify(noDoc.json())).toContain('validation_requires_evidence');
    const undecided = await save('officer', {
      validationKey: 'nca-ecc',
      status: 'validated',
      documentRef: 'dataroom://counsel/ecc-memo.pdf',
      baseVersion: 2,
    });
    expect(undecided.statusCode).toBe(422);
    expect(JSON.stringify(undecided.json())).toContain('validation_requires_evidence');
    // naming another person as the validator is refused
    expect(
      (
        await save('officer', {
          validationKey: 'nca-ecc',
          status: 'validated',
          applicability: 'applicable',
          documentRef: 'dataroom://counsel/ecc-memo.pdf',
          validatedBy: staff.root!.id,
          baseVersion: 2,
        })
      ).statusCode,
    ).toBe(422);
    const ok = await save('officer', {
      validationKey: 'nca-ecc',
      status: 'validated',
      applicability: 'applicable',
      documentRef: 'dataroom://counsel/ecc-memo.pdf',
      baseVersion: 2,
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({
      version: 3,
      status: 'validated',
      validatedBy: staff.officer!.id,
      documentRef: 'dataroom://counsel/ecc-memo.pdf',
    });
    expect(ok.json().validatedAt).toBeTruthy();
    expect(
      await count(
        `SELECT count(*) n FROM audit.audit_logs WHERE action = 'compliance.validation.changed'`,
      ),
    ).toBe(2);
  });
  it('the database refuses validated without a document or a human, and refuses a person on a version that is not validated', async () => {
    const ins = (status: string, doc: string | null, by: string | null, app = 'applicable') =>
      h.env.sql(
        `INSERT INTO compliance.regulatory_validations (id, validation_key, version, regime, question, applicability, status, document_ref, validated_by, validated_at, answer)
         VALUES (gen_random_uuid(), 'guard-test-' || $1, 1, 'Regime', 'A question long enough', $2, $3, $4, $5, CASE WHEN $5::uuid IS NULL THEN NULL ELSE now() END, 'a')`,
        [
          `${Math.random()}`.slice(2, 8).replace(/\d/g, (d) => 'abcdefghij'[Number(d)]!),
          app,
          status,
          doc,
          by,
        ],
      );
    await expect(ins('validated', null, staff.officer!.id)).rejects.toThrow(/check/i);
    await expect(ins('validated', 'dataroom://x/y.pdf', null)).rejects.toThrow(/check/i);
    await expect(
      ins('validated', 'dataroom://x/y.pdf', staff.officer!.id, 'to_confirm'),
    ).rejects.toThrow(/check/i);
    await expect(ins('answered', null, staff.officer!.id)).rejects.toThrow(/check/i);
    await expect(ins('validated', 'dataroom://x/y.pdf', staff.officer!.id)).resolves.toBeDefined();
    await expect(
      h.env.sql(`UPDATE compliance.regulatory_validations SET status = 'open'`),
    ).rejects.toThrow(/append-only/);
    await expect(h.env.sql(`DELETE FROM compliance.regulatory_validations`)).rejects.toThrow(
      /append-only/,
    );
  });
  it('versions: 409 without the current baseVersion, history, regime fixed, replay, new question', async () => {
    expect(
      (
        await save('officer', {
          validationKey: 'nca-ccc',
          status: 'answered',
          answer: 'a',
          baseVersion: 4,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await save('officer', { validationKey: 'nca-ccc', status: 'answered', answer: 'a' }))
        .statusCode,
    ).toBe(409); // exists: needs baseVersion
    expect(
      (
        await save('officer', {
          validationKey: 'nca-ccc',
          status: 'answered',
          answer: 'a',
          regime: 'Another regime',
          baseVersion: 1,
        })
      ).statusCode,
    ).toBe(422);
    const one = await save(
      'officer',
      {
        validationKey: 'nca-ccc',
        status: 'answered',
        answer: 'Probably a provider',
        baseVersion: 1,
      },
      'rep-1',
    );
    const two = await save(
      'officer',
      {
        validationKey: 'nca-ccc',
        status: 'answered',
        answer: 'Probably a provider',
        baseVersion: 1,
      },
      'rep-1',
    );
    expect([one.statusCode, two.statusCode]).toEqual([201, 200]);
    expect(two.json().id).toBe(one.json().id);
    expect(
      (
        await save(
          'officer',
          { validationKey: 'nca-ccc', status: 'answered', answer: 'different', baseVersion: 1 },
          'rep-1',
        )
      ).statusCode,
    ).toBe(422); // the same key with other content
    const hist = (
      await call(
        'officer',
        'GET',
        '/v1/admin/compliance/regulatory-validations?validationKey=nca-ccc&history=true',
      )
    ).json().items as Row[];
    expect(hist.map((x) => x.version).sort()).toEqual([1, 2]);
    expect(
      (await call('officer', 'GET', '/v1/admin/compliance/regulatory-validations?history=true'))
        .statusCode,
    ).toBe(422);
    const fresh = await save('officer', {
      validationKey: 'new-regime-question',
      regime: 'A new regime',
      question: 'Does this regime apply to Nuzm at all?',
    });
    expect(fresh.statusCode).toBe(201);
    expect(fresh.json()).toMatchObject({ version: 1, status: 'open', applicability: 'to_confirm' });
    expect((await save('officer', { validationKey: 'another-one' })).statusCode).toBe(422); // regime and question needed
    const filtered = (
      await call(
        'officer',
        'GET',
        '/v1/admin/compliance/regulatory-validations?status=validated&limit=100',
      )
    ).json().items as Row[];
    expect(filtered.map((x) => x.validationKey)).toContain('nca-ecc');
    expect(filtered.every((x) => x.status === 'validated')).toBe(true);
  });
});

describe('breach cases', () => {
  const post = (who: string, body: object, key?: string) =>
    call(who, 'POST', '/v1/admin/compliance/breach-cases', body, key);
  let id = '';
  let version = 1;
  const move = async (
    who: string,
    transition: string,
    data?: object,
    note?: string,
    base = version,
  ) => {
    const r = await post(who, {
      caseId: id,
      transition,
      baseVersion: base,
      ...(data ? { data } : {}),
      ...(note ? { note } : {}),
    });
    if (r.statusCode === 200) version = r.json().version;
    return r;
  };
  const detected = new Date(Date.now() - 3_600_000).toISOString();

  it('opens a case: validation, replay, audit, timers, first timeline entry', async () => {
    const body = {
      summary: 'Unusual export of customer records from one organization',
      detectedAt: detected,
      severity: 'high',
      linkedIncidentId: 'INC-2026-0042',
    };
    expect((await post('support', body)).statusCode).toBe(403);
    expect((await post('sec', { ...body, summary: 'short' })).statusCode).toBe(422);
    expect((await post('sec', { ...body, severity: 'urgent' })).statusCode).toBe(422);
    expect(
      (await post('sec', { ...body, detectedAt: new Date(Date.now() + 86_400_000).toISOString() }))
        .statusCode,
    ).toBe(422);
    expect((await post('sec', { ...body, linkedIncidentId: 'has spaces' })).statusCode).toBe(422);
    const a = await post('sec', body, 'open-1');
    expect(a.statusCode).toBe(201);
    id = a.json().id;
    expect(a.json()).toMatchObject({
      state: 'detected',
      severity: 'high',
      version: 1,
      createdBy: staff.sec!.id,
      linkedIncidentId: 'INC-2026-0042',
      assessment: null,
      decision: null,
      closedAt: null,
    });
    expect(a.json().timeline).toHaveLength(1);
    expect(a.json().timers.current).toMatchObject({ step: 'triage', overdue: false });
    const b = await post('sec', body, 'open-1');
    expect([b.statusCode, b.json().id]).toEqual([200, id]);
    expect((await post('sec', { ...body, severity: 'low' }, 'open-1')).statusCode).toBe(422);
    expect(
      await count(
        `SELECT count(*) n FROM audit.audit_logs WHERE action = 'compliance.breach.opened'`,
      ),
    ).toBe(1);
  });
  it('refuses a move that skips a step, an unknown state, a stale version and a missing note', async () => {
    expect((await move('sec', 'assessed', {})).statusCode).toBe(409);
    expect((await move('sec', 'closed', undefined, 'x')).statusCode).toBe(409);
    expect((await move('sec', 'detected')).statusCode).toBe(422);
    expect((await move('sec', 'teleported')).statusCode).toBe(422);
    expect((await move('sec', 'triaged', {}, undefined, 9)).statusCode).toBe(409);
    expect((await post('sec', { caseId: id, transition: 'triaged' })).statusCode).toBe(422); // baseVersion needed
    expect(
      (await post('sec', { caseId: 'nope', transition: 'triaged', baseVersion: 1 })).statusCode,
    ).toBe(422);
    expect(
      (
        await post('sec', {
          caseId: '0192f1c0-7a52-7c3e-9d65-1f0e2a4b5c6d',
          transition: 'triaged',
          baseVersion: 1,
        })
      ).statusCode,
    ).toBe(404);
    expect((await move('sec', 'triaged', { severity: 'urgent' })).statusCode).toBe(422);
  });
  it('triage may raise the severity; an assessment records what was affected and by whom', async () => {
    const t = await move('sec', 'triaged', { severity: 'critical' });
    expect(t.statusCode).toBe(200);
    expect(t.json()).toMatchObject({ state: 'triaged', severity: 'critical', version: 2 });
    expect(
      (await move('sec', 'assessed', { personalDataAffected: true, scope: 'short' })).statusCode,
    ).toBe(422);
    expect(
      (
        await move('sec', 'assessed', {
          personalDataAffected: true,
          scope: 'One export job read 1,200 customer rows',
          dataClasses: [],
        })
      ).statusCode,
    ).toBe(422); // classes needed
    expect(
      (
        await move('sec', 'assessed', {
          personalDataAffected: 'yes',
          scope: 'One export job read 1,200 customer rows',
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await move('sec', 'assessed', {
          personalDataAffected: true,
          scope: 'One export job read 1,200 customer rows',
          dataClasses: ['personal'],
          orgIds: ['nope'],
        })
      ).statusCode,
    ).toBe(422);
    const a = await move('sec', 'assessed', {
      personalDataAffected: true,
      scope: 'One export job read 1,200 customer rows',
      dataClasses: ['personal'],
      regions: ['SA'],
      orgIds: [orgA],
      tables: ['billing.subscriptions'],
    });
    expect(a.statusCode).toBe(200);
    expect(a.json().assessment).toMatchObject({
      personalDataAffected: true,
      dataClasses: ['personal'],
      orgIds: [orgA],
      assessedBy: staff.sec!.id,
    });
  });
  it('the decision about notification is a human decision by someone other than the assessor', async () => {
    const d = {
      notify: true,
      rationale: 'Personal data left the tenant boundary; counsel advised to notify',
      recipients: ['regulator', 'affected customers'],
    };
    expect((await move('sec', 'notification_decision', d)).statusCode).toBe(403); // the assessor cannot decide
    expect(
      (await move('officer', 'notification_decision', { ...d, recipients: [] })).statusCode,
    ).toBe(422); // who, decided by people
    expect(
      (await move('officer', 'notification_decision', { notify: 'maybe', rationale: d.rationale }))
        .statusCode,
    ).toBe(422);
    expect(
      (await move('officer', 'notification_decision', { ...d, rationale: 'x' })).statusCode,
    ).toBe(422);
    const r = await move('officer', 'notification_decision', d);
    expect(r.statusCode).toBe(200);
    expect(r.json().decision).toMatchObject({
      notify: true,
      decidedBy: staff.officer!.id,
      recipients: d.recipients,
    });
  });
  it('a decision to notify cannot skip the record of the notification, and the record is made by a person', async () => {
    expect((await move('officer', 'remediation', undefined, 'Fix the export job')).statusCode).toBe(
      409,
    );
    expect(
      (await move('officer', 'notified', { notifiedAt: new Date().toISOString() })).statusCode,
    ).toBe(422); // reference needed
    expect(
      (await move('officer', 'notified', { notifiedAt: 'soon', reference: 'Letter ref 77' }))
        .statusCode,
    ).toBe(422);
    expect(
      (
        await move('officer', 'notified', {
          notifiedAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
          reference: 'Letter ref 77',
        })
      ).statusCode,
    ).toBe(422);
    const r = await move('officer', 'notified', {
      notifiedAt: new Date().toISOString(),
      reference: 'Letter ref 77 to the regulator',
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().decision.notification).toMatchObject({
      reference: 'Letter ref 77 to the regulator',
      recordedBy: staff.officer!.id,
    });
  });
  it('remediation and closing need a note; a closed case cannot change; the timeline kept every step in order', async () => {
    expect((await move('officer', 'remediation')).statusCode).toBe(422);
    expect(
      (
        await move(
          'officer',
          'remediation',
          undefined,
          'Rotated credentials, disabled the export job, patched the filter',
        )
      ).statusCode,
    ).toBe(200);
    expect((await move('officer', 'closed')).statusCode).toBe(422);
    const closed = await move(
      'officer',
      'closed',
      undefined,
      'Root cause fixed and reviewed; no further exposure found',
    );
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toMatchObject({ state: 'closed', version: 7 });
    expect(closed.json().closedAt).toBeTruthy();
    expect(closed.json().timeline.map((t: Row) => t.to)).toEqual([
      'detected',
      'triaged',
      'assessed',
      'notification_decision',
      'notified',
      'remediation',
      'closed',
    ]);
    expect(closed.json().timers.current).toBeNull();
    expect((await move('officer', 'closed', undefined, 'again')).statusCode).toBe(409);
    await expect(
      h.env.sql(`UPDATE compliance.breach_cases SET severity = 'low' WHERE id = $1`, [id]),
    ).rejects.toThrow(/closed/);
    expect(
      await count(
        `SELECT count(*) n FROM audit.audit_logs WHERE action = 'compliance.breach.transition'`,
      ),
    ).toBe(6);
  });
  it('replaying a move returns the case and does not write again', async () => {
    const r = await post(
      'sec',
      { summary: 'A second case to replay a move on', detectedAt: detected, severity: 'low' },
      'open-2',
    );
    const cid = r.json().id;
    const body = { caseId: cid, transition: 'triaged', baseVersion: 1 };
    const a = await post('sec', body, 'mv-1');
    const b = await post('sec', body, 'mv-1');
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(b.json().version).toBe(2);
    expect(b.json().timeline).toHaveLength(2);
  });
  it('a decision not to notify goes straight to remediation, and notified is refused', async () => {
    const r = await post('sec', {
      summary: 'A case that turned out to hold no personal data',
      detectedAt: detected,
      severity: 'low',
    });
    const cid = r.json().id as string;
    let v = 1;
    const step = async (who: string, to: string, data?: object, note?: string) => {
      const x = await post(who, {
        caseId: cid,
        transition: to,
        baseVersion: v,
        ...(data ? { data } : {}),
        ...(note ? { note } : {}),
      });
      if (x.statusCode === 200) v = x.json().version;
      return x;
    };
    await step('sec', 'triaged');
    await step('sec', 'assessed', {
      personalDataAffected: false,
      scope: 'Only synthetic test data was involved',
    });
    expect(
      (
        await step('officer', 'notification_decision', {
          notify: false,
          rationale: 'No personal data was affected, per the assessment',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await step('officer', 'notified', {
          notifiedAt: new Date().toISOString(),
          reference: 'none at all',
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await step('officer', 'remediation', undefined, 'Add a test that would have caught it'))
        .statusCode,
    ).toBe(200);
  });
  it('the database guard refuses what the service would never do', async () => {
    const r = (
      await post('sec', {
        summary: 'A case to attack the guard with',
        detectedAt: detected,
        severity: 'medium',
      })
    ).json();
    await expect(
      h.env.sql(`UPDATE compliance.breach_cases SET timeline = '[]' WHERE id = $1`, [r.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      h.env.sql(
        `UPDATE compliance.breach_cases SET timeline = jsonb_set(timeline, '{0,note}', '"edited"') WHERE id = $1`,
        [r.id],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      h.env.sql(
        `UPDATE compliance.breach_cases SET state = 'closed', closed_at = now() WHERE id = $1`,
        [r.id],
      ),
    ).rejects.toThrow(/illegal breach case transition/);
    await expect(
      h.env.sql(
        `UPDATE compliance.breach_cases SET summary = 'rewritten history here' WHERE id = $1`,
        [r.id],
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      h.env.sql(`DELETE FROM compliance.breach_cases WHERE id = $1`, [r.id]),
    ).rejects.toThrow(/never deleted/);
    await expect(h.env.sql(`TRUNCATE compliance.breach_cases`)).rejects.toThrow();
  });
  it('lists, filters and shows overdue timers on a fake clock', async () => {
    const all = await call('officer', 'GET', '/v1/admin/compliance/breach-cases?limit=100');
    expect(all.json().items.length).toBeGreaterThanOrEqual(4);
    expect(
      (
        (await call('officer', 'GET', '/v1/admin/compliance/breach-cases?state=closed')).json()
          .items as Row[]
      ).every((x) => x.state === 'closed'),
    ).toBe(true);
    expect(
      (
        (await call('officer', 'GET', '/v1/admin/compliance/breach-cases?severity=critical')).json()
          .items as Row[]
      ).map((x) => x.id),
    ).toContain(id);
    expect(
      (await call('officer', 'GET', '/v1/admin/compliance/breach-cases?state=nope')).statusCode,
    ).toBe(422);
    expect(
      (await call('officer', 'GET', '/v1/admin/compliance/breach-cases?id=nope')).statusCode,
    ).toBe(422);
    const open = (
      await call('officer', 'GET', '/v1/admin/compliance/breach-cases?state=detected&limit=1')
    ).json().items[0];
    const late = new BreachService(
      app.get<Db>(DB),
      app.get(AuditSink),
      loadBreachConfig(),
      () => new Date(Date.now() + 100 * 3_600_000),
    );
    const view = (await late.list({ id: open.id, limit: 1 }, staff.officer!.id)).items[0]!;
    expect(view.timers.current).toMatchObject({ step: 'triage', overdue: true });
  });
  it('the evidence pack reads audit across organizations only with a reason, and is audited with a stable digest', async () => {
    const base = `/v1/admin/compliance/breach-cases?id=${id}&pack=true`;
    expect((await call('officer', 'GET', base)).statusCode).toBe(422); // a reason is required
    expect((await call('officer', 'GET', `${base}&reason=short`)).statusCode).toBe(422);
    expect(
      (
        await call(
          'officer',
          'GET',
          `/v1/admin/compliance/breach-cases?pack=true&reason=${encodeURIComponent('Reviewing the export incident')}`,
        )
      ).statusCode,
    ).toBe(422); // one case
    expect(
      (
        await call(
          'support',
          'GET',
          `${base}&reason=${encodeURIComponent('Reviewing the export incident')}`,
        )
      ).statusCode,
    ).toBe(403);
    const reason = encodeURIComponent('Reviewing the export incident for the counsel pack');
    const a = await call('officer', 'GET', `${base}&reason=${reason}`);
    expect(a.statusCode).toBe(200);
    const pack = a.json().items[0].evidencePack;
    expect(pack).toMatchObject({ case: { id, state: 'closed' }, window: { lookbackHours: 24 } });
    expect(pack.timeline).toHaveLength(7);
    expect(pack.organizations).toHaveLength(1);
    expect(pack.organizations[0].orgId).toBe(orgA);
    expect(pack.organizations[0].activity.length).toBeGreaterThan(0); // the organization's own audit trail (its creation)
    expect(pack.tables).toEqual(['billing.subscriptions']);
    expect(pack.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(pack.note).toMatch(/notifies no regulator/);
    const b = await call('officer', 'GET', `${base}&reason=${reason}`);
    expect(b.json().items[0].evidencePack.digest).toBe(pack.digest); // same input, same digest
    const logged = await h.env.sql(
      `SELECT detail FROM audit.audit_logs WHERE action = 'compliance.breach.evidence_pack' ORDER BY chain_seq`,
    );
    expect(logged).toHaveLength(2);
    expect(logged[0]!.detail).toMatchObject({
      reason: 'Reviewing the export incident for the counsel pack',
      organizations: 1,
      digest: pack.digest,
    });
  });
});
