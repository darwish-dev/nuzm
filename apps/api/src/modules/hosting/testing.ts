// Test support of the hosting module (never imported by production code): a CONNECTED mock panel for suites that need a site on a node that
// answers, without building the whole hosting stack (cross-tenant.int.spec). NOT VERIFIED against a real node: nothing here is vendor evidence.
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HestiaClient, HttpHestiaChannel } from './internal/hestia/client';
import { startHestiaMock } from './internal/hestia/mock-server';
import { LocalSftpConnector } from './internal/mock/local-sftp';
import { MemoryVault } from './internal/mock/mocks';
import { MAIL_DNS, MockMailDns } from './internal/tools/dns';
import { SFTP_CONNECTOR } from './internal/tools/sftp';
import { HESTIA_CLIENT } from './internal/tokens';
import { VAULT_PORT } from './internal/ports';

/** The node inventory of a node that provides every service the site tools can use. */
export const CONNECTED_NODE_INVENTORY = {
  services: { ftp: 'vsftpd', mail: 'exim4', imap: 'dovecot', webmail: 'roundcube' },
} as const;

export interface ToolsPanel {
  /** provider overrides for the Nest testing module: the panel client, the SFTP connector, the DNS lookup and an in-memory vault for the site credentials */
  overrides: [unknown, unknown][];
  /**
   * The on-node side of one site: the panel account with the site's domain, its SFTP home and its sealed credentials (the `credentialsRef` of the site row).
   * The node row itself (healthy, panel configured, `CONNECTED_NODE_INVENTORY`) is the caller's, so a suite can keep another node disconnected.
   */
  addAccount(a: { credentialsRef: string; account: string; domain: string }): Promise<void>;
  close(): Promise<void>;
}

export async function startToolsPanel(): Promise<ToolsPanel> {
  const base = await mkdtemp(join(tmpdir(), 'nuzm-panel-'));
  const mock = await startHestiaMock();
  const client = new HestiaClient(
    { resolve: async () => ({ host: mock.host, port: mock.port, accessKeyRef: 'vault://dev/x' }) },
    { accessKey: async () => mock.controls.hash },
    new HttpHestiaChannel({ allowPlainLoopback: true }),
  );
  const sftp = new LocalSftpConnector();
  const dns = new MockMailDns();
  const vault = new MemoryVault();
  return {
    overrides: [
      [HESTIA_CLIENT, client],
      [SFTP_CONNECTOR, sftp],
      [MAIL_DNS, dns],
      [VAULT_PORT, vault],
    ],
    async addAccount({ credentialsRef, account, domain }) {
      const password = randomBytes(12).toString('hex'); // a per-run secret of the fixture account, never a literal
      mock.controls.users.set(account, {
        name: account,
        password,
        pkg: 'nuzm-starter',
        suspended: false,
        domains: new Map([
          [
            domain,
            {
              backend: 'PHP-8_3',
              ssl: false,
              notAfter: null,
              wp: { phase: 'none', placeholders: new Set(), posts: [] },
              ftp: new Map(),
              auth: new Set(),
              accessLog: [],
              errorLog: [],
            },
          ],
        ]),
        databases: new Map(),
        wpCli: false,
        cron: new Map(),
        mail: new Map(),
        sftpJail: true,
      });
      const home = join(base, 'home', account);
      const web = join(home, 'web', domain, 'public_html');
      await mkdir(web, { recursive: true });
      await writeFile(join(web, 'index.html'), '<p>fixture</p>\n'); // a file of the site for the read routes (download, text)
      sftp.homes.set(account, home);
      sftp.passwords.set(account, password);
      await vault.put(credentialsRef, JSON.stringify({ user: account, password }));
    },
    async close() {
      await mock.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}
