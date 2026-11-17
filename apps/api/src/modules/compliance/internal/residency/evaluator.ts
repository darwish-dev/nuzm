import { createHash } from 'node:crypto';
import type { ResidencyDecision, ResidencyReason } from '@nuzm/domain';
import type { RegionGroup, Target } from './regions';

/** Strictest first. */
export const MODES = ['in_kingdom_only', 'allow_listed', 'unrestricted_with_assessment'] as const;
export type Mode = (typeof MODES)[number];
export const CLASSES = [
  'public',
  'internal',
  'customer-content',
  'personal',
  'financial',
  'credentials',
] as const;
export type DataClass = (typeof CLASSES)[number];
export const rank = (m: Mode) => MODES.indexOf(m);
export const stricter = (a: Mode, b: Mode): Mode => (rank(a) <= rank(b) ? a : b);

export interface OrgPolicy {
  version: number;
  mode: Mode;
  allowedCountriesByClass: Partial<Record<DataClass, string[]>>;
  /** Ids of approved transfer assessments the organization relies on. */
  exceptions: string[];
}
export interface Floor {
  version: number;
  byClass: Record<DataClass, Mode>;
}
export interface AssessmentRef {
  id: string;
  orgId: string | null;
  dataClass: DataClass;
  /** An ISO country code or a region group. */
  region: string;
  processorId: string | null;
  status: 'pending' | 'approved' | 'rejected';
  expiresAt: Date;
}
export interface ProcessorInfo {
  exists: boolean;
  dataClasses: string[];
}
export interface EvaluateInput {
  orgId: string;
  dataClass: DataClass;
  target: Target;
  processorId?: string;
  policy: OrgPolicy | null;
  floor: Floor;
  /** The default mode when the organization has no policy (spec/compliance/defaults.yaml: in_kingdom_only). */
  defaultMode: Mode;
  assessments: AssessmentRef[];
  processor: ProcessorInfo | null;
  now: Date;
}
export interface Evaluation {
  decision: ResidencyDecision;
  reasons: ResidencyReason[];
  policyVersion: number | null;
  floorVersion: number;
  assessmentId: string | null;
  evidenceRef: string;
}

/** User-visible reasons, in both languages, without technical jargon (docs/10 §3: denials give non-technical reasons). */
export const REASONS = {
  public_data: {
    ar: 'هذه بيانات عامة ولا قيود على موقعها.',
    en: 'This is public data and has no location restriction.',
  },
  in_kingdom: { ar: 'الموقع داخل المملكة.', en: 'The location is inside the Kingdom.' },
  processor_not_in_ropa: {
    ar: 'الجهة المستلمة غير مسجلة في سجل أنشطة المعالجة.',
    en: 'The receiving party is not listed in the record of processing activities.',
  },
  processor_class_not_registered: {
    ar: 'الجهة المستلمة غير مسجلة لهذا النوع من البيانات.',
    en: 'The receiving party is not registered for this kind of data.',
  },
  floor_in_kingdom_only: {
    ar: 'سياسة المنصة تُبقي هذا النوع من البيانات داخل المملكة دائمًا.',
    en: 'Platform policy keeps this kind of data inside the Kingdom, always.',
  },
  in_kingdom_only: {
    ar: 'سياسة مؤسستكم تُبقي البيانات داخل المملكة.',
    en: 'Your organization policy keeps data inside the Kingdom.',
  },
  country_allow_listed: {
    ar: 'الدولة ضمن قائمة الدول المسموح بها لهذا النوع من البيانات.',
    en: 'The country is on the allowed list for this kind of data.',
  },
  country_not_allow_listed: {
    ar: 'الدولة ليست ضمن قائمة الدول المسموح بها لهذا النوع من البيانات.',
    en: 'The country is not on the allowed list for this kind of data.',
  },
  assessment_required: {
    ar: 'النقل خارج المملكة يحتاج تقييمًا معتمدًا قبل المتابعة.',
    en: 'Moving this data outside the Kingdom needs an approved assessment first.',
  },
  assessment_exception: {
    ar: 'سُمح بالنقل بموجب تقييم معتمد.',
    en: 'Allowed under an approved transfer assessment.',
  },
  assessment_expired: {
    ar: 'انتهت صلاحية التقييم المعتمد لهذا النقل.',
    en: 'The approved assessment for this transfer has expired.',
  },
  region_unverified: {
    ar: 'لم يُتحقق من موقع هذه المنطقة بعد، لذا تُعامل كخارج المملكة.',
    en: 'The location of this region has not been verified, so it is treated as outside the Kingdom.',
  },
  residency_unavailable: {
    ar: 'تعذّر التحقق من سياسة الموقع، لذا رُفض الطلب احترازيًا.',
    en: 'The location policy could not be checked, so the request was refused as a precaution.',
  },
} as const satisfies Record<string, ResidencyReason['message']>;
export type ReasonCode = keyof typeof REASONS;
export const reason = (code: ReasonCode): ResidencyReason => ({ code, message: REASONS[code] });

const evidence = (
  i: EvaluateInput,
  decision: string,
  codes: string[],
  assessmentId: string | null,
  floorVersion: number,
) =>
  `rd_${createHash('sha256')
    .update(
      JSON.stringify([
        i.orgId,
        i.dataClass,
        i.target.input,
        i.target.group,
        i.target.verified,
        i.processorId ?? null,
        i.policy?.version ?? null,
        floorVersion,
        decision,
        codes,
        assessmentId,
      ]),
    )
    .digest('hex')
    .slice(0, 24)}`;

/** The groups a region-scoped assessment can name: the country itself or its group. */
const assessmentCovers = (a: AssessmentRef, target: Target) =>
  a.region === target.country || a.region === target.group;

/**
 * The residency decision (docs/10 §3), pure and deterministic. Order of the rules:
 *  1. public data is always allowed;
 *  2. a named processor must exist in the ROPA and be registered for the class, else deny;
 *  3. a VERIFIED in-Kingdom region is always allowed;
 *  4. outside the Kingdom, the effective mode is the STRICTER of the organization's mode (default in_kingdom_only) and the platform floor of the class;
 *     an approved, unexpired assessment that the policy references and that covers (class, region, processor) allows the transfer, unless the floor is
 *     in_kingdom_only (nothing overrides that); then in_kingdom_only denies, allow_listed allows only listed countries, unrestricted_with_assessment
 *     answers requires_assessment.
 */
export function evaluate(i: EvaluateInput): Evaluation {
  const floorVersion = i.floor.version;
  const done = (
    decision: ResidencyDecision,
    codes: ReasonCode[],
    assessmentId: string | null = null,
  ): Evaluation => ({
    decision,
    reasons: codes.map(reason),
    policyVersion: i.policy?.version ?? null,
    floorVersion,
    assessmentId,
    evidenceRef: evidence(i, decision, codes, assessmentId, floorVersion),
  });
  if (i.dataClass === 'public') return done('allow', ['public_data']);
  if (i.processorId !== undefined) {
    if (!i.processor?.exists) return done('deny', ['processor_not_in_ropa']);
    if (!i.processor.dataClasses.includes(i.dataClass))
      return done('deny', ['processor_class_not_registered']);
  }
  if (i.target.group === 'in_kingdom' && i.target.verified) return done('allow', ['in_kingdom']);

  const floor = i.floor.byClass[i.dataClass];
  const orgMode = i.policy?.mode ?? i.defaultMode;
  const mode = stricter(orgMode, floor);
  const unverified =
    i.target.input !== '' && !i.target.verified && i.target.country === 'SA'
      ? (['region_unverified'] as ReasonCode[])
      : [];

  // an approved assessment the policy relies on
  const exceptions = new Set(i.policy?.exceptions ?? []);
  const candidates = i.assessments.filter(
    (a) =>
      exceptions.has(a.id) &&
      a.status === 'approved' &&
      (a.orgId === null || a.orgId === i.orgId) &&
      a.dataClass === i.dataClass &&
      assessmentCovers(a, i.target) &&
      (a.processorId === null || a.processorId === i.processorId),
  );
  const live = candidates.find((a) => a.expiresAt.getTime() > i.now.getTime());
  const expired = candidates.length > 0 && !live;
  if (floor === 'in_kingdom_only') return done('deny', [...unverified, 'floor_in_kingdom_only']);
  if (live) return done('allow', ['assessment_exception'], live.id);
  const tail: ReasonCode[] = expired ? ['assessment_expired'] : [];
  switch (mode) {
    case 'in_kingdom_only':
      return done('deny', [...unverified, 'in_kingdom_only', ...tail]);
    case 'allow_listed': {
      const listed =
        i.target.country !== null &&
        (i.policy?.allowedCountriesByClass[i.dataClass] ?? []).includes(i.target.country);
      return listed
        ? done('allow', ['country_allow_listed'])
        : done('deny', [...unverified, 'country_not_allow_listed', ...tail]);
    }
    case 'unrestricted_with_assessment':
      return done('requires_assessment', [...unverified, 'assessment_required', ...tail]);
  }
}

export type { RegionGroup };
