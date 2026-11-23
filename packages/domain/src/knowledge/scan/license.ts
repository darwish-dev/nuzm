import type { LicenseProposal, LicenseVerdict } from './types';

const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'Unlicense',
  'CC0-1.0',
  'Zlib',
  'BlueOak-1.0.0',
  'Python-2.0',
]);
const RANK: Record<LicenseVerdict, number> = { ALLOWED: 0, UNKNOWN: 1, RESTRICTED: 2, BLOCKED: 3 };

export function verdictOf(spdx: string): LicenseVerdict {
  const id = spdx.trim();
  if (ALLOWED.has(id)) return 'ALLOWED';
  if (
    /^(?:UNLICENSED|PROPRIETARY|COMMERCIAL|SSPL-1\.0|BUSL-1\.1|Elastic-2\.0|CC-BY-NC.*|CC-BY-ND.*)$/i.test(
      id,
    )
  )
    return 'BLOCKED';
  if (
    /^(?:A?GPL-|LGPL-|MPL-|EPL-|EUPL-|CDDL-|OSL-|CC-BY-SA|CC-BY-4|CC-BY-3|Artistic-|CPAL-|RPL-)/i.test(
      id,
    )
  )
    return 'RESTRICTED';
  if (/^SEE LICEN[SC]E/i.test(id) || id === '') return 'UNKNOWN';
  return 'RESTRICTED'; // a custom or unrecognised identifier: a person must read it
}

/** Evaluates an SPDX expression. OR = the licensee picks (best); AND / WITH = all apply (worst). */
export function expressionVerdict(expr: string): { spdx: string; verdict: LicenseVerdict } {
  const e = expr.replace(/[()]/g, ' ').trim();
  const orParts = e.split(/\s+OR\s+/i);
  const evalAnd = (s: string) => {
    const ids = s
      .split(/\s+(?:AND|WITH)\s+/i)
      .map((x) => x.trim())
      .filter(Boolean);
    return ids
      .map(verdictOf)
      .reduce<LicenseVerdict>((w, v) => (RANK[v] > RANK[w] ? v : w), 'ALLOWED');
  };
  const verdicts = orParts.map(evalAnd);
  const best = verdicts.reduce<LicenseVerdict>((b, v) => (RANK[v] < RANK[b] ? v : b), 'BLOCKED');
  return { spdx: e.replace(/\s+/g, ' '), verdict: best };
}

const FINGERPRINTS: { spdx: string; re: RegExp }[] = [
  { spdx: 'AGPL-3.0', re: /GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/i },
  { spdx: 'LGPL-3.0', re: /GNU LESSER GENERAL PUBLIC LICENSE\s+Version 3/i },
  { spdx: 'LGPL-2.1', re: /GNU LESSER GENERAL PUBLIC LICENSE\s+Version 2\.1/i },
  { spdx: 'GPL-3.0', re: /GNU GENERAL PUBLIC LICENSE\s+Version 3/i },
  { spdx: 'GPL-2.0', re: /GNU GENERAL PUBLIC LICENSE\s+Version 2/i },
  { spdx: 'MPL-2.0', re: /Mozilla Public License,? (?:Version|v\.?) ?2\.0/i },
  { spdx: 'Apache-2.0', re: /Apache License\s+Version 2\.0/i },
  {
    spdx: 'BSD-3-Clause',
    re: /Redistribution and use in source and binary forms[\s\S]{0,900}Neither the name of/i,
  },
  {
    spdx: 'BSD-2-Clause',
    re: /Redistribution and use in source and binary forms[\s\S]{0,900}THIS SOFTWARE IS PROVIDED/i,
  },
  {
    spdx: 'ISC',
    re: /Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee/i,
  },
  {
    spdx: 'MIT',
    re: /Permission is hereby granted, free of charge, to any person obtaining a copy/i,
  },
  {
    spdx: 'Unlicense',
    re: /This is free and unencumbered software released into the public domain/i,
  },
  { spdx: 'CC0-1.0', re: /CC0 1\.0 Universal/i },
  {
    spdx: '0BSD',
    re: /Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee is hereby granted\.\s*$/im,
  },
];
const PROPRIETARY =
  /(?:all rights reserved(?![\s\S]{0,400}(?:permission is hereby granted|redistribution and use))|proprietary and confidential|may not be (?:copied|redistributed|resold|sublicensed)|no part of this (?:software|theme|template) may|extended license required|single[- ]project license|regular license|not for (?:resale|redistribution))/i;

export function classifyLicenseText(text: string): {
  spdx: string | null;
  verdict: LicenseVerdict;
} {
  const head = text.slice(0, 20_000);
  for (const f of FINGERPRINTS)
    if (f.re.test(head)) return { spdx: f.spdx, verdict: verdictOf(f.spdx) };
  if (PROPRIETARY.test(head)) return { spdx: null, verdict: 'BLOCKED' };
  return { spdx: null, verdict: head.trim().length < 20 ? 'UNKNOWN' : 'RESTRICTED' };
}

const LICENSE_FILE =
  /^(?:.*\/)?(?:licen[sc]e|copying|unlicense|notice)(?:[.-][A-Za-z0-9._-]+)?(?:\.(?:md|txt|rst))?$/i;
export const isLicenseFile = (path: string): boolean =>
  LICENSE_FILE.test(path) && path.split('/').length <= 3;
const SPDX_HEADER = /SPDX-License-Identifier:\s*([A-Za-z0-9.+\-() ]{2,80})/;

export interface LicenseInput {
  path: string;
  /** Text of a licence file, or the manifest / source head to look into. */
  text: string;
}
function manifestLicense(path: string, text: string): string | null {
  const base = path.split('/').pop() ?? path;
  try {
    if (base === 'package.json' || base === 'composer.json') {
      const j = JSON.parse(text) as { license?: unknown; licenses?: { type?: string }[] };
      if (typeof j.license === 'string') return j.license;
      if (Array.isArray(j.license)) return (j.license as string[]).join(' OR ');
      if (j.license && typeof j.license === 'object')
        return String((j.license as { type?: string }).type ?? '') || null;
      if (Array.isArray(j.licenses))
        return (
          j.licenses
            .map((l) => l.type)
            .filter(Boolean)
            .join(' OR ') || null
        );
      return null;
    }
  } catch {
    return null;
  }
  if (base === 'pubspec.yaml')
    return /^license:\s*["']?([^"'\n#]+)/m.exec(text)?.[1]?.trim() ?? null;
  if (base === 'pyproject.toml')
    return (
      /^\s*license\s*=\s*(?:\{[^}]*(?:text|file)\s*=\s*)?["']([^"']+)["']/m
        .exec(text)?.[1]
        ?.trim() ?? null
    );
  if (base === 'Cargo.toml') return /^license\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? null;
  return null;
}

/** Proposes a verdict. It is EVIDENCE for the reviewers (D-43): the database only lets a version go ACTIVE when a person has set the verdict to ALLOWED. */
export function proposeLicense(inputs: LicenseInput[]): LicenseProposal {
  const evidence: LicenseProposal['evidence'] = [];
  for (const f of inputs) {
    if (isLicenseFile(f.path)) {
      const c = classifyLicenseText(f.text);
      evidence.push({ path: f.path, via: 'license_file', spdx: c.spdx, verdict: c.verdict });
      continue;
    }
    const m = manifestLicense(f.path, f.text);
    if (m !== null) {
      const c = expressionVerdict(m);
      evidence.push({ path: f.path, via: 'manifest', spdx: c.spdx, verdict: c.verdict });
      continue;
    }
    const h = SPDX_HEADER.exec(f.text.slice(0, 2000));
    if (h?.[1]) {
      const c = expressionVerdict(h[1]);
      evidence.push({ path: f.path, via: 'spdx_header', spdx: c.spdx, verdict: c.verdict });
    }
  }
  if (evidence.length === 0)
    return {
      spdx: null,
      verdict: 'UNKNOWN',
      evidence,
      conflicts: false,
      reason: 'No licence file, manifest licence field or SPDX header was found.',
    };
  // the licence file outranks the manifest field for the headline; any disagreement is reported and the stricter verdict wins
  const worst = evidence.reduce<LicenseVerdict>(
    (w, e) => (RANK[e.verdict] > RANK[w] ? e.verdict : w),
    'ALLOWED',
  );
  const distinct = new Set(evidence.map((e) => e.spdx ?? `?${e.verdict}`));
  const conflicts = distinct.size > 1;
  const head = evidence.find((e) => e.via === 'license_file') ?? evidence[0]!;
  const spdx = conflicts
    ? [...new Set(evidence.map((e) => e.spdx).filter(Boolean))].join(' + ') || null
    : head.spdx;
  const reason =
    worst === 'ALLOWED'
      ? conflicts
        ? 'Permissive licences were detected and they differ between files; a reviewer must confirm.'
        : 'A permissive licence was detected.'
      : worst === 'RESTRICTED'
        ? 'A copyleft, weak-copyleft or custom licence was detected; reuse needs a person to read it.'
        : worst === 'BLOCKED'
          ? 'The text restricts redistribution or reuse.'
          : 'The licence could not be determined.';
  return {
    spdx,
    verdict: conflicts && worst === 'ALLOWED' ? 'UNKNOWN' : worst,
    evidence,
    conflicts,
    reason,
  };
}
