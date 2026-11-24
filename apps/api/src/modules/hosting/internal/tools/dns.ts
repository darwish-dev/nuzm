import { promises as dns } from 'node:dns';

/**
 * Read-only DNS lookups for the business-email checks (MX, SPF, DKIM, DMARC, the mail host, PTR). The platform NEVER writes a record here: the records a customer already has
 * (for example an external mail provider's) are only read and shown, and kept. Tests replace this port with `MockMailDns`.
 */
export interface MailDns {
  mx(domain: string): Promise<{ exchange: string; priority: number }[]>;
  /** the TXT records of a name, each already joined from its chunks */
  txt(name: string): Promise<string[]>;
  a(host: string): Promise<string[]>;
  reverse(ip: string): Promise<string[]>;
}
export const MAIL_DNS = Symbol('HOSTING_MAIL_DNS');

const empty = <T>(e: unknown): T[] => {
  const code = (e as { code?: string }).code;
  if (code === 'ENODATA' || code === 'ENOTFOUND' || code === 'NXDOMAIN' || code === 'ENOENT')
    return [];
  throw e;
};
export class SystemMailDns implements MailDns {
  async mx(domain: string) {
    return dns
      .resolveMx(domain)
      .then((r) =>
        r.map((x) => ({
          exchange: x.exchange.replace(/\.$/, '').toLowerCase(),
          priority: x.priority,
        })),
      )
      .catch(empty<{ exchange: string; priority: number }>);
  }
  async txt(name: string) {
    return dns
      .resolveTxt(name)
      .then((r) => r.map((chunks) => chunks.join('')))
      .catch(empty<string>);
  }
  async a(host: string) {
    return dns.resolve4(host).catch(empty<string>);
  }
  async reverse(ip: string) {
    return dns
      .reverse(ip)
      .then((r) => r.map((h) => h.replace(/\.$/, '').toLowerCase()))
      .catch(empty<string>);
  }
}

/** Test double: a table of records. */
export class MockMailDns implements MailDns {
  readonly mxRecords = new Map<string, { exchange: string; priority: number }[]>();
  readonly txtRecords = new Map<string, string[]>();
  readonly aRecords = new Map<string, string[]>();
  readonly ptrRecords = new Map<string, string[]>();
  async mx(d: string) {
    return this.mxRecords.get(d) ?? [];
  }
  async txt(n: string) {
    return this.txtRecords.get(n) ?? [];
  }
  async a(h: string) {
    return this.aRecords.get(h) ?? [];
  }
  async reverse(ip: string) {
    return this.ptrRecords.get(ip) ?? [];
  }
}
