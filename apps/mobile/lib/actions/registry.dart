
import '../api/api_client.dart';
import '../api/api_data_source.dart' show localized;
import '../l10n/strings.dart';
import '../widgets/nz_icons.dart';
import 'action_model.dart';

// Every write the app offers, per page, against the endpoints in spec/openapi/openapi.yaml. Paid resources go
// quote → confirm → create; edits and deletes send If-Match; creates carry one Idempotency-Key per submission.

T _t(String s) => T(s, s);
Map<String, dynamic> _m(Object? o) => o is Map ? o.cast<String, dynamic>() : <String, dynamic>{};

Future<List<(String, T)>> Function(ActionContext) _from(
  String path,
  String Function(Map<String, dynamic>) label, {
  String valueKey = 'id',
  bool Function(Map<String, dynamic>)? where,
  Map<String, String>? query,
}) =>
    (c) async => [
          for (final x in await c.list(path, query: query))
            if (where == null || where(x)) ('${x[valueKey]}', _t(label(x))),
        ];

const _roles = <(String, T)>[
  ('owner', T('مالك', 'Owner')),
  ('admin', T('مشرف', 'Admin')),
  ('billing_admin', T('مشرف الفوترة', 'Billing admin')),
  ('developer', T('مطوّر', 'Developer')),
  ('viewer', T('مشاهد', 'Viewer')),
];

const _name = FieldDef('name', T('الاسم', 'Name'));
FieldDef _nameFrom() => FieldDef('name', const T('الاسم', 'Name'), initial: (r) => r['name']);

ActionDef _rename(String Function(ActionContext) path, {String bodyKey = 'name'}) => ActionDef(
      id: 'rename',
      label: const T('إعادة التسمية', 'Rename'),
      icon: NzIcons.penLine,
      fields: [_nameFrom()],
      done: const T('تم الحفظ', 'Saved'),
      run: (c) async => c.versioned('PATCH', path(c), {bodyKey: c.v('name')}),
    );

ActionDef _delete(String Function(ActionContext) path, {bool stepUp = false, T? confirm}) => ActionDef(
      id: 'delete',
      label: const T('حذف', 'Delete'),
      icon: NzIcons.trash2,
      destructive: true,
      stepUp: stepUp,
      confirm: confirm ?? const T('سيُحذف هذا العنصر. لا يمكن التراجع إلا حيث تسمح سياسة الاحتفاظ.',
          'This will be deleted. It can only be undone where the retention policy allows.'),
      done: const T('طُلب الحذف', 'Deletion requested'),
      run: (c) async => c.versioned('DELETE', path(c)),
    );

const _created = T('تم الإنشاء', 'Created');
const _requested = T('تم إرسال الطلب', 'Request sent');

final _contactFields = <FieldDef>[
  const FieldDef('firstName', T('الاسم الأول', 'First name')),
  const FieldDef('lastName', T('اسم العائلة', 'Last name')),
  const FieldDef('email', T('البريد الإلكتروني', 'Email'), kind: FieldKind.email, ltr: true),
  FieldDef('phone', const T('الجوال', 'Phone'), ltr: true, hint: const T('بالصيغة الدولية: +966.5xxxxxxxx', 'International: +966.5xxxxxxxx'),
      pattern: RegExp(r'^\+\d{1,3}\.\d{4,14}$')),
  const FieldDef('street', T('الشارع', 'Street')),
  const FieldDef('city', T('المدينة', 'City')),
  const FieldDef('postalCode', T('الرمز البريدي', 'Postal code'), ltr: true),
  FieldDef('country', const T('الدولة (رمزان)', 'Country (2 letters)'), ltr: true, initial: (_) => 'SA', pattern: RegExp(r'^[A-Za-z]{2}$')),
];

Map<String, Object?> _contact(ActionContext c) => {
      'firstName': c.v('firstName'),
      'lastName': c.v('lastName'),
      'email': c.v('email'),
      'phone': c.v('phone'),
      'address': {'street': c.v('street'), 'city': c.v('city'), 'postalCode': c.v('postalCode'), 'country': c.v('country').toUpperCase()},
    };

/// Page-level actions (create, or edit for settings pages), shown at the top of the page.
final Map<String, List<ActionDef>> kPageActions = {
  'workspaces': [
    ActionDef(
      id: 'create',
      label: const T('مساحة عمل جديدة', 'New workspace'),
      icon: NzIcons.plus,
      fields: const [_name],
      done: _created,
      run: (c) async => c.post('/v1/workspaces', {'name': c.v('name')}),
    ),
  ],
  'projects': [
    ActionDef(
      id: 'create',
      label: const T('مشروع جديد', 'New project'),
      icon: NzIcons.plus,
      fields: [
        FieldDef('workspaceId', const T('مساحة العمل', 'Workspace'), kind: FieldKind.select, optionsFrom: _from('/v1/workspaces', (w) => '${w['name']}')),
        _name,
      ],
      done: _created,
      run: (c) async => c.post('/v1/projects', {'workspaceId': c.v('workspaceId'), 'name': c.v('name')}),
    ),
  ],
  'appbuilder': [
    ActionDef(
      id: 'create',
      label: const T('مشروع بناء جديد', 'New build project'),
      icon: NzIcons.plus,
      fields: const [
        FieldDef('type', T('النوع', 'Type'), kind: FieldKind.select, options: [
          ('website', T('موقع', 'Website')),
          ('webapp', T('تطبيق ويب', 'Web app')),
          ('mobile', T('تطبيق جوال', 'Mobile app')),
        ]),
        _name,
      ],
      done: _created,
      run: (c) async => c.post('/v1/builder/projects', {'type': c.v('type'), 'name': c.v('name')}),
    ),
  ],
  'mobile': [
    ActionDef(
      id: 'create',
      label: const T('طلب بناء', 'Request a build'),
      icon: NzIcons.hammer,
      fields: [
        FieldDef('projectId', const T('المشروع', 'Project'),
            kind: FieldKind.select, optionsFrom: _from('/v1/builder/projects', (p) => '${p['name']}', where: (p) => p['type'] == 'mobile')),
        const FieldDef('platform', T('المنصة', 'Platform'), kind: FieldKind.select, options: [('android', T('أندرويد', 'Android')), ('ios', T('iOS', 'iOS'))]),
        const FieldDef('profile', T('النوع', 'Profile'), kind: FieldKind.select, options: [('debug', T('تجريبي', 'Debug')), ('release', T('إصدار', 'Release'))]),
      ],
      done: _requested,
      run: (c) async => c.post('/v1/mobile/builds', {'projectId': c.v('projectId'), 'platform': c.v('platform'), 'profile': c.v('profile')}),
    ),
  ],
  'aiBudgets': [
    ActionDef(
      id: 'edit',
      label: const T('تعديل الميزانيات', 'Edit budgets'),
      icon: NzIcons.slidersHorizontal,
      fields: [
        FieldDef('dailyCredits', const T('الحد اليومي (رصيد)', 'Daily credits'), kind: FieldKind.number, required: false,
            initial: (r) => _m(r['org'])['dailyCredits']),
        FieldDef('runMaxCredits', const T('حد التشغيل الواحد', 'Per-run credits'), kind: FieldKind.number, required: false,
            initial: (r) => _m(r['org'])['runMaxCredits']),
        FieldDef('totalCredits', const T('الحد الكلي', 'Total credits'), kind: FieldKind.number, required: false,
            initial: (r) => _m(r['org'])['totalCredits']),
      ],
      done: const T('تم الحفظ', 'Saved'),
      run: (c) async {
        int? n(String k) => c.opt(k) == null ? null : c.n(k);
        final org = {..._m(c.item['org']), 'dailyCredits': n('dailyCredits'), 'runMaxCredits': n('runMaxCredits'), 'totalCredits': n('totalCredits')};
        await c.versioned('PUT', '/v1/ai/budgets', {'org': org, 'projects': c.item['projects'] ?? const []});
      },
    ),
  ],
  'instances': [
    ActionDef(
      id: 'create',
      label: const T('خادم جديد', 'New server'),
      icon: NzIcons.plus,
      fields: [
        FieldDef('offerId', const T('الحجم والمنطقة', 'Size and region'),
            kind: FieldKind.select,
            optionsFrom: _from('/v1/offers', (o) => '${_m(o['plan'])['name'] ?? o['family']} · ${o['dataRegion']}', valueKey: 'offerId')),
        FieldDef('imageId', const T('نظام التشغيل', 'Operating system'),
            kind: FieldKind.select,
            optionsFrom: (c) async => c.v('offerId').isEmpty
                ? const []
                : [
                    for (final i in await c.list('/v1/offers/${c.v('offerId')}/images'))
                      ('${i['imageId'] ?? i['id']}', _t('${i['name'] ?? i['displayName'] ?? i['imageId'] ?? i['id']}')),
                  ]),
        FieldDef('name', const T('اسم الخادم', 'Server name'), ltr: true, pattern: RegExp(r'^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
            hint: const T('حروف إنجليزية صغيرة وأرقام وشرطة', 'Lowercase letters, digits and hyphens')),
      ],
      quote: (c) => {
        'kind': 'compute',
        'offerId': c.v('offerId'),
        'spec': {'imageId': c.v('imageId'), 'count': 1},
        'term': {'period': 'month'},
      },
      done: const T('بدأ تجهيز الخادم', 'The server is being set up'),
      run: (c) async => c.post('/v1/compute/instances', {'quoteId': c.quote!.id, 'name': c.v('name')}),
    ),
  ],
  'sites': [
    ActionDef(
      id: 'create',
      label: const T('موقع استضافة جديد', 'New hosting site'),
      icon: NzIcons.plus,
      fields: [
        FieldDef('planId', const T('الخطة', 'Plan'),
            kind: FieldKind.select, optionsFrom: (c) async => [for (final p in await c.list('/v1/hosting/plans')) ('${p['id']}', localized(p['name']))]),
        FieldDef('runtime', const T('بيئة التشغيل', 'Runtime'),
            kind: FieldKind.select,
            optionsFrom: (c) async {
              final plan = (await c.list('/v1/hosting/plans')).where((p) => '${p['id']}' == c.v('planId'));
              final rts = plan.isEmpty ? const [] : (plan.first['runtimes'] as List? ?? const []);
              return [
                for (final r in rts)
                  r is Map ? ('${r['id'] ?? r['key'] ?? r['name']}', _t('${r['name'] ?? r['id']}')) : ('$r', _t('$r')),
              ];
            }),
        FieldDef('projectId', const T('المشروع', 'Project'), kind: FieldKind.select, optionsFrom: _from('/v1/projects', (p) => '${p['name']}')),
        const FieldDef('name', T('اسم الموقع', 'Site name')),
        const FieldDef('primaryDomain', T('النطاق (اختياري)', 'Domain (optional)'), required: false, ltr: true),
      ],
      quote: (c) => {
        'kind': 'hosting',
        'items': [
          {'planId': c.v('planId'), 'runtime': c.v('runtime')},
        ],
      },
      done: const T('بدأ إنشاء الموقع', 'The site is being created'),
      run: (c) async => c.post('/v1/hosting/sites', {
        'quoteId': c.quote!.id,
        'planId': c.v('planId'),
        'name': c.v('name'),
        'projectId': c.v('projectId'),
        'runtime': c.v('runtime'),
        if (c.opt('primaryDomain') != null) 'primaryDomain': c.v('primaryDomain').toLowerCase(),
      }),
    ),
  ],
  'databases': [
    ActionDef(
      id: 'create',
      label: const T('قاعدة بيانات جديدة', 'New database'),
      icon: NzIcons.plus,
      fields: [
        const FieldDef('engine', T('المحرك', 'Engine'), kind: FieldKind.select, options: [
          ('postgresql', T('PostgreSQL', 'PostgreSQL')),
          ('mysql', T('MySQL', 'MySQL')),
          ('redis', T('Redis', 'Redis')),
        ]),
        FieldDef('version', const T('الإصدار', 'Version'), ltr: true, pattern: RegExp(r'^\d{1,3}(\.\d{1,3}){0,2}$')),
        FieldDef('planRef', const T('الخطة', 'Plan'), ltr: true, pattern: RegExp(r'^[A-Za-z0-9._-]{1,100}$')),
        const FieldDef('storageGb', T('التخزين (GB)', 'Storage (GB)'), kind: FieldKind.number),
        const FieldDef('name', T('الاسم', 'Name'), ltr: true),
      ],
      quote: (c) => {
        'kind': 'database',
        'items': [
          {'engine': c.v('engine'), 'version': c.v('version'), 'planRef': c.v('planRef'), 'storageGb': c.n('storageGb')},
        ],
      },
      done: const T('بدأ تجهيز قاعدة البيانات', 'The database is being set up'),
      run: (c) async => c.post('/v1/databases', {
        'quoteId': c.quote!.id,
        'engine': c.v('engine'),
        'version': c.v('version'),
        'name': c.v('name'),
        'network': {'access': 'private'},
      }),
    ),
  ],
  'storage': [
    ActionDef(
      id: 'create',
      label: const T('حاوية جديدة', 'New bucket'),
      icon: NzIcons.plus,
      fields: [
        FieldDef('name', const T('الاسم', 'Name'), ltr: true, pattern: RegExp(r'^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$')),
        const FieldDef('estimatedGb', T('الحجم المتوقع (GB)', 'Expected size (GB)'), kind: FieldKind.number),
        const FieldDef('versioning', T('حفظ الإصدارات', 'Versioning'), kind: FieldKind.toggle, required: false),
      ],
      quote: (c) => {
        'kind': 'storage',
        'items': [
          {'estimatedGb': c.n('estimatedGb')},
        ],
      },
      done: _created,
      run: (c) async => c.post('/v1/storage/buckets', {'name': c.v('name'), 'quoteId': c.quote!.id, 'versioning': c.b('versioning')}),
    ),
  ],
  'emailDomains': [
    ActionDef(
      id: 'create',
      label: const T('إضافة نطاق بريد', 'Add an email domain'),
      icon: NzIcons.plus,
      fields: const [
        FieldDef('domain', T('النطاق', 'Domain'), ltr: true),
        FieldDef('purposes', T('الاستخدام', 'Use'), kind: FieldKind.select, options: [
          ('mailbox', T('صناديق بريد', 'Mailboxes')),
          ('transactional', T('رسائل المعاملات', 'Transactional email')),
          ('both', T('الاثنان', 'Both')),
        ]),
      ],
      done: const T('أُضيف النطاق. أضف سجلات DNS الظاهرة في التفاصيل.', 'Domain added. Add the DNS records shown in its details.'),
      run: (c) async => c.post('/v1/email/domains', {
        'domain': c.v('domain').toLowerCase(),
        'purposes': c.v('purposes') == 'both' ? ['mailbox', 'transactional'] : [c.v('purposes')],
      }),
    ),
  ],
  'mailboxes': [
    ActionDef(
      id: 'create',
      label: const T('صندوق بريد جديد', 'New mailbox'),
      icon: NzIcons.plus,
      fields: [
        FieldDef('domainId', const T('النطاق', 'Domain'),
            kind: FieldKind.select, optionsFrom: _from('/v1/email/domains', (d) => '${d['domain']}', where: (d) => d['state'] == 'verified')),
        FieldDef('localPart', const T('اسم الصندوق (قبل @)', 'Mailbox name (before @)'), ltr: true, pattern: RegExp(r'^[A-Za-z0-9._-]{1,64}$')),
        const FieldDef('quotaMb', T('السعة (MB)', 'Size (MB)'), kind: FieldKind.number),
      ],
      quote: (c) => {
        'kind': 'email',
        'items': [
          {'type': 'mailbox', 'quotaMb': c.n('quotaMb')},
        ],
      },
      done: _created,
      run: (c) async => c.post('/v1/email/mailboxes',
          {'domainId': c.v('domainId'), 'localPart': c.v('localPart').toLowerCase(), 'quotaMb': c.n('quotaMb'), 'quoteId': c.quote!.id}),
    ),
  ],
  'senders': [
    ActionDef(
      id: 'create',
      label: const T('هوية مرسل جديدة', 'New sender identity'),
      icon: NzIcons.plus,
      fields: [
        FieldDef('domainId', const T('النطاق', 'Domain'), kind: FieldKind.select, optionsFrom: _from('/v1/email/domains', (d) => '${d['domain']}')),
        const FieldDef('fromAddress', T('عنوان المرسل', 'From address'), kind: FieldKind.email, ltr: true),
      ],
      done: _created,
      run: (c) async => c.post('/v1/email/sender-identities', {'domainId': c.v('domainId'), 'fromAddress': c.v('fromAddress').toLowerCase()}),
    ),
  ],
  'templates': [
    ActionDef(
      id: 'create',
      label: const T('قالب جديد', 'New template'),
      icon: NzIcons.plus,
      fields: [
        // Same rule as the API (sender-template.service.ts): a lower-case slug.
        FieldDef('key', const T('المفتاح', 'Key'), ltr: true, pattern: RegExp(r'^[a-z][a-z0-9_-]{1,62}$'),
            hint: const T('حروف إنجليزية صغيرة وأرقام و - أو _', 'Lowercase letters, digits, - or _')),
        const FieldDef('name', T('الاسم', 'Name')),
        const FieldDef('locale', T('اللغة', 'Language'), kind: FieldKind.select, options: [('ar', T('العربية', 'Arabic')), ('en', T('الإنجليزية', 'English'))]),
        const FieldDef('subject', T('الموضوع', 'Subject')),
        const FieldDef('html', T('المحتوى (HTML)', 'Content (HTML)'), kind: FieldKind.multiline, ltr: true),
      ],
      done: _created,
      run: (c) async => c.post('/v1/email/templates',
          {'key': c.v('key'), 'name': c.v('name'), 'locale': c.v('locale'), 'subject': c.v('subject'), 'html': c.v('html')}),
    ),
  ],
  'messages': [
    ActionDef(
      id: 'create',
      label: const T('إرسال رسالة', 'Send a message'),
      icon: NzIcons.send,
      fields: [
        FieldDef('senderId', const T('المرسل', 'Sender'),
            kind: FieldKind.select,
            optionsFrom: _from('/v1/email/sender-identities', (x) => '${x['fromAddress']}', where: (x) => x['status'] == 'verified')),
        const FieldDef('to', T('إلى', 'To'), kind: FieldKind.email, ltr: true),
        const FieldDef('subject', T('الموضوع', 'Subject')),
        const FieldDef('text', T('النص', 'Text'), kind: FieldKind.multiline),
      ],
      confirm: const T('ستُرسل الرسالة فعليًا إلى المستلم.', 'The message will really be sent to the recipient.'),
      done: const T('قُبلت الرسالة للإرسال', 'Message accepted for sending'),
      run: (c) async => c.post('/v1/email/messages', {
        'senderId': c.v('senderId'),
        'to': [c.v('to')],
        'subject': c.v('subject'),
        'text': c.v('text'),
        'category': 'transactional',
      }),
    ),
  ],
  'suppressions': [
    ActionDef(
      id: 'create',
      label: const T('حظر عنوان', 'Suppress an address'),
      icon: NzIcons.ban,
      fields: const [FieldDef('address', T('العنوان', 'Address'), kind: FieldKind.email, ltr: true)],
      done: const T('أُضيف إلى قائمة الحظر', 'Added to the suppression list'),
      run: (c) async => c.post('/v1/email/suppressions', {'address': c.v('address').toLowerCase(), 'action': 'add'}),
    ),
  ],
  'limits': [
    ActionDef(
      id: 'edit',
      label: const T('ضبط الحد الشهري', 'Set the monthly cap'),
      icon: NzIcons.slidersHorizontal,
      fields: [
        FieldDef('cap', const T('الحد الشهري (ر.س)', 'Monthly cap (SAR)'),
            kind: FieldKind.money, initial: (r) => fromMinor(r['monthlyCapMinor'])),
        FieldDef('fourEyes', const T('موافقة شخصين فوق (ر.س، اختياري)', 'Two approvals above (SAR, optional)'),
            kind: FieldKind.money, required: false, initial: (r) => fromMinor(r['fourEyesAboveMinor'])),
      ],
      done: const T('تم الحفظ', 'Saved'),
      run: (c) async => c.versioned('PUT', '/v1/billing/spending-limits', {
        'scope': 'org',
        'monthlyCapMinor': '${toMinor(c.v('cap'))}',
        'currency': 'SAR',
        'fourEyesAboveMinor': c.opt('fourEyes') == null ? null : '${toMinor(c.v('fourEyes'))}',
      }),
    ),
  ],
  'taxProfile': [
    ActionDef(
      id: 'edit',
      label: const T('تعديل الملف الضريبي', 'Edit tax profile'),
      icon: NzIcons.penLine,
      fields: [
        FieldDef('buyerType', const T('نوع المشتري', 'Buyer type'),
            kind: FieldKind.select,
            options: const [('b2b', T('منشأة', 'Business')), ('b2c', T('فرد', 'Individual'))],
            initial: (r) => r['buyerType'] ?? 'b2b'),
        FieldDef('legalAr', const T('الاسم القانوني بالعربية', 'Legal name in Arabic'), initial: (r) => _m(r['legalName'])['ar']),
        FieldDef('legalEn', const T('الاسم القانوني بالإنجليزية', 'Legal name in English'), initial: (r) => _m(r['legalName'])['en']),
        FieldDef('vat', const T('الرقم الضريبي', 'VAT number'),
            required: false, ltr: true, pattern: RegExp(r'^3\d{13}3$'), initial: (r) => r['vatNumber'],
            hint: const T('15 رقمًا يبدأ وينتهي بـ 3', '15 digits, starts and ends with 3')),
        FieldDef('cr', const T('السجل التجاري', 'CR number'), required: false, ltr: true, initial: (r) => r['crNumber']),
        FieldDef('street', const T('الشارع', 'Street'), required: false, initial: (r) => _m(r['address'])['street']),
        FieldDef('buildingNumber', const T('رقم المبنى', 'Building number'), required: false, ltr: true, initial: (r) => _m(r['address'])['buildingNumber']),
        FieldDef('district', const T('الحي', 'District'), required: false, initial: (r) => _m(r['address'])['district']),
        FieldDef('city', const T('المدينة', 'City'), required: false, initial: (r) => _m(r['address'])['city']),
        FieldDef('postalCode', const T('الرمز البريدي', 'Postal code'), required: false, ltr: true, initial: (r) => _m(r['address'])['postalCode']),
      ],
      done: const T('تم الحفظ', 'Saved'),
      run: (c) async => c.versioned('PUT', '/v1/billing/tax-profile', {
        'buyerType': c.v('buyerType'),
        'legalName': {'ar': c.v('legalAr'), 'en': c.v('legalEn')},
        'vatNumber': c.opt('vat'),
        'crNumber': c.opt('cr'),
        'address': {
          for (final k in ['street', 'buildingNumber', 'district', 'city', 'postalCode'])
            if (c.opt(k) != null) k: c.v(k),
          'country': 'SA',
        },
      }),
    ),
  ],
  'team': [
    ActionDef(
      id: 'create',
      label: const T('دعوة عضو', 'Invite a member'),
      icon: NzIcons.userPlus,
      fields: const [
        FieldDef('email', T('البريد الإلكتروني', 'Email'), kind: FieldKind.email, ltr: true),
        FieldDef('role', T('الدور', 'Role'), kind: FieldKind.select, options: _roles),
      ],
      done: const T('أُرسلت الدعوة', 'Invitation sent'),
      run: (c) async => c.post('/v1/invitations', {'email': c.v('email').toLowerCase(), 'role': c.v('role')}),
    ),
  ],
  'orgSettings': [
    ActionDef(
      id: 'edit',
      label: const T('تعديل المؤسسة', 'Edit organization'),
      icon: NzIcons.penLine,
      fields: [
        FieldDef('name', const T('اسم المؤسسة', 'Organization name'), initial: (r) => r['name']),
        FieldDef('defaultLocale', const T('اللغة الافتراضية', 'Default language'),
            kind: FieldKind.select, options: const [('ar', T('العربية', 'Arabic')), ('en', T('الإنجليزية', 'English'))], initial: (r) => r['defaultLocale']),
      ],
      done: const T('تم الحفظ', 'Saved'),
      run: (c) async => c.versioned('PATCH', '/v1/organizations/${c.orgId}', {'name': c.v('name'), 'defaultLocale': c.v('defaultLocale')}),
    ),
  ],
  'profile': [
    ActionDef(
      id: 'password',
      label: const T('تغيير كلمة المرور', 'Change password'),
      icon: NzIcons.keyRound,
      fields: const [
        FieldDef('currentPassword', T('كلمة المرور الحالية', 'Current password'), kind: FieldKind.password, ltr: true),
        FieldDef('newPassword', T('كلمة المرور الجديدة (12 حرفًا على الأقل)', 'New password (at least 12 characters)'), kind: FieldKind.password, ltr: true),
      ],
      done: const T('تم تغيير كلمة المرور', 'Password changed'),
      run: (c) async => c.post('/v1/auth/password/change', {'currentPassword': c.v('currentPassword'), 'newPassword': c.v('newPassword')}),
    ),
  ],
};

/// Actions on one row, shown on its detail screen.
final Map<String, List<ActionDef>> kItemActions = {
  'workspaces': [_rename((c) => '/v1/workspaces/${c.id}'), _delete((c) => '/v1/workspaces/${c.id}')],
  'projects': [_rename((c) => '/v1/projects/${c.id}'), _delete((c) => '/v1/projects/${c.id}')],
  'appbuilder': [
    _rename((c) => '/v1/builder/projects/${c.id}'),
    // The API takes the typed project name as the human approval of this destructive action.
    ActionDef(
      id: 'delete',
      label: const T('حذف', 'Delete'),
      icon: NzIcons.trash2,
      destructive: true,
      fields: const [FieldDef('confirmName', T('اكتب اسم المشروع للتأكيد', 'Type the project name to confirm'))],
      confirm: const T('سيُحذف المشروع (يُحتفظ به لفترة الاحتفاظ) وتتوقف معايناته.',
          'The project is deleted (kept for the retention window) and its previews stop.'),
      done: const T('حُذف المشروع', 'Project deleted'),
      run: (c) async {
        if (c.v('confirmName') != '${c.item['name']}') {
          throw ApiException(422, 'validation_failed', 'confirmName', fields: const ['confirmName']);
        }
        await c.versioned('DELETE', '/v1/builder/projects/${c.id}?confirmName=${Uri.encodeQueryComponent(c.v('confirmName'))}', null,
            '/v1/builder/projects/${c.id}');
      },
    ),
  ],
  'buildApprovals': [
    for (final (d, l, i) in [
      ('approve', const T('موافقة', 'Approve'), NzIcons.check),
      ('reject', const T('رفض', 'Reject'), NzIcons.x),
    ])
      ActionDef(
        id: d,
        label: l,
        icon: i,
        destructive: d == 'reject',
        visible: (x) => x['status'] == 'pending',
        fields: const [FieldDef('note', T('ملاحظة (اختياري)', 'Note (optional)'), required: false)],
        confirm: d == 'approve' ? const T('ستُنفَّذ العملية بعد موافقتك.', 'The operation runs after your approval.') : null,
        done: const T('سُجّل القرار', 'Decision recorded'),
        run: (c) async => c.post('/v1/ai/approvals/${c.id}/decisions',
            {'decision': d, 'scopeHash': c.item['scopeHash'], if (c.opt('note') != null) 'note': c.v('note')}),
      ),
  ],
  'instances': [
    for (final (a, l, i, onlyWhen) in [
      ('start', const T('تشغيل', 'Start'), NzIcons.play, 'stopped'),
      ('stop', const T('إيقاف', 'Stop'), NzIcons.pause, 'running'),
      ('reboot', const T('إعادة التشغيل', 'Reboot'), NzIcons.rotateCw, 'running'),
    ])
      ActionDef(
        id: a,
        label: l,
        icon: i,
        visible: (x) => x['status'] == onlyWhen,
        done: const T('بدأت العملية', 'Operation started'),
        run: (c) async => c.post('/v1/compute/instances/${c.id}/actions', {'type': a}),
      ),
    _delete((c) => '/v1/compute/instances/${c.id}',
        confirm: const T('سيُحذف الخادم وبياناته. لا يمكن التراجع.', 'The server and its data will be deleted. This cannot be undone.')),
  ],
  'sites': [
    _rename((c) => '/v1/hosting/sites/${c.id}'),
    ActionDef(
      id: 'backup',
      label: const T('نسخة احتياطية الآن', 'Back up now'),
      icon: NzIcons.hardDrive,
      fields: const [FieldDef('label', T('وصف (اختياري)', 'Label (optional)'), required: false)],
      done: const T('بدأ النسخ الاحتياطي', 'Backup started'),
      run: (c) async => c.post('/v1/hosting/sites/${c.id}/backups', {if (c.opt('label') != null) 'label': c.v('label')}),
    ),
    _delete((c) => '/v1/hosting/sites/${c.id}',
        confirm: const T('سيُحذف الموقع وملفاته. لا يمكن التراجع.', 'The site and its files will be deleted. This cannot be undone.')),
  ],
  'domainList': [
    ActionDef(
      id: 'renew',
      label: const T('تجديد سنة', 'Renew 1 year'),
      icon: NzIcons.rotateCw,
      quote: (c) => {
        'kind': 'domain',
        'items': [
          {'name': c.item['name'], 'years': 1, 'action': 'renew'},
        ],
      },
      done: const T('طُلب التجديد', 'Renewal requested'),
      run: (c) async => c.post('/v1/domains/${c.id}/renewals', {'quoteId': c.quote!.id, 'years': 1}),
    ),
    ActionDef(
      id: 'settings',
      label: const T('القفل والتجديد التلقائي', 'Lock and auto-renew'),
      icon: NzIcons.lock,
      fields: [
        FieldDef('lock', const T('قفل النقل', 'Transfer lock'), kind: FieldKind.toggle, required: false, initial: (r) => r['locked'] == true),
        FieldDef('autoRenew', const T('تجديد تلقائي', 'Auto-renew'), kind: FieldKind.toggle, required: false, initial: (r) => r['autoRenew'] == true),
      ],
      done: const T('تم الحفظ', 'Saved'),
      run: (c) async => c.versioned('PATCH', '/v1/domains/${c.id}', {'lock': c.b('lock'), 'autoRenew': c.b('autoRenew')}),
    ),
  ],
  'domainSearch': [
    ActionDef(
      id: 'register',
      label: const T('تسجيل النطاق', 'Register domain'),
      icon: NzIcons.globe,
      fields: [
        const FieldDef('years', T('المدة', 'Term'), kind: FieldKind.select, options: [
          ('1', T('سنة', '1 year')),
          ('2', T('سنتان', '2 years')),
          ('3', T('3 سنوات', '3 years')),
        ]),
        ..._contactFields,
        const FieldDef('privacy', T('حماية الخصوصية', 'Privacy protection'), kind: FieldKind.toggle, required: false),
      ],
      quote: (c) => {
        'kind': 'domain',
        'items': [
          {'name': c.item['name'], 'years': c.n('years'), 'action': 'register'},
        ],
      },
      done: const T('طُلب تسجيل النطاق', 'Registration requested'),
      run: (c) async => c.post('/v1/domains', {
        'quoteId': c.quote!.id,
        'contacts': {'registrant': _contact(c)},
        'privacy': c.b('privacy'),
        'autoRenew': false,
      }),
    ),
  ],
  'databases': [
    _rename((c) => '/v1/databases/${c.id}'),
    ActionDef(
      id: 'backup',
      label: const T('نسخة احتياطية الآن', 'Back up now'),
      icon: NzIcons.hardDrive,
      done: const T('بدأ النسخ الاحتياطي', 'Backup started'),
      run: (c) async => c.post('/v1/databases/${c.id}/backups', {'type': 'manual'}),
    ),
    _delete((c) => '/v1/databases/${c.id}',
        confirm: const T('ستُحذف قاعدة البيانات. لا يمكن التراجع.', 'The database will be deleted. This cannot be undone.')),
  ],
  'storage': [
    ActionDef(
      id: 'quota',
      label: const T('تغيير الحصة', 'Change quota'),
      icon: NzIcons.gauge,
      fields: [
        FieldDef('gb', const T('الحصة (GB)', 'Quota (GB)'),
            kind: FieldKind.number, initial: (r) => r['quotaBytes'] == null ? null : '${(r['quotaBytes'] as num) ~/ 1000000000}'),
      ],
      done: const T('تم الحفظ', 'Saved'),
      run: (c) async => c.versioned('PATCH', '/v1/storage/buckets/${c.id}', {'quotaBytes': c.n('gb') * 1000000000}),
    ),
    _delete((c) => '/v1/storage/buckets/${c.id}', stepUp: true),
  ],
  'emailDomains': [
    ActionDef(
      id: 'verify',
      label: const T('إعادة التحقق الآن', 'Check again now'),
      icon: NzIcons.refreshCw,
      done: const T('بدأ التحقق', 'Check started'),
      run: (c) async => c.post('/v1/email/domains/${c.id}/verification', {}),
    ),
  ],
  'mailboxes': [
    ActionDef(
      id: 'quota',
      label: const T('تغيير السعة', 'Change size'),
      icon: NzIcons.gauge,
      fields: [FieldDef('quotaMb', const T('السعة (MB)', 'Size (MB)'), kind: FieldKind.number, initial: (r) => r['quotaMb'])],
      done: const T('تم الحفظ', 'Saved'),
      run: (c) async => c.versioned('PATCH', '/v1/email/mailboxes/${c.id}', {'quotaMb': c.n('quotaMb')}),
    ),
    _delete((c) => '/v1/email/mailboxes/${c.id}',
        confirm: const T('سيُحذف الصندوق ورسائله.', 'The mailbox and its messages will be deleted.')),
  ],
  'suppressions': [
    ActionDef(
      id: 'remove',
      label: const T('إزالة من الحظر', 'Remove from the list'),
      icon: NzIcons.check,
      visible: (x) => x['active'] == true,
      confirm: const T('ستُرسل الرسائل إلى هذا العنوان مجددًا.', 'Messages will be sent to this address again.'),
      done: const T('أُزيل من قائمة الحظر', 'Removed from the list'),
      run: (c) async => c.post('/v1/email/suppressions', {'address': c.item['address'], 'action': 'remove'}),
    ),
  ],
  'plansSubs': [
    ActionDef(
      id: 'cancel',
      label: const T('إلغاء عند نهاية الفترة', 'Cancel at period end'),
      icon: NzIcons.x,
      destructive: true,
      visible: (x) => x['cancelAtPeriodEnd'] != true && x['status'] != 'cancelled',
      fields: const [FieldDef('reason', T('السبب (اختياري)', 'Reason (optional)'), required: false)],
      confirm: const T('يبقى الاشتراك فعّالًا حتى نهاية الفترة المدفوعة ثم يتوقف.',
          'The subscription stays active until the end of the paid period, then stops.'),
      done: const T('سيتوقف الاشتراك في نهاية الفترة', 'The subscription will stop at period end'),
      run: (c) async => c.post('/v1/billing/subscriptions/${c.id}/cancellation', {if (c.opt('reason') != null) 'reason': c.v('reason')}),
    ),
  ],
  'spendApprovals': [
    for (final (d, l, i) in [
      ('approve', const T('موافقة', 'Approve'), NzIcons.check),
      ('deny', const T('رفض', 'Deny'), NzIcons.x),
    ])
      ActionDef(
        id: d,
        label: l,
        icon: i,
        destructive: d == 'deny',
        stepUp: true,
        visible: (x) => x['status'] == 'pending',
        fields: const [FieldDef('note', T('ملاحظة (اختياري)', 'Note (optional)'), required: false)],
        confirm: d == 'approve' ? const T('ستُعتمد هذه النفقة.', 'This spend will be approved.') : null,
        done: const T('سُجّل القرار', 'Decision recorded'),
        run: (c) async => c.post('/v1/billing/spend-approvals/${c.id}/decision', {'decision': d, if (c.opt('note') != null) 'note': c.v('note')}),
      ),
  ],
  'team': [
    ActionDef(
      id: 'role',
      label: const T('تغيير الدور', 'Change role'),
      icon: NzIcons.userCog,
      stepUp: true,
      fields: [FieldDef('role', const T('الدور', 'Role'), kind: FieldKind.select, options: _roles, initial: (r) => r['role'])],
      done: const T('تم تغيير الدور', 'Role changed'),
      run: (c) async => c.versioned('PATCH', '/v1/organizations/${c.orgId}/members/${c.item['userId']}', {'role': c.v('role')},
          '/v1/organizations/${c.orgId}/members/${c.item['userId']}'),
    ),
    ActionDef(
      id: 'remove',
      label: const T('إزالة من المؤسسة', 'Remove from organization'),
      icon: NzIcons.userMinus,
      destructive: true,
      confirm: const T('سيفقد هذا العضو الوصول إلى المؤسسة فورًا.', 'This member loses access to the organization right away.'),
      done: const T('أُزيل العضو', 'Member removed'),
      run: (c) async => c.api.delete('/v1/organizations/${c.orgId}/members/${c.item['userId']}'),
    ),
  ],
};

/// Pages whose writes stay in the web console for now (open-ended bodies, PSP redirects or a delegated flow).
const Set<String> kWebOnlyWrites = {
  'workflows', 'connectors', 'webhooks', 'marketplace', 'transfers', 'invoices', 'payments', 'sso', 'agency', 'reseller', 'partners',
  'hostingPlans', 'ledger', 'privacy', 'usageQuotas', 'aiUsage', 'billingOverview',
};
