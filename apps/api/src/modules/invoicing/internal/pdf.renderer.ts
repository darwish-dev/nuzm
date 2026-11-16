import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ProblemException } from '../../../common/errors';

const run = promisify(execFile);

/** HTML → PDF. Complex-script shaping and bidi are the browser engine's job, so Arabic joins and RTL are correct without our own layout code. */
export interface PdfRenderer {
  render(html: string): Promise<Buffer>;
}

const DEFAULTS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

/**
 * Headless Chrome/Chromium (`CHROME_PATH` or a standard location). Each render uses a throwaway profile and temp files, a hard timeout
 * and no network use. When no browser exists the endpoint answers 503 rather than returning a wrong document. Production needs the
 * renderer as a sandboxed sidecar with bundled Arabic fonts (D-13/M12): flagged in the report.
 */
export class ChromePdfRenderer implements PdfRenderer {
  constructor(private readonly chromePath: string | null = null) {}

  private async binary(): Promise<string> {
    for (const p of [this.chromePath ?? process.env.CHROME_PATH, ...DEFAULTS]) {
      if (!p) continue;
      try {
        await access(p);
        return p;
      } catch {
        /* try the next candidate */
      }
    }
    throw new ProblemException(
      'service_unavailable',
      'no PDF renderer (Chrome/Chromium) is available',
    );
  }

  async available(): Promise<boolean> {
    try {
      await this.binary();
      return true;
    } catch {
      return false;
    }
  }

  async render(html: string): Promise<Buffer> {
    const bin = await this.binary();
    const dir = await mkdtemp(join(tmpdir(), 'nuzm-pdf-'));
    try {
      const src = join(dir, 'doc.html');
      const out = join(dir, 'doc.pdf');
      await writeFile(src, html, 'utf8');
      await run(
        bin,
        [
          '--headless=new',
          '--disable-gpu',
          '--no-first-run',
          '--no-default-browser-check',
          `--user-data-dir=${join(dir, 'profile')}`,
          '--no-pdf-header-footer',
          `--print-to-pdf=${out}`,
          `file://${src}`,
        ],
        { timeout: 30_000 },
      );
      const pdf = await readFile(out);
      if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-')
        throw new ProblemException('internal_error', 'the PDF renderer produced no document');
      return pdf;
    } catch (e) {
      if (e instanceof ProblemException) throw e;
      throw new ProblemException('service_unavailable', 'the PDF renderer failed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
