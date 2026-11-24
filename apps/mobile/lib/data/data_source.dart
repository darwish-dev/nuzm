import 'package:flutter/foundation.dart';

import '../l10n/strings.dart';
import 'demo.dart';
import 'nav.dart';
import 'plans.dart';

/// What a page shows. Whichever lists are present are drawn, in this order: stats, catalog, fields, items.
@immutable
class PageData {
  const PageData({this.items, this.stats, this.catalog, this.fields, this.related, this.relatedPage, this.raw = const {}});

  /// The API object behind a settings page (prefills its edit form).
  final Map<String, dynamic> raw;
  final List<Item>? items;
  final List<Stat>? stats;
  final List<CatalogItem>? catalog;
  final List<FieldSpec>? fields;

  /// A short list from another page shown below (e.g. the latest invoices on the billing overview).
  final List<Item>? related;
  final String? relatedPage;
}

@immutable
class DashboardData {
  const DashboardData({required this.stats, required this.attention});
  final List<Stat> stats;
  final List<(T, String, Tone)> attention;
}

@immutable
class Notice {
  const Notice({required this.id, required this.title, required this.time, required this.pageId, required this.tone, this.read = false});
  final String id;
  final T title;
  final T time;
  final String pageId;
  final Tone tone;
  final bool read;
}

@immutable
class ChatSummary {
  const ChatSummary(this.id, this.title);
  final String? id;
  final T title;
}

@immutable
class ChatLine {
  const ChatLine(this.text, {required this.fromUser});
  final String text;
  final bool fromUser;
}

/// What a chat message can carry (`AiMessageInput.attachments`): a text file's contents, or a link the run fetches
/// through the platform's SSRF-safe fetcher. The API takes nothing else (no images, no audio).
@immutable
class ChatAttachment {
  const ChatAttachment.text(this.name, String this.text) : url = null;
  const ChatAttachment.link(String this.url)
      : name = url,
        text = null;
  final String name;
  final String? text;
  final String? url;
  bool get isLink => url != null;

  /// At most 10 per message; each text at most this many characters (MAX_MESSAGE_CHARS in the API).
  static const maxCount = 10;
  static const maxChars = 20000;

  Map<String, Object> toJson() => isLink ? {'kind': 'url', 'url': url!} : {'kind': 'text', 'name': name, 'text': text!};
}

@immutable
class ChatTurn {
  const ChatTurn({required this.sessionId, required this.reply});
  final String? sessionId;

  /// The assistant's answer, or null when the run did not finish in time (it keeps running on the server).
  final String? reply;
}

/// The two balances of the console's top bar: the prepaid wallet and the AI credits.
@immutable
class Balances {
  const Balances({this.walletMinor, this.currency = 'SAR', this.credits, this.lowCredit = false});

  /// Integer minor units; null when the member may not read billing.
  final int? walletMinor;
  final String currency;

  /// Available AI credits; null when AI is off or not readable.
  final int? credits;
  final bool lowCredit;
}

@immutable
class DomainResult {
  const DomainResult(this.name, this.available, {this.price, this.premium = false, this.purchasable, this.blockedRule});
  final String name;

  /// null: unknown / not sold.
  final bool? available;

  /// `money:<minor>:<currency>`, per year.
  final String? price;
  final bool premium;

  /// Whether it can be bought here now (null: the source does not say; then "available" decides).
  final bool? purchasable;

  /// The eligibility rule when the extension is blocked (`policy.saudi_absent`, ...), else null.
  final String? blockedRule;

  bool get blocked => blockedRule != null;
  bool get canBuy => !blocked && available == true && (purchasable ?? true);
}

/// Everything the screens read. [DemoDataSource] serves the sample data; `ApiDataSource` the live API.
abstract class DataSource {
  bool get isLive;
  T get orgName;
  String get userName;
  Future<PageData> load(String pageId);
  Future<DashboardData> dashboard();
  Future<Balances> balances();
  Future<List<DomainResult>> searchDomains(String query, {List<String> tlds = const []});

  /// The service's plans, as the website shows them ([buildPlanGroups]).
  Future<List<PlanGroup>> plans(String service);
  Future<List<Notice>> notifications();
  Future<void> markNotificationsRead(List<String> ids);
  Future<List<ChatSummary>> recentChats();
  Future<List<ChatLine>> chatLines(String sessionId);
  Future<ChatTurn> sendChat({String? sessionId, required String text, required String locale, List<ChatAttachment> attachments = const []});
}

class DemoDataSource implements DataSource {
  const DemoDataSource({this.latency = const Duration(milliseconds: 350)});
  final Duration latency;

  @override
  bool get isLive => false;
  @override
  T get orgName => kOrgName;
  @override
  String get userName => kUserName;

  Future<void> _wait() => Future<void>.delayed(latency);

  @override
  Future<PageData> load(String pageId) async {
    await _wait();
    // Transfers live on the add-domain screen, not in the navigation.
    if (pageId == 'transfers') return PageData(items: kLists['transfers'] ?? const []);
    final kind = findPage(pageId).$2.kind;
    return switch (kind) {
      PageKind.list => PageData(items: kLists[pageId] ?? const []),
      PageKind.stats => PageData(
          stats: kStats[pageId] ?? const [],
          related: pageId == 'billingOverview' ? kLists['invoices']!.take(2).toList() : null,
          relatedPage: pageId == 'billingOverview' ? 'invoices' : null,
        ),
      PageKind.catalog => PageData(catalog: kCatalogs[pageId] ?? const []),
      PageKind.form => PageData(fields: kForms[pageId] ?? const []),
      _ => const PageData(),
    };
  }

  @override
  Future<DashboardData> dashboard() async {
    await _wait();
    return DashboardData(stats: kDashboardStats, attention: kAttention);
  }

  @override
  Future<Balances> balances() async => const Balances(walletMinor: 125000, credits: 7420);

  @override
  Future<List<DomainResult>> searchDomains(String query, {List<String> tlds = const []}) async {
    await _wait();
    final base = query.trim().toLowerCase().split('.').first.replaceAll(RegExp(r'[^a-z0-9-]'), '');
    if (base.isEmpty) return const [];
    const prices = {'com': 4900, 'net': 5900, 'org': 5500};
    return [
      for (final (i, tld) in (tlds.isEmpty ? const ['com', 'net', 'org'] : tlds).indexed)
        DomainResult('$base.$tld', (base.length + i).isEven, price: 'money:${prices[tld] ?? 4900}:SAR'),
      if (tlds.isEmpty) DomainResult('$base.sa', null, blockedRule: 'policy.saudi_absent'),
    ];
  }

  @override
  Future<List<PlanGroup>> plans(String service) async {
    await _wait();
    return buildPlanGroups(service, kSampleHostingPlans, kSampleComputePlans);
  }

  @override
  Future<List<Notice>> notifications() async {
    await _wait();
    return [
      for (final (i, (title, time, pageId, tone)) in kNotifications.indexed)
        Notice(id: '$i', title: title, time: time, pageId: pageId, tone: tone),
    ];
  }

  @override
  Future<void> markNotificationsRead(List<String> ids) async {}

  @override
  Future<List<ChatSummary>> recentChats() async => [for (final c in kRecentChats) ChatSummary(null, c)];

  @override
  Future<List<ChatLine>> chatLines(String sessionId) async => const [];

  @override
  Future<ChatTurn> sendChat({String? sessionId, required String text, required String locale, List<ChatAttachment> attachments = const []}) async {
    await Future<void>.delayed(const Duration(milliseconds: 900));
    return ChatTurn(sessionId: null, reply: locale == 'ar' ? S.aiPreviewReply.ar : S.aiPreviewReply.en);
  }
}
