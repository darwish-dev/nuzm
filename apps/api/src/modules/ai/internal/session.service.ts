import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { defaultModeration, scanForSecrets } from '@nuzm/domain';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import type { FieldCipher } from '../../../common/field-crypto';
import { decodeCursor, pageOf } from '../../../common/pagination';
import { isUuid, type AiConfig, type Row } from './model';

const PERSONAL = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})|(\+?\d[\d\s()-]{7,}\d)/;
export const MAX_MESSAGE_CHARS = 20_000;

export interface SessionDto {
  id: string;
  title: string;
  projectId: string | null;
  state: string;
  dataRegion: string;
  createdAt: string;
}
export interface MessageDto {
  id: string;
  sessionId: string;
  runId: string | null;
  role: string;
  content: string;
  classification: string;
  attachments: unknown[];
  createdAt: string;
}
const sdto = (r: Row): SessionDto => ({
  id: r.id as string,
  title: r.title as string,
  projectId: (r.project_id as string | null) ?? null,
  state: r.state as string,
  dataRegion: r.data_region as string,
  createdAt: new Date(r.created_at as string).toISOString(),
});

/** AI sessions and messages (docs/04 §2.9). Message bodies are sealed with field encryption (`customer-content`, or `personal` when an e-mail or phone number is detected). */
export class SessionService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly cipher: FieldCipher,
    private readonly cfg: AiConfig,
  ) {}

  async create(orgId: string, userId: string, b: Record<string, unknown>): Promise<SessionDto> {
    const title = typeof b.title === 'string' ? b.title.trim() : '';
    if (title.length < 1 || title.length > 200)
      throw new ProblemException('validation_failed', 'title must be 1..200 characters');
    if (b.projectId !== undefined && b.projectId !== null && !isUuid(b.projectId))
      throw new ProblemException('validation_failed', 'projectId must be a uuid');
    const id = uuidv7();
    const row = await this.db.withOrg(orgId, async (c) => {
      if (b.projectId) {
        const p = (
          await c.query(`SELECT 1 FROM builder.projects WHERE id=$1 AND deleted_at IS NULL`, [
            b.projectId,
          ])
        ).rows[0];
        if (!p) throw new ProblemException('not_found', 'project not found');
      }
      return (
        await c.query(
          `INSERT INTO ai.sessions (id, org_id, project_id, title, data_region, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [id, orgId, b.projectId ?? null, title, this.cfg.dataRegion, userId],
        )
      ).rows[0] as Row;
    });
    await this.audit.record({
      action: 'ai.session.created',
      actorUserId: userId,
      actorType: 'user',
      orgId,
      resource: { type: 'ai_session', id },
      outcome: 'success',
    });
    return sdto(row);
  }
  async list(orgId: string, o: { limit: number; cursor?: string }) {
    const cur = decodeCursor(o.cursor);
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM ai.sessions WHERE ($1::uuid IS NULL OR id < $1) ORDER BY id DESC LIMIT $2`,
            [cur, o.limit + 1],
          )
        ).rows as Row[],
    );
    const p = pageOf(
      rows.map((r) => ({ ...sdto(r) })),
      o.limit,
    );
    return p;
  }
  async get(orgId: string, id: string): Promise<SessionDto> {
    if (!isUuid(id)) throw new ProblemException('not_found');
    const r = (await this.db.withOrg(
      orgId,
      async (c) => (await c.query(`SELECT * FROM ai.sessions WHERE id=$1`, [id])).rows[0],
    )) as Row | undefined;
    if (!r) throw new ProblemException('not_found');
    return sdto(r);
  }
  async messages(orgId: string, sessionId: string, o: { limit: number; cursor?: string }) {
    await this.get(orgId, sessionId);
    const cur = decodeCursor(o.cursor);
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM ai.messages WHERE session_id=$1 AND ($2::uuid IS NULL OR id > $2) ORDER BY id ASC LIMIT $3`,
            [sessionId, cur, o.limit + 1],
          )
        ).rows as Row[],
    );
    const items = await Promise.all(rows.slice(0, o.limit).map((r) => this.open(r)));
    return {
      items,
      nextCursor:
        rows.length > o.limit
          ? Buffer.from(items[items.length - 1]!.id).toString('base64url')
          : null,
    };
  }
  private async open(r: Row): Promise<MessageDto> {
    return {
      id: r.id as string,
      sessionId: r.session_id as string,
      runId: (r.run_id as string | null) ?? null,
      role: r.role as string,
      content: await this.cipher.decrypt(r.content_enc as string, {
        column: 'ai.messages.content_enc',
        row: r.id as string,
      }),
      classification: r.classification as string,
      attachments: (r.attachments as unknown[]) ?? [],
      createdAt: new Date(r.created_at as string).toISOString(),
    };
  }
  static validateAttachments(a: unknown): unknown[] {
    if (a === undefined) return [];
    if (!Array.isArray(a) || a.length > 10)
      throw new ProblemException('validation_failed', 'attachments must be a list of at most 10');
    return a.map((x: { kind?: unknown; url?: unknown; name?: unknown; text?: unknown }, i) => {
      if (x?.kind === 'url') {
        if (typeof x.url !== 'string' || !/^https?:\/\/[^\s<>"']{3,1900}$/.test(x.url))
          throw new ProblemException(
            'validation_failed',
            `attachments[${i}].url must be an http(s) URL`,
          );
        return { kind: 'url', url: x.url };
      }
      if (x?.kind === 'text') {
        if (
          typeof x.name !== 'string' ||
          x.name.length < 1 ||
          x.name.length > 100 ||
          typeof x.text !== 'string' ||
          x.text.length > MAX_MESSAGE_CHARS
        )
          throw new ProblemException(
            'validation_failed',
            `attachments[${i}] needs a name (≤100) and text (≤${MAX_MESSAGE_CHARS})`,
          );
        return { kind: 'text', name: x.name, text: x.text };
      }
      throw new ProblemException('validation_failed', `attachments[${i}].kind must be url or text`);
    });
  }
  /** A user message. Moderation (placeholder deny-list, policy owner open) and the secret scan run BEFORE anything is stored. */
  async addMessage(
    orgId: string,
    userId: string,
    sessionId: string,
    b: Record<string, unknown>,
  ): Promise<MessageDto> {
    await this.get(orgId, sessionId);
    const content = typeof b.content === 'string' ? b.content : '';
    if (content.trim().length < 1 || content.length > MAX_MESSAGE_CHARS)
      throw new ProblemException(
        'validation_failed',
        `content must be 1..${MAX_MESSAGE_CHARS} characters`,
      );
    const attachments = SessionService.validateAttachments(b.attachments);
    const all = [content, ...attachments.map((a) => (a as { text?: string }).text ?? '')].join(
      '\n',
    );
    const mod = defaultModeration(all);
    if (!mod.allowed) {
      await this.audit.record({
        action: 'ai.content.blocked',
        actorUserId: userId,
        actorType: 'user',
        orgId,
        resource: { type: 'ai_session', id: sessionId },
        outcome: 'failure',
        detail: { categories: mod.categories },
      });
      throw new ProblemException(
        'content_blocked',
        'the message is blocked by the content policy',
        undefined,
        { categories: mod.categories },
      );
    }
    const secrets = scanForSecrets(all, this.cfg.canaries);
    if (secrets.length) {
      await this.audit.record({
        action: 'ai.secret_scan.blocked',
        actorUserId: userId,
        actorType: 'user',
        orgId,
        resource: { type: 'ai_session', id: sessionId },
        outcome: 'failure',
        detail: { kinds: [...new Set(secrets.map((s) => s.kind))], where: 'message' },
      });
      throw new ProblemException(
        'secret_detected',
        'the message looks like it contains a secret and was not stored',
      );
    }
    return this.store(orgId, userId, sessionId, null, 'user', content, attachments);
  }
  async store(
    orgId: string,
    userId: string | null,
    sessionId: string,
    runId: string | null,
    role: 'user' | 'assistant' | 'system',
    content: string,
    attachments: unknown[] = [],
  ): Promise<MessageDto> {
    const id = uuidv7();
    const sealed = await this.cipher.encrypt(content, {
      column: 'ai.messages.content_enc',
      row: id,
    });
    const hash = createHash('sha256').update(content).digest('hex');
    const cls = PERSONAL.test(content) ? 'personal' : 'customer-content';
    const row = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `INSERT INTO ai.messages (id, org_id, session_id, run_id, role, content_enc, content_hash, classification, attachments, data_region, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
            [
              id,
              orgId,
              sessionId,
              runId,
              role,
              sealed,
              hash,
              cls,
              JSON.stringify(attachments),
              this.cfg.dataRegion,
              userId,
            ],
          )
        ).rows[0] as Row,
    );
    return this.open(row);
  }
}
