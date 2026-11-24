import {
  normalizedError,
  type AccountContext,
  type EvidenceKind,
  type OperationResult,
  type RawEvidence,
} from '../m05-contracts';
import type { NodeRef, WordPressNodePort, WpSite } from '../ports';
import type { HestiaClient, HestiaResult } from './client';
import type { HestiaCommandId } from './commands';

/**
 * Managed WordPress on a Hestia node (ADR-068). Hestia's "Quick Install" is panel PHP (`WordPressSetup.php`): it has no CLI command and no REST entry, so it cannot be
 * called. What it does is reproduced from the SAME documented commands it calls (read in the official repository 2026-11-24, NOT VERIFIED against a node):
 *   v-delete-fs-file (placeholders) → v-add-user-wp-cli → v-add-database → `wp core download` → `wp config create` → `wp core install` → v-change-web-domain-tpl wordpress
 * with WP-CLI run through `v-run-cli-cmd <user> /usr/bin/php<ver> <home>/.wp-cli/wp …` as the site's own non-root user. Two deliberate differences, both recorded in the ADR:
 *  - Quick Install installs by an HTTP POST because of a WP-CLI quirk with spaces in the title; here the title is the domain (no spaces) and the customer renames the site in WordPress;
 *  - every argument is one `wparg` token (`commands.ts`): nothing with a space, quote or shell metacharacter can reach the node.
 * WP-CLI refuses to overwrite an existing installation or configuration, so a retry after any interruption cannot destroy content; the service decides what to run from the OBSERVED phase.
 * An argument passed to WP-CLI (the generated DB and admin passwords) is visible in the node's process list for the seconds the command runs: the node setup mounts /proc with hidepid=2.
 */
type R<T = void> = OperationResult<T>;
const phpBin = (runtime: string): string | null => {
  const m = /^php:(\d)\.(\d{1,2})$/.exec(runtime);
  return m ? `/usr/bin/php${m[1]}.${m[2]}` : null;
};
const docroot = (s: WpSite) => `/home/${s.name}/web/${s.domain}/public_html`;

export class HestiaWordPress implements WordPressNodePort {
  constructor(
    private readonly client: HestiaClient,
    private readonly o: { evidenceKind?: EvidenceKind; now?: () => Date } = {},
  ) {}
  private ev(operation: string, summary: string): RawEvidence {
    return {
      kind: this.o.evidenceKind ?? 'live',
      capturedAt: (this.o.now?.() ?? new Date()).toISOString(),
      operation,
      summary,
    };
  }
  private run(
    ctx: AccountContext,
    node: NodeRef,
    id: HestiaCommandId,
    v: Record<string, string | undefined>,
  ) {
    return this.client.run(node.nodeId, id, v, ctx.deadlineMs);
  }
  private bad<T>(op: string, r: Extract<HestiaResult, { ok: false }>): R<T> {
    return {
      status: r.uncertain ? 'uncertain' : 'failed',
      error: r.error,
      raw: this.ev(op, r.summary),
    };
  }
  private okv(op: string, summary: string): R<void> {
    return { status: 'succeeded', raw: this.ev(op, summary) };
  }

  /** `wp <words…>` as the site user; the words are validated one by one. */
  private async wp(
    ctx: AccountContext,
    node: NodeRef,
    site: WpSite,
    op: string,
    words: string[],
  ): Promise<R<void>> {
    const php = phpBin(site.runtime);
    if (!php)
      return {
        status: 'failed',
        error: normalizedError('unsupported', 'runtime', 'WordPress needs a PHP runtime'),
        raw: this.ev(op, 'no php'),
      };
    if (words.length > 16)
      return {
        status: 'failed',
        error: normalizedError('validation', 'bad_args', 'too many arguments'),
        raw: this.ev(op, 'args'),
      };
    const values: Record<string, string> = {
      user: site.name,
      php,
      wp: `/home/${site.name}/.wp-cli/wp`,
    };
    words.forEach((w, i) => (values[`w${i + 1}`] = w));
    const r = await this.run(ctx, node, 'runWpCli', values);
    return r.ok ? this.okv(op, `v-run-cli-cmd wp ${op}`) : this.bad(op, r);
  }

  async ensureWpCli(ctx: AccountContext, node: NodeRef, site: WpSite): Promise<R> {
    const r = await this.run(ctx, node, 'addWpCli', { user: site.name, update: 'yes' });
    return r.ok ? this.okv('wp-cli', 'v-add-user-wp-cli') : this.bad('wp-cli', r);
  }

  async ensureDatabase(
    ctx: AccountContext,
    node: NodeRef,
    site: WpSite,
    db: { name: string; user: string; password: string },
  ): Promise<R<{ dbName: string; dbUser: string }>> {
    // Hestia prefixes both with `<account>_`; the full names are what WordPress is configured with
    const dbName = `${site.name}_${db.name}`;
    const dbUser = `${site.name}_${db.user}`;
    const have = await this.run(ctx, node, 'listDatabases', { user: site.name });
    if (!have.ok) return this.bad('database', have);
    const exists =
      dbName in
      (have.data && typeof have.data === 'object' ? (have.data as Record<string, unknown>) : {});
    if (!exists) {
      const add = await this.run(ctx, node, 'addDatabase', {
        user: site.name,
        database: db.name,
        dbuser: db.user,
        dbpass: db.password,
        type: 'mysql',
        host: 'localhost',
        charset: 'utf8mb4',
      });
      if (!add.ok && add.error.providerCode !== 'E_EXISTS') return this.bad('database', add);
    }
    return {
      status: 'succeeded',
      data: { dbName, dbUser },
      raw: this.ev('database', exists ? 'present' : 'v-add-database'),
    };
  }

  /** Quick Install deletes the two placeholder files of a fresh docroot (`index.html`, `robots.txt`); one that is already gone is fine. */
  async prepareDocroot(ctx: AccountContext, node: NodeRef, site: WpSite): Promise<R> {
    for (const f of ['index.html', 'robots.txt']) {
      const r = await this.run(ctx, node, 'deleteFsFile', {
        user: site.name,
        file: `${docroot(site)}/${f}`,
      });
      if (!r.ok && r.error.providerCode !== 'E_NOTEXIST') return this.bad('placeholders', r);
    }
    return this.okv('placeholders', 'v-delete-fs-file');
  }

  download(ctx: AccountContext, node: NodeRef, site: WpSite, locale: string): Promise<R> {
    return this.wp(ctx, node, site, 'core download', [
      'core',
      'download',
      `--locale=${locale}`,
      '--version=latest',
      `--path=${docroot(site)}`,
    ]);
  }

  configure(
    ctx: AccountContext,
    node: NodeRef,
    site: WpSite,
    c: { dbName: string; dbUser: string; dbPassword: string; prefix: string; locale: string },
  ): Promise<R> {
    return this.wp(ctx, node, site, 'config create', [
      'config',
      'create',
      `--dbname=${c.dbName}`,
      `--dbuser=${c.dbUser}`,
      `--dbpass=${c.dbPassword}`,
      '--dbhost=localhost',
      `--dbprefix=${c.prefix}`,
      '--dbcharset=utf8mb4',
      `--locale=${c.locale}`,
      `--path=${docroot(site)}`,
    ]);
  }

  install(
    ctx: AccountContext,
    node: NodeRef,
    site: WpSite,
    i: { title: string; adminUser: string; adminPassword: string; adminEmail: string },
  ): Promise<R> {
    return this.wp(ctx, node, site, 'core install', [
      'core',
      'install',
      `--url=https://${site.domain}`,
      `--title=${i.title}`,
      `--admin_user=${i.adminUser}`,
      `--admin_password=${i.adminPassword}`,
      `--admin_email=${i.adminEmail}`,
      '--skip-email',
      `--path=${docroot(site)}`,
    ]);
  }

  resetAdminPassword(
    ctx: AccountContext,
    node: NodeRef,
    site: WpSite,
    r: { adminUser: string; password: string },
  ): Promise<R> {
    return this.wp(ctx, node, site, 'user update', [
      'user',
      'update',
      r.adminUser,
      `--user_pass=${r.password}`,
      `--path=${docroot(site)}`,
    ]);
  }

  /** The pretty-permalink web template Quick Install sets. Hestia installs without that template are possible, so a refusal is reported, not fatal: the caller records it. */
  async applyTemplate(ctx: AccountContext, node: NodeRef, site: WpSite): Promise<R> {
    const r = await this.run(ctx, node, 'changeWebTemplate', {
      user: site.name,
      domain: site.domain,
      template: 'wordpress',
    });
    return r.ok
      ? this.okv('template', 'v-change-web-domain-tpl wordpress')
      : this.bad('template', r);
  }
}
