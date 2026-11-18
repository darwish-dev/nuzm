import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DnsRecordData, FaultKind, FaultOp, RegistrarControls } from './mock-types';

/**
 * Local mock of the Openprovider REST API as documented in docs/adapters/openprovider.md (NOT VERIFIED: shaped from the documentation, never from a real
 * response). It exists to test OUR adapter and gating logic; its results can never produce a vendor-evidence PASS (HG-07-01).
 */
type Obj = Record<string, unknown>;
interface Dom {
  id: number;
  name: string;
  ext: string;
  status: 'ACT' | 'REQ';
  comments: string;
  owner: string;
  ns: string[];
  locked: boolean;
  autorenew: string;
  renewal: number;
  privacy: boolean;
}
const TLDS: Record<
  string,
  { create: number; renew: number; transfer: number; restrictions: string[] }
> = {
  com: { create: 8.99, renew: 10.49, transfer: 8.5, restrictions: [] },
  net: { create: 10.5, renew: 12.25, transfer: 10, restrictions: [] },
  org: { create: 9.75, renew: 11.2, transfer: 9.5, restrictions: [] },
  ae: { create: 25, renew: 27, transfer: 25, restrictions: ['local presence required'] },
};

export interface OpenproviderMock {
  url: string;
  controls: RegistrarControls & {
    holdRegistrations(v: boolean): void;
    dnsFailFrom(k: number | null): void;
    activate(name: string): void;
    webhookBody(type: string, id: string, domain: string, at: Date): string;
  };
  credentials: { username: string; password: string };
  webhookSecret: string;
  close(): Promise<void>;
}

export async function startOpenproviderMock(): Promise<OpenproviderMock> {
  const credentials = { username: 'mock-user', password: 'mock-password-value' };
  const webhookSecret = 'mock-webhook-secret-value';
  const tokens = new Set<string>();
  const doms = new Map<number, Dom>();
  const customers = new Set<string>();
  const taken = new Set<string>();
  const zones = new Map<string, Obj[]>();
  const txs: Obj[] = [];
  const bodies: string[] = [];
  const faults: { op: FaultOp; kind: FaultKind; left: number }[] = [];
  let failLogins = 0;
  let nextId = 1000;
  let nextHandle = 1;
  let dnsFailAt: number | null = null;
  let dnsCalls = 0;
  let hold = false;
  let dnsFailFrom: number | null = null;

  const takeFault = (op: FaultOp): FaultKind | null => {
    const f = faults.find((x) => x.op === op && x.left > 0);
    if (!f) return null;
    f.left--;
    return f.kind;
  };
  const ok = (data: unknown) => ({ code: 0, data, desc: '', maintenance: false, warnings: [] });
  const err = (code: number, desc: string) => ({
    code,
    data: '',
    desc,
    maintenance: code === 4005,
    warnings: [],
  });
  const iso = (ms: number) => new Date(ms).toISOString();
  const view = (d: Dom): Obj => ({
    id: d.id,
    domain: { name: d.name, extension: d.ext },
    status: d.status,
    comments: d.comments,
    owner_handle: d.owner,
    name_servers: d.ns.map((n, i) => ({ name: n, seq_nr: i + 1 })),
    is_locked: d.locked,
    autorenew: d.autorenew,
    renewal_date: iso(d.renewal),
    expiration_date: iso(d.renewal),
    is_private_whois_allowed: true,
    is_private_whois_enabled: d.privacy,
  });
  const full = (d: Dom) => `${d.name}.${d.ext}`;
  const addTx = (action: string, d: Dom, price: number) =>
    txs.push({
      action,
      type: 'domain',
      subject: full(d),
      creation_date: new Date().toISOString(),
      reference_id: d.id,
      total: { reseller: { currency: 'EUR', price } },
    });

  const read = (req: IncomingMessage) =>
    new Promise<string>((res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
    });

  const server: Server = createServer(async (req, res) => {
    const raw = await read(req);
    const u = new URL(req.url ?? '/', 'http://x');
    const path = u.pathname.replace(/^\/v1(beta)?/, '');
    const body: Obj = raw ? (JSON.parse(raw) as Obj) : {};
    if (path !== '/auth/login') bodies.push(raw);
    const send = (o: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    const drop = () => req.socket.destroy();
    const route = req.method + ' ' + path;

    if (route === 'POST /auth/login') {
      if (failLogins > 0) {
        failLogins--;
        return send(err(900, 'Login failed'));
      }
      if (body.username !== credentials.username || body.password !== credentials.password)
        return send(err(900, 'Login failed'));
      const t = `tok-${Math.random().toString(36).slice(2)}`;
      tokens.add(t);
      return send(ok({ token: t, reseller_id: 1 }));
    }
    const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];

    // logical op for fault injection
    const m = /^\/domains\/(\d+)(\/\w+)?$/.exec(path);
    let op: FaultOp | null = null;
    if (route === 'POST /domains') op = 'register';
    else if (route === 'POST /domains/check') op = 'search';
    else if (route === 'POST /domains/transfer') op = 'transferIn';
    else if (m && req.method === 'POST' && m[2] === '/renew') op = 'renew';
    else if (route === 'GET /domains')
      op = u.searchParams.has('comment_pattern') ? 'findByToken' : 'inspect';
    else if (req.method === 'PUT' && path.startsWith('/dns/zones/')) op = 'dns.apply';
    const fault = op ? takeFault(op) : null;
    if (fault === 'timeout_before_side_effect') return drop();
    if (fault === 'rate_limit') return send(err(4007, 'Temporarily blocked for excessive use'));
    if (fault === 'outage') return send(err(4005, 'API disabled for maintenance'));
    if (fault === 'auth_failure') {
      failLogins = 1;
      return send(err(196, 'Authentication failed'));
    }
    if (!bearer || !tokens.has(bearer)) return send(err(196, 'Authentication failed'));
    const after = fault === 'timeout_after_side_effect';
    const reply = (o: unknown) => (after ? drop() : send(o));

    if (route === 'GET /tlds') {
      const results = Object.entries(TLDS).map(([name, t]) => ({
        name,
        status: 'ACT',
        min_period: 1,
        max_period: 10,
        transfer_available: true,
        renew_available: true,
        is_private_whois_allowed: true,
        dnssec_allowed: name === 'com',
        restrictions: t.restrictions,
        prices: {
          create_price: { currency: 'EUR', price: t.create },
          renew_price: { currency: 'EUR', price: t.renew },
          transfer_price: { currency: 'EUR', price: t.transfer },
        },
      }));
      return send(
        ok({
          results: results.slice(0, Number(u.searchParams.get('limit') ?? 1000)),
          total: results.length,
        }),
      );
    }
    if (route === 'POST /domains/check') {
      const list = (body.domains as { name: string; extension: string }[]) ?? [];
      if (list.length > 15) return send(err(701, 'too many domains'));
      return send(
        ok({
          results: list.map((d) => {
            const n = `${d.name}.${d.extension}`;
            const t = TLDS[d.extension];
            const isTaken = taken.has(n) || [...doms.values()].some((x) => full(x) === n);
            return {
              domain: n,
              status: !t ? 'unknown' : isTaken ? 'active' : 'free',
              is_premium: false,
              price: t
                ? {
                    reseller: { currency: 'EUR', price: t.create },
                    product: { currency: 'EUR', price: t.create },
                  }
                : undefined,
            };
          }),
        }),
      );
    }
    if (route === 'POST /customers') {
      const h = `AB${String(nextHandle++).padStart(6, '0')}-XX`;
      customers.add(h);
      return send(ok({ handle: h }));
    }
    if (route === 'POST /domains' || route === 'POST /domains/transfer') {
      const dom = body.domain as { name: string; extension: string };
      const n = `${dom.name}.${dom.extension}`;
      if (!TLDS[dom.extension]) return reply(err(322, 'extension not supported'));
      if (taken.has(n) || [...doms.values()].some((x) => full(x) === n))
        return reply(
          route === 'POST /domains'
            ? err(311, 'Domain is not free')
            : err(514, 'already transferring'),
        );
      if (!customers.has(String(body.owner_handle)))
        return reply(err(330, 'owner handle is invalid'));
      if (route === 'POST /domains/transfer' && body.auth_code === 'WRONG')
        return reply(err(318, 'wrong auth code'));
      const d: Dom = {
        id: nextId++,
        name: dom.name,
        ext: dom.extension,
        status: route === 'POST /domains' && !hold ? 'ACT' : 'REQ',
        comments: String(body.comments ?? ''),
        owner: String(body.owner_handle),
        ns: ((body.name_servers as { name: string }[]) ?? []).map((x) => x.name),
        locked: true,
        autorenew: String(body.autorenew ?? 'off'),
        renewal: Date.now() + Number(body.period ?? 1) * 365 * 86_400_000,
        privacy: body.is_private_whois_enabled === true,
      };
      doms.set(d.id, d);
      if (route === 'POST /domains') addTx('create', d, TLDS[d.ext]!.create);
      return reply(
        ok({
          id: d.id,
          status: d.status,
          renewal_date: iso(d.renewal),
          expiration_date: iso(d.renewal),
        }),
      );
    }
    if (route === 'GET /domains') {
      const full_name = u.searchParams.get('full_name');
      const pat = u.searchParams.get('comment_pattern');
      const results = [...doms.values()]
        .filter(
          (d) =>
            (!full_name || full(d) === full_name) &&
            (!pat || d.comments.includes(pat.replace(/\*/g, ''))),
        )
        .map(view);
      return reply(ok({ results, total: results.length }));
    }
    if (m && req.method === 'POST' && m[2] === '/renew') {
      const d = doms.get(Number(m[1]));
      if (!d) return reply(err(104, 'no such domain'));
      d.renewal += Number(body.period ?? 1) * 365 * 86_400_000;
      addTx('renew', d, TLDS[d.ext]!.renew);
      return reply(ok({ status: 'ACT' }));
    }
    if (m && req.method === 'PUT' && !m[2]) {
      const d = doms.get(Number(m[1]));
      if (!d) return send(err(104, 'no such domain'));
      if (Array.isArray(body.name_servers))
        d.ns = (body.name_servers as { name: string }[]).map((x) => x.name);
      if (typeof body.is_locked === 'boolean') d.locked = body.is_locked;
      if (typeof body.autorenew === 'string') d.autorenew = body.autorenew;
      if (typeof body.owner_handle === 'string') d.owner = body.owner_handle;
      return send(ok({ id: d.id, status: d.status }));
    }
    if (m && req.method === 'GET' && m[2] === '/authcode') {
      const d = doms.get(Number(m[1]));
      return d
        ? send(ok({ auth_code: `AUTH-${d.id}-SECRET`, success: true, type: 'external' }))
        : send(err(319, 'cannot request'));
    }
    if (route === 'GET /transactions') return send(ok({ results: txs, total: txs.length }));

    // DNS
    if (route === 'GET /dns/zones')
      return send(ok({ results: [...zones.keys()].map((name) => ({ name })), total: zones.size }));
    if (route === 'POST /dns/zones') {
      const d = body.domain as { name: string; extension: string };
      const n = `${d.name}.${d.extension}`;
      if (zones.has(n)) return send(err(800, 'zone exists'));
      zones.set(n, []);
      return send(ok({ success: true }));
    }
    const z = /^\/dns\/zones\/([^/]+)$/.exec(path);
    if (z) {
      const name = decodeURIComponent(z[1]!);
      const recs = zones.get(name);
      if (!recs) return send(err(800, 'zone not found'));
      if (req.method === 'GET')
        return send(
          ok({
            id: 5,
            name,
            type: 'master',
            records: recs.map((r) => ({
              ...r,
              name: r.name === '' ? name : `${String(r.name)}.${name}`,
            })),
          }),
        );
      if (req.method === 'PUT') {
        if (dnsFailFrom !== null && dnsCalls++ >= dnsFailFrom)
          return send(err(104, 'invalid record'));
        if (dnsFailAt !== null && dnsCalls++ === dnsFailAt) {
          dnsFailAt = null;
          return send(err(104, 'invalid record'));
        }
        const r = body.records as {
          add?: Obj[];
          remove?: Obj[];
          update?: { original_record: Obj; record: Obj }[];
        };
        const key = (x: Obj) => `${String(x.name)}|${String(x.type)}|${String(x.value)}`;
        const norm = (x: Obj): Obj => ({
          ...x,
          name: String(x.name ?? '').replace(new RegExp(`\\.?${name.replace(/\./g, '\\.')}$`), ''),
        });
        for (const a of r.add ?? []) recs.push(norm(a));
        for (const x of r.remove ?? []) {
          const i = recs.findIndex((y) => key(y) === key(norm(x)));
          if (i >= 0) recs.splice(i, 1);
        }
        for (const u2 of r.update ?? []) {
          const i = recs.findIndex((y) => key(y) === key(norm(u2.original_record)));
          if (i >= 0) recs[i] = norm(u2.record);
        }
        return reply(ok({ success: true }));
      }
    }
    return send(err(81, `wrong method or endpoint: ${route}`));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

  const controls: OpenproviderMock['controls'] = {
    registrationCount: () => doms.size,
    registrationsByName: (n) => [...doms.values()].filter((d) => full(d) === n).length,
    inject: (op, kind, times = 1) => void faults.push({ op, kind, left: times }),
    seedTaken: (n) => void taken.add(n),
    injectDnsFailureAt: (k) => {
      dnsFailAt = k;
      dnsCalls = 0;
    },
    dnsRecords: (zone): DnsRecordData[] =>
      (zones.get(zone) ?? []).map((r) => ({
        name: String(r.name) || '@',
        type: r.type as DnsRecordData['type'],
        ttl: Number(r.ttl),
        value: r.value,
      })),
    signWebhook: (b, at) => {
      const t = Math.floor(at.getTime() / 1000);
      const v1 = createHmac('sha256', webhookSecret).update(`${t}.${b}`).digest('hex');
      return { headers: { 'x-webhook-signature': `t=${t},v1=${v1}` }, secret: webhookSecret };
    },
    lastRequestBodies: () => bodies,
    /** Registrations answer REQ (pending at the registry) until `activate` is called. */
    holdRegistrations: (v: boolean) => void (hold = v),
    /** Every zone-modifying call from the k-th on fails (rollback cannot succeed) until `null`. */
    dnsFailFrom: (k: number | null) => {
      dnsFailFrom = k;
      dnsCalls = 0;
    },
    activate: (name: string) => {
      for (const d of doms.values()) if (full(d) === name) d.status = 'ACT';
    },
    webhookBody: (type: string, id: string, domain: string, at: Date) =>
      JSON.stringify({
        id,
        schemaVersion: '1.0',
        eventType: type,
        timeStamp: Math.floor(at.getTime() / 1000),
        data: {
          domain,
          domainId: [...doms.values()].find((d) => full(d) === domain)?.id ?? 0,
          status: 'ACT',
        },
      }),
  };
  return {
    url,
    controls,
    credentials,
    webhookSecret,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
