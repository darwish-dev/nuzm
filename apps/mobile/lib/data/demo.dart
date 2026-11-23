import 'package:flutter/widgets.dart';

import '../l10n/strings.dart';
import '../widgets/nz_icons.dart';

/// SAMPLE DATA ONLY. The app is not connected to the API yet; every screen says so with a "Sample data" chip.
/// No prices, plans, regions or provider capabilities are claimed here (CLAUDE.md §4): plan cards show names only,
/// and amounts are the organization's own sample invoices, held as integer minor units (halalas).

enum Tone { success, warn, danger, neutral, accent, orange }

@immutable
class Status {
  const Status(this.label, this.tone);
  final T label;
  final Tone tone;

  static const running = Status(T('يعمل', 'Running'), Tone.success);
  static const active = Status(T('نشط', 'Active'), Tone.success);
  static const verified = Status(T('موثّق', 'Verified'), Tone.success);
  static const paid = Status(T('مدفوعة', 'Paid'), Tone.success);
  static const succeeded = Status(T('ناجحة', 'Succeeded'), Tone.success);
  static const delivered = Status(T('سُلّمت', 'Delivered'), Tone.success);
  static const connected = Status(T('متصل', 'Connected'), Tone.success);
  static const stopped = Status(T('متوقف', 'Stopped'), Tone.neutral);
  static const draft = Status(T('مسودة', 'Draft'), Tone.neutral);
  static const paused = Status(T('موقوف مؤقتًا', 'Paused'), Tone.neutral);
  static const pending = Status(T('قيد الانتظار', 'Pending'), Tone.warn);
  static const building = Status(T('قيد البناء', 'Building'), Tone.accent);
  static const due = Status(T('مستحقة', 'Due'), Tone.orange);
  static const expiring = Status(T('يقترب التجديد', 'Renews soon'), Tone.orange);
  static const failed = Status(T('فشل', 'Failed'), Tone.danger);
  static const bounced = Status(T('ارتدّت', 'Bounced'), Tone.danger);
  static const owner = Status(T('مالك', 'Owner'), Tone.accent);
  static const admin = Status(T('مشرف', 'Admin'), Tone.neutral);
  static const member = Status(T('عضو', 'Member'), Tone.neutral);
  static const invited = Status(T('مدعو', 'Invited'), Tone.warn);
}

@immutable
class Item {
  const Item(this.title, this.subtitle,
      {this.status, this.meta, this.icon, this.facts = const [], this.ltrTitle = false, this.raw = const {}});
  final T title;
  final T subtitle;
  final Status? status;

  /// Short trailing value (amount, IP, size). Always shown left-to-right.
  final String? meta;
  final IconData? icon;
  final List<(T, String)> facts;

  /// Technical names (hosts, domains, emails) stay left-to-right in Arabic too.
  final bool ltrTitle;

  /// The API object behind the row (empty for sample data): item actions read ids, versions and states from it.
  final Map<String, dynamic> raw;
}

@immutable
class Stat {
  const Stat(this.label, this.value, {this.hint, this.progress, this.icon});
  final T label;
  final String value;
  final T? hint;

  /// 0..1, drawn as a meter.
  final double? progress;
  final IconData? icon;
}

@immutable
class CatalogItem {
  const CatalogItem(this.name, this.desc, this.icon, {this.tag});
  final T name;
  final T desc;
  final IconData icon;
  final T? tag;
}

@immutable
class FieldSpec {
  const FieldSpec(this.label, this.value, {this.ltr = false, this.hint, this.toggle});
  final T label;
  final String value;
  final bool ltr;
  final T? hint;

  /// Non-null → a switch row with this initial value.
  final bool? toggle;
}

/// Integer minor units → "1,234.50 SAR" / "1,234.50 ر.س". Two decimals (SAR and the other currencies the platform bills).
String money(int minor, BuildContext context, {String currency = 'SAR'}) {
  final sign = minor < 0 ? '-' : '';
  final abs = minor.abs();
  final whole = (abs ~/ 100).toString().replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (_) => ',');
  final frac = (abs % 100).toString().padLeft(2, '0');
  final unit = currency == 'SAR' && isAr(context) ? 'ر.س' : currency;
  return '$sign$whole.$frac $unit';
}

const _riyadh = T('الرياض', 'Riyadh');

final Map<String, List<Item>> kLists = {
  'projects': [
    Item(T('متجر القهوة', 'Coffee shop'), T('موقع + تطبيق جوال', 'Website + mobile app'), status: Status.building, icon: NzIcons.shoppingBag,
        facts: [(T('مساحة العمل', 'Workspace'), 'Main'), (T('آخر تحديث', 'Last update'), '2026-11-21')]),
    Item(T('بوابة العملاء', 'Customer portal'), T('تطبيق ويب', 'Web app'), status: Status.active, icon: NzIcons.appWindow,
        facts: [(T('مساحة العمل', 'Workspace'), 'Main'), (T('آخر تحديث', 'Last update'), '2026-11-18')]),
    Item(T('الموقع التعريفي', 'Company site'), T('موقع ثابت', 'Static site'), status: Status.active, icon: NzIcons.globe),
    Item(T('أتمتة الطلبات', 'Order automation'), T('سير عمل', 'Workflow'), status: Status.draft, icon: NzIcons.workflow),
  ],
  'workspaces': [
    Item(T('الرئيسية', 'Main'), T('4 مشاريع · 3 أعضاء', '4 projects · 3 members'), status: Status.active, icon: NzIcons.layoutGrid),
    Item(T('التجارب', 'Sandbox'), T('مشروع واحد · عضو واحد', '1 project · 1 member'), status: Status.active, icon: NzIcons.layoutGrid),
  ],
  'appbuilder': [
    Item(T('تطبيق متجر القهوة', 'Coffee shop app'), T('Next.js · آخر بناء قبل ساعتين', 'Next.js · built 2 hours ago'), status: Status.building, icon: NzIcons.appWindow),
    Item(T('لوحة الحجوزات', 'Bookings board'), T('React · آخر بناء أمس', 'React · built yesterday'), status: Status.active, icon: NzIcons.appWindow),
  ],
  'buildApprovals': [
    Item(T('نشر تطبيق متجر القهوة', 'Deploy Coffee shop app'), T('يحتاج موافقتك قبل النشر', 'Needs your approval before deploy'), status: Status.pending, icon: NzIcons.rocket),
  ],
  'mobile': [
    Item(T('متجر القهوة — iOS', 'Coffee shop — iOS'), T('Flutter · نسخة 0.3.0', 'Flutter · version 0.3.0'), status: Status.building, icon: NzIcons.smartphone),
    Item(T('متجر القهوة — Android', 'Coffee shop — Android'), T('Flutter · نسخة 0.3.0', 'Flutter · version 0.3.0'), status: Status.draft, icon: NzIcons.smartphone),
  ],
  'workflows': [
    Item(T('طلب جديد ← بريد ترحيب', 'New order → welcome email'), T('آخر تشغيل قبل 5 دقائق', 'Last run 5 minutes ago'), status: Status.active, icon: NzIcons.workflow),
    Item(T('فاتورة مستحقة ← تذكير', 'Invoice due → reminder'), T('آخر تشغيل أمس', 'Last run yesterday'), status: Status.paused, icon: NzIcons.workflow),
    Item(T('نسخة احتياطية ليلية', 'Nightly backup'), T('فشل آخر تشغيل', 'Last run failed'), status: Status.failed, icon: NzIcons.workflow),
  ],
  'connectors': [
    Item(T('Slack', 'Slack'), T('إشعارات الفريق', 'Team notifications'), status: Status.connected, icon: NzIcons.plug, ltrTitle: true),
    Item(T('Google Sheets', 'Google Sheets'), T('تصدير الطلبات', 'Order export'), status: Status.connected, icon: NzIcons.plug, ltrTitle: true),
  ],
  'webhooks': [
    Item(T('https://api.coffee.sa/hooks/orders', 'https://api.coffee.sa/hooks/orders'), T('order.created · invoice.paid', 'order.created · invoice.paid'),
        status: Status.active, icon: NzIcons.webhook, ltrTitle: true),
  ],
  'instances': [
    Item(T('web-01', 'web-01'), T('2 vCPU · 4 GB · Ubuntu 24.04', '2 vCPU · 4 GB · Ubuntu 24.04'), status: Status.running, meta: '10.0.0.12', icon: NzIcons.server, ltrTitle: true,
        facts: [(T('المنطقة', 'Region'), 'Riyadh'), (T('المشروع', 'Project'), 'Coffee shop'), (T('أُنشئ', 'Created'), '2026-10-02')]),
    Item(T('db-01', 'db-01'), T('4 vCPU · 8 GB · Ubuntu 24.04', '4 vCPU · 8 GB · Ubuntu 24.04'), status: Status.running, meta: '10.0.0.13', icon: NzIcons.server, ltrTitle: true),
    Item(T('staging', 'staging'), T('1 vCPU · 2 GB · Debian 12', '1 vCPU · 2 GB · Debian 12'), status: Status.stopped, meta: '10.0.0.20', icon: NzIcons.server, ltrTitle: true),
  ],
  'sites': [
    Item(T('coffee.sa', 'coffee.sa'), T('WordPress · SSL مفعّل', 'WordPress · SSL on'), status: Status.active, icon: NzIcons.globe, ltrTitle: true),
    Item(T('blog.coffee.sa', 'blog.coffee.sa'), T('PHP 8.3 · SSL مفعّل', 'PHP 8.3 · SSL on'), status: Status.active, icon: NzIcons.globe, ltrTitle: true),
  ],
  'domainList': [
    Item(T('coffee.sa', 'coffee.sa'), T('يتجدد في 2027-03-14', 'Renews 2027-03-14'), status: Status.active, icon: NzIcons.globe, ltrTitle: true),
    Item(T('coffee-shop.com', 'coffee-shop.com'), T('يتجدد في 2026-12-02', 'Renews 2026-12-02'), status: Status.expiring, icon: NzIcons.globe, ltrTitle: true),
    Item(T('darwish.dev', 'darwish.dev'), T('يتجدد في 2027-07-30', 'Renews 2027-07-30'), status: Status.active, icon: NzIcons.globe, ltrTitle: true),
  ],
  'transfers': [],
  'databases': [
    Item(T('orders-db', 'orders-db'), T('PostgreSQL 16 · 12 GB', 'PostgreSQL 16 · 12 GB'), status: Status.running, icon: NzIcons.database, ltrTitle: true),
    Item(T('cache', 'cache'), T('Redis 7 · 1 GB', 'Redis 7 · 1 GB'), status: Status.running, icon: NzIcons.database, ltrTitle: true),
  ],
  'storage': [
    Item(T('product-images', 'product-images'), T('3,240 ملفًا · 8.4 GB', '3,240 files · 8.4 GB'), status: Status.active, icon: NzIcons.container, ltrTitle: true),
    Item(T('backups', 'backups'), T('62 ملفًا · 21 GB', '62 files · 21 GB'), status: Status.active, icon: NzIcons.container, ltrTitle: true),
  ],
  'emailDomains': [
    Item(T('coffee.sa', 'coffee.sa'), T('SPF · DKIM · DMARC', 'SPF · DKIM · DMARC'), status: Status.verified, icon: NzIcons.atSign, ltrTitle: true),
    Item(T('coffee-shop.com', 'coffee-shop.com'), T('بانتظار سجلات DNS', 'Waiting for DNS records'), status: Status.pending, icon: NzIcons.atSign, ltrTitle: true),
  ],
  'mailboxes': [
    Item(T('info@coffee.sa', 'info@coffee.sa'), T('2.1 GB من 10 GB', '2.1 GB of 10 GB'), status: Status.active, icon: NzIcons.inbox, ltrTitle: true),
    Item(T('orders@coffee.sa', 'orders@coffee.sa'), T('0.4 GB من 10 GB', '0.4 GB of 10 GB'), status: Status.active, icon: NzIcons.inbox, ltrTitle: true),
  ],
  'messages': [
    Item(T('تأكيد الطلب #1042', 'Order confirmation #1042'), T('إلى sara@example.com', 'To sara@example.com'), status: Status.delivered, icon: NzIcons.send),
    Item(T('تأكيد الطلب #1041', 'Order confirmation #1041'), T('إلى omar@example.com', 'To omar@example.com'), status: Status.delivered, icon: NzIcons.send),
    Item(T('فاتورتك جاهزة', 'Your invoice is ready'), T('إلى old@example.com', 'To old@example.com'), status: Status.bounced, icon: NzIcons.send),
  ],
  'senders': [
    Item(T('no-reply@coffee.sa', 'no-reply@coffee.sa'), T('للإشعارات', 'For notifications'), status: Status.verified, icon: NzIcons.badgeCheck, ltrTitle: true),
  ],
  'templates': [
    Item(T('تأكيد الطلب', 'Order confirmation'), T('عربي + إنجليزي', 'Arabic + English'), status: Status.active, icon: NzIcons.layoutTemplate),
    Item(T('استعادة كلمة المرور', 'Password reset'), T('عربي + إنجليزي', 'Arabic + English'), status: Status.active, icon: NzIcons.layoutTemplate),
  ],
  'suppressions': [],
  'invoices': [
    Item(T('INV-2026-0011', 'INV-2026-0011'), T('نوفمبر 2026 · تستحق 2026-12-01', 'November 2026 · due 2026-12-01'), status: Status.due, meta: 'amount:48300', icon: NzIcons.receipt, ltrTitle: true),
    Item(T('INV-2026-0010', 'INV-2026-0010'), T('أكتوبر 2026', 'October 2026'), status: Status.paid, meta: 'amount:45150', icon: NzIcons.receipt, ltrTitle: true),
    Item(T('INV-2026-0009', 'INV-2026-0009'), T('سبتمبر 2026', 'September 2026'), status: Status.paid, meta: 'amount:39900', icon: NzIcons.receipt, ltrTitle: true),
  ],
  'payments': [
    Item(T('بطاقة تنتهي بـ 4242', 'Card ending 4242'), T('2026-11-01 · INV-2026-0010', '2026-11-01 · INV-2026-0010'), status: Status.succeeded, meta: 'amount:45150', icon: NzIcons.creditCard),
    Item(T('بطاقة تنتهي بـ 4242', 'Card ending 4242'), T('2026-10-01 · INV-2026-0009', '2026-10-01 · INV-2026-0009'), status: Status.succeeded, meta: 'amount:39900', icon: NzIcons.creditCard),
  ],
  'spendApprovals': [
    Item(T('خادم جديد: worker-02', 'New server: worker-02'), T('طلبه سارة · يحتاج موافقة المالك', 'Requested by Sara · needs owner approval'), status: Status.pending, meta: 'amount:12000', icon: NzIcons.checkCheck),
  ],
  'ledger': [
    Item(T('رسوم الخوادم', 'Server charges'), T('2026-11-20', '2026-11-20'), meta: 'amount:-1840', icon: NzIcons.server),
    Item(T('رسوم الذكاء الاصطناعي', 'AI charges'), T('2026-11-19', '2026-11-19'), meta: 'amount:-620', icon: NzIcons.sparkles),
    Item(T('دفعة', 'Payment'), T('2026-11-01', '2026-11-01'), meta: 'amount:45150', icon: NzIcons.creditCard),
  ],
  'team': [
    Item(T('darwish', 'darwish'), T('أنت', 'You'), status: Status.owner, icon: NzIcons.user),
    Item(T('سارة', 'Sara'), T('sara@coffee.sa', 'sara@coffee.sa'), status: Status.admin, icon: NzIcons.user),
    Item(T('عمر', 'Omar'), T('omar@coffee.sa', 'omar@coffee.sa'), status: Status.member, icon: NzIcons.user),
    Item(T('lina@coffee.sa', 'lina@coffee.sa'), T('أُرسلت الدعوة أمس', 'Invite sent yesterday'), status: Status.invited, icon: NzIcons.mail, ltrTitle: true),
  ],
  'agency': [
    Item(T('مطعم الواحة', 'Oasis restaurant'), T('عميل · 2 مشروع', 'Client · 2 projects'), status: Status.active, icon: NzIcons.briefcase),
  ],
  'reseller': [
    Item(T('مؤسسة النخبة', 'Elite company'), T('عميل موزّع · 3 نطاقات', 'Reseller client · 3 domains'), status: Status.active, icon: NzIcons.network),
  ],
  'partners': [],
};

final Map<String, List<Stat>> kStats = {
  'aiUsage': [
    Stat(T('الرصيد المتبقي', 'Credits left'), '7,420', hint: T('من 10,000 هذا الشهر', 'of 10,000 this month'), progress: 0.258, icon: NzIcons.sparkles),
    Stat(T('طلبات اليوم', 'Requests today'), '138', icon: NzIcons.messageCircle),
    Stat(T('مشاريع بنيت بالذكاء', 'AI-built projects'), '4', icon: NzIcons.hammer),
  ],
  'aiBudgets': [
    Stat(T('ميزانية المؤسسة', 'Organization budget'), '62%', hint: T('مستخدم هذا الشهر', 'used this month'), progress: 0.62, icon: NzIcons.piggyBank),
    Stat(T('ميزانية مشروع متجر القهوة', 'Coffee shop budget'), '81%', hint: T('تنبيه عند 90%', 'Alert at 90%'), progress: 0.81, icon: NzIcons.folderKanban),
  ],
  'billingOverview': [
    Stat(T('الرصيد المستحق', 'Balance due'), 'amount:48300', hint: T('يستحق 2026-12-01', 'Due 2026-12-01'), icon: NzIcons.wallet),
    Stat(T('إنفاق هذا الشهر', 'Spend this month'), 'amount:31275', hint: T('حتى اليوم', 'So far'), icon: NzIcons.trendingUp),
    Stat(T('طريقة الدفع', 'Payment method'), '•••• 4242', icon: NzIcons.creditCard),
  ],
  'usageQuotas': [
    Stat(T('الخوادم', 'Servers'), '3 / 10', progress: 0.3, icon: NzIcons.server),
    Stat(T('مواقع الاستضافة', 'Hosting sites'), '2 / 5', progress: 0.4, icon: NzIcons.globe),
    Stat(T('صناديق البريد', 'Mailboxes'), '2 / 25', progress: 0.08, icon: NzIcons.inbox),
    Stat(T('التخزين', 'Storage'), '29 / 100 GB', progress: 0.29, icon: NzIcons.container),
  ],
  'limits': [
    Stat(T('الحد الشهري', 'Monthly limit'), 'amount:100000', hint: T('62% مستخدم', '62% used'), progress: 0.62, icon: NzIcons.slidersHorizontal),
    Stat(T('حد الطلب الواحد', 'Per-request limit'), 'amount:20000', hint: T('أعلى من ذلك يحتاج موافقة', 'Above this needs approval'), icon: NzIcons.checkCheck),
  ],
};

const Map<String, List<CatalogItem>> kCatalogs = {
  'marketplace': [
    CatalogItem(T('WordPress', 'WordPress'), T('موقع جاهز بنقرة', 'One-click site'), NzIcons.globe, tag: T('شائع', 'Popular')),
    CatalogItem(T('n8n', 'n8n'), T('أتمتة مفتوحة المصدر', 'Open-source automation'), NzIcons.workflow),
    CatalogItem(T('متجر إلكتروني', 'Online store'), T('قالب متجر مع سلة', 'Store template with cart'), NzIcons.shoppingBag),
    CatalogItem(T('Ghost', 'Ghost'), T('منصة تدوين', 'Blogging platform'), NzIcons.fileText),
  ],
  'hostingPlans': [
    CatalogItem(T('البداية', 'Starter'), T('لموقع واحد', 'For one site'), NzIcons.layers),
    CatalogItem(T('الأعمال', 'Business'), T('لعدة مواقع وبريد', 'Several sites and email'), NzIcons.layers, tag: T('خطتك', 'Your plan')),
    CatalogItem(T('المحترف', 'Pro'), T('موارد أعلى ونسخ احتياطي', 'More resources and backups'), NzIcons.layers),
  ],
  'plansSubs': [
    CatalogItem(T('اشتراك الاستضافة — الأعمال', 'Hosting — Business'), T('يتجدد شهريًا', 'Renews monthly'), NzIcons.hardDrive, tag: T('نشط', 'Active')),
    CatalogItem(T('نظم AI', 'Nuzm AI'), T('رصيد شهري', 'Monthly credits'), NzIcons.sparkles, tag: T('نشط', 'Active')),
  ],
};

const Map<String, List<FieldSpec>> kForms = {
  'taxProfile': [
    FieldSpec(T('الاسم القانوني', 'Legal name'), 'Coffee Trading Co.'),
    FieldSpec(T('الرقم الضريبي', 'VAT number'), '3XXXXXXXXXXXXX3', ltr: true, hint: T('15 رقمًا يبدأ وينتهي بـ 3', '15 digits, starts and ends with 3')),
    FieldSpec(T('العنوان الوطني', 'National address'), 'RRRD2929, Riyadh'),
  ],
  'orgSettings': [
    FieldSpec(T('اسم المؤسسة', 'Organization name'), 'Coffee Trading Co.'),
    FieldSpec(T('المنطقة الافتراضية للبيانات', 'Default data region'), 'Riyadh', hint: T('تُحفظ البيانات هنا ما لم تختر غير ذلك', 'Data is kept here unless you choose otherwise')),
    FieldSpec(T('اللغة الافتراضية', 'Default language'), 'العربية'),
  ],
  'privacy': [
    FieldSpec(T('تصدير بياناتي', 'Export my data'), '', toggle: false, hint: T('نرسل لك ملفًا عند جاهزيته', 'We send you a file when it is ready')),
    FieldSpec(T('رسائل تسويقية', 'Marketing emails'), '', toggle: false),
    FieldSpec(T('تحليلات الاستخدام', 'Usage analytics'), '', toggle: true),
  ],
  'sso': [
    FieldSpec(T('الدخول الموحّد', 'Single sign-on'), '', toggle: false, hint: T('SAML أو OIDC', 'SAML or OIDC')),
    FieldSpec(T('عنوان المُصدِر', 'Issuer URL'), 'https://login.example.com', ltr: true),
  ],
  'profile': [
    FieldSpec(T('الاسم', 'Name'), 'darwish'),
    FieldSpec(T('البريد الإلكتروني', 'Email'), 'you@example.com', ltr: true),
    FieldSpec(T('التحقق بخطوتين', 'Two-step verification'), '', toggle: true),
  ],
};

/// Cards of the dashboard overview.
final List<Stat> kDashboardStats = [
  Stat(T('خوادم تعمل', 'Servers running'), '2 / 3', icon: NzIcons.server, progress: 0.66),
  Stat(T('مواقع نشطة', 'Active sites'), '2', icon: NzIcons.globe),
  Stat(T('نطاقات', 'Domains'), '3', icon: NzIcons.globe, hint: T('واحد يتجدد قريبًا', 'One renews soon')),
  Stat(T('إنفاق هذا الشهر', 'Spend this month'), 'amount:31275', icon: NzIcons.wallet),
];

/// "Needs your attention" rows: (text, page to open).
const List<(T, String, Tone)> kAttention = [
  (T('الفاتورة INV-2026-0011 تستحق في 1 ديسمبر', 'Invoice INV-2026-0011 is due on 1 December'), 'invoices', Tone.orange),
  (T('coffee-shop.com يتجدد خلال 10 أيام', 'coffee-shop.com renews in 10 days'), 'domainList', Tone.warn),
  (T('فشل آخر تشغيل لسير "نسخة احتياطية ليلية"', '"Nightly backup" workflow failed last run'), 'workflows', Tone.danger),
  (T('نشر تطبيق متجر القهوة ينتظر موافقتك', 'Coffee shop app deploy is waiting for your approval'), 'buildApprovals', Tone.accent),
];

const List<T> kRecentChats = [
  T('ابنِ لي متجرًا لبيع القهوة المختصة مع دفع إلكتروني…', 'Build me a specialty-coffee store with online payments…'),
  T('انقل موقعي القديم إلى الاستضافة وفعّل SSL…', 'Move my old site to hosting and switch on SSL…'),
  T('اقترح نطاقًا متاحًا لعلامتي التجارية…', 'Suggest an available domain for my brand…'),
  T('أنشئ تطبيق جوال لحجز الطاولات…', 'Create a mobile app for table bookings…'),
];

/// Suggestions above the composer.
const List<T> kSuggestions = [
  T('ابنِ صفحة هبوط لمطعمي', 'Build a landing page for my restaurant'),
  T('أنشئ تطبيق جوال لمتجري', 'Create a mobile app for my store'),
  T('جهّز خادمًا لمشروع Node.js', 'Set up a server for a Node.js project'),
];

/// Notifications: (title, time, page, tone).
const List<(T, T, String, Tone)> kNotifications = [
  (T('فاتورة نوفمبر جاهزة', 'November invoice is ready'), T('قبل ساعة', '1 hour ago'), 'invoices', Tone.orange),
  (T('اكتمل بناء "بوابة العملاء"', '"Customer portal" build finished'), T('قبل 3 ساعات', '3 hours ago'), 'appbuilder', Tone.success),
  (T('فشل سير "نسخة احتياطية ليلية"', '"Nightly backup" workflow failed'), T('أمس', 'Yesterday'), 'workflows', Tone.danger),
  (T('انضمّت سارة إلى الفريق', 'Sara joined the team'), T('قبل يومين', '2 days ago'), 'team', Tone.accent),
];

/// The org line under the greeting.
const T kOrgName = T('شركة القهوة التجارية', 'Coffee Trading Co.');
const String kUserName = 'darwish';
const T kRegion = _riyadh;
