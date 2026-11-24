import { createHash } from 'node:crypto';
import { Client, type SFTPWrapper, type Stats } from 'ssh2';

/**
 * The SFTP side of the file manager. The control plane opens an SFTP session as the SITE'S OWN unprivileged account (never root), with the password it keeps in the vault for
 * that account; it never gets a shell. The port is deliberately small: every call is a plain SFTP operation, and the SERVICE (`files.service.ts`) decides which paths may be
 * touched. NOT VERIFIED against a real node: it has been exercised only against the test double in `internal/mock/local-sftp.ts`.
 */
export interface SftpAttrs {
  type: 'file' | 'dir' | 'symlink' | 'other';
  size: number;
  mtimeMs: number;
  mode: number;
}
export interface SftpDirEntry {
  name: string;
  attrs: SftpAttrs;
}
export class SftpError extends Error {
  constructor(
    readonly code: 'too_large' | 'connect' | 'auth' | 'host_key' | 'timeout' | 'io' | 'exists',
    message: string,
  ) {
    super(message);
    this.name = 'SftpError';
  }
}
export interface SftpSession {
  /** the SHA-256 fingerprint of the server's host key as seen on this connection (`SHA256:<base64>`), null for a double */
  readonly hostKey: string | null;
  /** the canonical path of the account's home directory */
  home(): Promise<string>;
  realpath(path: string): Promise<string>;
  /** attributes WITHOUT following a symbolic link; `null` when the entry does not exist */
  lstat(path: string): Promise<SftpAttrs | null>;
  readdir(path: string): Promise<SftpDirEntry[]>;
  /** reads at most `maxBytes`; a longer file is `SftpError('too_large')` and nothing is returned */
  read(path: string, maxBytes: number): Promise<Buffer>;
  /** creates the file EXCLUSIVELY (fails when it exists) with the given content */
  writeNew(path: string, data: Buffer): Promise<void>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  close(): void;
}
export interface SftpTarget {
  host: string;
  port: number;
  username: string;
  password: string;
  /** the pinned host key fingerprint of the node (`SHA256:<base64>`); null = first use, the connection reports the key it saw so it can be pinned */
  hostKeySha256: string | null;
  timeoutMs: number;
}
export interface SftpConnector {
  open(target: SftpTarget): Promise<SftpSession>;
}
export const SFTP_CONNECTOR = Symbol('HOSTING_SFTP_CONNECTOR');

const typeOf = (s: Stats): SftpAttrs['type'] =>
  s.isSymbolicLink() ? 'symlink' : s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other';
const attrsOf = (s: Stats): SftpAttrs => ({
  type: typeOf(s),
  size: s.size,
  mtimeMs: (s.mtime ?? 0) * 1000,
  mode: s.mode,
});
/** `SHA256:<base64 without padding>` as OpenSSH prints it */
export const hostKeyFingerprint = (key: Buffer) =>
  `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

class Ssh2Session implements SftpSession {
  constructor(
    private readonly client: Client,
    private readonly sftp: SFTPWrapper,
    readonly hostKey: string | null,
  ) {}
  private call<T>(f: (cb: (err: Error | null | undefined, v?: T) => void) => void): Promise<T> {
    return new Promise((resolve, reject) => f((err, v) => (err ? reject(err) : resolve(v as T))));
  }
  home() {
    return this.realpath('.');
  }
  realpath(path: string) {
    return this.call<string>((cb) => this.sftp.realpath(path, cb));
  }
  async lstat(path: string): Promise<SftpAttrs | null> {
    try {
      return attrsOf(await this.call<Stats>((cb) => this.sftp.lstat(path, cb)));
    } catch (e) {
      if ((e as { code?: number }).code === 2) return null; // SSH_FX_NO_SUCH_FILE
      throw e;
    }
  }
  async readdir(path: string): Promise<SftpDirEntry[]> {
    const list = await this.call<{ filename: string; attrs: Stats }[]>((cb) =>
      this.sftp.readdir(path, cb as never),
    );
    return list
      .filter((e) => e.filename !== '.' && e.filename !== '..')
      .map((e) => ({ name: e.filename, attrs: attrsOf(e.attrs) }));
  }
  read(path: string, maxBytes: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const rs = this.sftp.createReadStream(path);
      rs.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          rs.destroy();
          reject(new SftpError('too_large', 'the file is larger than the allowed size'));
        } else chunks.push(c);
      });
      rs.on('error', reject);
      rs.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }
  writeNew(path: string, data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = this.sftp.createWriteStream(path, { flags: 'wx', mode: 0o644 });
      ws.on('error', reject);
      ws.on('close', () => resolve());
      ws.end(data);
    });
  }
  mkdir(path: string) {
    return this.call<void>((cb) => this.sftp.mkdir(path, cb as never));
  }
  rename(from: string, to: string) {
    return this.call<void>((cb) => this.sftp.rename(from, to, cb as never));
  }
  unlink(path: string) {
    return this.call<void>((cb) => this.sftp.unlink(path, cb as never));
  }
  rmdir(path: string) {
    return this.call<void>((cb) => this.sftp.rmdir(path, cb as never));
  }
  close() {
    this.client.end();
  }
}

/** The real connector (ssh2). Password authentication as the site's account; the host key must match the pinned one when there is one. */
export class Ssh2SftpConnector implements SftpConnector {
  open(t: SftpTarget): Promise<SftpSession> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      let seen: string | null = null;
      let mismatch = false;
      const done = (e: Error) => {
        client.end();
        reject(e);
      };
      client
        .on('ready', () => {
          client.sftp((err, sftp) => {
            if (err)
              return done(new SftpError('connect', 'the SFTP subsystem could not be opened'));
            resolve(new Ssh2Session(client, sftp, seen));
          });
        })
        .on('error', (e: Error & { level?: string }) => {
          if (mismatch)
            return done(
              new SftpError('host_key', 'the node host key does not match the pinned one'),
            );
          if (e.level === 'client-authentication')
            return done(new SftpError('auth', 'the site account was refused'));
          if (/timed out/i.test(e.message))
            return done(new SftpError('timeout', 'the node did not answer in time'));
          done(new SftpError('connect', 'the node could not be reached'));
        })
        .connect({
          host: t.host,
          port: t.port,
          username: t.username,
          password: t.password,
          readyTimeout: t.timeoutMs,
          // ssh2 verifies the host key through this callback (the asynchronous form takes `verify`)
          hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
            seen = hostKeyFingerprint(key);
            if (t.hostKeySha256 && t.hostKeySha256 !== seen) mismatch = true;
            verify(!mismatch);
          },
        });
    });
  }
}
