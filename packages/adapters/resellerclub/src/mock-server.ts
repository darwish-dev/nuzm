import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FaultKind, FaultOp, RegistrarControls } from './mock-types';

/**
 * Local mock of the ResellerClub / LogicBoxes HTTP API as documented in docs/adapters/resellerclub.md (NOT VERIFIED: shaped from documentation, never from a
 * real response; the vendor documents no error codes or messages, so the messages here are OUR assumptions). It tests our adapter and gating only.
 */
type Obj = Record<string, unknown>;
interface Dom {
  orderid: number;
  name: string;
  customer: string;
  status: 'Active' | 'InActive';
  end: number; // epoch seconds
  ns: string[];
  locked: boolean;
  recurring: boolean;
}
const COST: Record<string, { add: number; renew: number; transfer: number }> = {
  domcno: { add: 8.5, renew: 10.2, transfer: 8.1 },
  domorg: { add: 9.1, renew: 11, transfer: 9 },
  dotnet: { add: 10.4, renew: 12, transfer: 10 },
};

export interface ResellerClubMock {
  url: string;
  controls: RegistrarControls;
  credentials: { authUserId: string; apiKey: string; customerId: string };
  close(): Promise<void>;
}

export async function startResellerClubMock(): Promise<ResellerClubMock> {
  const credentials = { authUserId: '4242', apiKey: 'mock-api-key-value-123', customerId: '777' };
  const doms = new Map<number, Dom>();
  const taken = new Set<string>();
  const txs: Obj[] = [];
  const bodies: string[] = [];
  const faults: { op: FaultOp; kind: FaultKind; left: number }[] = [];
  let nextOrder = 5000;
  let nextContact = 900;
  let nextTx = 1;
  const takeFault = (op: FaultOp): FaultKind | null => {
    const f = faults.find((x) => x.op === op && x.left > 0);
    if (!f) return null;
    f.left--;
    return f.kind;
  };
  const err = (message: string) => ({ status: 'ERROR', message });
  const find = (name: string) => [...doms.values()].find((d) => d.name === name);

  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    bodies.push(req.url ?? '');
    const q = u.searchParams;
    const send = (o: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    const route = `${req.method} ${u.pathname}`;
    let op: FaultOp | null = null;
    if (route === 'POST /api/domains/register.json') op = 'register';
    else if (route === 'GET /api/domains/available.json') op = 'search';
    else if (route === 'POST /api/domains/renew.json') op = 'renew';
    else if (route === 'GET /api/domains/details-by-name.json') op = 'inspect';
    else if (route === 'GET /api/domains/search.json') op = 'findByToken';
    else if (route === 'POST /api/domains/transfer.json') op = 'transferIn';
    const fault = op ? takeFault(op) : null;
    if (fault === 'timeout_before_side_effect') return void req.socket.destroy();
    if (fault === 'rate_limit') return send(err('Too many requests, please slow down'));
    if (fault === 'outage')
      return send(err('Unable to connect to the registry, please try again later'));
    if (fault === 'auth_failure') return send(err('Access Denied'));
    if (q.get('auth-userid') !== credentials.authUserId || q.get('api-key') !== credentials.apiKey)
      return send(err('Access Denied'));
    const after = fault === 'timeout_after_side_effect';
    const reply = (o: unknown) => (after ? req.socket.destroy() : send(o));
    const all = (k: string) => q.getAll(k);

    if (route === 'POST /api/domains/tld-info.json')
      return send({
        com: {
          locking_available: 'true',
          registry: 'Verisign',
          type: 'gTLD',
          privacy_available: 'true',
        },
        org: {
          locking_available: 'true',
          registry: 'PIR',
          type: 'gTLD',
          privacy_available: 'true',
        },
        net: {
          locking_available: 'true',
          registry: 'Verisign',
          type: 'gTLD',
          privacy_available: 'false',
        },
        ae: {
          locking_available: 'false',
          registry: 'aeDA',
          type: 'ccTLD',
          privacy_available: 'false',
        },
      });
    if (route === 'GET /api/products/reseller-cost-price.json')
      return send(
        Object.fromEntries(
          Object.entries(COST).map(([k, v]) => [
            k,
            {
              addnewdomain: { '1': v.add.toFixed(2), '2': (v.add * 2).toFixed(2) },
              renewdomain: { '1': v.renew.toFixed(2) },
              addtransferdomain: { '1': v.transfer.toFixed(2) },
            },
          ]),
        ),
      );
    if (route === 'GET /api/domains/available.json') {
      const out: Obj = {};
      for (const n of all('domain-name'))
        for (const t of all('tlds')) {
          const full = `${n}.${t}`;
          out[full] = {
            status: !['com', 'org', 'net'].includes(t)
              ? 'unknown'
              : taken.has(full) || find(full)
                ? 'regthroughothers'
                : 'available',
            classkey: 'domcno',
          };
        }
      return send(out);
    }
    if (route === 'POST /api/contacts/add.json') {
      if (q.get('customer-id') !== credentials.customerId) return send(err('Invalid customer-id'));
      return send(nextContact++);
    }
    if (
      route === 'POST /api/domains/register.json' ||
      route === 'POST /api/domains/transfer.json'
    ) {
      const name = q.get('domain-name') ?? '';
      if (taken.has(name) || find(name))
        return reply(err('The domain is already registered, not available for registration'));
      if (!q.get('reg-contact-id') || !q.get('invoice-option'))
        return reply(err('Please provide all required parameters'));
      const isTransfer = route.endsWith('transfer.json');
      if (isTransfer && q.get('auth-code') === 'WRONG') return reply(err('Invalid auth code'));
      const d: Dom = {
        orderid: nextOrder++,
        name,
        customer: q.get('customer-id') ?? '',
        status: isTransfer ? 'InActive' : 'Active',
        end: Math.floor(Date.now() / 1000) + Number(q.get('years') ?? 1) * 365 * 86400,
        ns: all('ns'),
        locked: true,
        recurring: q.get('auto-renew') === 'true',
      };
      doms.set(d.orderid, d);
      if (!isTransfer)
        txs.push({
          transid: String(nextTx++),
          transactiondate: String(Math.floor(Date.now() / 1000)),
          key: 'systemgenerated',
          type: 'debit',
          description: `Domain registration ${name}`,
          sellingcurrencysymbol: '$',
          sellingamount: COST[name.endsWith('.com') ? 'domcno' : 'dotnet']!.add.toFixed(2),
        });
      return reply({
        description: name,
        entityid: String(d.orderid),
        actiontype: isTransfer ? 'AddTransferDomain' : 'AddNewDomain',
        actiontypedesc: 'x',
        eaqid: String(d.orderid + 1),
        actionstatus: 'Success',
        actionstatusdesc: 'ok',
      });
    }
    if (route === 'GET /api/domains/search.json') {
      const name = q.get('domain-name');
      const rows = [...doms.values()].filter(
        (d) => (!name || d.name === name) && d.customer === q.get('customer-id'),
      );
      const o: Obj = { recsonpage: String(rows.length), recsindb: String(rows.length) };
      rows.forEach(
        (d, i) =>
          (o[String(i + 1)] = {
            domainname: d.name,
            orderid: String(d.orderid),
            customerid: d.customer,
            currentstatus: d.status,
          }),
      );
      return reply(o);
    }
    if (route === 'GET /api/domains/details-by-name.json') {
      const d = find(q.get('domain-name') ?? '');
      if (!d) return reply(err('No Entity found for the given domain name'));
      return reply({
        orderid: String(d.orderid),
        domainname: d.name,
        currentstatus: d.status,
        endtime: String(d.end),
        customerid: d.customer,
        recurring: String(d.recurring),
        orderstatus: d.locked ? ['transferlock'] : [],
        ...Object.fromEntries(d.ns.map((n, i) => [`ns${i + 1}`, n])),
        isprivacyprotected: 'false',
        privacyprotectedallowed: 'true',
      });
    }
    if (route === 'POST /api/domains/renew.json') {
      const d = doms.get(Number(q.get('order-id')));
      if (!d) return reply(err('Invalid order-id'));
      d.end += Number(q.get('years') ?? 1) * 365 * 86400;
      txs.push({
        transid: String(nextTx++),
        transactiondate: String(Math.floor(Date.now() / 1000)),
        key: 'systemgenerated',
        type: 'debit',
        description: `Renewal ${d.name}`,
        sellingcurrencysymbol: '$',
        sellingamount: '10.20',
      });
      return reply({ description: d.name, entityid: String(d.orderid), actionstatus: 'Success' });
    }
    if (route === 'GET /api/domains/validate-transfer.json')
      return send(!find(q.get('domain-name') ?? '') ? 'true' : 'false');
    if (route === 'POST /api/domains/modify-ns.json') {
      const d = doms.get(Number(q.get('order-id')));
      if (!d) return send(err('Invalid order-id'));
      d.ns = all('ns');
      return send({ entityid: String(d.orderid), actionstatus: 'Success' });
    }
    if (
      route === 'POST /api/domains/enable-theft-protection.json' ||
      route === 'POST /api/domains/disable-theft-protection.json'
    ) {
      const d = doms.get(Number(q.get('order-id')));
      if (!d) return send(err('Invalid order-id'));
      d.locked = route.includes('enable');
      return send({ entityid: String(d.orderid), actionstatus: 'Success' });
    }
    if (route === 'GET /api/billing/my-transactions/search.json') {
      const o: Obj = { recsonpage: String(txs.length), recsindb: String(txs.length) };
      txs.forEach((t, i) => (o[String(i + 1)] = t));
      return send(o);
    }
    return send(err(`unknown endpoint ${route}`));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const controls: RegistrarControls = {
    registrationCount: () => doms.size,
    registrationsByName: (n) => [...doms.values()].filter((d) => d.name === n).length,
    inject: (op, kind, times = 1) => void faults.push({ op, kind, left: times }),
    seedTaken: (n) => void taken.add(n),
    lastRequestBodies: () => bodies,
  };
  return { url, controls, credentials, close: () => new Promise((r) => server.close(() => r())) };
}
