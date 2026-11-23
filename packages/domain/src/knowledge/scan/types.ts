export type Severity = 'info' | 'warn' | 'block';
export type Scanner =
  'secrets' | 'license' | 'dependencies' | 'risky_files' | 'sensitive_files' | 'archive';
/** One scan result. `detail` never contains file content or a matched secret: kinds, counts and `path:line` only. */
export interface ScanFinding {
  scanner: Scanner;
  code: string;
  severity: Severity;
  path: string | null;
  line: number | null;
  detail: string;
}
export type LicenseVerdict = 'ALLOWED' | 'RESTRICTED' | 'UNKNOWN' | 'BLOCKED';
export interface LicenseProposal {
  spdx: string | null;
  verdict: LicenseVerdict;
  /** Where each signal came from (path + how); the reviewers read this next to the verdict. */
  evidence: {
    path: string;
    via: 'license_file' | 'manifest' | 'spdx_header';
    spdx: string | null;
    verdict: LicenseVerdict;
  }[];
  conflicts: boolean;
  reason: string;
}
export interface DependencyRecord {
  ecosystem: 'npm' | 'pub' | 'pip' | 'composer' | 'go' | 'gem';
  name: string;
  range: string | null;
  kind: 'runtime' | 'dev' | 'peer' | 'optional';
  path: string;
  license: string | null;
  risk: 'none' | 'low' | 'medium' | 'high';
}
