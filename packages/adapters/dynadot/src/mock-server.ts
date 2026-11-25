import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FaultKind, FaultOp, RegistrarControls } from './mock-types';

/**
 * Local mock of the Dynadot Legacy API (`api3.json`) as documented at https://www.dynadot.com/domain/api-commands (read 2026-11-24). NOT VERIFIED: it is shaped from
 * the documentation's examples, never from a real response; the vendor documents no error messages, so the messages here are OUR assumptions. It tests our
 * adapter and gating only and never produces vendor evidence.
 */
type Obj = Record<string, unknown>;
interface Dom {
  name: string;
  end: number; // epoch ms
  ns: string[];
  locked: boolean;
  renew: 'auto' | 'donot';
  privacy: 'none' | 'full';
  transferring: boolean;
}
const PRICES: Record<string, { reg: string; renew: string; transfer: string }> = {
  com: { reg: '12.50', renew: '14.00', transfer: '12.00' },
  net: { reg: '13.20', renew: '15.00', transfer: '13.00' },
  org: { reg: '11.90', renew: '13.50', transfer: '11.50' },
  ae: { reg: '30.00', renew: '32.00', transfer: '30.00' },
};

export interface DynadotMock {
  url: string;
  controls: RegistrarControls;
  credentials: { apiKey: string };
  close(): Promise<void>;
}

export async function startDynadotMock(): Promise<DynadotMock> {
  const credentials = { apiKey: 'mock-dynadot-key-0123456789abcdef' };
  const doms = new Map<string, Dom>();
  const taken = new Set<string>();
  const servers = new Set<string>();
  const bodies: string[] = [];
  const faults: { op: FaultOp; kind: FaultKind; left: number }[] = [];
  let nextContact = 100;
  const takeFault = (op: FaultOp): FaultKind | null => {
    const f = faults.find((x) => x.op === op && x.left > 0);
    if (!f) return null;
    f.left--;
    return f.kind;
  };
  const fail = (name: string, message: string) => ({
    [`${name}Response`]: { ResponseCode: -1, Status: 'error', Error: message },
  });
  const tldOf = (d: string) => d.slice(d.indexOf('.') + 1);

  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    // the request line carries the key (documented transport): only the command is kept for the PII/secret assertions
    bodies.push(`${u.pathname}?command=${u.searchParams.get('command') ?? ''}`);
    const q = u.searchParams;
    const send = (o: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    const command = q.get('command') ?? '';
    const resp = command
      .split('_')
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join('');
    let op: FaultOp | null = null;
    if (command === 'register') op = 'register';
    else if (command === 'search') op = 'search';
    else if (command === 'renew') op = 'renew';
    else if (command === 'domain_info') op = 'inspect';
    else if (command === 'transfer') op = 'transferIn';
    const fault = op ? takeFault(op) : null;
    if (fault === 'timeout_before_side_effect') return void req.socket.destroy();
    if (fault === 'rate_limit') return send(fail(resp, 'Too many requests, please slow down'));
    if (fault === 'outage')
      return send(fail(resp, 'Service temporarily unavailable, please try again later'));
    if (fault === 'auth_failure') return send(fail(resp, 'Invalid API key'));
    if (u.pathname !== '/api3.json') return send(fail(resp, 'unknown endpoint'));
    if (q.get('key') !== credentials.apiKey) return send(fail(resp, 'Invalid API key'));
    const after = fault === 'timeout_after_side_effect';
    const reply = (o: unknown) => (after ? req.socket.destroy() : send(o));
    const ok = (extra: Obj) => ({
      [`${resp}Response`]: { ResponseCode: 0, Status: 'success', ...extra },
    });
    const dom = (name: string) => doms.get(name.toLowerCase());

    switch (command) {
      case 'get_account_balance':
        return send(ok({ BalanceList: [{ Currency: 'USD', Amount: '300.00' }] }));
      case 'tld_price':
        return send(
          ok({
            PriceLevel: 'Regular Pricing',
            Currency: q.get('currency') ?? 'USD',
            TldPrice: Object.entries(PRICES).map(([tld, p]) => ({
              Tld: tld,
              Usage: 'General',
              IDN: 'YES',
              Restrictions: tld === 'ae' ? 'Local presence required' : '--',
              OnSale: 'Yes',
              Privacy: '10.00',
              Price: {
                Unit: '(Price/1 year)',
                Register: p.reg,
                Renew: p.renew,
                Transfer: p.transfer,
                Restore: '10.00',
              },
              GracePeriod: { Unit: 'days', Renew: '10', Delete: '30', Restore: 'YES' },
              maxDuration: 10,
              minDuration: 1,
            })),
          }),
        );
      case 'search': {
        const rows: Obj[] = [];
        for (let i = 0; q.get(`domain${i}`); i++) {
          const n = q.get(`domain${i}`)!.toLowerCase();
          const free = !taken.has(n) && !doms.has(n);
          rows.push({
            DomainName: n,
            Available: free ? 'yes' : 'no',
            ...(free ? { Price: `${PRICES[tldOf(n)]?.reg ?? '15.00'} in USD` } : {}),
          });
        }
        return reply({ SearchResponse: { ResponseCode: 0, SearchResults: rows } });
      }
      case 'create_contact':
        return send(ok({ CreateContactContent: { ContactId: String(nextContact++) } }));
      case 'register': {
        const n = (q.get('domain') ?? '').toLowerCase();
        if (taken.has(n) || doms.has(n)) return send(fail(resp, 'Domain already registered'));
        const years = Number(q.get('duration') ?? 1);
        const d: Dom = {
          name: n,
          end: Date.now() + years * 365 * 86_400_000,
          ns: [],
          locked: true,
          renew: 'donot',
          privacy: 'none',
          transferring: false,
        };
        doms.set(n, d);
        return reply(ok({ RegisterContent: { DomainName: n, Expiration: d.end } }));
      }
      case 'transfer': {
        const n = (q.get('domain') ?? '').toLowerCase();
        if (!q.get('auth')) return send(fail(resp, 'auth is required'));
        if (doms.has(n)) return send(fail(resp, 'Domain already exists in your account'));
        doms.set(n, {
          name: n,
          end: Date.now() + 365 * 86_400_000,
          ns: [],
          locked: false,
          renew: 'donot',
          privacy: 'none',
          transferring: true,
        });
        return reply({
          TransferResponse: {
            ResponseCode: 0,
            Status: 'order created',
            DomainName: n,
            OrderId: 1234567,
          },
        });
      }
      case 'domain_info': {
        const d = dom(q.get('domain') ?? '');
        if (!d) return reply(fail(resp, 'Domain not found in your account'));
        return reply(
          ok({
            DomainInfo: {
              Name: d.name,
              Expiration: String(d.end),
              Registration: '1234567890123',
              NameServerSettings: { Type: d.ns.length ? 'Name Servers' : 'Dynadot Parking' },
              Locked: d.locked ? 'yes' : 'no',
              Disabled: 'no',
              Privacy: d.privacy,
              RenewOption: d.renew === 'auto' ? 'auto' : 'no renew option',
              Status: d.transferring ? 'transferring' : 'active',
            },
          }),
        );
      }
      case 'get_ns': {
        const d = dom(q.get('domain') ?? '');
        if (!d) return send(fail(resp, 'Domain not found in your account'));
        return send(ok({ NsContent: Object.fromEntries(d.ns.map((h, i) => [`Host${i}`, h])) }));
      }
      case 'add_ns': {
        const h = q.get('host') ?? '';
        if (servers.has(h)) return send(fail(resp, 'Name server already exists'));
        servers.add(h);
        return send(ok({ AddNsContent: { Server: { Host: h, ServerId: servers.size } } }));
      }
      case 'set_ns': {
        const d = dom(q.get('domain') ?? '');
        if (!d) return send(fail(resp, 'Domain not found in your account'));
        const list: string[] = [];
        for (let i = 0; q.get(`ns${i}`); i++) list.push(q.get(`ns${i}`)!);
        if (list.some((h) => !servers.has(h)))
          return send(fail(resp, 'Name server is not in your account'));
        d.ns = list;
        return send(ok({}));
      }
      case 'lock_domain':
      case 'unlock_domain': {
        const d = dom(q.get('domain') ?? '');
        if (!d) return send(fail(resp, 'Domain not found in your account'));
        d.locked = command === 'lock_domain';
        return send(ok({}));
      }
      case 'set_renew_option': {
        const d = dom(q.get('domain') ?? '');
        if (!d) return send(fail(resp, 'Domain not found in your account'));
        d.renew = q.get('renew_option') === 'auto' ? 'auto' : 'donot';
        return send(ok({}));
      }
      case 'set_privacy': {
        const d = dom(q.get('domain') ?? '');
        if (!d) return send(fail(resp, 'Domain not found in your account'));
        d.privacy = q.get('option') === 'off' ? 'none' : 'full';
        return send(ok({}));
      }
      case 'get_transfer_auth_code': {
        const d = dom(q.get('domain') ?? '');
        if (!d) return send(fail(resp, 'Domain not found in your account'));
        if (d.locked)
          return send(
            fail(resp, 'The domain is locked: unlock it before requesting the auth code'),
          );
        return send(ok({ AuthCode: 'MOCK-AUTH-CODE-7731' }));
      }
      case 'renew': {
        const d = dom(q.get('domain') ?? '');
        if (!d) return reply(fail(resp, 'Domain not found in your account'));
        d.end += Number(q.get('duration') ?? 1) * 365 * 86_400_000;
        return reply(ok({ RenewContent: { DomainName: d.name, Expiration: d.end } }));
      }
      default:
        return send(fail(resp, `unknown command ${command}`));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const controls: RegistrarControls = {
    registrationCount: () => doms.size,
    registrationsByName: (n) => (doms.has(n.toLowerCase()) ? 1 : 0),
    inject: (op, kind, times = 1) => void faults.push({ op, kind, left: times }),
    seedTaken: (n) => void taken.add(n.toLowerCase()),
    lastRequestBodies: () => bodies,
  };
  return { url, controls, credentials, close: () => new Promise((r) => server.close(() => r())) };
}
