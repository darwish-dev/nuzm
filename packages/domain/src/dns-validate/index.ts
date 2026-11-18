/**
 * DNS record validation library (M07 S30 task 2). Pure: no I/O, no Nest. A change-set is validated AS A WHOLE against the zone's current records:
 * every create/update/delete is applied to a copy, then the resulting set is checked (CNAME exclusivity, duplicates, quota, ...), so a set that is
 * only valid in one order is still judged by its outcome. Errors carry the index of the offending change.
 */
import { domainToASCII } from 'node:url';
import { isIPv4, isIPv6 } from 'node:net';

export const DNS_RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA', 'NS'] as const;
export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];
export const MANAGED_BY = ['user', 'linkage', 'email-verification'] as const;
export type ManagedBy = (typeof MANAGED_BY)[number];

export interface DnsRecordInput {
  name: string;
  type: string;
  ttl?: number;
  value: unknown;
  managedBy?: ManagedBy;
}
export interface DnsRecord {
  /** relative to the apex, lower-case, punycode; `@` = apex */
  name: string;
  type: DnsRecordType;
  ttl: number;
  value: unknown;
  managedBy: ManagedBy;
}
export type DnsChangeInput =
  | { op: 'create'; record: DnsRecordInput }
  | { op: 'update'; match: { name: string; type: string }; record: DnsRecordInput }
  | { op: 'delete'; match: { name: string; type: string } };

export interface DnsValidationOptions {
  minTtl: number;
  maxTtl: number;
  defaultTtl: number;
  /** `records per zone` entitlement. */
  maxRecords: number;
  /** Who is writing: only `linkage` may write `_acme-challenge` TXT and records that point at Nuzm hosting targets. */
  writer: ManagedBy;
  /** Host suffixes that belong to Nuzm hosting (CNAME/MX/SRV targets under them are takeover-sensitive: only the linkage port may point there). */
  protectedTargetSuffixes: string[];
  allowDnssecRecords?: false;
}
export const DEFAULT_DNS_OPTIONS: DnsValidationOptions = {
  minTtl: 60,
  maxTtl: 86400,
  defaultTtl: 3600,
  maxRecords: 500,
  writer: 'user',
  protectedTargetSuffixes: [],
};

export type DnsErrorCode =
  | 'invalid_name'
  | 'invalid_type'
  | 'invalid_ttl'
  | 'invalid_value'
  | 'cname_at_apex'
  | 'cname_conflict'
  | 'ns_at_apex'
  | 'duplicate_record'
  | 'record_not_found'
  | 'record_exists'
  | 'quota_exceeded'
  | 'reserved_name'
  | 'protected_target'
  | 'unsafe_value';
export interface DnsValidationError {
  index: number;
  code: DnsErrorCode;
  field: 'name' | 'type' | 'ttl' | 'value' | 'record';
  message: string;
}
export interface DnsValidationResult {
  ok: boolean;
  errors: DnsValidationError[];
  /** The zone after the change-set (only meaningful when ok). */
  resulting: DnsRecord[];
}

const LABEL = /^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)$/;
// eslint-disable-next-line no-control-regex -- the point: reject control characters
const CONTROL = /[\u0000-\u001f\u007f]/;
export const TXT_CHUNK_BYTES = 255;

/** Normalizes an owner name to its relative, lower-case, punycode form. Returns null when invalid. */
export function normalizeName(raw: unknown, zone: string): string | null {
  if (typeof raw !== 'string') return null;
  let n = raw.trim();
  if (n === '' || n.length > 300 || CONTROL.test(n)) return null;
  if (n === '@') return '@';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020/\\?#@:%[\]!$&'()+,;=<>"^`{|}~]/.test(n)) return null; // URL syntax would be silently reinterpreted by the IDNA step
  n = n.endsWith('.') ? n.slice(0, -1) : n;
  const z = zone.toLowerCase().replace(/\.$/, '');
  const ascii = domainToASCII(n.toLowerCase());
  if (ascii === '') return null;
  let rel = ascii;
  if (rel === z) return '@';
  if (rel.endsWith(`.${z}`)) rel = rel.slice(0, -(z.length + 1));
  if (rel.length > 253 - z.length - 1) return null;
  const labels = rel.split('.');
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]!;
    if (l === '*' && i === 0) continue;
    if (!LABEL.test(l)) return null;
  }
  return rel;
}

/** Normalizes a host name used as a value target (absolute). */
export function normalizeHost(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let h = raw.trim();
  if (h === '' || h.length > 253 || CONTROL.test(h) || /\s/.test(h)) return null;
  if (/[/\\?#@:%[\]!$&'()+,;=<>"^`{|}~*]/.test(h)) return null;
  if (h.endsWith('.')) h = h.slice(0, -1);
  const a = domainToASCII(h.toLowerCase());
  if (a === '' || a.length > 253) return null;
  const labels = a.split('.');
  for (const l of labels) if (!LABEL.test(l)) return null;
  if (isIPv4(a) || /^[0-9]+$/.test(labels[labels.length - 1]!)) return null; // an address is not a host name target
  return a;
}

const privateOrUnsafeV4 = (ip: string): boolean => {
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return a === 0 || a === 127 || (a === 169 && b === 254) || a >= 224;
};
const unsafeV6 = (ip: string): boolean => {
  const x = ip.toLowerCase();
  return (
    x === '::' ||
    x === '::1' ||
    x.startsWith('fe8') ||
    x.startsWith('fe9') ||
    x.startsWith('fea') ||
    x.startsWith('feb') ||
    x.startsWith('ff') ||
    x.startsWith('::ffff:127.') ||
    x.startsWith('::ffff:169.254.')
  );
};

const u16 = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 65535;

/** Splits a TXT value into <=255 byte chunks (RFC 1035 character-strings), on UTF-8 boundaries. */
export function chunkTxt(value: string): string[] {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of value) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > TXT_CHUNK_BYTES) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += b;
  }
  if (cur !== '' || out.length === 0) out.push(cur);
  return out;
}

interface ValueCheck {
  value?: unknown;
  error?: { code: DnsErrorCode; message: string };
}
function validateValue(type: DnsRecordType, v: unknown, o: DnsValidationOptions): ValueCheck {
  const bad = (message: string, code: DnsErrorCode = 'invalid_value') => ({
    error: { code, message },
  });
  switch (type) {
    case 'A': {
      if (typeof v !== 'string' || !isIPv4(v)) return bad('A value must be an IPv4 address');
      if (privateOrUnsafeV4(v))
        return bad(
          'loopback, link-local, unspecified and multicast addresses are refused',
          'unsafe_value',
        );
      return { value: v };
    }
    case 'AAAA': {
      if (typeof v !== 'string' || !isIPv6(v)) return bad('AAAA value must be an IPv6 address');
      if (unsafeV6(v))
        return bad(
          'loopback, link-local, unspecified and multicast addresses are refused',
          'unsafe_value',
        );
      return { value: v.toLowerCase() };
    }
    case 'CNAME':
    case 'NS': {
      const h = normalizeHost(v);
      if (!h) return bad(`${type} value must be a host name`);
      return { value: h };
    }
    case 'MX': {
      const x = v as { priority?: unknown; host?: unknown } | null;
      if (!x || typeof x !== 'object' || !u16(x.priority))
        return bad('MX needs priority 0..65535 and host');
      const h = normalizeHost(x.host);
      if (!h) return bad('MX host must be a host name');
      return { value: { priority: x.priority, host: h } };
    }
    case 'TXT': {
      if (typeof v !== 'string') return bad('TXT value must be a string');
      if (v.length === 0 || Buffer.byteLength(v) > 4096)
        return bad('TXT value must be 1..4096 bytes');
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v) || /[\r\n]/.test(v))
        return bad('TXT value must not contain control characters or line breaks', 'unsafe_value');
      return { value: v };
    }
    case 'SRV': {
      const x = v as {
        priority?: unknown;
        weight?: unknown;
        port?: unknown;
        target?: unknown;
      } | null;
      if (!x || typeof x !== 'object' || !u16(x.priority) || !u16(x.weight) || !u16(x.port))
        return bad('SRV needs priority, weight, port (0..65535) and target');
      const target = x.target === '.' ? '.' : normalizeHost(x.target);
      if (!target) return bad('SRV target must be a host name or "."');
      return { value: { priority: x.priority, weight: x.weight, port: x.port, target } };
    }
    case 'CAA': {
      const x = v as { flags?: unknown; tag?: unknown; value?: unknown } | null;
      if (!x || typeof x !== 'object') return bad('CAA needs flags, tag and value');
      if (x.flags !== 0 && x.flags !== 128) return bad('CAA flags must be 0 or 128');
      if (x.tag !== 'issue' && x.tag !== 'issuewild' && x.tag !== 'iodef')
        return bad('CAA tag must be issue, issuewild or iodef');
      if (typeof x.value !== 'string' || x.value.length > 255 || CONTROL.test(x.value))
        return bad('CAA value must be a string of at most 255 characters');
      if (x.tag === 'iodef' && !/^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/.test(x.value))
        return bad('CAA iodef must be a mailto: or https: URL');
      if (
        x.tag !== 'iodef' &&
        x.value !== '' &&
        !/^[a-z0-9.-]+(;[\sa-z0-9=._:/-]*)?$/i.test(x.value)
      )
        return bad('CAA issue value must be a domain name with optional parameters');
      return { value: { flags: x.flags, tag: x.tag, value: x.value } };
    }
  }
  void o;
}

const hostsOf = (r: DnsRecord): string[] => {
  const v = r.value as Record<string, unknown> | string;
  if (r.type === 'CNAME' || r.type === 'NS') return [v as string];
  if (r.type === 'MX') return [(v as { host: string }).host];
  if (r.type === 'SRV') return [(v as { target: string }).target];
  return [];
};
const underSuffix = (host: string, suffixes: string[]) =>
  suffixes.some((s) => {
    const x = s.toLowerCase().replace(/^\./, '');
    return host === x || host.endsWith(`.${x}`);
  });

export const recordKey = (r: Pick<DnsRecord, 'name' | 'type'>): string => `${r.name}|${r.type}`;
/** Stable string of the value, for duplicate detection and the `value_hash` column. */
export const valueKey = (r: Pick<DnsRecord, 'value'>): string => JSON.stringify(sortKeys(r.value));
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, x]) => [k, sortKeys(x)]),
    );
  return v;
}

/** Validates ONE record input in isolation (field level). */
export function validateRecordInput(
  zone: string,
  input: DnsRecordInput,
  index: number,
  o: DnsValidationOptions,
): { record?: DnsRecord; errors: DnsValidationError[] } {
  const errors: DnsValidationError[] = [];
  const push = (code: DnsErrorCode, field: DnsValidationError['field'], message: string) =>
    errors.push({ index, code, field, message });
  const name = normalizeName(input.name, zone);
  if (name === null) push('invalid_name', 'name', 'the record name is not a valid DNS name');
  const type = typeof input.type === 'string' ? input.type.toUpperCase() : '';
  if (!(DNS_RECORD_TYPES as readonly string[]).includes(type))
    push('invalid_type', 'type', `type must be one of ${DNS_RECORD_TYPES.join(', ')}`);
  const ttl = input.ttl ?? o.defaultTtl;
  if (!Number.isInteger(ttl) || ttl < o.minTtl || ttl > o.maxTtl)
    push('invalid_ttl', 'ttl', `ttl must be an integer between ${o.minTtl} and ${o.maxTtl}`);
  if (errors.length) return { errors };
  const t = type as DnsRecordType;
  const vc = validateValue(t, input.value, o);
  if (vc.error) {
    push(vc.error.code, 'value', vc.error.message);
    return { errors };
  }
  if (t === 'NS' && name === '@')
    push(
      'ns_at_apex',
      'name',
      'NS records are for sub-zone delegation only; change nameservers on the domain',
    );
  if (t === 'CNAME' && name === '@')
    push('cname_at_apex', 'name', 'a CNAME cannot exist at the zone apex');
  const managedBy = input.managedBy ?? o.writer;
  if (managedBy !== o.writer && o.writer !== 'linkage')
    push('reserved_name', 'record', 'managedBy may only be set by the platform');
  if (
    name !== null &&
    (name === '_acme-challenge' || name.startsWith('_acme-challenge.')) &&
    o.writer !== 'linkage'
  )
    push(
      'reserved_name',
      'name',
      '_acme-challenge records are written by the platform only (certificate issuance)',
    );
  const rec: DnsRecord = { name: name!, type: t, ttl, value: vc.value, managedBy };
  if (o.writer !== 'linkage' && o.protectedTargetSuffixes.length)
    for (const h of hostsOf(rec))
      if (underSuffix(h, o.protectedTargetSuffixes))
        push(
          'protected_target',
          'value',
          'this target belongs to Nuzm hosting: link the domain to a hosting site instead',
        );
  return { record: rec, errors };
}

/** Validates a whole change-set against the current zone and returns the zone it would produce. */
export function validateChangeSet(
  zone: string,
  existing: DnsRecord[],
  changes: DnsChangeInput[],
  options: Partial<DnsValidationOptions> = {},
): DnsValidationResult {
  const o = { ...DEFAULT_DNS_OPTIONS, ...options };
  const errors: DnsValidationError[] = [];
  const working = new Map<string, DnsRecord[]>();
  const add = (r: DnsRecord) => {
    const k = recordKey(r);
    working.set(k, [...(working.get(k) ?? []), r]);
  };
  for (const r of existing) add(r);
  const find = (name: string, type: DnsRecordType) => working.get(`${name}|${type}`) ?? [];

  changes.forEach((ch, index) => {
    if (!ch || typeof ch !== 'object' || !['create', 'update', 'delete'].includes(ch.op)) {
      errors.push({
        index,
        code: 'invalid_value',
        field: 'record',
        message: 'op must be create, update or delete',
      });
      return;
    }
    if (ch.op === 'create') {
      const { record, errors: e } = validateRecordInput(zone, ch.record, index, o);
      errors.push(...e);
      if (!record) return;
      if (find(record.name, record.type).some((x) => valueKey(x) === valueKey(record)))
        errors.push({
          index,
          code: 'duplicate_record',
          field: 'record',
          message: 'an identical record already exists',
        });
      else add(record);
      return;
    }
    const mName = normalizeName(ch.match?.name, zone);
    const mType = typeof ch.match?.type === 'string' ? ch.match.type.toUpperCase() : '';
    if (mName === null || !(DNS_RECORD_TYPES as readonly string[]).includes(mType)) {
      errors.push({
        index,
        code: 'invalid_name',
        field: 'record',
        message: 'match needs a valid name and type',
      });
      return;
    }
    const key = `${mName}|${mType}`;
    const current = working.get(key) ?? [];
    if (current.length === 0) {
      errors.push({
        index,
        code: 'record_not_found',
        field: 'record',
        message: 'no record matches',
      });
      return;
    }
    if (current.some((x) => x.managedBy !== o.writer) && o.writer !== 'linkage') {
      errors.push({
        index,
        code: 'reserved_name',
        field: 'record',
        message: 'this record is managed by the platform',
      });
      return;
    }
    if (ch.op === 'delete') {
      working.delete(key);
      return;
    }
    const { record, errors: e } = validateRecordInput(zone, ch.record, index, o);
    errors.push(...e);
    if (!record) return;
    working.delete(key);
    if (find(record.name, record.type).some((x) => valueKey(x) === valueKey(record)))
      errors.push({
        index,
        code: 'duplicate_record',
        field: 'record',
        message: 'an identical record already exists',
      });
    else add(record);
  });

  const resulting = [...working.values()].flat();
  // set-level rules: CNAME exclusivity, quota
  const byName = new Map<string, DnsRecord[]>();
  for (const r of resulting) byName.set(r.name, [...(byName.get(r.name) ?? []), r]);
  for (const [name, rs] of byName) {
    const cn = rs.filter((r) => r.type === 'CNAME');
    if (cn.length > 1)
      errors.push({
        index: -1,
        code: 'cname_conflict',
        field: 'record',
        message: `${name} has more than one CNAME`,
      });
    if (cn.length >= 1 && rs.length > cn.length)
      errors.push({
        index: -1,
        code: 'cname_conflict',
        field: 'record',
        message: `${name} has a CNAME and other records; a CNAME must be alone at its name`,
      });
  }
  if (resulting.length > o.maxRecords)
    errors.push({
      index: -1,
      code: 'quota_exceeded',
      field: 'record',
      message: `the zone would hold ${resulting.length} records; the limit is ${o.maxRecords}`,
    });
  return { ok: errors.length === 0, errors, resulting };
}
