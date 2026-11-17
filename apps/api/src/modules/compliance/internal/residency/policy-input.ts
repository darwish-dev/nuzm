import { ProblemException } from '../../../../common/errors';
import { CLASSES, MODES, rank, type DataClass, type Floor, type Mode } from './evaluator';

const ISO = /^[A-Z]{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4,12}$/i;

export interface PolicyBody {
  mode: Mode;
  allowedCountriesByClass: Partial<Record<DataClass, string[]>>;
  exceptions: string[];
  changeNote: string | null;
}

/** Validate an organization policy body (422, one entry per bad field). Whether it loosens the platform floor is checked separately. */
export function parsePolicyBody(raw: Record<string, unknown>): PolicyBody {
  const errors: { field: string; message: string }[] = [];
  const bad = (field: string, message: string) => errors.push({ field, message });
  const mode = raw.mode;
  if (typeof mode !== 'string' || !(MODES as readonly string[]).includes(mode))
    bad('mode', `must be one of ${MODES.join(', ')}`);
  const allowed: Partial<Record<DataClass, string[]>> = {};
  const a = raw.allowedCountriesByClass ?? {};
  if (typeof a !== 'object' || a === null || Array.isArray(a))
    bad('allowedCountriesByClass', 'must be an object of data class → country codes');
  else
    for (const [k, v] of Object.entries(a as Record<string, unknown>)) {
      if (!(CLASSES as readonly string[]).includes(k))
        bad(`allowedCountriesByClass.${k}`, 'is not a data class');
      else if (
        !Array.isArray(v) ||
        v.length > 60 ||
        v.some((c) => typeof c !== 'string' || !ISO.test(c)) ||
        new Set(v).size !== v.length
      )
        bad(
          `allowedCountriesByClass.${k}`,
          'must be a list of at most 60 distinct ISO country codes (SA, AE, DE…)',
        );
      else allowed[k as DataClass] = v as string[];
    }
  const ex = raw.exceptions ?? [];
  if (
    !Array.isArray(ex) ||
    ex.length > 50 ||
    ex.some((x) => typeof x !== 'string' || !UUID.test(x)) ||
    new Set(ex).size !== ex.length
  )
    bad('exceptions', 'must be a list of at most 50 distinct transfer assessment ids');
  const note = raw.changeNote;
  if (
    note !== undefined &&
    note !== null &&
    (typeof note !== 'string' || note.trim().length < 1 || note.length > 500)
  )
    bad('changeNote', 'must be 1..500 characters');
  if (errors.length)
    throw new ProblemException('validation_failed', 'invalid residency policy', errors);
  return {
    mode: mode as Mode,
    allowedCountriesByClass: allowed,
    exceptions: (ex as string[]).map((x) => x.toLowerCase()),
    changeNote: typeof note === 'string' ? note.trim() : null,
  };
}

/**
 * An organization may only TIGHTEN the platform floor. Its mode needs no check (the engine always uses the stricter of mode and floor), but it must not
 * try to open a class the floor keeps in the Kingdom: no allow-list entries and no exception for such a class. Returns the offending fields.
 */
export function belowFloor(
  body: PolicyBody,
  floor: Floor,
  exceptionClasses: DataClass[],
): { field: string; message: string }[] {
  const out: { field: string; message: string }[] = [];
  for (const c of CLASSES)
    if (rank(floor.byClass[c]) === 0) {
      if ((body.allowedCountriesByClass[c] ?? []).length > 0)
        out.push({
          field: `allowedCountriesByClass.${c}`,
          message: `the platform keeps ${c} data inside the Kingdom: countries cannot be added`,
        });
      if (exceptionClasses.includes(c))
        out.push({
          field: 'exceptions',
          message: `an assessment for ${c} data cannot override the platform floor`,
        });
    }
  return out;
}
