import 'package:flutter/foundation.dart';

import '../l10n/strings.dart';

/// The plans of a service as the website shows them (`apps/web/lib/public-service-plans.ts`): families as tabs,
/// each family's plans cheapest first. Built from what the API publishes (`GET /v1/public/hosting-plans`,
/// `GET /v1/public/compute-plans`); nothing is invented, and an empty answer means no plans section.
enum PlanKind { hosting, compute }

@immutable
class PlanCard {
  const PlanCard({
    required this.key,
    required this.kind,
    required this.name,
    required this.sub,
    required this.priceMinor,
    required this.currency,
    required this.features,
    this.runs = const [],
  });
  final String key;
  final PlanKind kind;
  final T name;
  final T sub;

  /// Integer minor units, per month.
  final int priceMinor;
  final String currency;
  final List<T> features;

  /// Runtimes the plan runs (name, included), hosting only.
  final List<(String, bool)> runs;
}

@immutable
class PlanGroup {
  const PlanGroup(this.id, this.title, this.cards);
  final String id;
  final T title;
  final List<PlanCard> cards;
}

const _groupTitle = {
  'web': T('استضافة المواقع', 'Website hosting'),
  'webapp': T('تطبيقات الويب', 'Web apps'),
  'agency': T('الوكالات', 'Agencies'),
  'cloud': T('الاستضافة السحابية', 'Cloud hosting'),
};

/// Which families each app section shows. Cloud also lists the virtual servers (the website's VPS page).
const kServicePlanGroups = {
  'hosting': ['web', 'webapp', 'agency'],
  'cloud': ['cloud'],
};

String? _groupOf(String key) {
  for (final g in const ['webapp', 'web', 'agency', 'cloud']) {
    if (key.startsWith('$g-')) return g;
  }
  return null;
}

int _int(Object? v) => v is int ? v : int.tryParse('$v') ?? 0;
String _num(num v) => v == v.roundToDouble() ? v.round().toString() : v.toStringAsFixed(1);

const _runtimeNames = {'php': 'PHP', 'nodejs': 'Node.js', 'python': 'Python', 'static': 'Static'};

const _regionLabel = {
  'in_kingdom': T('داخل المملكة', 'Inside the Kingdom'),
  'gcc': T('دول الخليج', 'GCC'),
  'eu': T('أوروبا', 'Europe'),
  'other': T('مناطق أخرى', 'Other regions'),
};

/// [hosting] and [compute] are the `items` of the two public endpoints.
List<PlanGroup> buildPlanGroups(String service, List<Map<String, dynamic>> hosting, List<Map<String, dynamic>> compute) {
  final groups = <PlanGroup>[];
  for (final g in kServicePlanGroups[service] ?? const <String>[]) {
    final list = [for (final p in hosting) if (_groupOf('${p['key']}') == g) p]
      ..sort((a, b) => _int((a['price'] as Map?)?['amountMinor']).compareTo(_int((b['price'] as Map?)?['amountMinor'])));
    if (list.isEmpty) continue;
    groups.add(PlanGroup(g, _groupTitle[g]!, [for (final p in list) _hostingCard(p)]));
  }
  if (service == 'cloud' && compute.isNotEmpty) {
    groups.add(PlanGroup('servers', const T('الخوادم الافتراضية', 'Virtual servers'), [for (final p in compute) _computeCard(p)]));
  }
  return groups;
}

PlanCard _hostingCard(Map<String, dynamic> p) {
  final q = (p['quotas'] as Map?) ?? const {};
  final name = (p['name'] as Map?) ?? const {};
  final sites = _int(q['sitesCount']);
  final disk = _num(_int(q['diskMb']) / 1024);
  final bw = _int(q['bandwidthGb']);
  final db = _int(q['dbCount']);
  final features = [
    T('$sites ${sites == 1 ? 'موقع' : 'مواقع'}', '$sites ${sites == 1 ? 'website' : 'websites'}'),
    T('$disk جيجابايت تخزين', '$disk GB storage'),
    T('$bw جيجابايت نقل شهريًا', '$bw GB bandwidth a month'),
    T('$db قاعدة بيانات', '$db ${db == 1 ? 'database' : 'databases'}'),
  ];
  final kinds = {for (final r in (p['runtimes'] as List? ?? const [])) _runtimeNames['$r'.split(':').first] ?? '$r'.split(':').first};
  final price = (p['price'] as Map?) ?? const {};
  return PlanCard(
    key: '${p['key']}',
    kind: PlanKind.hosting,
    name: T('${name['ar'] ?? p['key']}', '${name['en'] ?? p['key']}'),
    sub: T('${features[0].ar} · ${features[1].ar}', '${features[0].en} · ${features[1].en}'),
    priceMinor: _int(price['amountMinor']),
    currency: '${price['currency'] ?? 'SAR'}',
    features: features,
    runs: [for (final n in const ['PHP', 'Node.js', 'Python', 'Static']) (n, kinds.contains(n))],
  );
}

PlanCard _computeCard(Map<String, dynamic> p) {
  final cpu = _int(p['vcpu']);
  final mem = _num(_int(p['memoryMb']) / 1024);
  final disk = _int(p['diskGb']);
  final bw = p['bandwidth'] == null ? null : '${p['bandwidth']}';
  final regions = [for (final r in (p['regions'] as List? ?? const [])) _regionLabel['$r'] ?? T('$r', '$r')];
  final price = (p['price'] as Map?) ?? const {};
  return PlanCard(
    key: '$cpu-${p['memoryMb']}-$disk',
    kind: PlanKind.compute,
    name: T('$cpu vCPU', '$cpu vCPU'),
    sub: T('$mem جيجابايت ذاكرة · $disk جيجابايت قرص', '$mem GB memory · $disk GB disk'),
    priceMinor: _int(price['amountMinor']),
    currency: '${price['currency'] ?? 'SAR'}',
    features: [
      T('$cpu نواة معالجة', '$cpu vCPU'),
      T('$mem جيجابايت ذاكرة', '$mem GB memory'),
      T('$disk جيجابايت قرص', '$disk GB disk'),
      if (bw != null) T('$bw نقل بيانات', '$bw transfer'),
      if (regions.isNotEmpty) T('المناطق: ${regions.map((r) => r.ar).join('، ')}', 'Regions: ${regions.map((r) => r.en).join(', ')}'),
    ],
  );
}

/// Sample plans for sample mode: the shape of the public endpoints, so the same mapper runs.
const kSampleHostingPlans = <Map<String, dynamic>>[
  {'key': 'web-start', 'name': {'ar': 'البداية', 'en': 'Start'}, 'quotas': {'diskMb': 20480, 'bandwidthGb': 200, 'dbCount': 5, 'sitesCount': 1}, 'runtimes': ['php:8.3', 'static'], 'price': {'amountMinor': '2900', 'currency': 'SAR'}},
  {'key': 'web-business', 'name': {'ar': 'الأعمال', 'en': 'Business'}, 'quotas': {'diskMb': 51200, 'bandwidthGb': 500, 'dbCount': 25, 'sitesCount': 10}, 'runtimes': ['php:8.3', 'static'], 'price': {'amountMinor': '5900', 'currency': 'SAR'}},
  {'key': 'web-premium', 'name': {'ar': 'المتقدمة', 'en': 'Premium'}, 'quotas': {'diskMb': 102400, 'bandwidthGb': 1000, 'dbCount': 50, 'sitesCount': 100}, 'runtimes': ['php:8.3', 'nodejs:20', 'python:3.12', 'static'], 'price': {'amountMinor': '9900', 'currency': 'SAR'}},
  {'key': 'webapp-start', 'name': {'ar': 'تطبيقات الويب - البداية', 'en': 'Web App Start'}, 'quotas': {'diskMb': 30720, 'bandwidthGb': 500, 'dbCount': 10, 'sitesCount': 5}, 'runtimes': ['nodejs:20', 'python:3.12', 'static'], 'price': {'amountMinor': '4900', 'currency': 'SAR'}},
  {'key': 'webapp-pro', 'name': {'ar': 'تطبيقات الويب - احترافي', 'en': 'Web App Pro'}, 'quotas': {'diskMb': 102400, 'bandwidthGb': 2000, 'dbCount': 30, 'sitesCount': 20}, 'runtimes': ['nodejs:20', 'python:3.12', 'static'], 'price': {'amountMinor': '14900', 'currency': 'SAR'}},
  {'key': 'cloud-startup', 'name': {'ar': 'البداية السحابية', 'en': 'Cloud Startup'}, 'quotas': {'diskMb': 102400, 'bandwidthGb': 2000, 'dbCount': 50, 'sitesCount': 100}, 'runtimes': ['php:8.3', 'nodejs:20', 'python:3.12', 'static'], 'price': {'amountMinor': '12900', 'currency': 'SAR'}},
];

const kSampleComputePlans = <Map<String, dynamic>>[
  {'vcpu': 1, 'memoryMb': 1024, 'diskGb': 20, 'bandwidth': '1 TB', 'price': {'amountMinor': '5380', 'currency': 'SAR'}, 'regions': ['gcc', 'in_kingdom']},
  {'vcpu': 2, 'memoryMb': 4096, 'diskGb': 80, 'bandwidth': '3 TB', 'price': {'amountMinor': '14220', 'currency': 'SAR'}, 'regions': ['gcc', 'in_kingdom', 'other']},
  {'vcpu': 4, 'memoryMb': 8192, 'diskGb': 160, 'bandwidth': '5 TB', 'price': {'amountMinor': '28440', 'currency': 'SAR'}, 'regions': ['gcc', 'in_kingdom', 'other']},
];
