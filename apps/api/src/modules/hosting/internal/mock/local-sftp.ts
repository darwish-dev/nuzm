import { constants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import {
  SftpError,
  type SftpAttrs,
  type SftpConnector,
  type SftpSession,
  type SftpTarget,
} from '../tools/sftp';

/**
 * TEST DOUBLE of an SFTP server: the operations run on a real directory of this machine, so symbolic links, hard links and permissions behave as on a POSIX server.
 * It proves the containment logic of the file manager; it says nothing about a real node's sshd, jail or permissions (NOT VERIFIED).
 */
const attrs = (s: Awaited<ReturnType<typeof lstat>>): SftpAttrs => ({
  type: s.isSymbolicLink() ? 'symlink' : s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other',
  size: Number(s.size),
  mtimeMs: Number(s.mtimeMs),
  mode: Number(s.mode),
});
export class LocalSftpSession implements SftpSession {
  readonly hostKey = null;
  closed = false;
  constructor(private readonly homeDir: string) {}
  home() {
    return realpath(this.homeDir);
  }
  realpath(p: string) {
    return realpath(p === '.' ? this.homeDir : p);
  }
  async lstat(p: string) {
    try {
      return attrs(await lstat(p));
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') return null;
      throw e;
    }
  }
  async readdir(p: string) {
    const names = await readdir(p);
    const out = [];
    for (const name of names) out.push({ name, attrs: attrs(await lstat(`${p}/${name}`)) });
    return out;
  }
  async read(p: string, maxBytes: number) {
    // O_NOFOLLOW: a server-side open of a symbolic link as the final component fails, like a hardened sshd would
    const fh = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = await fh.stat();
      if (st.size > maxBytes)
        throw new SftpError('too_large', 'the file is larger than the allowed size');
      return await fh.readFile();
    } finally {
      await fh.close();
    }
  }
  async writeNew(p: string, data: Buffer) {
    try {
      const fh = await open(
        p,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o644,
      );
      try {
        await fh.writeFile(data);
      } finally {
        await fh.close();
      }
    } catch (e) {
      if ((e as { code?: string }).code === 'EEXIST')
        throw new SftpError('exists', 'the file exists');
      throw e;
    }
  }
  async mkdir(p: string) {
    await mkdir(p);
  }
  async rename(a: string, b: string) {
    await rename(a, b);
  }
  async unlink(p: string) {
    await unlink(p);
  }
  async rmdir(p: string) {
    await rmdir(p);
  }
  close() {
    this.closed = true;
  }
  /** test helper: a hard link inside the tree */
  async hardLink(a: string, b: string) {
    await link(a, b);
  }
}
/** Hands out sessions homed at `homes[username]`; counts connections so a test can prove a session was opened (or not) and closed. */
export class LocalSftpConnector implements SftpConnector {
  readonly opened: { username: string; password: string }[] = [];
  readonly sessions: LocalSftpSession[] = [];
  /** username → home directory on this machine */
  readonly homes = new Map<string, string>();
  /** passwords the double accepts (username → password) */
  readonly passwords = new Map<string, string>();
  async open(t: SftpTarget): Promise<SftpSession> {
    const home = this.homes.get(t.username);
    if (!home || this.passwords.get(t.username) !== t.password)
      throw new SftpError('auth', 'the site account was refused');
    this.opened.push({ username: t.username, password: t.password });
    const s = new LocalSftpSession(home);
    this.sessions.push(s);
    return s;
  }
}
