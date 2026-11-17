import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { CLASSES, MODES, type Mode } from './evaluator';
import type { ResidencyOptions } from './residency.service';

export interface ResidencyDefaults extends ResidencyOptions {
  floor: Record<string, Mode>;
}

export function parseResidencyDefaults(text: string): ResidencyDefaults {
  const raw = (parse(text) as { residency?: Record<string, unknown> } | null)?.residency;
  const fail = (m: string): never => {
    throw new Error(`residency defaults: ${m}`);
  };
  if (!raw) return fail('residency section is required');
  const floor = raw.floor as Record<string, unknown> | undefined;
  if (!floor) fail('floor is required');
  for (const c of CLASSES)
    if (!(MODES as readonly unknown[]).includes(floor![c]))
      fail(`floor.${c} must be one of ${MODES.join(', ')}`);
  if (!(MODES as readonly unknown[]).includes(raw.default_mode)) fail('default_mode is not a mode');
  const days = raw.max_assessment_days;
  const ttl = raw.cache_ttl_seconds;
  if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > 730)
    fail('max_assessment_days must be 1..730');
  if (!Number.isInteger(ttl) || (ttl as number) < 0 || (ttl as number) > 300)
    fail('cache_ttl_seconds must be 0..300');
  return {
    floor: floor as Record<string, Mode>,
    defaultMode: raw.default_mode as Mode,
    maxAssessmentDays: days as number,
    cacheTtlMs: (ttl as number) * 1000,
  };
}

export function loadResidencyDefaults(
  path = process.env.COMPLIANCE_DEFAULTS_PATH,
): ResidencyDefaults {
  if (path) return parseResidencyDefaults(readFileSync(resolve(path), 'utf8'));
  for (let d = __dirname, i = 0; i < 12; i++, d = dirname(d)) {
    const f = join(d, 'spec/compliance/defaults.yaml');
    if (existsSync(f)) return parseResidencyDefaults(readFileSync(f, 'utf8'));
  }
  throw new Error('residency defaults: spec/compliance/defaults.yaml not found');
}
