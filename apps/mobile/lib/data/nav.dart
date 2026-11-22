import 'package:flutter/widgets.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../l10n/strings.dart';

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
  NavCategory('dashboard', T('لوحة التحكم', 'Dashboard'), LucideIcons.layoutDashboard, [
    NavGroup([NavPage('overview', T('نظرة عامة', 'Overview'), LucideIcons.layoutDashboard, PageKind.dashboard, '/')]),
  ]),
  NavCategory('projects', T('المشاريع', 'Projects'), LucideIcons.folderKanban, [
    NavGroup([
      NavPage('projects', T('المشاريع', 'Projects'), LucideIcons.folderKanban, PageKind.list, '/projects'),
      NavPage('workspaces', T('مساحات العمل', 'Workspaces'), LucideIcons.layoutGrid, PageKind.list, '/workspaces'),
    ]),
  ]),
  NavCategory('build', T('البناء', 'Build'), LucideIcons.code, [
    NavGroup([
      NavPage('builder', T('ابدأ مشروعًا', 'Start a project'), LucideIcons.sparkles, PageKind.builder, '/builder/projects'),
      NavPage('appbuilder', T('منشئ التطبيقات', 'App builder'), LucideIcons.appWindow, PageKind.list, '/builder/apps'),
      NavPage('buildApprovals', T('الموافقات', 'Approvals'), LucideIcons.badgeCheck, PageKind.list, '/approvals'),
      NavPage('mobile', T('تطبيقات الجوال', 'Mobile apps'), LucideIcons.smartphone, PageKind.list, '/mobile/new'),
    ]),
    NavGroup(title: T('الذكاء الاصطناعي', 'AI'), [
      NavPage('aiUsage', T('الاستهلاك والرصيد', 'Usage and credits'), LucideIcons.gauge, PageKind.stats, '/ai/usage'),
      NavPage('aiBudgets', T('الميزانيات', 'Budgets'), LucideIcons.piggyBank, PageKind.stats, '/ai/budgets'),
    ]),
  ], badge: 1),
  NavCategory('automation', T('الأتمتة', 'Automation'), LucideIcons.workflow, [
    NavGroup([
      NavPage('workflows', T('سير العمل', 'Workflows'), LucideIcons.workflow, PageKind.list, '/automation/workflows'),
      NavPage('connectors', T('الموصّلات', 'Connectors'), LucideIcons.plug, PageKind.list, '/automation/connectors'),
      NavPage('webhooks', T('خطافات الويب', 'Webhooks'), LucideIcons.webhook, PageKind.list, '/settings/webhooks'),
    ]),
  ]),
  NavCategory('marketplace', T('السوق', 'Marketplace'), LucideIcons.store, [
    NavGroup([NavPage('marketplace', T('السوق', 'Marketplace'), LucideIcons.store, PageKind.catalog, '/marketplace')]),
  ]),
  NavCategory('cloud', T('السحابة', 'Cloud'), LucideIcons.cloud, title: T('البنية السحابية', 'Cloud infrastructure'), [
    NavGroup(title: T('البنية', 'Infrastructure'), [
      NavPage('instances', T('الخوادم', 'Servers'), LucideIcons.server, PageKind.list, '/compute/instances'),
    ]),
  ]),
  NavCategory('hosting', T('الاستضافة', 'Hosting'), LucideIcons.hardDrive, [
    NavGroup([
      NavPage('sites', T('مواقع الاستضافة', 'Hosting sites'), LucideIcons.globe, PageKind.list, '/hosting/sites'),
      NavPage('hostingPlans', T('خطط الاستضافة', 'Hosting plans'), LucideIcons.layers, PageKind.catalog, '/hosting/plans'),
    ]),
  ]),
  NavCategory('domains', T('النطاقات', 'Domains'), LucideIcons.globe, [
    NavGroup([
      NavPage('domainList', T('نطاقاتي', 'My domains'), LucideIcons.globe, PageKind.list, '/domains'),
      NavPage('domainSearch', T('بحث', 'Search'), LucideIcons.search, PageKind.domainSearch, '/domains/search'),
      NavPage('transfers', T('النقل', 'Transfers'), LucideIcons.arrowLeftRight, PageKind.list, '/domains/transfers'),
    ]),
  ], badge: 1),
  NavCategory('data', T('البيانات', 'Data'), LucideIcons.database, [
    NavGroup([
      NavPage('databases', T('قواعد البيانات', 'Databases'), LucideIcons.database, PageKind.list, '/databases'),
      NavPage('storage', T('التخزين', 'Storage'), LucideIcons.container, PageKind.list, '/storage/buckets'),
    ]),
  ]),
  NavCategory('email', T('البريد', 'Email'), LucideIcons.mail, [
    NavGroup([
      NavPage('emailDomains', T('النطاقات', 'Domains'), LucideIcons.atSign, PageKind.list, '/email/domains'),
      NavPage('mailboxes', T('صناديق البريد', 'Mailboxes'), LucideIcons.inbox, PageKind.list, '/email/mailboxes'),
      NavPage('messages', T('الرسائل', 'Messages'), LucideIcons.send, PageKind.list, '/email/messages'),
      NavPage('senders', T('هويات المرسل', 'Sender identities'), LucideIcons.badgeCheck, PageKind.list, '/email/senders'),
      NavPage('templates', T('القوالب', 'Templates'), LucideIcons.layoutTemplate, PageKind.list, '/email/templates'),
      NavPage('suppressions', T('قائمة الحظر', 'Suppression list'), LucideIcons.ban, PageKind.list, '/email/suppressions'),
    ]),
  ], badge: 3),
  NavCategory('finance', T('المالية', 'Finance'), LucideIcons.wallet, [
    NavGroup(title: T('الفوترة', 'Billing'), [
      NavPage('billingOverview', T('نظرة عامة', 'Overview'), LucideIcons.wallet, PageKind.stats, '/billing'),
      NavPage('plansSubs', T('الخطط والاشتراكات', 'Plans and subscriptions'), LucideIcons.layers, PageKind.catalog, '/billing/plans'),
      NavPage('usageQuotas', T('الاستخدام والحصص', 'Usage and quotas'), LucideIcons.gauge, PageKind.stats, '/billing/usage'),
      NavPage('invoices', T('الفواتير', 'Invoices'), LucideIcons.receipt, PageKind.list, '/billing/invoices'),
      NavPage('payments', T('المدفوعات', 'Payments'), LucideIcons.creditCard, PageKind.list, '/billing/payments'),
    ]),
    NavGroup(title: T('الضبط والمتابعة', 'Control'), [
      NavPage('limits', T('حدود الإنفاق', 'Spending limits'), LucideIcons.slidersHorizontal, PageKind.stats, '/billing/spending-limits'),
      NavPage('spendApprovals', T('موافقات الإنفاق', 'Spend approvals'), LucideIcons.checkCheck, PageKind.list, '/billing/approvals'),
      NavPage('ledger', T('كشف الحساب', 'Statement'), LucideIcons.fileText, PageKind.list, '/billing/ledger'),
      NavPage('taxProfile', T('الملف الضريبي', 'Tax profile'), LucideIcons.landmark, PageKind.form, '/billing/tax-profile'),
    ]),
  ], badge: 1),
  NavCategory('organization', T('المؤسسة', 'Organization'), LucideIcons.building2, [
    NavGroup([
      NavPage('team', T('الفريق', 'Team'), LucideIcons.users, PageKind.list, '/settings/team'),
      NavPage('orgSettings', T('المؤسسة', 'Organization'), LucideIcons.building2, PageKind.form, '/settings/organization'),
      NavPage('privacy', T('الخصوصية والبيانات', 'Privacy and data'), LucideIcons.shieldCheck, PageKind.form, '/privacy'),
      NavPage('sso', T('الدخول الموحّد', 'Single sign-on'), LucideIcons.keyRound, PageKind.form, '/settings/security/sso'),
      NavPage('agency', T('بوابة الوكالة', 'Agency portal'), LucideIcons.briefcase, PageKind.list, '/agency'),
      NavPage('reseller', T('بوابة الموزّع', 'Reseller portal'), LucideIcons.network, PageKind.list, '/reseller'),
      NavPage('partners', T('الشركاء', 'Partners'), LucideIcons.handshake, PageKind.list, '/settings/partners'),
    ]),
  ]),
  NavCategory('account', T('الملف الشخصي', 'Profile'), LucideIcons.user, [
    NavGroup(title: T('حسابك', 'Your account'), [
      NavPage('profile', T('الملف الشخصي', 'Profile'), LucideIcons.user, PageKind.form, '/account'),
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
