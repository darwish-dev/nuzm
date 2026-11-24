import { task } from './task-builder';
import type { FixtureFile, GoldenTask } from './types';

/** Extended golden tasks, part 1: landing pages, UI, responsive design, Arabic RTL and accessibility. Synthetic; every fixture is authored for this suite. */
const L = (...lines: string[]) => `${lines.join('\n')}\n`;
const page = (lang: 'en' | 'ar', body: string[], head: string[] = []) =>
  L(
    '<!doctype html>',
    lang === 'ar' ? '<html lang="ar" dir="rtl">' : '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Demo</title>',
    ...head,
    '</head>',
    '<body>',
    ...body,
    '</body>',
    '</html>',
  );
const BASE_CSS = L('body { margin: 0; font-family: sans-serif; }', '.hero { padding: 2rem; }');
const landing = (lang: 'en' | 'ar'): FixtureFile[] => [
  {
    path: 'index.html',
    content: page(
      lang,
      [
        '<header><h1>' + (lang === 'ar' ? 'أطلق أسرع' : 'Launch faster') + '</h1></header>',
        '<main><section id="hero" class="hero"><p>' + (lang === 'ar' ? 'ابنِ موقعك وانشره.' : 'Build and ship your site.') + '</p></section></main>',
      ],
      ['<link rel="stylesheet" href="styles.css">'],
    ),
  },
  { path: 'styles.css', content: BASE_CSS },
];

export const WEB_TASKS: readonly GoldenTask[] = [
  // ---- landing page
  task({
    id: 'land-01-cta',
    category: 'landing-page',
    locale: 'en',
    title: 'Add a call-to-action button',
    prompt: 'Add a "Start free" call-to-action link to the hero section. It should point to #signup and have the class "cta".',
    fixture: landing('en'),
    checks: [
      { type: 'matches', path: 'index.html', pattern: String.raw`<a[^>]*class="cta"[^>]*href="#signup"|<a[^>]*href="#signup"[^>]*class="cta"` },
      { type: 'contains', path: 'index.html', text: 'Start free' },
    ],
    solution: [
      {
        path: 'index.html',
        content: page(
          'en',
          [
            '<header><h1>Launch faster</h1></header>',
            '<main><section id="hero" class="hero"><p>Build and ship your site.</p><a class="cta" href="#signup">Start free</a></section></main>',
          ],
          ['<link rel="stylesheet" href="styles.css">'],
        ),
      },
    ],
  }),
  task({
    id: 'land-02-pricing-ar',
    category: 'landing-page',
    locale: 'ar',
    title: 'إضافة قسم الأسعار',
    prompt: 'أضف قسم أسعار بمعرّف pricing يحتوي على ثلاث خطط، لكل خطة العنصر class="plan".',
    fixture: landing('ar'),
    checks: [
      { type: 'contains', path: 'index.html', text: 'id="pricing"' },
      { type: 'matches', path: 'index.html', pattern: String.raw`(class="plan"[\s\S]*){3}` },
      { type: 'contains', path: 'index.html', text: 'dir="rtl"' },
    ],
    solution: [
      {
        path: 'index.html',
        content: page(
          'ar',
          [
            '<header><h1>أطلق أسرع</h1></header>',
            '<main><section id="hero" class="hero"><p>ابنِ موقعك وانشره.</p></section>',
            '<section id="pricing"><h2>الأسعار</h2>',
            '<div class="plan">مجانية</div>',
            '<div class="plan">احترافية</div>',
            '<div class="plan">للمؤسسات</div>',
            '</section></main>',
          ],
          ['<link rel="stylesheet" href="styles.css">'],
        ),
      },
    ],
  }),
  task({
    id: 'land-03-testimonials',
    category: 'landing-page',
    locale: 'en',
    title: 'Add testimonials with styling',
    prompt: 'Add a testimonials section (id "testimonials") with two blockquote elements, and a .testimonials rule in styles.css that sets a padding.',
    fixture: landing('en'),
    checks: [
      { type: 'contains', path: 'index.html', text: 'id="testimonials"' },
      { type: 'matches', path: 'index.html', pattern: String.raw`(<blockquote[\s\S]*){2}` },
      { type: 'matches', path: 'styles.css', pattern: String.raw`\.testimonials\s*\{[^}]*padding` },
    ],
    solution: [
      {
        path: 'index.html',
        content: page(
          'en',
          [
            '<header><h1>Launch faster</h1></header>',
            '<main><section id="hero" class="hero"><p>Build and ship your site.</p></section>',
            '<section id="testimonials" class="testimonials">',
            '<blockquote>Shipped in a day.</blockquote>',
            '<blockquote>Our best launch.</blockquote>',
            '</section></main>',
          ],
          ['<link rel="stylesheet" href="styles.css">'],
        ),
      },
      { path: 'styles.css', content: `${BASE_CSS}.testimonials { padding: 2rem; }\n` },
    ],
  }),

  // ---- UI implementation
  ...(() => {
    const BADGE: FixtureFile[] = [
      {
        path: 'src/components/Badge.tsx',
        content: L('export function Badge({ label }: { label: string }) {', '  return <span className="badge">{label}</span>;', '}'),
      },
    ];
    return [
      task({
        id: 'ui-01-tone-prop',
        category: 'ui-implementation',
        locale: 'en',
        title: 'Give the badge a tone',
        prompt: 'Add a "tone" prop to Badge ("info" or "danger"). The element class becomes "badge badge--<tone>".',
        fixture: BADGE,
        checks: [
          { type: 'contains', path: 'src/components/Badge.tsx', text: "'info' | 'danger'" },
          { type: 'contains', path: 'src/components/Badge.tsx', text: 'badge--${tone}' },
        ],
        solution: [
          {
            path: 'src/components/Badge.tsx',
            content: L(
              "export function Badge({ label, tone = 'info' }: { label: string; tone?: 'info' | 'danger' }) {",
              '  return <span className={`badge badge--${tone}`}>{label}</span>;',
              '}',
            ),
          },
        ],
      }),
      task({
        id: 'ui-02-empty-state',
        category: 'ui-implementation',
        locale: 'en',
        title: 'Build an empty state component',
        prompt: 'Create src/components/EmptyState.tsx: a component with "title" and "description" props that renders both and has role="status".',
        fixture: BADGE,
        checks: [
          { type: 'file_exists', path: 'src/components/EmptyState.tsx' },
          { type: 'contains', path: 'src/components/EmptyState.tsx', text: 'role="status"' },
          { type: 'matches', path: 'src/components/EmptyState.tsx', pattern: String.raw`\{title\}[\s\S]*\{description\}` },
        ],
        solution: [
          {
            path: 'src/components/EmptyState.tsx',
            content: L(
              'export function EmptyState({ title, description }: { title: string; description: string }) {',
              '  return (',
              '    <div role="status">',
              '      <h2>{title}</h2>',
              '      <p>{description}</p>',
              '    </div>',
              '  );',
              '}',
            ),
          },
        ],
      }),
      task({
        id: 'ui-03-spinner-ar',
        category: 'ui-implementation',
        locale: 'ar',
        title: 'مكوّن مؤشر التحميل',
        prompt: 'أنشئ src/components/Spinner.tsx: مكوّن بخاصية aria-busy="true" ونص مخفي بصريًا يقول "جارٍ التحميل".',
        fixture: BADGE,
        checks: [
          { type: 'file_exists', path: 'src/components/Spinner.tsx' },
          { type: 'contains', path: 'src/components/Spinner.tsx', text: 'aria-busy="true"' },
          { type: 'contains', path: 'src/components/Spinner.tsx', text: 'جارٍ التحميل' },
        ],
        solution: [
          {
            path: 'src/components/Spinner.tsx',
            content: L(
              'export function Spinner() {',
              '  return (',
              '    <span aria-busy="true" className="spinner">',
              '      <span className="sr-only">جارٍ التحميل</span>',
              '    </span>',
              '  );',
              '}',
            ),
          },
        ],
      }),
    ];
  })(),

  // ---- responsive design
  ...(() => {
    const GRID_CSS = L('.grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }', '.card { padding: 16px; }');
    const NO_VIEWPORT = L('<!doctype html>', '<html lang="en">', '<head>', '<meta charset="utf-8">', '<title>Demo</title>', '<link rel="stylesheet" href="styles.css">', '</head>', '<body><div class="grid"></div></body>', '</html>');
    const fixture: FixtureFile[] = [
      { path: 'index.html', content: NO_VIEWPORT },
      { path: 'styles.css', content: GRID_CSS },
    ];
    return [
      task({
        id: 'resp-01-viewport',
        category: 'responsive-design',
        locale: 'en',
        title: 'Add the viewport meta tag',
        prompt: 'The page does not scale on phones. Add the standard viewport meta tag to index.html.',
        fixture,
        checks: [{ type: 'contains', path: 'index.html', text: 'name="viewport"' }, { type: 'contains', path: 'index.html', text: 'width=device-width' }],
        solution: [
          {
            path: 'index.html',
            content: L('<!doctype html>', '<html lang="en">', '<head>', '<meta charset="utf-8">', '<meta name="viewport" content="width=device-width, initial-scale=1">', '<title>Demo</title>', '<link rel="stylesheet" href="styles.css">', '</head>', '<body><div class="grid"></div></body>', '</html>'),
          },
        ],
      }),
      task({
        id: 'resp-02-mobile-grid',
        category: 'responsive-design',
        locale: 'en',
        title: 'Collapse the grid on small screens',
        prompt: 'In styles.css, make .grid a single column on screens up to 600px wide, using a media query. Keep the desktop layout.',
        fixture,
        checks: [
          { type: 'matches', path: 'styles.css', pattern: String.raw`@media \(max-width: 600px\)\s*\{[^}]*\.grid\s*\{[^}]*grid-template-columns:\s*1fr` },
          { type: 'contains', path: 'styles.css', text: 'repeat(4, 1fr)' },
        ],
        solution: [{ path: 'styles.css', content: `${GRID_CSS}@media (max-width: 600px) {\n  .grid { grid-template-columns: 1fr; }\n}\n` }],
      }),
      task({
        id: 'resp-03-fluid-images',
        category: 'responsive-design',
        locale: 'en',
        title: 'Make images fluid',
        prompt: 'Images overflow their containers on narrow screens. Add a rule so images never exceed their container width and keep their aspect ratio.',
        fixture,
        checks: [
          { type: 'matches', path: 'styles.css', pattern: String.raw`img\s*\{[^}]*max-width:\s*100%` },
          { type: 'matches', path: 'styles.css', pattern: String.raw`img\s*\{[^}]*height:\s*auto` },
        ],
        solution: [{ path: 'styles.css', content: `${GRID_CSS}img { max-width: 100%; height: auto; }\n` }],
      }),
    ];
  })(),

  // ---- Arabic RTL
  ...(() => {
    const CSS = L('.nav { margin-left: 16px; text-align: left; }', '.price { padding-right: 8px; }');
    const HTML = L('<!doctype html>', '<html lang="ar">', '<head>', '<meta charset="utf-8">', '<meta name="viewport" content="width=device-width, initial-scale=1">', '<title>متجر</title>', '</head>', '<body><nav class="nav">الرئيسية</nav><p>للتواصل: <span>+966 55 123 4567</span></p></body>', '</html>');
    const fixture: FixtureFile[] = [
      { path: 'index.html', content: HTML },
      { path: 'styles.css', content: CSS },
    ];
    return [
      task({
        id: 'rtl-01-direction',
        category: 'arabic-rtl',
        locale: 'ar',
        title: 'اتجاه الصفحة من اليمين إلى اليسار',
        prompt: 'الصفحة عربية لكن اتجاهها غير محدد. اجعل اتجاه الصفحة من اليمين إلى اليسار بإضافة السمة المناسبة إلى عنصر html مع الإبقاء على اللغة.',
        fixture,
        checks: [
          { type: 'matches', path: 'index.html', pattern: String.raw`<html[^>]*dir="rtl"` },
          { type: 'matches', path: 'index.html', pattern: String.raw`<html[^>]*lang="ar"` },
        ],
        solution: [{ path: 'index.html', content: HTML.replace('<html lang="ar">', '<html lang="ar" dir="rtl">') }],
      }),
      task({
        id: 'rtl-02-logical-properties',
        category: 'arabic-rtl',
        locale: 'ar',
        title: 'خصائص منطقية بدل الفيزيائية',
        prompt: 'في styles.css استبدل الخصائص الفيزيائية (margin-left و padding-right و text-align: left) بخصائص منطقية تعمل في الاتجاهين.',
        fixture,
        checks: [
          { type: 'not_matches', path: 'styles.css', pattern: String.raw`margin-left|padding-right|text-align:\s*left` },
          { type: 'contains', path: 'styles.css', text: 'margin-inline-start' },
          { type: 'contains', path: 'styles.css', text: 'padding-inline-end' },
          { type: 'contains', path: 'styles.css', text: 'text-align: start' },
        ],
        solution: [{ path: 'styles.css', content: L('.nav { margin-inline-start: 16px; text-align: start; }', '.price { padding-inline-end: 8px; }') }],
      }),
      task({
        id: 'rtl-03-isolate-phone',
        category: 'arabic-rtl',
        locale: 'en',
        title: 'Isolate a phone number inside RTL text',
        prompt: 'In the Arabic page the phone number renders scrambled. Isolate it as left-to-right text by wrapping it in a bdi element with dir="ltr".',
        fixture: [{ path: 'index.html', content: L('<!doctype html>', '<html lang="ar" dir="rtl">', '<head>', '<meta charset="utf-8">', '<meta name="viewport" content="width=device-width, initial-scale=1">', '<title>متجر</title>', '</head>', '<body><p>للتواصل: <span>+966 55 123 4567</span></p></body>', '</html>') }],
        checks: [
          { type: 'matches', path: 'index.html', pattern: String.raw`<bdi dir="ltr">\+966 55 123 4567</bdi>` },
          { type: 'contains', path: 'index.html', text: 'dir="rtl"' },
        ],
        solution: [{ path: 'index.html', content: L('<!doctype html>', '<html lang="ar" dir="rtl">', '<head>', '<meta charset="utf-8">', '<meta name="viewport" content="width=device-width, initial-scale=1">', '<title>متجر</title>', '</head>', '<body><p>للتواصل: <bdi dir="ltr">+966 55 123 4567</bdi></p></body>', '</html>') }],
      }),
    ];
  })(),

  // ---- accessibility
  ...(() => {
    const a11y = (body: string): FixtureFile[] => [{ path: 'index.html', content: page('en', [body]) }];
    return [
      task({
        id: 'a11y-01-img-alt',
        category: 'accessibility',
        locale: 'en',
        title: 'Describe the logo image',
        prompt: 'The logo image has no text alternative. Give it a meaningful alt text ("Oasis Cafe logo").',
        fixture: a11y('<img src="logo.png">'),
        checks: [{ type: 'matches', path: 'index.html', pattern: String.raw`<img[^>]*alt="Oasis Cafe logo"` }],
        solution: [{ path: 'index.html', content: page('en', ['<img src="logo.png" alt="Oasis Cafe logo">']) }],
      }),
      task({
        id: 'a11y-02-form-label',
        category: 'accessibility',
        locale: 'en',
        title: 'Label the email field',
        prompt: 'The email field has no label. Add a visible label bound to it with for/id.',
        fixture: a11y('<form><input type="email" name="email"></form>'),
        checks: [
          { type: 'contains', path: 'index.html', text: '<label for="email">' },
          { type: 'matches', path: 'index.html', pattern: String.raw`<input[^>]*id="email"` },
        ],
        solution: [{ path: 'index.html', content: page('en', ['<form><label for="email">Email</label><input id="email" type="email" name="email"></form>']) }],
      }),
      task({
        id: 'a11y-03-icon-button',
        category: 'accessibility',
        locale: 'ar',
        title: 'اسم متاح لزر الأيقونة',
        prompt: 'زر الإغلاق يحتوي على أيقونة فقط ولا اسم له لقارئ الشاشة. أضف aria-label بقيمة "إغلاق".',
        fixture: [{ path: 'index.html', content: page('ar', ['<button class="close"><svg aria-hidden="true" width="16" height="16"></svg></button>']) }],
        checks: [
          { type: 'matches', path: 'index.html', pattern: String.raw`<button[^>]*aria-label="إغلاق"` },
          { type: 'contains', path: 'index.html', text: 'aria-hidden="true"' },
        ],
        solution: [{ path: 'index.html', content: page('ar', ['<button class="close" aria-label="إغلاق"><svg aria-hidden="true" width="16" height="16"></svg></button>']) }],
      }),
    ];
  })(),
];
