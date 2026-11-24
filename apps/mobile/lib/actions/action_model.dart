import 'package:flutter/widgets.dart';

import '../api/api_client.dart';
import '../l10n/strings.dart';

enum FieldKind { text, multiline, number, money, email, password, select, toggle }

/// One input of an action form.
@immutable
class FieldDef {
  const FieldDef(
    this.key,
    this.label, {
    this.kind = FieldKind.text,
    this.required = true,
    this.options = const [],
    this.optionsFrom,
    this.initial,
    this.ltr = false,
    this.hint,
    this.pattern,
  });
  final String key;
  final T label;
  final FieldKind kind;
  final bool required;

  /// Fixed choices for [FieldKind.select]: (value, label).
  final List<(String, T)> options;

  /// Choices loaded from the API when the form opens (e.g. the organization's workspaces).
  final Future<List<(String, T)>> Function(ActionContext c)? optionsFrom;

  /// Initial value from the item or page being edited (string, or bool for toggles).
  final Object? Function(Map<String, dynamic> raw)? initial;
  final bool ltr;
  final T? hint;

  /// A text pattern the value must match (checked before sending; the API checks again).
  final RegExp? pattern;
}

/// A quote (`POST /v1/quotes`) shown before a paid resource is created. Amounts are integer minor units.
@immutable
class Quote {
  const Quote({
    required this.id,
    required this.currency,
    required this.subtotalMinor,
    required this.taxMinor,
    required this.totalMinor,
    required this.expiresAt,
    required this.requiresApproval,
  });
  final String id;
  final String currency;
  final int subtotalMinor;
  final int taxMinor;
  final int totalMinor;
  final DateTime? expiresAt;
  final bool requiresApproval;

  factory Quote.fromJson(Map<String, dynamic> j) {
    int i(Object? v) => v is int ? v : int.tryParse('${v ?? 0}') ?? 0;
    final tax = j['taxEstimate'];
    return Quote(
      id: '${j['id']}',
      currency: '${j['currency'] ?? 'SAR'}',
      subtotalMinor: i(j['subtotalMinor']),
      taxMinor: tax is Map ? i(tax['taxMinor']) : 0,
      totalMinor: i(j['totalMinor'] ?? j['subtotalMinor']),
      expiresAt: DateTime.tryParse('${j['expiresAt'] ?? ''}'),
      requiresApproval: j['requiresApproval'] == true,
    );
  }
}

/// What an action can use while it runs: the form values, the item it acts on, and the API.
class ActionContext {
  ActionContext({
    required this.api,
    required this.orgId,
    required this.idempotencyKey,
    this.item = const {},
    this.values = const {},
    this.quote,
  });
  final ApiClient api;

  /// One key per user action: a retry of the same submission reuses it, so the API never does it twice.
  final String idempotencyKey;
  final String orgId;

  /// The raw API object of the row (item actions) or page (edit actions).
  final Map<String, dynamic> item;
  final Map<String, Object?> values;
  final Quote? quote;

  String v(String key) => '${values[key] ?? ''}'.trim();
  bool b(String key) => values[key] == true;
  String? opt(String key) => v(key).isEmpty ? null : v(key);
  int n(String key) => int.parse(v(key));
  String get id => '${item['id']}';

  /// A side-effecting POST under this action's idempotency key.
  Future<dynamic> post(String path, [Object? body]) => api.post(path, body ?? const {}, idempotencyKey);

  /// Items of a list endpoint (`{items: [...]}`).
  Future<List<Map<String, dynamic>>> list(String path, {Map<String, String>? query}) async {
    final r = await api.get(path, query: {'limit': '100', ...?query});
    final l = r is Map ? r['items'] : r;
    return [for (final e in (l is List ? l : const [])) if (e is Map) e.cast<String, dynamic>()];
  }

  /// PATCH / PUT / DELETE with `If-Match`: reads the resource first for its current ETag (docs/04 optimistic
  /// concurrency). [readPath] defaults to [path].
  Future<dynamic> versioned(String method, String path, [Object? body, String? readPath]) async {
    String? etag;
    try {
      etag = (await api.send('GET', readPath ?? path)).etag;
    } on ApiException catch (e) {
      if (!e.notFound && e.status != 405) rethrow;
    }
    return switch (method) {
      'PATCH' => api.patch(path, body!, ifMatch: etag),
      'PUT' => api.put(path, body!, ifMatch: etag),
      _ => api.delete(path, ifMatch: etag),
    };
  }
}

/// A write the user can start: a create, an edit, a state change or a delete.
@immutable
class ActionDef {
  const ActionDef({
    required this.id,
    required this.label,
    required this.icon,
    required this.run,
    this.fields = const [],
    this.quote,
    this.destructive = false,
    this.stepUp = false,
    this.confirm,
    this.done,
    this.visible,
  });
  final String id;
  final T label;
  final IconData icon;
  final List<FieldDef> fields;

  /// Paid resources: builds the quote request body from the form; the user sees the price before [run].
  final Map<String, Object?> Function(ActionContext c)? quote;

  /// Sends the write. For quoted actions [ActionContext.quote] is set.
  final Future<void> Function(ActionContext c) run;
  final bool destructive;

  /// Needs a recent two-step verification (the API answers 403 step_up_required otherwise).
  final bool stepUp;

  /// Asked before running (destructive actions always ask).
  final T? confirm;

  /// Shown after success.
  final T? done;

  /// Whether the action applies to this item (e.g. "start" only when stopped).
  final bool Function(Map<String, dynamic> item)? visible;
}

/// "1,250.5" → 125050 (integer minor units, two decimals; no floating point).
int? toMinor(String text) {
  final t = text.trim().replaceAll(',', '');
  final m = RegExp(r'^(\d{1,15})(?:\.(\d{1,2}))?$').firstMatch(t);
  if (m == null) return null;
  return int.parse(m[1]!) * 100 + int.parse((m[2] ?? '0').padRight(2, '0'));
}

/// 125050 → "1250.50" (to prefill money fields).
String fromMinor(Object? minor) {
  final n = minor is int ? minor : int.tryParse('${minor ?? ''}');
  if (n == null) return '';
  return '${n ~/ 100}.${(n % 100).toString().padLeft(2, '0')}';
}
