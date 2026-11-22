import 'package:flutter/widgets.dart';

import '../l10n/strings.dart';
import '../widgets/nz_icons.dart';

/// How a page renders. Every page of the customer console maps to one of these.
enum PageKind { dashboard, list, stats, catalog, form, domainSearch, builder }

@immutable
class NavPage {
  const NavPage(this.id, this.label, this.icon, this.kind, this.path);
  final String id;
  final T label;
  final IconData icon;
  final PageKind kind;

  /// The console route this page mirrors (apps/web/lib/nav.ts), shown on detail screens for reference.
  final String path;
}

@immutable
class NavGroup {
  const NavGroup(this.pages, {this.title});
  final T? title;
  final List<NavPage> pages;
}

@immutable
class NavCategory {
  const NavCategory(this.id, this.label, this.icon, this.groups, {this.title, this.badge = 0});
  final String id;
  final T label;
  final T? title;
  final IconData icon;
  final List<NavGroup> groups;
  final int badge;

  T get heading => title ?? label;
  List<NavPage> get pages => [for (final g in groups) ...g.pages];
}

/// The customer console's navigation, category for category and page for page (labels from packages/i18n).
const List<NavCategory> kCategories = [
  NavCategory('dashboard', T('لوحة التحكم', 'Dashboard'), NzIcons.layoutDashboard, [
    NavGroup([NavPage('overview', T('نظرة عامة', 'Overview'), NzIcons.layoutDashboard, PageKind.dashboard, '/')]),
  ]),
  NavCategory('projects', T('المشاريع', 'Projects'), NzIcons.folderKanban, [
    NavGroup([
      NavPage('projects', T('المشاريع', 'Projects'), NzIcons.folderKanban, PageKind.list, '/projects'),
      NavPage('workspaces', T('مساحات العمل', 'Workspaces'), NzIcons.layoutGrid, PageKind.list, '/workspaces'),
    ]),
  ]),
  NavCategory('build', T('البناء', 'Build'), NzIcons.code, [
    NavGroup([
      NavPage('builder', T('ابدأ مشروعًا', 'Start a project'), NzIcons.sparkles, PageKind.builder, '/builder/projects'),
      NavPage('appbuilder', T('منشئ التطبيقات', 'App builder'), NzIcons.appWindow, PageKind.list, '/builder/apps'),
      NavPage('buildApprovals', T('الموافقات', 'Approvals'), NzIcons.badgeCheck, PageKind.list, '/approvals'),
      NavPage('mobile', T('تطبيقات الجوال', 'Mobile apps'), NzIcons.smartphone, PageKind.list, '/mobile/new'),
    ]),
    NavGroup(title: T('الذكاء الاصطناعي', 'AI'), [
      NavPage('aiUsage', T('الاستهلاك والرصيد', 'Usage and credits'), NzIcons.gauge, PageKind.stats, '/ai/usage'),
      NavPage('aiBudgets', T('الميزانيات', 'Budgets'), NzIcons.piggyBank, PageKind.stats, '/ai/budgets'),
    ]),
  ], badge: 1),
  NavCategory('automation', T('الأتمتة', 'Automation'), NzIcons.workflow, [
    NavGroup([
      NavPage('workflows', T('سير العمل', 'Workflows'), NzIcons.workflow, PageKind.list, '/automation/workflows'),
      NavPage('connectors', T('الموصّلات', 'Connectors'), NzIcons.plug, PageKind.list, '/automation/connectors'),
      NavPage('webhooks', T('خطافات الويب', 'Webhooks'), NzIcons.webhook, PageKind.list, '/settings/webhooks'),
    ]),
  ]),
  NavCategory('marketplace', T('السوق', 'Marketplace'), NzIcons.store, [
    NavGroup([NavPage('marketplace', T('السوق', 'Marketplace'), NzIcons.store, PageKind.catalog, '/marketplace')]),
  ]),
  NavCategory('cloud', T('السحابة', 'Cloud'), NzIcons.cloud, title: T('البنية السحابية', 'Cloud infrastructure'), [
    NavGroup(title: T('البنية', 'Infrastructure'), [
      NavPage('instances', T('الخوادم', 'Servers'), NzIcons.server, PageKind.list, '/compute/instances'),
    ]),
  ]),
  NavCategory('hosting', T('الاستضافة', 'Hosting'), NzIcons.hardDrive, [
    NavGroup([
      NavPage('sites', T('مواقع الاستضافة', 'Hosting sites'), NzIcons.globe, PageKind.list, '/hosting/sites'),
      NavPage('hostingPlans', T('خطط الاستضافة', 'Hosting plans'), NzIcons.layers, PageKind.catalog, '/hosting/plans'),
    ]),
  ]),
  NavCategory('domains', T('النطاقات', 'Domains'), NzIcons.globe, [
    NavGroup([
      NavPage('domainList', T('نطاقاتي', 'My domains'), NzIcons.globe, PageKind.list, '/domains'),
      NavPage('domainSearch', T('بحث', 'Search'), NzIcons.search, PageKind.domainSearch, '/domains/search'),
      NavPage('transfers', T('النقل', 'Transfers'), NzIcons.arrowLeftRight, PageKind.list, '/domains/transfers'),
    ]),
  ], badge: 1),
  NavCategory('data', T('البيانات', 'Data'), NzIcons.database, [
    NavGroup([
      NavPage('databases', T('قواعد البيانات', 'Databases'), NzIcons.database, PageKind.list, '/databases'),
      NavPage('storage', T('التخزين', 'Storage'), NzIcons.container, PageKind.list, '/storage/buckets'),
    ]),
  ]),
  NavCategory('email', T('البريد', 'Email'), NzIcons.mail, [
    NavGroup([
      NavPage('emailDomains', T('النطاقات', 'Domains'), NzIcons.atSign, PageKind.list, '/email/domains'),
      NavPage('mailboxes', T('صناديق البريد', 'Mailboxes'), NzIcons.inbox, PageKind.list, '/email/mailboxes'),
      NavPage('messages', T('الرسائل', 'Messages'), NzIcons.send, PageKind.list, '/email/messages'),
      NavPage('senders', T('هويات المرسل', 'Sender identities'), NzIcons.badgeCheck, PageKind.list, '/email/senders'),
      NavPage('templates', T('القوالب', 'Templates'), NzIcons.layoutTemplate, PageKind.list, '/email/templates'),
      NavPage('suppressions', T('قائمة الحظر', 'Suppression list'), NzIcons.ban, PageKind.list, '/email/suppressions'),
    ]),
  ], badge: 3),
  NavCategory('finance', T('المالية', 'Finance'), NzIcons.wallet, [
    NavGroup(title: T('الفوترة', 'Billing'), [
      NavPage('billingOverview', T('نظرة عامة', 'Overview'), NzIcons.wallet, PageKind.stats, '/billing'),
      NavPage('plansSubs', T('الخطط والاشتراكات', 'Plans and subscriptions'), NzIcons.layers, PageKind.catalog, '/billing/plans'),
      NavPage('usageQuotas', T('الاستخدام والحصص', 'Usage and quotas'), NzIcons.gauge, PageKind.stats, '/billing/usage'),
      NavPage('invoices', T('الفواتير', 'Invoices'), NzIcons.receipt, PageKind.list, '/billing/invoices'),
      NavPage('payments', T('المدفوعات', 'Payments'), NzIcons.creditCard, PageKind.list, '/billing/payments'),
    ]),
    NavGroup(title: T('الضبط والمتابعة', 'Control'), [
      NavPage('limits', T('حدود الإنفاق', 'Spending limits'), NzIcons.slidersHorizontal, PageKind.stats, '/billing/spending-limits'),
      NavPage('spendApprovals', T('موافقات الإنفاق', 'Spend approvals'), NzIcons.checkCheck, PageKind.list, '/billing/approvals'),
      NavPage('ledger', T('كشف الحساب', 'Statement'), NzIcons.fileText, PageKind.list, '/billing/ledger'),
      NavPage('taxProfile', T('الملف الضريبي', 'Tax profile'), NzIcons.landmark, PageKind.form, '/billing/tax-profile'),
    ]),
  ], badge: 1),
  NavCategory('organization', T('المؤسسة', 'Organization'), NzIcons.building2, [
    NavGroup([
      NavPage('team', T('الفريق', 'Team'), NzIcons.users, PageKind.list, '/settings/team'),
      NavPage('orgSettings', T('المؤسسة', 'Organization'), NzIcons.building2, PageKind.form, '/settings/organization'),
      NavPage('privacy', T('الخصوصية والبيانات', 'Privacy and data'), NzIcons.shieldCheck, PageKind.form, '/privacy'),
      NavPage('sso', T('الدخول الموحّد', 'Single sign-on'), NzIcons.keyRound, PageKind.form, '/settings/security/sso'),
      NavPage('agency', T('بوابة الوكالة', 'Agency portal'), NzIcons.briefcase, PageKind.list, '/agency'),
      NavPage('reseller', T('بوابة الموزّع', 'Reseller portal'), NzIcons.network, PageKind.list, '/reseller'),
      NavPage('partners', T('الشركاء', 'Partners'), NzIcons.handshake, PageKind.list, '/settings/partners'),
    ]),
  ]),
  NavCategory('account', T('الملف الشخصي', 'Profile'), NzIcons.user, [
    NavGroup(title: T('حسابك', 'Your account'), [
      NavPage('profile', T('الملف الشخصي', 'Profile'), NzIcons.user, PageKind.form, '/account'),
    ]),
  ]),
];

NavCategory categoryById(String id) => kCategories.firstWhere((c) => c.id == id);

/// The category that holds [pageId], with the page itself.
(NavCategory, NavPage) findPage(String pageId) {
  for (final c in kCategories) {
    for (final p in c.pages) {
      if (p.id == pageId) return (c, p);
    }
  }
  throw ArgumentError('Unknown page $pageId');
}
