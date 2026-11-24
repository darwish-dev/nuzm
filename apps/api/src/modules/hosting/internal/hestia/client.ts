import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { AdapterTimeoutError, normalizedError, type NormalizedError } from '../m05-contracts';
import {
  HESTIA_COMMANDS,
  HESTIA_RETURN,
  HestiaArgError,
  buildArgs,
  type HestiaCommandId,
} from './commands';

/** Where a node's HestiaCP panel is and which secret opens it. The access key itself is only ever resolved from the vault at call time. */
export interface HestiaConnection {
  host: string;
  port: number;
  /** `vault://…` reference of a Hestia access key (`ACCESS_KEY_ID:SECRET_ACCESS_KEY`). */
  accessKeyRef: string;
  /** SHA-256 fingerprint (colon-separated hex) of the panel's TLS certificate. Set it when the panel uses a self-signed certificate; unset = normal CA validation. */
  tlsPinSha256?: string | null;
}
export interface HestiaConnections {
  resolve(nodeId: string): Promise<HestiaConnection | null>;
}
export interface HestiaKeys {
  /** `ACCESS_KEY_ID:SECRET_ACCESS_KEY` for a vault reference; throws when it does not resolve. */
  accessKey(ref: string): Promise<string>;
}
export interface HestiaHttpResponse {
  status: number;
  text: string;
}
export interface HestiaChannel {
  post(conn: HestiaConnection, form: string, deadlineMs: number): Promise<HestiaHttpResponse>;
}

const FP = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
export const isFingerprint = (s: string) => FP.test(s.toUpperCase());
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
/** A panel host is a fixed FQDN (no IP literal, no path, no credentials): nothing a browser request says can point the control plane somewhere else. */
export const isPanelHost = (s: string) => HOST.test(s);

/** `POST https://<host>:<port>/api/` as the documented examples do, with the certificate checked (CA, or the pinned fingerprint). `allowPlainLoopback` is for the local mock only. */
export class HttpHestiaChannel implements HestiaChannel {
  constructor(private readonly o: { allowPlainLoopback?: boolean } = {}) {}
  post(conn: HestiaConnection, form: string, deadlineMs: number): Promise<HestiaHttpResponse> {
    return new Promise((resolve, reject) => {
      const loop =
        this.o.allowPlainLoopback && (conn.host === '127.0.0.1' || conn.host === 'localhost');
      if (!loop && !isPanelHost(conn.host))
        return reject(new Error('the panel host is not a valid fqdn'));
      const pin = conn.tlsPinSha256 ? conn.tlsPinSha256.toUpperCase() : null;
      const opts = {
        host: conn.host,
        port: conn.port,
        path: '/api/',
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': Buffer.byteLength(form),
        },
        ...(loop ? {} : { servername: conn.host, rejectUnauthorized: !pin }),
      };
      const req = (loop ? httpRequest : httpsRequest)(opts, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > 2_000_000) req.destroy(new Error('the panel answer is too large'));
          else chunks.push(c);
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
        );
      });
      req.setTimeout(deadlineMs, () =>
        req.destroy(new AdapterTimeoutError('the panel did not answer in time')),
      );
      req.on('error', reject);
      if (pin)
        req.on('socket', (s) => {
          s.on('secureConnect', () => {
            const cert = (
              s as unknown as { getPeerCertificate(): { fingerprint256?: string } }
            ).getPeerCertificate();
            if ((cert.fingerprint256 ?? '').toUpperCase() !== pin)
              req.destroy(new Error('the panel certificate does not match the pinned fingerprint'));
          });
        });
      req.end(form);
    });
  }
}

export type HestiaResult =
  | { ok: true; code: 0; data: unknown; summary: string }
  | { ok: false; uncertain: boolean; error: NormalizedError; summary: string };

/** Runs allow-listed commands on a node. Mutating commands use `returncode=yes` (the body is the numeric return code); reads ask for JSON. */
export class HestiaClient {
  constructor(
    private readonly connections: HestiaConnections,
    private readonly keys: HestiaKeys,
    private readonly channel: HestiaChannel,
  ) {}

  async run(
    nodeId: string,
    id: HestiaCommandId,
    values: Record<string, string | undefined>,
    deadlineMs: number,
  ): Promise<HestiaResult> {
    const def = HESTIA_COMMANDS[id];
    const summary = def.cmd; // never the arguments: they carry domains and passwords
    let args: string[];
    try {
      args = buildArgs(def, values);
    } catch (e) {
      if (e instanceof HestiaArgError)
        return {
          ok: false,
          uncertain: false,
          summary,
          error: normalizedError('validation', 'bad_args', e.message),
        };
      throw e;
    }
    const conn = await this.connections.resolve(nodeId);
    if (!conn)
      return {
        ok: false,
        uncertain: false,
        summary,
        error: normalizedError('unsupported', 'no_panel', 'this node has no panel connection'),
      };
    let hash: string;
    try {
      hash = await this.keys.accessKey(conn.accessKeyRef);
    } catch {
      return {
        ok: false,
        uncertain: false,
        summary,
        error: normalizedError('auth', 'no_key', 'the panel access key cannot be read'),
      };
    }
    const asJson = !!def.json;
    const form = new URLSearchParams({ hash, returncode: asJson ? 'no' : 'yes', cmd: def.cmd });
    args.forEach((v, i) => form.set(`arg${i + 1}`, v));
    if (asJson) form.set(`arg${args.length + 1}`, 'json');
    try {
      const res = await this.channel.post(conn, form.toString(), deadlineMs);
      if (res.status === 401 || res.status === 403)
        return {
          ok: false,
          uncertain: false,
          summary,
          error: normalizedError('auth', `http_${res.status}`, 'the panel refused the access key'),
        };
      if (res.status >= 500 || res.status === 0)
        return this.lost(
          def.mutating,
          summary,
          `http_${res.status}`,
          'the panel had a server error',
        );
      const text = res.text.trim();
      if (!asJson) {
        const code = /^\d{1,3}$/.test(text) ? Number(text) : NaN;
        if (Number.isNaN(code))
          return this.lost(
            def.mutating,
            summary,
            'unreadable',
            'the panel answer was not a return code',
          );
        if (code === 0) return { ok: true, code: 0, data: null, summary };
        const r = HESTIA_RETURN[code];
        return {
          ok: false,
          uncertain: false,
          summary,
          error: normalizedError(
            r?.category ?? 'unknown',
            r?.name ?? `code_${code}`,
            `the panel returned ${r?.name ?? code}`,
          ),
        };
      }
      // a read: JSON on success; a numeric body is a return code (an error)
      if (/^\d{1,3}$/.test(text)) {
        const code = Number(text);
        const r = HESTIA_RETURN[code];
        if (code === 0) return { ok: true, code: 0, data: {}, summary };
        return {
          ok: false,
          uncertain: false,
          summary,
          error: normalizedError(
            r?.category ?? 'unknown',
            r?.name ?? `code_${code}`,
            `the panel returned ${r?.name ?? code}`,
          ),
        };
      }
      try {
        return { ok: true, code: 0, data: text === '' ? {} : JSON.parse(text), summary };
      } catch {
        return {
          ok: false,
          uncertain: false,
          summary,
          error: normalizedError('unknown', 'unreadable', 'the panel answer was not JSON'),
        };
      }
    } catch (e) {
      if (
        (e as Error).name === 'AdapterTimeoutError' ||
        /certificate|pinned/.test((e as Error).message)
      )
        return (e as Error).name === 'AdapterTimeoutError'
          ? this.lost(def.mutating, summary, 'timeout', 'the panel did not answer in time')
          : {
              ok: false,
              uncertain: false,
              summary,
              error: normalizedError('auth', 'tls', 'the panel certificate was refused'),
            };
      return this.lost(def.mutating, summary, 'connect', 'the panel could not be reached');
    }
  }

  /** A lost answer on a mutating command is `uncertain` (the effect is unknown: reconcile before any retry); on a read it is a plain outage. */
  private lost(mutating: boolean, summary: string, code: string, message: string): HestiaResult {
    return {
      ok: false,
      uncertain: mutating,
      summary,
      error: normalizedError('provider_outage', code, message),
    };
  }
}
