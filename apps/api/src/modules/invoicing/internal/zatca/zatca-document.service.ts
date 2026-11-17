import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import { ArchiveCorrupt, type ArchiveStore } from './archive';
import { buildDocument, type ZatcaDocument } from './build-document';
import { documentHash, firstPih, verifyChain, type ChainProblem } from './hash-chain';
import type { ZatcaProfile } from './profile';
import { encodeTlv } from './qr-tlv';
import { signDocumentHash, type KeyVault } from './signing';
import { assemble, buildBody, money, stripStamp } from './ubl';
import { validateDocument, type ValidationResult } from './validator';

type Row = Record<string, unknown>;
export type ZatcaMode = 'off' | 'sandbox' | 'simulation';
const ICV_SERIES: Record<'sandbox' | 'simulation', string> = {
  sandbox: 'ICVSBX',
  simulation: 'ICVSIM',
};

export interface ZatcaDocumentDto {
  id: string;
  environment: 'sandbox' | 'simulation';
  sourceType: 'invoice' | 'credit_note';
  sourceId: string;
  documentType: string;
  subtype: 'standard' | 'simplified';
  uuid: string;
  icv: string;
  pih: string;
  invoiceHash: string;
  stamped: boolean;
  qr: string | null;
  archived: boolean;
  /** Always true while the profile is synthetic: nothing here is verified against ZATCA. */
  notVerifiedVsZatca: boolean;
  createdAt: string;
}

/**
 * E-invoice documents (docs/11 §5), SYNTHETIC profile. The rules that matter:
 *  - **One document per issued legal document and environment**, generated idempotently; the hash chain (ICV, PIH) is per billing entity and
 *    environment, serialized by an advisory lock and re-checked by a database trigger; the ICV is allocated in the same transaction as the
 *    document, so a failure gives the number back and the chain never has a gap.
 *  - **Nothing is generated unless it validates** (seller VAT number present and well-formed, totals, references); a failure creates nothing.
 *  - **Stamping is separate and once**: the signature and QR need credentials (a CSID) that exist only after onboarding (S11b); the hashed body
 *    never changes, so the chain does not depend on when a document is stamped.
 *  - **Not production:** `production` is not a mode of this build; it needs HG-03-03 evidence and the owner's decision.
 */
export class ZatcaDocumentService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    readonly profile: ZatcaProfile,
    private readonly archive: ArchiveStore,
    readonly mode: ZatcaMode = 'off',
  ) {}

  static modeFromEnv(env: NodeJS.ProcessEnv = process.env): ZatcaMode {
    const m = env.ZATCA_MODE ?? 'off';
    if (m === 'production')
      throw new Error(
        "ZATCA_MODE=production is refused: it needs HG-03-03 evidence and the owner's explicit decision (never set by the agent)",
      );
    if (m !== 'off' && m !== 'sandbox' && m !== 'simulation')
      throw new Error('ZATCA_MODE must be off, sandbox or simulation');
    return m;
  }

  private env(): 'sandbox' | 'simulation' {
    if (this.mode === 'off')
      throw new ProblemException('conflict', 'e-invoicing is not enabled (ZATCA_MODE=off)');
    return this.mode;
  }

  private toDto(r: Row): ZatcaDocumentDto {
    return {
      id: r.id as string,
      environment: r.environment as 'sandbox' | 'simulation',
      sourceType: r.source_type as 'invoice' | 'credit_note',
      sourceId: r.source_id as string,
      documentType: r.document_type as string,
      subtype: r.subtype as 'standard' | 'simplified',
      uuid: r.uuid as string,
      icv: String(r.icv),
      pih: r.pih as string,
      invoiceHash: r.invoice_hash as string,
      stamped: r.xml_final !== null,
      qr: (r.qr as string | null) ?? null,
      archived: r.archive_ref !== null,
      notVerifiedVsZatca: this.profile.synthetic,
      createdAt: (r.created_at as Date).toISOString(),
    };
  }

  // ---- generate -----------------------------------------------------------------------------------------------------

  async generate(
    orgId: string,
    source: { type: 'invoice' | 'credit_note'; id: string },
    now = new Date(),
  ): Promise<ZatcaDocumentDto> {
    const env = this.env();
    const done = await this.bySource(orgId, source.type, source.id);
    if (done) return done;
    try {
      return await this.db.withOrg(orgId, async (c) => {
        const src = await this.load(c, orgId, source);
        await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
          `zatca-chain:${src.entityId}:${env}`,
        ]);
        const again = (
          await c.query(
            `SELECT * FROM invoicing.zatca_documents WHERE source_type = $1 AND source_id = $2 AND environment = $3`,
            [source.type, source.id, env],
          )
        ).rows[0];
        if (again) return this.toDto(again as Row);
        const tip = (
          await c.query<{ icv: string; invoice_hash: string }>(
            `SELECT icv::text, invoice_hash FROM invoicing.zatca_chain_tip($1, $2)`,
            [src.entityId, env],
          )
        ).rows[0];
        const pih = tip ? tip.invoice_hash : firstPih(this.profile);
        const icv = BigInt(
          (
            await c.query<{ n: string }>(`SELECT invoicing.allocate_number($1, $2)::text n`, [
              src.entityId,
              ICV_SERIES[env],
            ])
          ).rows[0]!.n,
        );
        if (icv !== (tip ? BigInt(tip.icv) + 1n : 1n))
          throw new ProblemException(
            'conflict',
            'the invoice counter is out of step with the chain; refusing to continue',
          );
        const uuid = randomUUID();
        const doc: ZatcaDocument = buildDocument(this.profile, { ...src.doc, uuid, icv, pih });
        const v = validateDocument(this.profile, doc, { now });
        if (!v.valid)
          throw new ProblemException(
            'validation_failed',
            `the document does not validate: ${v.issues
              .filter((i) => i.severity === 'error')
              .map((i) => i.code)
              .join(', ')}`,
          );
        const body = buildBody(this.profile, doc);
        const hash = documentHash(body);
        const row = (
          await c.query(
            `INSERT INTO invoicing.zatca_documents (id, org_id, entity_id, environment, source_type, source_id, document_type, subtype, uuid, icv, pih, invoice_hash, xml_body, data_region, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
            [
              randomUUID(),
              orgId,
              src.entityId,
              env,
              source.type,
              source.id,
              doc.type,
              doc.subtype,
              uuid,
              icv.toString(),
              pih,
              hash,
              body,
              src.dataRegion,
              now,
            ],
          )
        ).rows[0] as Row;
        await this.audit.record({
          action: 'invoicing.zatca_document.generated',
          actorType: 'system',
          orgId,
          resource: { type: 'zatca_document', id: row.id as string },
          outcome: 'success',
          after: {
            sourceType: source.type,
            sourceId: source.id,
            icv: icv.toString(),
            environment: env,
            subtype: doc.subtype,
            notVerifiedVsZatca: this.profile.synthetic,
          },
        });
        return this.toDto(row);
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        const winner = await this.bySource(orgId, source.type, source.id);
        if (winner) return winner;
      }
      throw e;
    }
  }

  /** The legal document as a generator input (everything except uuid, icv and pih, which the chain assigns). */
  private async load(
    c: PoolClient,
    orgId: string,
    source: { type: 'invoice' | 'credit_note'; id: string },
  ) {
    if (source.type === 'invoice') {
      const inv = (
        await c.query(`SELECT * FROM invoicing.invoices WHERE id = $1 AND org_id = $2`, [
          source.id,
          orgId,
        ])
      ).rows[0] as Row | undefined;
      if (!inv) throw new ProblemException('not_found', 'invoice not found');
      if (inv.status === 'draft')
        throw new ProblemException('conflict', 'a draft invoice has no e-invoice');
      const lines = (
        await c.query(
          `SELECT * FROM invoicing.invoice_lines WHERE invoice_id = $1 ORDER BY position`,
          [source.id],
        )
      ).rows as Row[];
      return {
        entityId: inv.entity_id as string,
        dataRegion: inv.data_region as string,
        doc: {
          type: 'invoice' as const,
          number: inv.number_text as string,
          issuedAt: inv.issued_at as Date,
          currency: inv.currency as string,
          seller: inv.seller as Row,
          buyer: inv.buyer as Row,
          lines: lines.map((l) => ({
            quantity: String(l.quantity),
            unit: l.unit as string,
            description: l.description as string,
            netMinor: String(l.net_minor),
            taxMinor: String(l.tax_minor),
            rateBps: l.rate_bps as number,
          })),
          reference: null,
        },
      };
    }
    const cn = (
      await c.query(`SELECT * FROM invoicing.credit_notes WHERE id = $1 AND org_id = $2`, [
        source.id,
        orgId,
      ])
    ).rows[0] as Row | undefined;
    if (!cn) throw new ProblemException('not_found', 'credit note not found');
    if (cn.status === 'draft')
      throw new ProblemException('conflict', 'a draft credit note has no e-invoice');
    const inv = (await c.query(`SELECT * FROM invoicing.invoices WHERE id = $1`, [cn.invoice_id]))
      .rows[0] as Row;
    const invLines = new Map(
      (
        (
          await c.query(`SELECT * FROM invoicing.invoice_lines WHERE invoice_id = $1`, [
            cn.invoice_id,
          ])
        ).rows as Row[]
      ).map((l) => [l.id as string, l]),
    );
    const lines = (cn.lines as { invoiceLineId: string; netMinor: string; taxMinor: string }[]).map(
      (l) => {
        const o = invLines.get(l.invoiceLineId);
        if (!o)
          throw new ProblemException(
            'conflict',
            'a credit note line refers to an unknown invoice line',
          );
        return {
          quantity: '1',
          unit: o.unit as string,
          description: o.description as string,
          netMinor: String(l.netMinor),
          taxMinor: String(l.taxMinor),
          rateBps: o.rate_bps as number,
        };
      },
    );
    return {
      entityId: cn.entity_id as string,
      dataRegion: inv.data_region as string,
      doc: {
        type: 'credit_note' as const,
        number: cn.number_text as string,
        issuedAt: cn.issued_at as Date,
        currency: cn.currency as string,
        seller: inv.seller as Row,
        buyer: inv.buyer as Row,
        lines,
        reference: { number: inv.number_text as string, reason: cn.reason as string },
      },
    };
  }

  // ---- stamp & archive -----------------------------------------------------------------------------------------------

  /** Sign the document hash with the key behind `keyRef`, build the QR, and set the final XML. Once: a stamped document is returned as is. */
  async stamp(
    orgId: string,
    documentId: string,
    vault: KeyVault,
    keyRef: string,
    now = new Date(),
  ): Promise<ZatcaDocumentDto> {
    const r = await this.row(orgId, documentId);
    if (r.xml_final !== null) return this.toDto(r);
    const body = r.xml_body as string;
    if (documentHash(body) !== r.invoice_hash)
      throw new ProblemException(
        'conflict',
        'the stored body no longer matches its hash; refusing to stamp',
      );
    const { signature, publicKey } = await signDocumentHash(
      vault,
      keyRef,
      r.invoice_hash as string,
    );
    const inv = await this.model(orgId, r);
    const qr = encodeTlv([
      { tag: 1, value: Buffer.from(inv.seller.nameEn, 'utf8') },
      { tag: 2, value: Buffer.from(inv.seller.vatNumber ?? '', 'utf8') },
      { tag: 3, value: Buffer.from(inv.issuedAt.toISOString().slice(0, 19) + 'Z', 'utf8') },
      { tag: 4, value: Buffer.from(money(inv.totals.totalMinor), 'utf8') },
      { tag: 5, value: Buffer.from(money(inv.totals.taxMinor), 'utf8') },
      { tag: 6, value: Buffer.from(r.invoice_hash as string, 'utf8') },
      { tag: 7, value: Buffer.from(signature, 'base64') },
      { tag: 8, value: Buffer.from(publicKey, 'base64') },
    ]);
    const finalXml = assemble(body, qr, signature, publicKey);
    await this.db.withOrg(orgId, async (c) => {
      const u = await c.query(
        `UPDATE invoicing.zatca_documents SET xml_final = $2, signature = $3, public_key = $4, qr = $5, stamped_at = $6 WHERE id = $1 AND xml_final IS NULL`,
        [documentId, finalXml, signature, publicKey, qr, now],
      );
      if (u.rowCount)
        await this.audit.record({
          action: 'invoicing.zatca_document.stamped',
          actorType: 'system',
          orgId,
          resource: { type: 'zatca_document', id: documentId },
          outcome: 'success',
          after: { keyRef, notVerifiedVsZatca: this.profile.synthetic },
        });
    });
    return this.ensureArchived(orgId, documentId);
  }

  /** The stamped XML goes to the WORM archive once; a missing object is rewritten from the database copy, a damaged one is reported. */
  async ensureArchived(orgId: string, documentId: string): Promise<ZatcaDocumentDto> {
    const r = await this.row(orgId, documentId);
    if (r.xml_final === null) return this.toDto(r);
    const bytes = Buffer.from(r.xml_final as string, 'utf8');
    const key = `${r.environment as string}/${r.entity_id as string}/${String(r.icv).padStart(10, '0')}.xml`;
    if (r.archive_ref === null) {
      const put = await this.archive.put(key, bytes);
      await this.db.withOrg(orgId, (c) =>
        c.query(
          `UPDATE invoicing.zatca_documents SET archive_ref = $2, archive_sha256 = $3, archived_at = now() WHERE id = $1 AND archive_ref IS NULL`,
          [documentId, put.ref, put.sha256],
        ),
      );
    } else {
      try {
        await this.archive.get(r.archive_ref as string, r.archive_sha256 as string);
      } catch (e) {
        if (e instanceof ArchiveCorrupt) throw e;
        await this.archive.put(r.archive_ref as string, bytes); // the object is missing: rewrite it from the database copy
      }
    }
    return this.toDto(await this.row(orgId, documentId));
  }

  // ---- reads & verification ------------------------------------------------------------------------------------------

  private async row(orgId: string, id: string): Promise<Row> {
    const r = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(`SELECT * FROM invoicing.zatca_documents WHERE id = $1 AND org_id = $2`, [
            id,
            orgId,
          ])
        ).rows[0],
    );
    if (!r) throw new ProblemException('not_found');
    return r as Row;
  }
  async get(orgId: string, id: string): Promise<ZatcaDocumentDto> {
    return this.toDto(await this.row(orgId, id));
  }
  async bySource(
    orgId: string,
    type: 'invoice' | 'credit_note',
    id: string,
  ): Promise<ZatcaDocumentDto | null> {
    if (this.mode === 'off') return null;
    const r = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM invoicing.zatca_documents WHERE org_id = $1 AND source_type = $2 AND source_id = $3 AND environment = $4`,
            [orgId, type, id, this.mode],
          )
        ).rows[0],
    );
    return r ? this.toDto(r as Row) : null;
  }
  /** Rebuild the model of a stored document (to validate it again, or to build the QR from the same numbers). */
  private async model(orgId: string, r: Row): Promise<ZatcaDocument> {
    return this.db.withOrg(orgId, async (c) => {
      const src = await this.load(c, orgId, {
        type: r.source_type as 'invoice' | 'credit_note',
        id: r.source_id as string,
      });
      return buildDocument(this.profile, {
        ...src.doc,
        uuid: r.uuid as string,
        icv: BigInt(r.icv as string),
        pih: r.pih as string,
      });
    });
  }
  /** Re-validate a stored document against its current source rows (the XML must still equal the model). */
  async validateStored(orgId: string, id: string, now = new Date()): Promise<ValidationResult> {
    const r = await this.row(orgId, id);
    return validateDocument(this.profile, await this.model(orgId, r), {
      now,
      xmlBody: r.xml_body as string,
    });
  }

  /** Continuity of an entity's chain across ALL organizations (icv from 1, no gap, no duplicate, pih = previous hash). */
  async verifyChain(
    entityId: string,
    environment: 'sandbox' | 'simulation',
  ): Promise<{ checked: number; problems: ChainProblem[] }> {
    const rows = await this.db.withoutScope(
      async (c) =>
        (
          await c.query<{ icv: string; pih: string; invoice_hash: string }>(
            `SELECT icv::text, pih, invoice_hash FROM invoicing.zatca_chain($1, $2)`,
            [entityId, environment],
          )
        ).rows,
    );
    const links = rows.map((r) => ({
      icv: BigInt(r.icv),
      pih: r.pih,
      invoiceHash: r.invoice_hash,
    }));
    return { checked: links.length, problems: verifyChain(links, this.profile) };
  }
  /** Content of one organization's documents: every body still hashes to its recorded hash, and every stamped XML is its body plus the stamp. */
  async verifyStored(orgId: string): Promise<{ checked: number; problems: string[] }> {
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT icv, invoice_hash, xml_body, xml_final FROM invoicing.zatca_documents WHERE org_id = $1 ORDER BY icv`,
            [orgId],
          )
        ).rows as Row[],
    );
    const problems: string[] = [];
    for (const r of rows) {
      if (documentHash(r.xml_body as string) !== r.invoice_hash)
        problems.push(`icv ${String(r.icv)}: body no longer matches its hash`);
      if (r.xml_final !== null && stripStamp(r.xml_final as string) !== r.xml_body)
        problems.push(`icv ${String(r.icv)}: stamped XML is not the body plus the stamp`);
    }
    return { checked: rows.length, problems };
  }
}
