import type { ProductProfile } from './types';
import {
  STACK_FLUTTER,
  STACK_NEST_API,
  STACK_NEXT_NEST,
  STACK_SQL,
  STACK_HTML,
  b,
  mod,
} from './profiles-core';
import { WEBAPP } from './profiles-a';

const reuse = (ids: readonly string[]) => WEBAPP.modules.filter((m) => ids.includes(m.id));

export const MOBILE: ProductProfile = {
  type: 'mobile',
  title: b('Mobile app', 'تطبيق جوال'),
  en: [
    'mobile app',
    'mobile application',
    'ios app',
    'android app',
    'iphone app',
    'ios',
    'android',
    'iphone',
  ],
  ar: [
    'تطبيق جوال',
    'تطبيق موبايل',
    'تطبيق للجوال',
    'تطبيق اندرويد',
    'تطبيق ايفون',
    'ايفون',
    'اندرويد',
  ],
  stacks: [STACK_FLUTTER],
  impliedFeatures: ['auth', 'rtl'],
  questions: [
    {
      id: 'platforms',
      text: b(
        'Which platforms: Android, iOS or both?',
        'أي المنصات: أندرويد أم آي أو إس أم كلاهما؟',
      ),
    },
    {
      id: 'backend',
      text: b(
        'Is there an existing API, or should one be planned too?',
        'هل توجد واجهة برمجية جاهزة أم تلزم خطتها أيضاً؟',
      ),
    },
  ],
  modules: [
    mod(
      'scaffold',
      ['Flutter project scaffold', 'هيكل مشروع Flutter'],
      'config',
      [],
      ['pubspec.yaml', 'lib/main.dart', 'analysis_options.yaml', 'README.md'],
      [['The project analyzes with no errors', 'يمر المشروع التحليل دون أخطاء']],
      null,
      2,
    ),
    mod(
      'theme',
      ['Theme, localization and RTL', 'السمة والترجمة واتجاه RTL'],
      'frontend',
      ['scaffold'],
      ['lib/theme/app_theme.dart', 'lib/l10n/app_ar.arb', 'lib/l10n/app_en.arb'],
      [
        ['Arabic lays out right-to-left', 'تُعرض العربية من اليمين لليسار'],
        ['Text scales with the system font size', 'يتكيف النص مع حجم خط النظام'],
      ],
      null,
      3,
    ),
    mod(
      'navigation',
      ['Navigation and screens', 'التنقل والشاشات'],
      'frontend',
      ['theme'],
      ['lib/router.dart', 'lib/screens/home_screen.dart', 'lib/screens/settings_screen.dart'],
      [
        [
          'Every screen has loading, empty and error states',
          'لكل شاشة حالات التحميل والفراغ والخطأ',
        ],
      ],
      null,
      3,
    ),
    mod(
      'api-client',
      ['API client', 'عميل الواجهة البرمجية'],
      'integration',
      ['scaffold'],
      ['lib/data/api_client.dart', 'lib/data/models.dart'],
      [['Network errors and timeouts are handled and shown', 'تُعالج أخطاء الشبكة والمهلات وتُعرض']],
      null,
      3,
    ),
    mod(
      'auth',
      ['Sign-in', 'تسجيل الدخول'],
      'auth',
      ['api-client', 'navigation'],
      ['lib/auth/auth_service.dart', 'lib/screens/login_screen.dart'],
      [
        [
          'Tokens are kept in secure storage, never in plain preferences',
          'تُحفظ الرموز في تخزين آمن لا في تفضيلات عادية',
        ],
      ],
      'auth',
      4,
      'authentication code: a person reviews it',
    ),
    mod(
      'offline',
      ['Offline cache and sync', 'التخزين دون اتصال والمزامنة'],
      'backend',
      ['api-client'],
      ['lib/data/local_store.dart', 'lib/data/sync_service.dart'],
      [
        [
          'The app opens and shows cached data without a network',
          'يفتح التطبيق ويعرض البيانات المخزنة دون شبكة',
        ],
      ],
      'offline',
      4,
    ),
    mod(
      'push',
      ['Push notifications (disabled until configured)', 'إشعارات الجوال (معطلة حتى الإعداد)'],
      'integration',
      ['auth'],
      ['lib/push/push_service.dart'],
      [
        [
          'No push provider key is stored in the app; the integration is off until the owner configures it',
          'لا يُخزَّن مفتاح مزود الإشعارات في التطبيق والتكامل معطل حتى يعدّه المالك',
        ],
      ],
      'push',
      3,
      'push: the owner creates the provider account and keys',
    ),
    mod(
      'store-prep',
      ['Store-readiness checklist (no submission)', 'قائمة جاهزية المتاجر (دون رفع)'],
      'docs',
      ['navigation'],
      ['docs/store-checklist.md'],
      [
        [
          'The checklist lists icons, privacy text and permissions; nothing is submitted to a store',
          'تسرد القائمة الأيقونات ونص الخصوصية والصلاحيات دون رفع لأي متجر',
        ],
      ],
      null,
      1,
      'store submission is a human step and is never done by generated code',
    ),
  ],
};

export const FLUTTER: ProductProfile = {
  type: 'flutter',
  title: b('Flutter app', 'تطبيق Flutter'),
  en: ['flutter', 'dart', 'flutter app'],
  ar: ['فلاتر', 'تطبيق فلاتر'],
  stacks: [STACK_FLUTTER],
  impliedFeatures: ['rtl'],
  questions: [
    {
      id: 'state',
      text: b(
        'Do you prefer a state-management approach (Riverpod, Bloc, Provider)?',
        'هل تفضّل أسلوباً لإدارة الحالة (Riverpod أو Bloc أو Provider)؟',
      ),
    },
  ],
  modules: [
    ...MOBILE.modules.filter((m) =>
      [
        'scaffold',
        'theme',
        'navigation',
        'api-client',
        'auth',
        'offline',
        'push',
        'store-prep',
      ].includes(m.id),
    ),
    mod(
      'state',
      ['State management', 'إدارة الحالة'],
      'frontend',
      ['navigation'],
      ['lib/state/app_state.dart', 'lib/state/providers.dart'],
      [['State changes are covered by widget tests', 'تغطي اختبارات الواجهة تغييرات الحالة']],
      null,
      3,
    ),
  ],
};

export const ERP: ProductProfile = {
  type: 'erp',
  title: b('ERP system', 'نظام تخطيط موارد المؤسسة'),
  en: ['erp', 'enterprise resource planning', 'resource planning', 'back-office suite'],
  ar: ['تخطيط موارد المؤسسات', 'نظام erp', 'نظام موارد', 'نظام محاسبه ومخزون'],
  stacks: [STACK_NEXT_NEST],
  impliedFeatures: ['auth', 'roles', 'inventory', 'accounting', 'reports', 'dashboard', 'rtl'],
  questions: [
    {
      id: 'modules',
      text: b(
        'Which departments does it cover first (sales, purchasing, inventory, accounting, HR)?',
        'أي الأقسام تُغطى أولاً (مبيعات، مشتريات، مخزون، محاسبة، موارد بشرية)؟',
      ),
    },
    {
      id: 'tax',
      text: b(
        'Which tax and reporting rules apply? (a tax advisor decides; none are claimed)',
        'ما الضرائب والتقارير المطبقة؟ (يقررها مستشار ضريبي ولا يُدَّعى أي امتثال)',
      ),
    },
  ],
  modules: [
    ...reuse([
      'scaffold',
      'schema',
      'auth',
      'roles',
      'core',
      'ui',
      'dashboard',
      'reports',
      'admin',
    ]),
    mod(
      'sales',
      ['Sales: quotes, orders, customers', 'المبيعات: عروض الأسعار والطلبات والعملاء'],
      'backend',
      ['core'],
      ['apps/api/src/sales/sales.controller.ts', 'app/[locale]/(app)/sales/page.tsx'],
      [
        [
          'An order moves quote → confirmed → delivered; invalid moves are refused',
          'ينتقل الطلب من عرض إلى مؤكد إلى مسلّم وتُرفض الانتقالات غير الصالحة',
        ],
      ],
      null,
      4,
    ),
    mod(
      'purchasing',
      ['Purchasing and suppliers', 'المشتريات والموردون'],
      'backend',
      ['core'],
      ['apps/api/src/purchasing/purchasing.controller.ts'],
      [['Receiving goods raises stock exactly once', 'استلام البضاعة يزيد المخزون مرة واحدة']],
      null,
      3,
    ),
    mod(
      'inventory',
      ['Inventory and warehouses', 'المخزون والمستودعات'],
      'backend',
      ['sales', 'purchasing'],
      ['apps/api/src/inventory/inventory.service.ts'],
      [
        [
          'Stock never goes negative under concurrent movements',
          'لا ينخفض المخزون عن الصفر مع الحركات المتزامنة',
        ],
      ],
      'inventory',
      4,
    ),
    mod(
      'accounting',
      [
        'Accounting: ledger and journal (append-only)',
        'المحاسبة: دفتر الأستاذ والقيود (إضافة فقط)',
      ],
      'backend',
      ['sales', 'purchasing'],
      [
        'apps/api/src/accounting/ledger.service.ts',
        'db/migrations/0002_ledger.sql',
        'db/migrations/0002_ledger.down.sql',
      ],
      [
        [
          'Ledger rows are append-only; a correction is a reversing entry',
          'قيود الدفتر إضافة فقط والتصحيح بقيد عكسي',
        ],
        [
          'Debits equal credits for every entry; money is in minor units',
          'المدين يساوي الدائن لكل قيد والمبالغ بأصغر وحدة',
        ],
        [
          'Tax and e-invoicing compliance is NOT claimed',
          'لا يُدَّعى الامتثال الضريبي ولا للفوترة الإلكترونية',
        ],
      ],
      'accounting',
      5,
      'accounting and tax: the owner and a tax advisor decide the rules; a person reviews the ledger design',
    ),
    mod(
      'hr',
      ['Employees and leave', 'الموظفون والإجازات'],
      'backend',
      ['core', 'roles'],
      ['apps/api/src/hr/hr.controller.ts'],
      [
        [
          'Personal data fields are classified and visible only to HR roles',
          'حقول البيانات الشخصية مصنفة ولا يراها إلا أدوار الموارد البشرية',
        ],
      ],
      'hr',
      3,
      'personal data of employees: privacy review by the owner',
    ),
  ],
};

export const CRM: ProductProfile = {
  type: 'crm',
  title: b('CRM', 'إدارة علاقات العملاء'),
  en: ['crm', 'customer relationship management', 'customer relationship', 'sales crm'],
  ar: ['ادارة علاقات العملاء', 'نظام crm', 'علاقات العملاء'],
  stacks: [STACK_NEXT_NEST],
  impliedFeatures: ['auth', 'roles', 'customers', 'crm-leads', 'dashboard', 'rtl'],
  questions: [
    {
      id: 'sources',
      text: b(
        'Where do leads come from (web forms, imports, integrations)?',
        'من أين يأتي العملاء المحتملون (نماذج، استيراد، تكاملات)؟',
      ),
    },
  ],
  modules: [
    ...reuse([
      'scaffold',
      'schema',
      'auth',
      'roles',
      'core',
      'ui',
      'dashboard',
      'reports',
      'search',
      'notifications',
      'admin',
    ]),
    mod(
      'customers',
      ['Customers and contacts', 'العملاء وجهات الاتصال'],
      'backend',
      ['core'],
      ['apps/api/src/customers/customers.controller.ts', 'app/[locale]/(app)/customers/page.tsx'],
      [
        ['Duplicate customers are detected on create', 'تُكتشف تكرارات العملاء عند الإنشاء'],
        ['Personal data fields are classified', 'حقول البيانات الشخصية مصنفة'],
      ],
      'customers',
      3,
      'personal data: privacy review by the owner',
    ),
    mod(
      'pipeline',
      ['Leads and sales pipeline', 'العملاء المحتملون ومسار المبيعات'],
      'backend',
      ['customers'],
      ['apps/api/src/pipeline/pipeline.controller.ts', 'app/[locale]/(app)/pipeline/page.tsx'],
      [
        [
          'A lead moves between stages with a history of who moved it',
          'ينتقل العميل بين المراحل مع سجل بمن نقله',
        ],
      ],
      'crm-leads',
      4,
    ),
    mod(
      'activities',
      ['Tasks and activity log', 'المهام وسجل النشاط'],
      'backend',
      ['customers'],
      ['apps/api/src/activities/activities.controller.ts'],
      [
        [
          'Every change to a customer is logged with who and when',
          'كل تغيير على عميل يُسجَّل بمن ومتى',
        ],
      ],
      null,
      3,
    ),
    mod(
      'import',
      ['CSV import', 'الاستيراد من CSV'],
      'backend',
      ['customers'],
      ['apps/api/src/customers/import.service.ts'],
      [
        [
          'A bad row is reported with its line number and nothing is half-imported',
          'يُبلَّغ عن الصف الخاطئ برقم سطره دون استيراد جزئي',
        ],
      ],
      'uploads',
      3,
    ),
  ],
};

export const FULLSTACK: ProductProfile = {
  type: 'fullstack',
  title: b('Full-stack application', 'تطبيق متكامل (Full-stack)'),
  en: ['full stack', 'fullstack', 'full-stack', 'frontend and backend', 'front end and back end'],
  ar: ['فل ستاك', 'واجهه امامية وخلفيه', 'تطبيق متكامل'],
  stacks: [STACK_NEXT_NEST],
  impliedFeatures: ['auth', 'rtl'],
  questions: [
    {
      id: 'entities',
      text: b('What are the main records it manages?', 'ما السجلات الرئيسية التي يديرها؟'),
    },
  ],
  modules: reuse([
    'scaffold',
    'schema',
    'auth',
    'core',
    'ui',
    'search',
    'uploads',
    'notifications',
  ]),
};

export const DATABASE: ProductProfile = {
  type: 'database',
  title: b('Database schema', 'مخطط قاعدة بيانات'),
  en: [
    'database schema',
    'database design',
    'data model',
    'sql schema',
    'erd',
    'migrations',
    'database',
  ],
  ar: ['مخطط قاعده بيانات', 'تصميم قاعده بيانات', 'نموذج البيانات', 'قاعده بيانات', 'ترحيلات'],
  stacks: [STACK_SQL],
  impliedFeatures: [],
  questions: [
    {
      id: 'entities',
      text: b(
        'Which entities and relationships should it hold?',
        'ما الكيانات والعلاقات المطلوبة؟',
      ),
    },
    {
      id: 'isolation',
      text: b(
        'Is the data per organization or per user (row isolation)?',
        'هل البيانات لكل مؤسسة أم لكل مستخدم (عزل الصفوف)؟',
      ),
    },
  ],
  modules: [
    mod(
      'model',
      ['Data model document', 'وثيقة نموذج البيانات'],
      'docs',
      [],
      ['docs/data-model.md'],
      [['Every entity, key and relationship is described', 'يوصف كل كيان ومفتاح وعلاقة']],
      null,
      2,
    ),
    mod(
      'migrations',
      ['Migrations with reversal notes', 'الترحيلات مع ملاحظات التراجع'],
      'schema',
      ['model'],
      ['db/migrations/0001_init.sql', 'db/migrations/0001_init.down.sql'],
      [
        [
          'Every migration is forward-only with a documented reversal',
          'كل ترحيل إلى الأمام فقط مع تراجع موثق',
        ],
        [
          'Money columns are integer minor units with a currency',
          'أعمدة المال أعداد صحيحة بأصغر وحدة مع العملة',
        ],
      ],
      null,
      4,
      'a migration changes the database: a person approves it',
    ),
    mod(
      'isolation',
      ['Row-level isolation policies', 'سياسات عزل الصفوف'],
      'schema',
      ['migrations'],
      ['db/migrations/0002_rls.sql', 'db/migrations/0002_rls.down.sql'],
      [
        [
          'A row of one owner can never be read by another (tested)',
          'لا يقرأ مالك صفاً لمالك آخر (باختبار)',
        ],
      ],
      'multitenant',
      4,
      'security policies: a person reviews them',
    ),
    mod(
      'indexes',
      ['Indexes and constraints', 'الفهارس والقيود'],
      'schema',
      ['migrations'],
      ['db/migrations/0003_indexes.sql', 'db/migrations/0003_indexes.down.sql'],
      [
        [
          'Every foreign key and frequent filter has an index',
          'لكل مفتاح أجنبي وعامل تصفية متكرر فهرس',
        ],
      ],
      null,
      2,
      'a migration changes the database: a person approves it',
    ),
    mod(
      'seed',
      ['Sample data (synthetic only)', 'بيانات تجريبية (وهمية فقط)'],
      'config',
      ['migrations'],
      ['db/seed.sql'],
      [
        [
          'The seed contains no real personal data',
          'لا تحتوي البيانات التجريبية على بيانات شخصية حقيقية',
        ],
      ],
      null,
      1,
    ),
  ],
};

export const AUTH: ProductProfile = {
  type: 'auth',
  title: b('Authentication service', 'خدمة مصادقة'),
  en: [
    'authentication service',
    'auth service',
    'login system',
    'sso',
    'single sign-on',
    'identity service',
    'oauth server',
  ],
  ar: ['خدمه مصادقه', 'نظام تسجيل دخول', 'تسجيل دخول موحد', 'خدمه الهويه'],
  stacks: [STACK_NEST_API],
  impliedFeatures: ['auth', 'roles', 'rate-limit'],
  questions: [
    {
      id: 'methods',
      text: b(
        'Which sign-in methods (email and password, one-time codes, social)?',
        'أي طرق الدخول (بريد وكلمة مرور، رموز لمرة واحدة، حسابات اجتماعية)؟',
      ),
    },
  ],
  modules: [
    mod(
      'scaffold',
      ['Service scaffold', 'هيكل الخدمة'],
      'config',
      [],
      ['package.json', 'tsconfig.json', 'src/main.ts', 'src/app.module.ts'],
      [['The service starts and answers a health check', 'تعمل الخدمة وتجيب فحص الصحة']],
      null,
      2,
    ),
    mod(
      'schema',
      ['Users and sessions schema', 'مخطط المستخدمين والجلسات'],
      'schema',
      ['scaffold'],
      ['db/migrations/0001_users.sql', 'db/migrations/0001_users.down.sql'],
      [
        [
          'Passwords are stored only as salted slow hashes',
          'تُخزَّن كلمات المرور كتجزئة مملّحة بطيئة فقط',
        ],
      ],
      null,
      3,
      'a migration changes the database: a person approves it',
    ),
    mod(
      'signin',
      ['Sign-up, sign-in, sign-out', 'التسجيل والدخول والخروج'],
      'auth',
      ['schema'],
      ['src/auth/auth.controller.ts', 'src/auth/auth.service.ts', 'src/auth/password.ts'],
      [
        [
          'Failed sign-ins answer the same way for unknown users and wrong passwords',
          'تتشابه إجابة الدخول الفاشل للمستخدم المجهول وكلمة المرور الخاطئة',
        ],
        ['Sessions expire and can be revoked', 'تنتهي الجلسات ويمكن إلغاؤها'],
      ],
      'auth',
      5,
      'authentication code: a person reviews it',
    ),
    mod(
      'reset',
      ['Password reset (mail is queued, not sent)', 'استعادة كلمة المرور (البريد يُجدول ولا يُرسل)'],
      'integration',
      ['signin'],
      ['src/auth/reset.service.ts'],
      [['Reset tokens are single-use and short-lived', 'رموز الاستعادة لمرة واحدة وقصيرة العمر']],
      'password-reset',
      3,
      'email provider: the owner supplies the account',
    ),
    mod(
      'roles',
      ['Roles and permissions', 'الأدوار والصلاحيات'],
      'auth',
      ['signin'],
      ['src/auth/permissions.ts', 'src/auth/roles.guard.ts'],
      [['A caller without the permission gets 403', 'من لا يملك الصلاحية يتلقى 403']],
      'roles',
      3,
      'authorization code: a person reviews it',
    ),
    mod(
      'rate-limit',
      ['Brute-force protection', 'الحماية من التخمين'],
      'backend',
      ['signin'],
      ['src/common/rate-limit.guard.ts'],
      [
        [
          'Repeated failures lock the attempt with a retry hint',
          'تُقفل المحاولة بعد الفشل المتكرر مع تلميح الإعادة',
        ],
      ],
      'rate-limit',
      2,
    ),
    mod(
      'audit',
      ['Sign-in audit log', 'سجل تدقيق الدخول'],
      'backend',
      ['signin'],
      ['src/audit/audit.service.ts'],
      [
        [
          'Every sign-in outcome is recorded without the password',
          'يُسجَّل كل ناتج دخول دون كلمة المرور',
        ],
      ],
      null,
      2,
    ),
  ],
};

export const DOCS: ProductProfile = {
  type: 'docs',
  title: b('Documentation', 'توثيق'),
  en: [
    'documentation',
    'docs',
    'readme',
    'generate docs',
    'api docs',
    'user guide',
    'technical documentation',
  ],
  ar: ['توثيق', 'وثائق', 'دليل المستخدم', 'ملف readme', 'توثيق تقني'],
  stacks: [STACK_HTML],
  impliedFeatures: ['rtl'],
  questions: [
    {
      id: 'audience',
      text: b(
        'Who reads it: developers, operators or end users?',
        'من القارئ: مطورون أم مشغلون أم مستخدمون؟',
      ),
    },
  ],
  modules: [
    mod(
      'readme',
      ['README', 'ملف README'],
      'docs',
      [],
      ['README.md'],
      [
        [
          'A new developer can run the project from the README alone',
          'يستطيع مطور جديد تشغيل المشروع من README وحده',
        ],
      ],
      null,
      1,
    ),
    mod(
      'architecture',
      ['Architecture overview', 'نظرة معمارية'],
      'docs',
      ['readme'],
      ['docs/architecture.md'],
      [['Modules and their boundaries are described', 'توصف الوحدات وحدودها']],
      null,
      2,
    ),
    mod(
      'reference',
      ['API and module reference', 'مرجع الواجهات والوحدات'],
      'docs',
      ['architecture'],
      ['docs/reference.md'],
      [
        [
          'Every public function or endpoint found in the project is listed',
          'تُسرد كل دالة أو نقطة نهاية عامة في المشروع',
        ],
      ],
      'api-public',
      3,
    ),
    mod(
      'runbook',
      ['Operations runbook', 'دليل التشغيل'],
      'docs',
      ['architecture'],
      ['docs/runbook.md'],
      [
        [
          'Start, stop, backup and rollback steps are written down',
          'تُكتب خطوات التشغيل والإيقاف والنسخ الاحتياطي والتراجع',
        ],
      ],
      null,
      2,
    ),
    mod(
      'guide',
      ['User guide (Arabic and English)', 'دليل المستخدم (عربي وإنجليزي)'],
      'docs',
      ['readme'],
      ['docs/guide.ar.md', 'docs/guide.en.md'],
      [['Both languages describe the same steps', 'تصف اللغتان الخطوات نفسها']],
      'rtl',
      3,
    ),
    mod(
      'changelog',
      ['Changelog', 'سجل التغييرات'],
      'docs',
      ['readme'],
      ['CHANGELOG.md'],
      [['Changes are grouped by version', 'تُجمَّع التغييرات حسب الإصدار']],
      null,
      1,
    ),
  ],
};
