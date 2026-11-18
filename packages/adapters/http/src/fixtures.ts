import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Redactor } from '@nuzm/adapter-contracts';
import type { HttpRequest, HttpResponse, HttpTransport } from './transport';

/**
 * Fixture recorder / replayer (M05 S18 task 13). The recorder wraps a transport and stores REDACTED exchanges (no auth headers, secrets
 * scrubbed by value and key) so that a human-triggered live-verification run can later be replayed in CI. The agent never runs the
 * recorder against a live account (HG-05-0x pending); the replayer only ever yields `fixture` evidence.
 */
export interface RecordedExchange {
  method: string;
  url: string;
  requestBody?: string;
  status: number;
  responseBody: string;
}

const SKIP_HEADERS = /^(authorization|x-auth-token|x-subject-token|x-sdk-date|cookie|x-acs-.*)$/i;
export const stripHeaders = (h: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(h).filter(([k]) => !SKIP_HEADERS.test(k)));

export class RecordingTransport implements HttpTransport {
  readonly exchanges: RecordedExchange[] = [];
  constructor(
    private readonly inner: HttpTransport,
    private readonly redactor: Redactor,
  ) {}
  evidenceKind(url: string) {
    return this.inner.evidenceKind(url);
  }
  async send(req: HttpRequest): Promise<HttpResponse> {
    const res = await this.inner.send(req);
    this.exchanges.push({
      method: req.method,
      url: this.redactor.string(
        req.url.replace(/([?&](?:Signature|signature|X-Amz-Signature)=)[^&]*/g, '$1[REDACTED]'),
      ),
      ...(req.body !== undefined ? { requestBody: this.redactor.string(req.body) } : {}),
      status: res.status,
      responseBody: this.redactor.string(res.body),
    });
    return res;
  }
  save(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify(
        this.exchanges.map((e) => this.redactor.deep(e)),
        null,
        2,
      ) + '\n',
    );
  }
}

/** Replays recorded exchanges in order of matching `method + path`; an unmatched request is a test failure, never a silent success. */
export class ReplayTransport implements HttpTransport {
  private readonly used = new Set<number>();
  constructor(private readonly exchanges: readonly RecordedExchange[]) {}
  evidenceKind(): 'fixture' {
    return 'fixture';
  }
  async send(req: HttpRequest): Promise<HttpResponse> {
    const path = (u: string) => new URL(u).pathname;
    const idx = this.exchanges.findIndex(
      (e, i) => !this.used.has(i) && e.method === req.method && path(e.url) === path(req.url),
    );
    if (idx < 0) throw new Error(`no recorded exchange for ${req.method} ${path(req.url)}`);
    this.used.add(idx);
    const e = this.exchanges[idx]!;
    return { status: e.status, headers: {}, body: e.responseBody };
  }
}
