import { randomUUID } from 'node:crypto';
import {
  hashPassword,
  MIN_PASSWORD_LENGTH,
  readSession,
  signToken,
  verifyPassword,
} from './auth.ts';
import { withTenant } from './tenant.ts';
import { MAX_CSV_ROWS, parseCsv, toCsv } from './csv.ts';
import { HttpError, Router } from './http.ts';
import type { AppRequest, AppResponse } from './http.ts';
import type {
  AppMeta,
  AuditEntry,
  EntityMeta,
  Filter,
  ListQuery,
  Notifier,
  Row,
  Scope,
  SessionUser,
  Store,
  UserRow,
} from './types.ts';
import { isUuid, validateInput } from './validation.ts';

export interface EngineDeps {
  meta: AppMeta;
  store: Store;
  notifier: Notifier;
  sessionSecret: string;
  now?: () => number;
  sessionTtlSeconds?: number;
}

/** Builds the API of the generated application from its metadata: authentication, RBAC with row-level scope, CRUD, search/filter/sort/pagination, board, dashboard, CSV, audit trail. */
export function buildRouter(deps: EngineDeps): Router {
  const { meta, store, notifier } = deps;
  const now = deps.now ?? Date.now;
  const ttl = deps.sessionTtlSeconds ?? 8 * 3600;
  const failures = new Map<string, number[]>();
  const signups: number[] = [];
  const multi = meta.auth?.tenancy === 'multi';
  const signupRole = meta.auth?.signupRole ?? null;
  if (signupRole !== null) {
    const r = meta.roles[signupRole];
    if (!r) throw new Error('signupRole is not a role of the application');
    if (!multi && r.admin)
      throw new Error('signupRole must not be an administrator role of a single-tenant app');
  }
  // a hash to verify against when the e-mail is unknown, so that the response time does not reveal whether an account exists
  const dummyHash = hashPassword('not-a-real-password-' + randomUUID());

  const toSession = (u: UserRow): SessionUser => ({
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    teamId: u.teamId,
    ...(multi ? { tenantId: u.tenantId ?? null } : {}),
    locale: u.locale,
  });
  const router = new Router(async (headers) => {
    const h = headers['authorization'] ?? '';
    if (!h.startsWith('Bearer ')) return null;
    const session = readSession(deps.sessionSecret, h.slice(7), now());
    if (!session) return null;
    if (session.jti !== null && (await store.isSessionRevoked(session.jti))) return null;
    const u = await store.getUser(session.uid);
    if (!u || !u.active) return null;
    if (multi && !u.tenantId) return null; // a user without a tenant has no data and no access
    return toSession(u);
  });
  // multi-tenant: the tenant of every authenticated request comes from the verified user row, never from the request
  if (multi) router.setContext((user, run) => withTenant(user.tenantId as string, run));

  const can = (u: SessionUser, entity: string, action: string): boolean =>
    (meta.roles[u.role]?.permissions[entity] ?? []).includes(action);
  const need = (u: SessionUser, entity: string, action: string): void => {
    if (!can(u, entity, action))
      throw new HttpError(403, 'forbidden', 'Your role may not ' + action + ' ' + entity);
  };
  const isAdmin = (u: SessionUser): boolean => meta.roles[u.role]?.admin === true;
  /** Row-level rule: the scope of the role, applied to entities that are not organisation-wide. */
  const scopeFor = (u: SessionUser, em: EntityMeta): Scope => {
    const role = meta.roles[u.role];
    if (!role || em.ownership === 'org' || role.scope === 'all')
      return { ownerId: null, teamId: null };
    if (role.scope === 'team')
      return { ownerId: u.id, teamId: u.teamId ?? '00000000-0000-0000-0000-000000000000' };
    return { ownerId: u.id, teamId: null };
  };
  const visible = (r: Row, s: Scope): boolean =>
    (s.ownerId === null && s.teamId === null) ||
    (s.ownerId !== null && r['ownerId'] === s.ownerId) ||
    (s.teamId !== null && r['teamId'] === s.teamId);
  const publicRow = (r: Row): Row => r;
  const maskDiff = (em: EntityMeta, d: Record<string, unknown>): Record<string, unknown> => {
    // personal fields are redacted in every shape of diff: {after:{f:v}}, {before:{f:v}}, {changes:{f:{from,to}}}
    const pii = new Set(em.fields.filter((f) => f.pii).map((f) => f.name));
    const out: Record<string, unknown> = {};
    for (const [section, body] of Object.entries(d)) {
      if (typeof body !== 'object' || body === null) {
        out[section] = body;
        continue;
      }
      const inner: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(body as Record<string, unknown>))
        inner[k] = pii.has(k) ? '[redacted]' : v;
      out[section] = inner;
    }
    return out;
  };
  const writeAudit = async (
    em: EntityMeta,
    recordId: string,
    action: AuditEntry['action'],
    actor: string | null,
    diff: Record<string, unknown>,
  ): Promise<void> => {
    if (!em.audit) return;
    await store.appendAudit({
      id: randomUUID(),
      entity: em.name,
      recordId,
      action,
      actorId: actor,
      diff: maskDiff(em, diff),
      at: new Date(now()).toISOString(),
    });
  };
  const storeError = (e: unknown): never => {
    const err = e as { code?: string; field?: string };
    if (err.code === 'unique')
      throw new HttpError(409, 'duplicate', 'A record with this value already exists', [
        { field: err.field ?? '$', message: 'must be unique' },
      ]);
    if (err.code === 'reference')
      throw new HttpError(422, 'validation_failed', 'A referenced record does not exist', [
        { field: err.field ?? '$', message: 'refers to a record that does not exist' },
      ]);
    if (err.code === 'in_use')
      throw new HttpError(409, 'in_use', 'The record is referenced by other records');
    throw e;
  };
  const notifyAssignment = async (
    em: EntityMeta,
    row: Row,
    actor: SessionUser,
    previousOwner: string | null,
  ): Promise<void> => {
    const rule = meta.notifications.find((n) => n.event === 'assignment' && n.channel === 'email');
    const owner = row['ownerId'] as string | null;
    if (!rule || !owner || owner === actor.id || owner === previousOwner) return;
    const u = await store.getUser(owner);
    if (u)
      await notifier
        .send({
          to: u.email,
          template: rule.template,
          data: { entity: em.name, recordId: row.id, assignedBy: actor.name },
        })
        .catch(() => undefined);
  };
  const checkReferenceScope = async (
    em: EntityMeta,
    values: Record<string, unknown>,
    u: SessionUser,
  ): Promise<void> => {
    // a reference may only point at a record the caller can see (no linking to hidden records)
    for (const f of em.fields) {
      const v = values[f.name];
      if (f.type !== 'reference' || typeof v !== 'string' || !f.references) continue;
      const target = meta.entities[f.references];
      const r = target ? await store.get(f.references, v) : null;
      if (!r || !target || !visible(r, scopeFor(u, target)))
        throw new HttpError(422, 'validation_failed', 'A referenced record does not exist', [
          { field: f.name, message: 'refers to a record that does not exist' },
        ]);
    }
  };
  const parseOwner = async (
    u: SessionUser,
    em: EntityMeta,
    requested: unknown,
  ): Promise<{ ownerId: string; teamId: string | null }> => {
    if (requested === undefined || requested === null || requested === u.id)
      return { ownerId: u.id, teamId: u.teamId };
    if (!isUuid(requested))
      throw new HttpError(422, 'validation_failed', 'ownerId must be an id', [
        { field: 'ownerId', message: 'must be an id' },
      ]);
    if (meta.roles[u.role]?.scope === 'own' && em.ownership !== 'org')
      throw new HttpError(403, 'forbidden', 'Your role may only own its own records');
    const found = await store.getUser(requested);
    // multi-tenant: a user of another tenant is indistinguishable from no user
    const target = found && (!multi || found.tenantId === u.tenantId) ? found : null;
    if (!target || !target.active)
      throw new HttpError(422, 'validation_failed', 'ownerId is not a user', [
        { field: 'ownerId', message: 'is not a user' },
      ]);
    if (meta.roles[u.role]?.scope === 'team' && target.teamId !== u.teamId)
      throw new HttpError(403, 'forbidden', 'A manager may only assign within the team');
    return { ownerId: target.id, teamId: target.teamId };
  };

  // ---- health and authentication ----
  router.add('GET', '/health', async () => ({ status: 200, body: { status: 'ok' } }), true);

  router.add(
    'POST',
    meta.basePath + '/auth/login',
    async (req) => {
      const b = (req.body ?? {}) as { email?: unknown; password?: unknown };
      if (typeof b.email !== 'string' || typeof b.password !== 'string')
        throw new HttpError(422, 'validation_failed', 'email and password are required');
      const key = b.email.toLowerCase();
      const recent = (failures.get(key) ?? []).filter((t) => now() - t < 60_000);
      if (recent.length >= 5)
        throw new HttpError(429, 'rate_limited', 'Too many attempts; try again in a minute');
      const u = await store.findUserByEmail(key);
      const ok =
        u !== null
          ? u.active && (await verifyPassword(b.password, u.passwordHash))
          : (await verifyPassword(b.password, await dummyHash)) && false;
      if (!ok || !u) {
        recent.push(now());
        failures.set(key, recent);
        throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect');
      }
      failures.delete(key);
      return {
        status: 200,
        body: { token: signToken(deps.sessionSecret, u.id, ttl, now()), user: toSession(u) },
      };
    },
    true,
  );
  router.add('GET', meta.basePath + '/auth/me', async (req) => ({
    status: 200,
    body: {
      user: req.user,
      permissions: meta.roles[(req.user as SessionUser).role]?.permissions ?? {},
    },
  }));
  router.add('POST', meta.basePath + '/auth/logout', async (req) => {
    // the session id is revoked server-side: the token stops working at once, not at its expiry
    const h = req.headers['authorization'] ?? '';
    const session = h.startsWith('Bearer ')
      ? readSession(deps.sessionSecret, h.slice(7), now())
      : null;
    if (session?.jti) await store.revokeSession(session.jti, session.exp);
    return { status: 204 };
  });
  if (signupRole !== null)
    router.add(
      'POST',
      meta.basePath + '/auth/signup',
      async (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const errors: { field: string; message: string }[] = [];
        if (
          typeof b['email'] !== 'string' ||
          !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b['email']) ||
          b['email'].length > 254
        )
          errors.push({ field: 'email', message: 'must be an email address' });
        if (typeof b['name'] !== 'string' || b['name'].trim() === '' || b['name'].length > 120)
          errors.push({ field: 'name', message: 'is required' });
        if (typeof b['password'] !== 'string' || b['password'].length < MIN_PASSWORD_LENGTH)
          errors.push({
            field: 'password',
            message: 'must be at least ' + MIN_PASSWORD_LENGTH + ' characters',
          });
        else if (b['password'].length > 200)
          errors.push({ field: 'password', message: 'is too long' });
        if (
          multi &&
          (typeof b['organization'] !== 'string' ||
            b['organization'].trim() === '' ||
            b['organization'].length > 120)
        )
          errors.push({ field: 'organization', message: 'is required' });
        if (errors.length)
          throw new HttpError(422, 'validation_failed', 'The sign-up is invalid', errors);
        // sign-up is public: it is rate limited as a whole (script-driven account creation) and each address is checked for duplicates below
        const recent = signups.filter((t) => now() - t < 60_000);
        signups.length = 0;
        signups.push(...recent);
        if (recent.length >= 20)
          throw new HttpError(429, 'rate_limited', 'Too many sign-ups; try again in a minute');
        signups.push(now());
        const email = (b['email'] as string).toLowerCase();
        if (await store.findUserByEmail(email))
          throw new HttpError(409, 'duplicate', 'A record with this value already exists', [
            { field: 'email', message: 'must be unique' },
          ]);
        let tenantId: string | null = null;
        if (multi) {
          tenantId = randomUUID();
          await store.insertTenant({
            id: tenantId,
            name: (b['organization'] as string).trim(),
            createdAt: new Date(now()).toISOString(),
          });
        }
        try {
          const row = await store.insertUser({
            id: randomUUID(),
            email,
            name: (b['name'] as string).trim(),
            role: signupRole,
            teamId: null,
            ...(multi ? { tenantId } : {}),
            locale: b['locale'] === 'en' ? 'en' : 'ar',
            passwordHash: await hashPassword(b['password'] as string),
            active: true,
            createdAt: new Date(now()).toISOString(),
          });
          return {
            status: 201,
            body: {
              token: signToken(deps.sessionSecret, row.id, ttl, now()),
              user: toSession(row),
            },
          };
        } catch (e) {
          return storeError(e);
        }
      },
      true,
    );

  // ---- users (administrators) ----
  router.add('GET', meta.basePath + '/users', async (req) => {
    const u = req.user as SessionUser;
    const list = await store.listUsers();
    const items = (
      isAdmin(u) ? list : list.filter((x) => x.teamId === u.teamId || x.id === u.id)
    ).map((x) => ({
      id: x.id,
      email: x.email,
      name: x.name,
      role: x.role,
      teamId: x.teamId,
      active: x.active,
    }));
    return { status: 200, body: { items } };
  });
  router.add('POST', meta.basePath + '/users', async (req) => {
    const u = req.user as SessionUser;
    if (!isAdmin(u))
      throw new HttpError(403, 'forbidden', 'Only an administrator may create users');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const errors: { field: string; message: string }[] = [];
    if (typeof b['email'] !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b['email']))
      errors.push({ field: 'email', message: 'must be an email address' });
    if (typeof b['name'] !== 'string' || b['name'].trim() === '' || b['name'].length > 120)
      errors.push({ field: 'name', message: 'is required' });
    if (typeof b['role'] !== 'string' || !meta.roles[b['role']])
      errors.push({
        field: 'role',
        message: 'must be one of ' + Object.keys(meta.roles).join(', '),
      });
    if (typeof b['password'] !== 'string' || b['password'].length < MIN_PASSWORD_LENGTH)
      errors.push({
        field: 'password',
        message: 'must be at least ' + MIN_PASSWORD_LENGTH + ' characters',
      });
    if (b['teamId'] !== undefined && b['teamId'] !== null && !isUuid(b['teamId']))
      errors.push({ field: 'teamId', message: 'must be an id' });
    if (errors.length) throw new HttpError(422, 'validation_failed', 'The user is invalid', errors);
    try {
      const row = await store.insertUser({
        id: randomUUID(),
        email: (b['email'] as string).toLowerCase(),
        name: (b['name'] as string).trim(),
        role: b['role'] as string,
        teamId: (b['teamId'] as string | null | undefined) ?? null,
        // an administrator creates users in THEIR OWN tenant only
        ...(multi ? { tenantId: u.tenantId ?? null } : {}),
        locale: b['locale'] === 'en' ? 'en' : 'ar',
        passwordHash: await hashPassword(b['password'] as string),
        active: true,
        createdAt: new Date(now()).toISOString(),
      });
      return {
        status: 201,
        body: {
          id: row.id,
          email: row.email,
          name: row.name,
          role: row.role,
          teamId: row.teamId,
          active: row.active,
        },
      };
    } catch (e) {
      return storeError(e);
    }
  });

  // ---- dashboard ----
  router.add('GET', meta.basePath + '/dashboard', async (req) => {
    const u = req.user as SessionUser;
    const out: Record<string, unknown> = {};
    for (const page of meta.pages)
      for (const w of page.widgets) {
        const em = meta.entities[w.entity];
        if (!em || !can(u, em.name, 'read') || (page.roles && !page.roles.includes(u.role)))
          continue;
        const scope = scopeFor(u, em);
        if (w.kind === 'count')
          out[w.id] = (
            await store.list(em.name, {
              filters: [],
              search: null,
              searchFields: [],
              sort: null,
              limit: 1,
              offset: 0,
              scope,
            })
          ).total;
        else if (w.kind === 'sum' && w.field) out[w.id] = await store.sum(em.name, w.field, scope);
        else if (w.kind === 'by_stage' && em.stageField)
          out[w.id] = await store.groupCount(em.name, em.stageField, scope);
        else if (w.kind === 'recent')
          out[w.id] = (
            await store.list(em.name, {
              filters: [],
              search: null,
              searchFields: [],
              sort: { field: 'createdAt', dir: 'desc' },
              limit: 5,
              offset: 0,
              scope,
            })
          ).rows.map(publicRow);
      }
    return { status: 200, body: { widgets: out } };
  });

  // ---- entities ----
  for (const em of Object.values(meta.entities)) {
    const base = meta.basePath + '/' + em.plural;
    const fieldByName = new Map(em.fields.map((f) => [f.name, f]));

    const parseList = (req: AppRequest, u: SessionUser): ListQuery => {
      const filters: Filter[] = [];
      for (const [k, v] of req.query.entries()) {
        if (!k.startsWith('filter.')) continue;
        const [name, op] = k.slice(7).split('.') as [string, string | undefined];
        const f = fieldByName.get(name);
        if (!f || f.type === 'file')
          throw new HttpError(422, 'invalid_filter', 'Unknown filter field ' + name);
        const operator =
          op ??
          (f.type === 'string' ||
          f.type === 'text' ||
          f.type === 'email' ||
          f.type === 'phone' ||
          f.type === 'url'
            ? 'contains'
            : 'eq');
        if (!['eq', 'contains', 'gte', 'lte'].includes(operator))
          throw new HttpError(422, 'invalid_filter', 'Unknown filter operator ' + operator);
        if (v.length > 200)
          throw new HttpError(422, 'invalid_filter', 'The filter value is too long');
        filters.push({ field: name, op: operator as Filter['op'], value: v });
      }
      let sort: ListQuery['sort'] = null;
      const s = req.query.get('sort');
      if (s) {
        const [field, dir] = s.split(':') as [string, string | undefined];
        if (!em.sortable.includes(field) && field !== 'createdAt' && field !== 'updatedAt')
          throw new HttpError(422, 'invalid_sort', 'Cannot sort by ' + field);
        sort = { field, dir: dir === 'asc' ? 'asc' : 'desc' };
      }
      const lim = Number(req.query.get('limit') ?? meta.defaultLimit);
      const off = Number(req.query.get('offset') ?? 0);
      if (
        !Number.isInteger(lim) ||
        lim < 1 ||
        lim > meta.maxLimit ||
        !Number.isInteger(off) ||
        off < 0
      )
        throw new HttpError(
          422,
          'invalid_page',
          'limit must be 1..' + meta.maxLimit + ' and offset 0 or more',
        );
      return {
        filters,
        search: req.query.get('search')?.slice(0, 100) || null,
        searchFields: em.searchable,
        sort,
        limit: lim,
        offset: off,
        scope: scopeFor(u, em),
      };
    };

    router.add('GET', base, async (req) => {
      const u = req.user as SessionUser;
      need(u, em.name, 'read');
      const q = parseList(req, u);
      const r = await store.list(em.name, q);
      return {
        status: 200,
        body: { items: r.rows.map(publicRow), total: r.total, limit: q.limit, offset: q.offset },
      };
    });

    router.add('GET', base + '/board', async (req) => {
      const u = req.user as SessionUser;
      need(u, em.name, 'read');
      const sf = em.stageField ? fieldByName.get(em.stageField) : undefined;
      if (!sf) throw new HttpError(404, 'not_found', 'This entity has no pipeline');
      const scope = scopeFor(u, em);
      const columns: Record<string, { items: Row[]; total: number }> = {};
      for (const stage of sf.enumValues ?? []) {
        const r = await store.list(em.name, {
          filters: [{ field: sf.name, op: 'eq', value: stage }],
          search: null,
          searchFields: [],
          sort: { field: 'updatedAt', dir: 'desc' },
          limit: 50,
          offset: 0,
          scope,
        });
        columns[stage] = { items: r.rows.map(publicRow), total: r.total };
      }
      return { status: 200, body: { stageField: sf.name, stages: sf.enumValues, columns } };
    });

    if (meta.csvImportExport) {
      router.add('GET', base + '/export.csv', async (req) => {
        const u = req.user as SessionUser;
        need(u, em.name, 'export');
        const q = { ...parseList(req, u), limit: MAX_CSV_ROWS, offset: 0 };
        const r = await store.list(em.name, q);
        const cols = em.fields.filter((f) => f.type !== 'file').map((f) => f.name);
        return {
          status: 200,
          text: toCsv(['id', ...cols], r.rows as Record<string, unknown>[]),
          contentType: 'text/csv; charset=utf-8',
          headers: { 'content-disposition': 'attachment; filename="' + em.plural + '.csv"' },
        };
      });
      router.add('POST', base + '/import', async (req) => {
        const u = req.user as SessionUser;
        need(u, em.name, 'import');
        let table: string[][];
        try {
          table = parseCsv(req.rawBody);
        } catch (e) {
          throw new HttpError(422, 'invalid_csv', (e as Error).message);
        }
        const header = (table[0] ?? []).map((h) => h.trim());
        const unknown = header.filter((h) => h !== 'ownerId' && !fieldByName.has(h));
        if (header.length === 0 || unknown.length)
          throw new HttpError(422, 'invalid_csv', 'Unknown column(s): ' + unknown.join(', '));
        const dry = req.query.get('dryRun') === 'true';
        const report: { row: number; errors: { field: string; message: string }[] }[] = [];
        const accepted: { values: Record<string, unknown>; ownerId: string | undefined }[] = [];
        for (let i = 1; i < table.length; i++) {
          const raw: Record<string, unknown> = {};
          (table[i] as string[]).forEach((cell, j) => {
            const key = header[j];
            if (key !== undefined && cell !== '')
              raw[key] = fieldByName.get(key)?.type === 'boolean' ? cell === 'true' : cell;
          });
          const v = validateInput(em, { ...raw, ownerId: undefined }, 'create', 0);
          if (v.errors.length) report.push({ row: i + 1, errors: v.errors });
          else accepted.push({ values: v.values, ownerId: raw['ownerId'] as string | undefined });
        }
        let imported = 0;
        if (!dry && report.length === 0) {
          for (const a of accepted) {
            const o = await parseOwner(u, em, a.ownerId);
            await checkReferenceScope(em, a.values, u);
            const ts = new Date(now()).toISOString();
            let row: Row;
            try {
              row = await store.insert(em.name, {
                id: randomUUID(),
                ownerId: o.ownerId,
                teamId: o.teamId,
                createdAt: ts,
                updatedAt: ts,
                createdBy: u.id,
                updatedBy: u.id,
                version: 1,
                ...Object.fromEntries(em.fields.map((f) => [f.name, null])),
                ...a.values,
              } as Row);
            } catch (e) {
              return storeError(e);
            }
            await writeAudit(em, row.id, 'import', u.id, { after: a.values });
            imported++;
          }
        }
        return {
          status: report.length ? 422 : 200,
          body: { imported, dryRun: dry, accepted: accepted.length, errors: report },
        };
      });
    }

    router.add('POST', base, async (req) => {
      const u = req.user as SessionUser;
      need(u, em.name, 'create');
      const v = validateInput(em, req.body, 'create', meta.attachmentMaxBytes);
      if (v.errors.length)
        throw new HttpError(422, 'validation_failed', 'The record is invalid', v.errors);
      const o = await parseOwner(u, em, (req.body as Record<string, unknown>)['ownerId']);
      await checkReferenceScope(em, v.values, u);
      const ts = new Date(now()).toISOString();
      const base0 = Object.fromEntries(em.fields.map((f) => [f.name, null]));
      const fileVals = Object.fromEntries(Object.entries(v.files).map(([k, f]) => [k, f]));
      let row: Row;
      try {
        row = await store.insert(em.name, {
          id: randomUUID(),
          ownerId: o.ownerId,
          teamId: o.teamId,
          createdAt: ts,
          updatedAt: ts,
          createdBy: u.id,
          updatedBy: u.id,
          version: 1,
          ...base0,
          ...v.values,
          ...fileVals,
        } as Row);
      } catch (e) {
        return storeError(e);
      }
      await writeAudit(em, row.id, 'create', u.id, { after: v.values });
      await notifyAssignment(em, row, u, null);
      return {
        status: 201,
        body: publicRow(row),
        headers: { etag: '"' + String(row['version']) + '"', location: base + '/' + row.id },
      };
    });

    router.add('GET', base + '/:id', async (req) => {
      const u = req.user as SessionUser;
      need(u, em.name, 'read');
      const id = req.params['id'] as string;
      const row = isUuid(id) ? await store.get(em.name, id) : null;
      if (!row || !visible(row, scopeFor(u, em)))
        throw new HttpError(404, 'not_found', 'Not found');
      return {
        status: 200,
        body: publicRow(row),
        headers: { etag: '"' + String(row['version']) + '"' },
      };
    });

    router.add('PATCH', base + '/:id', async (req) => {
      const u = req.user as SessionUser;
      need(u, em.name, 'update');
      const id = req.params['id'] as string;
      const cur = isUuid(id) ? await store.get(em.name, id) : null;
      if (!cur || !visible(cur, scopeFor(u, em)))
        throw new HttpError(404, 'not_found', 'Not found');
      const v = validateInput(em, req.body, 'update', meta.attachmentMaxBytes);
      if (v.errors.length)
        throw new HttpError(422, 'validation_failed', 'The record is invalid', v.errors);
      const bodyObj = req.body as Record<string, unknown>;
      const ifMatch = req.headers['if-match'];
      const expected = ifMatch
        ? Number(ifMatch.replace(/"/g, ''))
        : typeof bodyObj['version'] === 'number'
          ? (bodyObj['version'] as number)
          : null;
      if (expected !== null && !Number.isInteger(expected))
        throw new HttpError(422, 'validation_failed', 'If-Match must be a version');
      await checkReferenceScope(em, v.values, u);
      const patch: Record<string, unknown> = {
        ...v.values,
        ...Object.fromEntries(Object.entries(v.files)),
        updatedBy: u.id,
      };
      let prevOwner: string | null = null;
      if (bodyObj['ownerId'] !== undefined) {
        const o = await parseOwner(u, em, bodyObj['ownerId']);
        prevOwner = cur['ownerId'] as string | null;
        patch['ownerId'] = o.ownerId;
        patch['teamId'] = o.teamId;
      }
      let r: Row | 'conflict' | null;
      try {
        r = await store.update(em.name, id, patch, expected);
      } catch (e) {
        return storeError(e);
      }
      if (r === 'conflict')
        throw new HttpError(
          409,
          'version_conflict',
          'The record was changed by someone else; reload it',
        );
      if (!r) throw new HttpError(404, 'not_found', 'Not found');
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const k of Object.keys(v.values))
        if (JSON.stringify(cur[k]) !== JSON.stringify(r[k]))
          changes[k] = { from: cur[k], to: r[k] };
      if (patch['ownerId'] !== undefined && cur['ownerId'] !== r['ownerId'])
        changes['ownerId'] = { from: cur['ownerId'], to: r['ownerId'] };
      await writeAudit(em, id, 'update', u.id, { changes });
      if (patch['ownerId'] !== undefined) await notifyAssignment(em, r, u, prevOwner);
      return {
        status: 200,
        body: publicRow(r),
        headers: { etag: '"' + String(r['version']) + '"' },
      };
    });

    router.add('DELETE', base + '/:id', async (req) => {
      const u = req.user as SessionUser;
      need(u, em.name, 'delete');
      const id = req.params['id'] as string;
      const cur = isUuid(id) ? await store.get(em.name, id) : null;
      if (!cur || !visible(cur, scopeFor(u, em)))
        throw new HttpError(404, 'not_found', 'Not found');
      try {
        await store.remove(em.name, id);
      } catch (e) {
        return storeError(e);
      }
      await writeAudit(em, id, 'delete', u.id, {
        before: Object.fromEntries(
          em.fields.filter((f) => f.type !== 'file').map((f) => [f.name, cur[f.name]]),
        ),
      });
      return { status: 204 };
    });

    router.add('GET', base + '/:id/audit', async (req) => {
      const u = req.user as SessionUser;
      need(u, em.name, 'read');
      const id = req.params['id'] as string;
      const row = isUuid(id) ? await store.get(em.name, id) : null;
      const entries = isUuid(id) ? await store.listAudit(em.name, id) : [];
      if (!visible(row ?? ({ id: '', ownerId: null, teamId: null } as Row), scopeFor(u, em)) && row)
        throw new HttpError(404, 'not_found', 'Not found');
      if (!row && entries.length === 0) throw new HttpError(404, 'not_found', 'Not found');
      if (!row) {
        // a deleted record: only an administrator-scoped role may read its trail
        if (meta.roles[u.role]?.scope !== 'all') throw new HttpError(404, 'not_found', 'Not found');
      }
      return { status: 200, body: { items: entries } };
    });

    for (const f of em.fields.filter((x) => x.type === 'file'))
      router.add('GET', base + '/:id/files/' + f.name, async (req): Promise<AppResponse> => {
        const u = req.user as SessionUser;
        need(u, em.name, 'read');
        const id = req.params['id'] as string;
        const row = isUuid(id) ? await store.get(em.name, id) : null;
        const meta0 = row?.[f.name] as { name: string; mime: string } | null | undefined;
        if (!row || !meta0 || !visible(row, scopeFor(u, em)))
          throw new HttpError(404, 'not_found', 'Not found');
        const data = await store.fileData(em.name, id, f.name);
        if (!data) throw new HttpError(404, 'not_found', 'Not found');
        // user-supplied types are never rendered inline: always a download, never sniffed
        return {
          status: 200,
          bytes: data,
          contentType: 'application/octet-stream',
          headers: {
            'content-disposition':
              'attachment; filename="' + meta0.name.replace(/[^A-Za-z0-9._ -]/g, '_') + '"',
          },
        };
      });
  }
  return router;
}
