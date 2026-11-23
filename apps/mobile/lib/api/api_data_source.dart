import 'dart:async';

import 'package:flutter/widgets.dart';

import '../data/data_source.dart';
import '../data/demo.dart';
import '../data/plans.dart';
import '../l10n/strings.dart';
import '../widgets/nz_icons.dart';
import 'api_client.dart';
import 'notification_kinds.dart';

/// The live API (spec/openapi/openapi.yaml). Each console page reads the same endpoint the web console uses for it.
class ApiDataSource implements DataSource {
  ApiDataSource(this.api, {required this.orgId, required this.orgDisplayName, required this.user});

  final ApiClient api;
  final String orgId;
  final String orgDisplayName;
  final String user;

  @override
  bool get isLive => true;
  @override
  T get orgName => T(orgDisplayName, orgDisplayName);
  @override
  String get userName => user;

  Future<List<Map<String, dynamic>>> _items(String path, {Map<String, String>? query}) async {
    final r = await api.get(path, query: {'limit': '50', ...?query});
    final list = r is Map ? r['items'] : r;
    return [for (final e in (list is List ? list : const [])) if (e is Map) e.cast<String, dynamic>()];
  }

  Future<Map<String, dynamic>> _obj(String path) async {
    final r = await api.get(path);
    return r is Map ? r.cast<String, dynamic>() : <String, dynamic>{};
  }

  @override
  Future<PageData> load(String pageId) async {
    switch (pageId) {
      case 'projects':
        return PageData(items: [
          for (final p in await _items('/v1/projects'))
            _item(p, NzIcons.folderKanban, title: s(p['name']), sub: _date(p['createdAt']), facts: [
              (const T('المعرّف', 'ID'), s(p['id'])),
              (const T('سياسة المنطقة', 'Region policy'), s(p['defaultRegionPolicy'])),
            ]),
        ]);
      case 'workspaces':
        return PageData(items: [
          for (final w in await _items('/v1/workspaces')) _item(w, NzIcons.layoutGrid, title: s(w['name']), sub: s(w['slug'])),
        ]);
      case 'builder':
        return const PageData();
      case 'appbuilder':
        return PageData(items: [
          for (final p in await _items('/v1/builder/projects'))
            _item(p, NzIcons.appWindow,
                title: s(p['name']),
                sub: '${s(p['type'])} · ${_date(p['updatedAt'])}',
                status: p['lastDeployment'] is Map ? _status((p['lastDeployment'] as Map)['status']) : null,
                facts: [(const T('منطقة البيانات', 'Data region'), s(p['dataRegion'])), (const T('اللغات', 'Locales'), _join(p['locales']))]),
        ]);
      case 'buildApprovals':
        return PageData(items: [
          for (final a in await _items('/v1/ai/approvals'))
            _item(a, NzIcons.badgeCheck,
                title: _humanize(a['type']), sub: s(a['action']), status: _status(a['status']), facts: [
              (const T('ينتهي', 'Expires'), _date(a['expiresAt'])),
              (const T('طلبه', 'Requested by'), s(a['requestedByKind'])),
            ]),
        ]);
      case 'mobile':
        return PageData(items: [
          for (final b in await _items('/v1/mobile/builds'))
            _item(b, NzIcons.smartphone,
                title: '${s(b['platform'])} · ${s(b['profile'])}', sub: _date(b['createdAt']), status: _status(b['status']), ltr: true),
        ]);
      case 'aiUsage':
        final c = await _obj('/v1/ai/credits');
        return PageData(stats: [
          Stat(const T('الرصيد المتاح', 'Available credits'), _num(c['availableCredits']), icon: NzIcons.sparkles,
              hint: c['lowCredit'] == true ? const T('الرصيد منخفض', 'Credit is low') : null),
          Stat(const T('محجوز للتشغيلات الجارية', 'Reserved by running work'), _num(c['reservedCredits']), icon: NzIcons.clock),
          Stat(const T('آخر 30 يومًا', 'Last 30 days'), _num(c['last30DaysCredits']), icon: NzIcons.trendingUp),
        ]);
      case 'aiBudgets':
        final b = await _obj('/v1/ai/budgets');
        final org = (b['org'] is Map ? b['org'] as Map : const {});
        return PageData(raw: b, stats: [
          Stat(const T('الحد اليومي', 'Daily credits'), _num(org['dailyCredits']), icon: NzIcons.piggyBank),
          Stat(const T('حد التشغيل الواحد', 'Per-run credits'), _num(org['runMaxCredits']), icon: NzIcons.gauge),
          Stat(const T('الحد الكلي', 'Total credits'), _num(org['totalCredits']), icon: NzIcons.wallet),
          Stat(const T('ميزانيات المشاريع', 'Project budgets'), '${(b['projects'] as List?)?.length ?? 0}', icon: NzIcons.folderKanban),
        ]);
      case 'workflows':
        return PageData(items: [for (final w in await _items('/v1/workflows')) _generic(w, NzIcons.workflow)]);
      case 'connectors':
        return PageData(items: [for (final w in await _items('/v1/connectors')) _generic(w, NzIcons.plug)]);
      case 'webhooks':
        return PageData(items: [for (final w in await _items('/v1/webhook-endpoints')) _generic(w, NzIcons.webhook, ltr: true)]);
      case 'marketplace':
        return PageData(catalog: [
          for (final l in await _items('/v1/marketplace/listings'))
            CatalogItem(T(_title(l), _title(l)), T(s(l['summary'] ?? l['description'] ?? l['category']), s(l['summary'] ?? l['description'] ?? l['category'])),
                NzIcons.store,
                tag: _priceTag(l['price'])),
        ]);
      case 'instances':
        return PageData(items: [
          for (final i in await _items('/v1/compute/instances'))
            _item(i, NzIcons.server,
                title: s(i['name']),
                sub: '${_planName(i['plan'])} · ${s(i['dataRegion'])}',
                status: _status(i['status']),
                meta: (i['publicIps'] is List && (i['publicIps'] as List).isNotEmpty) ? s((i['publicIps'] as List).first) : null,
                ltr: true,
                facts: [
                  (const T('منطقة البيانات', 'Data region'), s(i['dataRegion'])),
                  (const T('الدولة', 'Country'), s(i['country'])),
                  (const T('حالة المطابقة', 'Drift'), s(i['driftState'])),
                  (const T('أُنشئ', 'Created'), _date(i['createdAt'])),
                ]),
        ]);
      case 'sites':
        return PageData(items: [
          for (final x in await _items('/v1/hosting/sites'))
            _item(x, NzIcons.globe,
                title: s(x['primaryDomain'] ?? x['name']),
                sub: '${_runtime(x['runtime'])} · ${_planName(x['plan'])}',
                status: _status(x['status']),
                ltr: true,
                facts: [(const T('منطقة البيانات', 'Data region'), s(x['dataRegion'])), (const T('العقدة', 'Node'), s(x['nodeName']))]),
        ]);
      case 'hostingPlans':
        return PageData(catalog: [
          for (final p in await _items('/v1/hosting/plans'))
            CatalogItem(localized(p['name']), T(_runtimes(p['runtimes']), _runtimes(p['runtimes'])), NzIcons.layers, tag: _priceTag(p['price'])),
        ]);
      case 'domainList':
        return PageData(items: [
          for (final d in await _items('/v1/domains'))
            _item(d, NzIcons.globe,
                title: s(d['name']),
                sub: '${const T('ينتهي', 'Expires').ar} ${_date(d['expiresAt'])}',
                subEn: 'Expires ${_date(d['expiresAt'])}',
                status: d['renewalAtRisk'] == true ? Status.expiring : _status(d['state']),
                ltr: true,
                facts: [
                  (const T('تجديد تلقائي', 'Auto-renew'), s(d['autoRenew'])),
                  (const T('القفل', 'Locked'), s(d['locked'])),
                  (const T('خوادم الأسماء', 'Nameservers'), _join(d['nameservers'])),
                ]),
        ]);
      case 'transfers':
        return PageData(items: [for (final t in await _items('/v1/domains/transfers')) _generic(t, NzIcons.arrowLeftRight, ltr: true)]);
      case 'databases':
        return PageData(items: [
          for (final d in await _items('/v1/databases'))
            _item(d, NzIcons.database,
                title: s(d['name']), sub: '${s(d['engine'])} ${s(d['version'])}', status: _status(d['status']), ltr: true,
                facts: [(const T('منطقة البيانات', 'Data region'), s(d['dataRegion'])), (const T('TLS مطلوب', 'TLS required'), s(d['tlsRequired']))]),
        ]);
      case 'storage':
        return PageData(items: [
          for (final b in await _items('/v1/storage/buckets'))
            _item(b, NzIcons.container,
                title: s(b['name']), sub: s(b['bucketName']), status: _status(b['status']), ltr: true,
                facts: [(const T('عام', 'Public'), s(b['public'])), (const T('الإصدارات', 'Versioning'), s(b['versioning']))]),
        ]);
      case 'emailDomains':
        return PageData(items: [
          for (final d in await _items('/v1/email/domains'))
            _item(d, NzIcons.atSign, title: s(d['domain']), sub: _join(d['purposes']), status: _status(d['state']), ltr: true),
        ]);
      case 'mailboxes':
        return PageData(items: [
          for (final m in await _items('/v1/email/mailboxes'))
            _item(m, NzIcons.inbox, title: s(m['address']), sub: '${_num(m['quotaMb'])} MB', status: _status(m['status']), ltr: true),
        ]);
      case 'messages':
        return PageData(items: [
          for (final m in await _items('/v1/email/messages'))
            _item(m, NzIcons.send,
                title: s(m['category']), sub: '${_date(m['createdAt'])} · ${_num(m['recipientCount'])}', status: _status(m['status'])),
        ]);
      case 'senders':
        return PageData(items: [
          for (final x in await _items('/v1/email/sender-identities'))
            _item(x, NzIcons.badgeCheck, title: s(x['fromAddress']), sub: _date(x['createdAt']), status: _status(x['status']), ltr: true),
        ]);
      case 'templates':
        return PageData(items: [
          for (final x in await _items('/v1/email/templates'))
            _item(x, NzIcons.layoutTemplate, title: s(x['name']), sub: '${s(x['key'])} · ${s(x['locale'])} · v${s(x['version'])}'),
        ]);
      case 'suppressions':
        return PageData(items: [
          for (final x in await _items('/v1/email/suppressions'))
            _item(x, NzIcons.ban, title: s(x['address']), sub: _humanize(x['reason']), ltr: true,
                status: x['active'] == true ? Status.active : Status.stopped),
        ]);
      case 'billingOverview':
        final bal = await _obj('/v1/billing/balance');
        final invoices = await _invoices(limit: 3);
        return PageData(
          stats: [
            for (final b in (bal['balances'] is List ? bal['balances'] as List : const []))
              if (b is Map)
                Stat(T('الرصيد (${s(b['currency'])})', 'Balance (${s(b['currency'])})'),
                    _money(b['availableMinor'] ?? b['balanceMinor'] ?? b['amountMinor'], b['currency']),
                    icon: NzIcons.wallet),
          ],
          related: invoices,
          relatedPage: 'invoices',
        );
      case 'plansSubs':
        return PageData(items: [
          for (final x in await _items('/v1/billing/subscriptions'))
            _item(x, NzIcons.layers,
                title: s(x['planKey']),
                sub: '${_date(x['currentPeriodStart'])} → ${_date(x['currentPeriodEnd'])}',
                status: _status(x['status']),
                meta: _money(x['amountPerPeriodMinor'], x['currency'])),
        ]);
      case 'usageQuotas':
        return PageData(stats: [
          for (final q in await _items('/v1/quotas'))
            Stat(T(_humanize(q['meterId']), _humanize(q['meterId'])), '${_num(q['used'])} / ${_num(q['limit'])} ${s(q['unit'])}',
                progress: _pct(q['percent']), icon: NzIcons.gauge),
        ]);
      case 'invoices':
        return PageData(items: await _invoices());
      case 'payments':
        return PageData(items: [
          for (final x in await _items('/v1/billing/payments'))
            _item(x, NzIcons.creditCard, title: _date(x['createdAt']), sub: s(x['invoiceId'] ?? x['walletTopupId']),
                status: _status(x['status']), meta: _money(x['amountMinor'], x['currency'])),
        ]);
      case 'limits':
        final limits = await _items('/v1/billing/spending-limits');
        return PageData(raw: limits.where((l) => l['scope'] == 'org').firstOrNull ?? const {}, stats: [
          for (final l in limits)
            Stat(
              l['scope'] == 'project' ? const T('حد المشروع الشهري', 'Project monthly cap') : const T('الحد الشهري للمؤسسة', 'Organization monthly cap'),
              _money(l['monthlyCapMinor'], l['currency']),
              hint: l['fourEyesAboveMinor'] == null
                  ? null
                  : T('موافقة شخصين فوق ${_money(l['fourEyesAboveMinor'], l['currency'])}',
                      'Two approvals above ${_money(l['fourEyesAboveMinor'], l['currency'])}'),
              icon: NzIcons.slidersHorizontal,
            ),
        ]);
      case 'spendApprovals':
        return PageData(items: [
          for (final x in await _items('/v1/billing/spend-approvals'))
            _item(x, NzIcons.checkCheck, title: s(x['reason']), sub: _date(x['createdAt']), status: _status(x['status']),
                meta: _money(x['amountMinor'], x['currency'])),
        ]);
      case 'ledger':
        return PageData(items: [
          for (final x in await _items('/v1/billing/ledger'))
            _item(x, x['direction'] == 'credit' ? NzIcons.arrowLeftRight : NzIcons.fileText,
                title: s(x['description'] ?? _humanize(x['kind'])), sub: _date(x['occurredAt']),
                meta: _money(((x['direction'] == 'debit') ? -1 : 1) * _int(x['amountMinor']), x['currency'])),
        ]);
      case 'taxProfile':
        // 404 not_found = no tax profile saved yet: show the empty form to fill.
        final t = await _obj('/v1/billing/tax-profile').catchError(
            (Object e) => e is ApiException && e.notFound ? <String, dynamic>{} : throw e);
        return PageData(raw: t, fields: [
          FieldSpec(const T('نوع المشتري', 'Buyer type'), s(t['buyerType']).toUpperCase()),
          FieldSpec(const T('الاسم القانوني', 'Legal name'), s(t['legalName'])),
          FieldSpec(const T('الرقم الضريبي', 'VAT number'), s(t['vatNumber']), ltr: true),
          FieldSpec(const T('السجل التجاري', 'CR number'), s(t['crNumber']), ltr: true),
          FieldSpec(const T('العنوان', 'Address'), _address(t['address'])),
        ]);
      case 'team':
        return PageData(items: [
          for (final m in await _items('/v1/organizations/$orgId/members'))
            _item(m, NzIcons.user, title: s(m['displayName'] ?? m['email']), sub: s(m['email']), status: _role(m['role']),
                facts: [(const T('انضم', 'Joined'), _date(m['joinedAt']))]),
        ]);
      case 'orgSettings':
        final o = await _obj('/v1/organizations/$orgId');
        return PageData(raw: o, fields: [
          FieldSpec(const T('اسم المؤسسة', 'Organization name'), s(o['name'])),
          FieldSpec(const T('المعرّف المختصر', 'Slug'), s(o['slug']), ltr: true),
          FieldSpec(const T('الدولة', 'Country'), s(o['country']), ltr: true),
          FieldSpec(const T('اللغة الافتراضية', 'Default language'), s(o['defaultLocale'])),
          FieldSpec(const T('النوع', 'Type'), s(o['type'])),
        ]);
      case 'privacy':
        final r = await _obj('/v1/compliance/residency-policy');
        return PageData(fields: [
          FieldSpec(const T('سياسة إقامة البيانات', 'Data residency policy'), _humanize(r['mode']),
              hint: r['isDefault'] == true ? const T('السياسة الافتراضية', 'Default policy') : null),
          FieldSpec(const T('آخر تحديث', 'Updated'), _date(r['updatedAt'])),
        ]);
      case 'sso':
        return PageData(items: [
          for (final c in await _items('/v1/organizations/$orgId/sso-connections'))
            _item(c, NzIcons.keyRound, title: s(c['name']), sub: '${s(c['protocol']).toUpperCase()} · ${_join(c['domains'])}',
                status: _status(c['status'])),
        ]);
      case 'agency':
      case 'partners':
        return PageData(items: [for (final a in await _items('/v1/agencies')) _generic(a, NzIcons.briefcase)]);
      case 'reseller':
        return PageData(items: [for (final a in await _items('/v1/resellers')) _generic(a, NzIcons.network)]);
      case 'profile':
        final me = await _obj('/v1/me');
        return PageData(fields: [
          FieldSpec(const T('الاسم', 'Name'), s(me['displayName'])),
          FieldSpec(const T('البريد الإلكتروني', 'Email'), s(me['email']), ltr: true,
              hint: me['emailVerified'] == true ? const T('موثّق', 'Verified') : const T('غير موثّق', 'Not verified')),
          FieldSpec(const T('اللغة', 'Language'), s(me['locale'])),
          FieldSpec(const T('التحقق بخطوتين', 'Two-step verification'), s(me['mfaLevel'])),
        ]);
      case 'overview':
      case 'domainSearch':
      default:
        return const PageData();
    }
  }

  Future<List<Item>> _invoices({int? limit}) async => [
        for (final x in (await _items('/v1/billing/invoices', query: limit == null ? null : {'limit': '$limit'})))
          _item(x, NzIcons.receipt,
              title: s(x['number'] ?? x['id']),
              sub: '${_date(x['periodStart'])} → ${_date(x['periodEnd'])}',
              status: _status(x['status']),
              meta: _money(x['totalMinor'], x['currency']),
              ltr: true,
              facts: [
                (const T('تاريخ الإصدار', 'Issued'), _date(x['issuedAt'])),
                (const T('الاستحقاق', 'Due'), _date(x['dueAt'])),
                (const T('الضريبة', 'Tax'), _money(x['taxMinor'], x['currency'])),
                (const T('المدفوع', 'Paid'), _money(x['paidMinor'], x['currency'])),
              ]),
      ];

  @override
  Future<DashboardData> dashboard() async {
    Future<List<Map<String, dynamic>>?> safe(String p, [Map<String, String>? q]) =>
        _items(p, query: q).then<List<Map<String, dynamic>>?>((v) => v).catchError((_) => null);
    final r = await Future.wait([
      safe('/v1/compute/instances'),
      safe('/v1/hosting/sites'),
      safe('/v1/domains'),
      safe('/v1/billing/invoices'),
      safe('/v1/ai/approvals'),
      safe('/v1/billing/spend-approvals'),
    ]);
    final (inst, sites, doms, inv, aiAppr, spend) = (r[0], r[1], r[2], r[3], r[4], r[5]);
    final stats = <Stat>[
      if (inst != null)
        Stat(const T('خوادم تعمل', 'Servers running'), '${inst.where((i) => i['status'] == 'running').length} / ${inst.length}',
            icon: NzIcons.server, progress: inst.isEmpty ? 0 : inst.where((i) => i['status'] == 'running').length / inst.length),
      if (sites != null) Stat(const T('مواقع نشطة', 'Active sites'), '${sites.where((x) => x['status'] == 'active').length}', icon: NzIcons.globe),
      if (doms != null) Stat(const T('نطاقات', 'Domains'), '${doms.length}', icon: NzIcons.globe),
      if (inv != null)
        Stat(const T('فواتير مفتوحة', 'Open invoices'),
            '${inv.where((x) => x['status'] == 'open' || x['status'] == 'partially_paid').length}', icon: NzIcons.receipt),
    ];
    final attention = <(T, String, Tone)>[
      for (final x in inv ?? const <Map<String, dynamic>>[])
        if (x['status'] == 'open' || x['status'] == 'partially_paid')
          (T('الفاتورة ${s(x['number'])} مستحقة في ${_date(x['dueAt'])}', 'Invoice ${s(x['number'])} is due on ${_date(x['dueAt'])}'), 'invoices', Tone.orange),
      for (final d in doms ?? const <Map<String, dynamic>>[])
        if (d['renewalAtRisk'] == true || d['state'] == 'renewal_at_risk')
          (T('${s(d['name'])} يحتاج تجديدًا', '${s(d['name'])} needs renewal'), 'domainList', Tone.warn),
      for (final i in inst ?? const <Map<String, dynamic>>[])
        if (i['status'] == 'failed') (T('فشل الخادم ${s(i['name'])}', 'Server ${s(i['name'])} failed'), 'instances', Tone.danger),
      for (final a in aiAppr ?? const <Map<String, dynamic>>[])
        if (a['status'] == 'pending') (T('موافقة معلّقة: ${_humanize(a['type'])}', 'Pending approval: ${_humanize(a['type'])}'), 'buildApprovals', Tone.accent),
      for (final a in spend ?? const <Map<String, dynamic>>[])
        if (a['status'] == 'pending') (T('طلب إنفاق ينتظر قرارك', 'A spend request is waiting for you'), 'spendApprovals', Tone.accent),
    ];
    return DashboardData(stats: stats, attention: attention);
  }

  /// Same sources as the console's top bar; each one is optional (permission, AI flag).
  @override
  Future<Balances> balances() async {
    final r = await Future.wait([
      api.get('/v1/billing/balance').then<Object?>((v) => v).catchError((Object _) => null),
      api.get('/v1/ai/credits').then<Object?>((v) => v).catchError((Object _) => null),
    ]);
    final bal = r[0] is Map ? (r[0] as Map)['balances'] : null;
    final first = bal is List && bal.isNotEmpty && bal.first is Map ? bal.first as Map : null;
    final cr = r[1] is Map ? r[1] as Map : null;
    return Balances(
      // an organization with no wallet movement yet has a zero balance (as the console shows it)
      walletMinor: r[0] == null ? null : _int(first?['balanceMinor'] ?? 0),
      currency: s(first?['currency'] ?? 'SAR'),
      credits: cr == null ? null : _int(cr['availableCredits']),
      lowCredit: cr?['lowCredit'] == true,
    );
  }

  @override
  Future<List<DomainResult>> searchDomains(String query, {List<String> tlds = const []}) async {
    final r = await api.get('/v1/domains/search', query: {'q': query.trim(), if (tlds.isNotEmpty) 'tlds': tlds.join(',')});
    final items = r is Map && r['items'] is List ? r['items'] as List : const [];
    return [
      for (final d in items.whereType<Map>())
        DomainResult(
          s(d['name']),
          d['available'] is bool ? d['available'] as bool : null,
          price: d['price'] is Map ? _money((d['price'] as Map)['amountMinor'], (d['price'] as Map)['currency']) : null,
          premium: d['premium'] == true,
          purchasable: d['purchasable'] is bool ? d['purchasable'] as bool : null,
          blockedRule: d['eligibility'] is Map && (d['eligibility'] as Map)['state'] == 'blocked' ? s((d['eligibility'] as Map)['rule']) : null,
        ),
    ];
  }

  /// The public price lists (the website's source): no organization needed, nothing invented.
  @override
  Future<List<PlanGroup>> plans(String service) async {
    List<Map<String, dynamic>> items(Object? r) =>
        [for (final e in (r is Map && r['items'] is List ? r['items'] as List : const [])) if (e is Map) e.cast<String, dynamic>()];
    final r = await Future.wait([
      api.get('/v1/public/hosting-plans'),
      service == 'cloud' ? api.get('/v1/public/compute-plans') : Future<Object?>.value(null),
    ]);
    return buildPlanGroups(service, items(r[0]), items(r[1]));
  }

  @override
  Future<List<Notice>> notifications() async => [
        for (final n in await _items('/v1/notifications'))
          Notice(
            id: s(n['id']),
            title: _notificationText(s(n['kind']), n['params'] is Map ? (n['params'] as Map).cast<String, dynamic>() : const {}),
            time: T(_dateTime(n['createdAt']), _dateTime(n['createdAt'])),
            pageId: _pageForKind(s(n['kind'])),
            tone: _toneForKind(s(n['kind'])),
            read: n['readAt'] != null,
          ),
      ];

  @override
  Future<void> markNotificationsRead(List<String> ids) async {
    await Future.wait([for (final id in ids) api.patch('/v1/notifications/$id', {'read': true})]);
  }

  @override
  Future<List<ChatSummary>> recentChats() async => [
        for (final c in await _items('/v1/ai/sessions', query: {'limit': '6'}))
          ChatSummary(s(c['id']), T(s(c['title']), s(c['title']))),
      ];

  @override
  Future<List<ChatLine>> chatLines(String sessionId) async => [
        for (final m in await _items('/v1/ai/sessions/$sessionId/messages', query: {'limit': '100'}))
          if (m['role'] == 'user' || m['role'] == 'assistant') ChatLine(_content(m['content']), fromUser: m['role'] == 'user'),
      ];

  /// Session (created on the first message) → user message → `chat` run → poll the run → the newest assistant message.
  @override
  Future<ChatTurn> sendChat({String? sessionId, required String text, required String locale, List<ChatAttachment> attachments = const []}) async {
    var sid = sessionId;
    if (sid == null) {
      final title = text.length > 60 ? '${text.substring(0, 60)}…' : text;
      final created = await api.post('/v1/ai/sessions', {'title': title});
      sid = s((created as Map)['id']);
    }
    final before = (await _items('/v1/ai/sessions/$sid/messages', query: {'limit': '100'})).length;
    await api.post('/v1/ai/sessions/$sid/messages', {
      'content': text,
      if (attachments.isNotEmpty) 'attachments': [for (final a in attachments) a.toJson()],
    });
    final run = await api.post('/v1/ai/runs', {
      'sessionId': sid,
      'kind': 'chat',
      'input': {'mode': 'chat', 'locale': locale},
    });
    final runId = s(((run as Map)['run'] is Map ? run['run'] as Map : run)['id']);
    final deadline = DateTime.now().add(const Duration(seconds: 90));
    var state = 'queued';
    while (DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 1200));
      final r = await _obj('/v1/ai/runs/$runId');
      state = s(r['state'] ?? (r['run'] is Map ? (r['run'] as Map)['state'] : null));
      if (const {'succeeded', 'failed', 'cancelled', 'budget_exceeded', 'waiting_approval'}.contains(state)) break;
    }
    if (state == 'failed' || state == 'cancelled' || state == 'budget_exceeded') {
      throw ApiException(409, 'run_$state', state);
    }
    final msgs = await _items('/v1/ai/sessions/$sid/messages', query: {'limit': '100'});
    final replies = [for (final m in msgs.skip(before)) if (m['role'] == 'assistant') _content(m['content'])];
    return ChatTurn(sessionId: sid, reply: replies.isEmpty ? null : replies.last);
  }

  // ------------------------------------------------------------------ mapping helpers

  Item _item(Map<String, dynamic> raw, IconData icon,
      {required String title, String sub = '', String? subEn, Status? status, String? meta, bool ltr = false, List<(T, String)> facts = const []}) {
    return Item(
      T(title, title),
      T(sub, subEn ?? sub),
      status: status,
      meta: meta,
      icon: icon,
      ltrTitle: ltr,
      raw: raw,
      facts: [
        ...facts.where((f) => f.$2.isNotEmpty && f.$2 != 'null'),
        if (raw['id'] != null) (const T('المعرّف', 'ID'), s(raw['id'])),
      ],
    );
  }

  /// For lists whose item schema the spec leaves open: the usual name/state fields.
  Item _generic(Map<String, dynamic> x, IconData icon, {bool ltr = false}) => _item(x, icon,
      title: _title(x),
      sub: s(x['description'] ?? x['kind'] ?? x['type'] ?? x['url'] ?? _date(x['createdAt'])),
      status: _status(x['status'] ?? x['state'] ?? (x['enabled'] == null ? null : (x['enabled'] == true ? 'active' : 'paused'))),
      ltr: ltr);

  static String _title(Map<String, dynamic> x) =>
      s(x['name'] ?? x['title'] ?? x['displayName'] ?? x['label'] ?? x['domain'] ?? x['url'] ?? x['email'] ?? x['key'] ?? x['slug'] ?? x['id']);
}

// ------------------------------------------------------------------ pure helpers (unit-tested)

String s(Object? v) => v == null ? '' : v.toString();

int _int(Object? v) => v is int ? v : (v is num ? v.round() : int.tryParse(s(v)) ?? 0);

String _num(Object? v) {
  if (v == null) return '—';
  final n = _int(v);
  return n.toString().replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (_) => ',');
}

double? _pct(Object? v) => v is num ? (v > 1 ? v / 100 : v.toDouble()).clamp(0, 1).toDouble() : null;

/// Integer minor units + currency → the 'money:' value the widgets format (never a float).
String _money(Object? minor, Object? currency) => minor == null ? '—' : 'money:${_int(minor)}:${s(currency).isEmpty ? 'SAR' : s(currency)}';

T? _priceTag(Object? price) {
  if (price is! Map) return null;
  final m = price['amountMinor'] ?? price['monthlyMinor'] ?? price['minor'];
  if (m == null) return null;
  final v = _money(m, price['currency']);
  return T(v, v);
}

String _date(Object? iso) {
  final d = DateTime.tryParse(s(iso));
  if (d == null) return '';
  final u = d.toUtc();
  return '${u.year}-${u.month.toString().padLeft(2, '0')}-${u.day.toString().padLeft(2, '0')}';
}

String _dateTime(Object? iso) {
  final d = DateTime.tryParse(s(iso))?.toUtc();
  if (d == null) return '';
  return '${_date(iso)} ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')} UTC';
}

String _join(Object? v) => v is List ? v.map(s).join(', ') : s(v);

String _humanize(Object? v) {
  final x = s(v).replaceAll(RegExp(r'[._]'), ' ').trim();
  return x.isEmpty ? '' : x[0].toUpperCase() + x.substring(1);
}

String _planName(Object? p) => p is Map ? (p['name'] is Map ? localized(p['name']).en : s(p['name'] ?? p['key'] ?? p['id'])) : s(p);

/// API texts that come in both languages (`{ar, en}`), e.g. plan names.
T localized(Object? v) {
  if (v is Map) {
    final ar = s(v['ar'] ?? v['en']);
    return T(ar, s(v['en'] ?? v['ar']));
  }
  return T(s(v), s(v));
}

String _runtimes(Object? v) =>
    v is List ? v.map((r) => r is Map ? s(r['name'] ?? r['id'] ?? r['key']) : s(r)).join(', ') : s(v);
String _runtime(Object? r) => r is Map ? [s(r['kind'] ?? r['type']), s(r['version'])].where((e) => e.isNotEmpty).join(' ') : s(r);

String _address(Object? a) {
  if (a is! Map) return s(a);
  return [a['buildingNumber'], a['street'], a['district'], a['city'], a['postalCode'], a['country']].map(s).where((e) => e.isNotEmpty).join(', ');
}

String _content(Object? c) {
  if (c is String) return c;
  if (c is Map) return s(c['text'] ?? c['reply'] ?? c['content'] ?? c);
  if (c is List) return c.map(_content).join('\n');
  return s(c);
}

Status? _role(Object? r) => switch (s(r)) {
      'owner' => Status.owner,
      'admin' => Status.admin,
      '' => null,
      final x => Status(T(_humanize(x), _humanize(x)), Tone.neutral),
    };

/// Every status/state enum in the spec → a tone and a bilingual label.
Status? _status(Object? v) {
  final k = s(v);
  if (k.isEmpty) return null;
  const labels = <String, (String, String, Tone)>{
    'running': ('يعمل', 'Running', Tone.success),
    'active': ('نشط', 'Active', Tone.success),
    'verified': ('موثّق', 'Verified', Tone.success),
    'paid': ('مدفوعة', 'Paid', Tone.success),
    'succeeded': ('ناجح', 'Succeeded', Tone.success),
    'sent': ('أُرسلت', 'Sent', Tone.success),
    'delivered': ('سُلّمت', 'Delivered', Tone.success),
    'approved': ('موافق عليه', 'Approved', Tone.success),
    'trialing': ('تجريبي', 'Trial', Tone.accent),
    'stopped': ('متوقف', 'Stopped', Tone.neutral),
    'disabled': ('معطّل', 'Disabled', Tone.neutral),
    'paused': ('موقوف مؤقتًا', 'Paused', Tone.neutral),
    'cancelled': ('ملغى', 'Cancelled', Tone.neutral),
    'void': ('ملغاة', 'Void', Tone.neutral),
    'deleted': ('محذوف', 'Deleted', Tone.neutral),
    'expired': ('منتهٍ', 'Expired', Tone.neutral),
    'pending': ('قيد الانتظار', 'Pending', Tone.warn),
    'pending_domain_proof': ('بانتظار إثبات النطاق', 'Waiting for domain proof', Tone.warn),
    'partial': ('جزئي', 'Partial', Tone.warn),
    'queued': ('في الطابور', 'Queued', Tone.warn),
    'processing': ('قيد المعالجة', 'Processing', Tone.accent),
    'provisioning': ('قيد التجهيز', 'Provisioning', Tone.accent),
    'creating': ('قيد الإنشاء', 'Creating', Tone.accent),
    'building': ('قيد البناء', 'Building', Tone.accent),
    'sending': ('قيد الإرسال', 'Sending', Tone.accent),
    'restoring': ('قيد الاستعادة', 'Restoring', Tone.accent),
    'transferring': ('قيد النقل', 'Transferring', Tone.accent),
    'deleting': ('قيد الحذف', 'Deleting', Tone.warn),
    'open': ('مستحقة', 'Open', Tone.orange),
    'partially_paid': ('مدفوعة جزئيًا', 'Partly paid', Tone.orange),
    'past_due': ('متأخرة', 'Past due', Tone.orange),
    'renewal_at_risk': ('التجديد معرّض للخطر', 'Renewal at risk', Tone.orange),
    'requires_method': ('تحتاج وسيلة دفع', 'Needs a method', Tone.orange),
    'requires_action': ('تحتاج إجراء', 'Needs action', Tone.orange),
    'suspended': ('موقوف', 'Suspended', Tone.danger),
    'failed': ('فشل', 'Failed', Tone.danger),
    'bounced': ('ارتدّت', 'Bounced', Tone.danger),
    'complained': ('شكوى', 'Complaint', Tone.danger),
    'rejected': ('مرفوض', 'Rejected', Tone.danger),
    'denied': ('مرفوض', 'Denied', Tone.danger),
    'unpaid': ('غير مدفوعة', 'Unpaid', Tone.danger),
    'uncollectible': ('غير قابلة للتحصيل', 'Uncollectible', Tone.danger),
    'blocked': ('محظور', 'Blocked', Tone.danger),
    'redemption': ('فترة الاسترداد', 'Redemption', Tone.danger),
    'refunded': ('مستردة', 'Refunded', Tone.neutral),
    'partially_refunded': ('مستردة جزئيًا', 'Partly refunded', Tone.neutral),
    'unknown': ('غير معروف', 'Unknown', Tone.neutral),
  };
  final l = labels[k];
  return l == null ? Status(T(_humanize(k), _humanize(k)), Tone.neutral) : Status(T(l.$1, l.$2), l.$3);
}

T _notificationText(String kind, Map<String, dynamic> params) {
  final t = kNotificationKinds[kind] ?? kNotificationKinds['unknown'] ?? const T('إشعار جديد ({kind})', 'New notification ({kind})');
  String fill(String x) => x.replaceAllMapped(RegExp(r'\{(\w+)\}'), (m) => m[1] == 'kind' ? kind : s(params[m[1]]));
  return T(fill(t.ar), fill(t.en));
}

String _pageForKind(String kind) => switch (kind.split('.').first) {
      'billing' => 'invoices',
      'hosting' => 'sites',
      'domain' => 'domainList',
      'security' => 'orgSettings',
      _ => 'overview',
    };

Tone _toneForKind(String kind) {
  if (RegExp(r'failed|suspended|restricted|abuse|quota_hard').hasMatch(kind)) return Tone.danger;
  if (RegExp(r'reminder|expiring|approval|quota_soft|review').hasMatch(kind)) return Tone.orange;
  if (RegExp(r'succeeded|recovered|resumed|reinstated').hasMatch(kind)) return Tone.success;
  return Tone.accent;
}

/// Exposed for unit tests.
Status? statusFor(Object? v) => _status(v);
String moneyValue(Object? minor, Object? currency) => _money(minor, currency);
T notificationText(String kind, Map<String, dynamic> params) => _notificationText(kind, params);
