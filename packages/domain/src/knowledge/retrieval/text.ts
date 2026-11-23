/**
 * Text handling for library retrieval (S-K5, ADR-065 point 7): normalisation that works for Arabic and English, identifier splitting, and a small bilingual concept
 * table that turns a requirement such as "متجر إلكتروني مع لوحة تحكم" or "online store with admin dashboard" into groups of terms. Everything is deterministic and data-driven:
 * no model, no embedding, no external service (the semantic layer stays BLOCKED on D-47).
 */
const DIACRITICS = /[ً-ٰٟۖ-ۭـ]/g;
/** Lower-case, strip Arabic diacritics and tatweel, fold alef/yeh/teh-marbuta variants, collapse whitespace. Safe on any string. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(DIACRITICS, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim();
}
const hasArabic = (s: string) => /[؀-ۿ]/.test(s);
/** Text prepared for indexing: Arabic text is followed by its normalised form so a normalised query matches it in a plain `simple` text-search vector. */
export function indexable(s: string): string {
  return hasArabic(s) ? `${s}\n${normalizeText(s)}` : s;
}

const STOP_EN = new Set(
  'a an and or the of to for in on with by from at as is are be this that it its into your our my we you i me can will should would could app application site website web build make create want need needs like please using use based'.split(
    ' ',
  ),
);
const STOP_AR = new Set(
  [
    'في',
    'من',
    'الي',
    'على',
    'عن',
    'مع',
    'او',
    'و',
    'ان',
    'هذا',
    'هذه',
    'ذلك',
    'اريد',
    'ابغي',
    'نبي',
    'ابي',
    'عايز',
    'اعمل',
    'انشاء',
    'بناء',
    'تطبيق',
    'موقع',
    'نظام',
    'لي',
    'لدي',
    'عندي',
    'يكون',
    'تكون',
    'كل',
    'بعض',
    'ما',
    'لا',
    'هو',
    'هي',
  ].map(normalizeText),
);
/** Words of a text: identifiers are split (`UserCard`, `user_card`, `user-card`), stop words and one-letter tokens dropped, duplicates removed, order kept. */
export function tokenize(text: string, max = 60): string[] {
  const spaced = text.slice(0, 4000).replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of normalizeText(spaced).split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || STOP_EN.has(raw) || STOP_AR.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= max) break;
  }
  return out;
}

/** Concept groups: words that mean the same thing for retrieval, in English and Arabic. Data, editable in code review; not a claim of completeness. */
const CONCEPTS: { id: string; terms: string[] }[] = [
  {
    id: 'dashboard',
    terms: [
      'dashboard',
      'admin',
      'panel',
      'analytics',
      'backoffice',
      'لوحة تحكم',
      'لوحة',
      'تحكم',
      'ادارة',
      'إدارة',
      'تحليلات',
    ],
  },
  {
    id: 'store',
    terms: [
      'store',
      'shop',
      'ecommerce',
      'commerce',
      'cart',
      'checkout',
      'product',
      'products',
      'متجر',
      'متاجر',
      'تجارة',
      'سلة',
      'منتجات',
      'منتج',
    ],
  },
  {
    id: 'auth',
    terms: [
      'auth',
      'authentication',
      'login',
      'signin',
      'signup',
      'register',
      'password',
      'تسجيل',
      'دخول',
      'مصادقة',
      'حساب',
      'كلمة',
    ],
  },
  {
    id: 'payment',
    terms: [
      'payment',
      'payments',
      'pay',
      'billing',
      'invoice',
      'subscription',
      'stripe',
      'دفع',
      'مدفوعات',
      'فواتير',
      'فاتورة',
      'اشتراك',
      'اشتراكات',
    ],
  },
  {
    id: 'blog',
    terms: [
      'blog',
      'article',
      'articles',
      'post',
      'posts',
      'news',
      'cms',
      'مدونة',
      'مقالات',
      'مقال',
      'اخبار',
      'أخبار',
    ],
  },
  {
    id: 'landing',
    terms: [
      'landing',
      'marketing',
      'homepage',
      'hero',
      'pricing',
      'صفحة هبوط',
      'هبوط',
      'تسويق',
      'رئيسية',
      'اسعار',
      'أسعار',
    ],
  },
  {
    id: 'booking',
    terms: [
      'booking',
      'reservation',
      'appointment',
      'appointments',
      'schedule',
      'calendar',
      'حجز',
      'حجوزات',
      'مواعيد',
      'موعد',
      'تقويم',
    ],
  },
  {
    id: 'chat',
    terms: [
      'chat',
      'messaging',
      'message',
      'messages',
      'inbox',
      'support',
      'دردشة',
      'محادثة',
      'رسائل',
      'دعم',
    ],
  },
  {
    id: 'realestate',
    terms: [
      'real estate',
      'property',
      'properties',
      'listing',
      'listings',
      'rental',
      'عقارات',
      'عقار',
      'ايجار',
      'إيجار',
    ],
  },
  {
    id: 'restaurant',
    terms: [
      'restaurant',
      'menu',
      'food',
      'delivery',
      'order',
      'orders',
      'مطعم',
      'مطاعم',
      'قائمة',
      'طعام',
      'توصيل',
      'طلبات',
    ],
  },
  {
    id: 'gym',
    terms: [
      'gym',
      'fitness',
      'workout',
      'training',
      'member',
      'members',
      'نادي',
      'لياقة',
      'تمارين',
      'تدريب',
      'اعضاء',
      'أعضاء',
    ],
  },
  {
    id: 'education',
    terms: [
      'education',
      'course',
      'courses',
      'lms',
      'learning',
      'student',
      'students',
      'school',
      'تعليم',
      'دورات',
      'دوره',
      'طلاب',
      'مدرسة',
      'تعلم',
    ],
  },
  {
    id: 'health',
    terms: [
      'health',
      'clinic',
      'medical',
      'patient',
      'patients',
      'doctor',
      'صحة',
      'عيادة',
      'طبي',
      'مرضى',
      'طبيب',
    ],
  },
  {
    id: 'crm',
    terms: [
      'crm',
      'customer',
      'customers',
      'leads',
      'contacts',
      'sales',
      'عملاء',
      'عميل',
      'مبيعات',
    ],
  },
  {
    id: 'social',
    terms: ['social', 'feed', 'profile', 'followers', 'community', 'مجتمع', 'ملف شخصي', 'متابعين'],
  },
  {
    id: 'map',
    terms: ['map', 'maps', 'location', 'geo', 'tracking', 'خريطة', 'خرائط', 'موقع جغرافي', 'تتبع'],
  },
  {
    id: 'notification',
    terms: [
      'notification',
      'notifications',
      'push',
      'alerts',
      'email',
      'اشعارات',
      'إشعارات',
      'تنبيهات',
      'بريد',
    ],
  },
  { id: 'search', terms: ['search', 'filter', 'filters', 'بحث', 'تصفية', 'فلتر'] },
  { id: 'form', terms: ['form', 'forms', 'survey', 'wizard', 'نموذج', 'نماذج', 'استبيان'] },
  { id: 'table', terms: ['table', 'tables', 'datatable', 'grid', 'جدول', 'جداول'] },
  {
    id: 'chart',
    terms: [
      'chart',
      'charts',
      'graph',
      'report',
      'reports',
      'رسم بياني',
      'مخططات',
      'تقارير',
      'تقرير',
    ],
  },
  {
    id: 'mobile',
    terms: [
      'mobile',
      'android',
      'ios',
      'flutter',
      'native',
      'جوال',
      'موبايل',
      'اندرويد',
      'أندرويد',
    ],
  },
  {
    id: 'saas',
    terms: [
      'saas',
      'multitenant',
      'tenant',
      'workspace',
      'organization',
      'organizations',
      'team',
      'teams',
      'مؤسسة',
      'فريق',
      'فرق',
    ],
  },
  { id: 'darkmode', terms: ['dark', 'darkmode', 'night', 'داكن', 'ليلي', 'وضع داكن'] },
];
const NORMALISED: { id: string; terms: string[]; words: Set<string> }[] = CONCEPTS.map((c) => {
  const terms = [...new Set(c.terms.map(normalizeText))];
  return { id: c.id, terms, words: new Set(terms.filter((t) => !t.includes(' '))) };
});

export interface TermGroup {
  /** Stable id: the concept id, or the word itself for a word outside the table. */
  key: string;
  /** Words (or two-word phrases) that all mean this; the first is what the person wrote. */
  terms: string[];
  /** The words of the requirement that produced this group. */
  from: string[];
  concept: boolean;
}
/** A requirement text → at most `max` groups. Words of one concept collapse into one group; every other word is its own group. */
export function termGroups(text: string, max = 12): TermGroup[] {
  const normal = normalizeText(text.slice(0, 4000));
  const toks = tokenize(text);
  const groups = new Map<string, TermGroup>();
  const add = (key: string, terms: string[], from: string, concept: boolean) => {
    const g = groups.get(key);
    if (g) {
      if (!g.from.includes(from)) g.from.push(from);
    } else groups.set(key, { key, terms, from: [from], concept });
  };
  // phrases of the table ("real estate", "لوحة تحكم") match on the whole text
  for (const c of NORMALISED)
    for (const t of c.terms) if (t.includes(' ') && normal.includes(t)) add(c.id, c.terms, t, true);
  for (const w of toks) {
    const c = NORMALISED.find((x) => x.words.has(w));
    if (c) add(c.id, c.terms, w, true);
    else add(w, [w], w, false);
  }
  return [...groups.values()].slice(0, max);
}
const WORD = /^[\p{L}\p{N}_]+$/u;
/** A group → a `to_tsquery('simple', …)` string with prefix matching; null when no term is safe to send. Terms are restricted to letters and digits (no operators can be injected). */
export function tsQueryOf(g: TermGroup): string | null {
  const parts: string[] = [];
  for (const t of g.terms) {
    const words = t.split(' ').filter(Boolean);
    if (
      words.length === 0 ||
      words.length > 3 ||
      !words.every((w) => WORD.test(w) && w.length <= 40)
    )
      continue;
    parts.push(
      words.length === 1 ? `${words[0]}:*` : `(${words.map((w) => `${w}:*`).join(' & ')})`,
    );
  }
  return parts.length ? parts.join(' | ') : null;
}
/** Does normalised text contain one of the group's terms (as a word prefix)? Used for metadata matching in memory. */
export function groupMatches(normalised: string, g: TermGroup): boolean {
  const words = normalised.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return g.terms.some((t) => {
    const parts = t.split(' ');
    return parts.every((p) => words.some((w) => w.startsWith(p)));
  });
}
