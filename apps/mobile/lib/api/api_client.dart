import 'dart:convert';
import 'dart:math';

import 'package:http/http.dart' as http;

import 'session_store.dart';

/// RFC 9457 problem from the API (spec/openapi/errors.yaml), or a transport failure (status 0).
class ApiException implements Exception {
  ApiException(this.status, this.code, this.title, {this.traceId, this.fields = const []});
  final int status;
  final String code;
  final String title;
  final String? traceId;
  final List<String> fields;

  bool get unauthenticated => status == 401;
  bool get forbidden => status == 403;

  /// A module whose feature flag is off answers 404 (docs/04).
  bool get notFound => status == 404;
  bool get offline => status == 0;

  @override
  String toString() => 'ApiException($status $code: $title${traceId == null ? '' : ' trace=$traceId'})';
}

/// Talks to the Nuzm API the way the web console's SDK does (packages/sdk): a session cookie of the `web` realm,
/// the CSRF cookie echoed as `x-csrf-token` on unsafe methods, the active organization in `x-nuzm-org`, and an
/// `Idempotency-Key` on every side-effecting POST. The cookie jar lives in [SessionStore] (secure storage on device).
class ApiClient {
  ApiClient({required this.baseUrl, required this.store, http.Client? client, this.locale = 'ar'})
      : _http = client ?? http.Client();

  final String baseUrl;
  final SessionStore store;
  final http.Client _http;
  String locale;
  String? orgId;

  static const _csrfCookie = 'nuzm_csrf';
  static const _sessionCookie = 'nuzm_session';
  static const _timeout = Duration(seconds: 20);

  Map<String, String> _jar = {};
  bool _loaded = false;

  Future<void> _ensureJar() async {
    if (_loaded) return;
    _jar = await store.readCookies();
    orgId ??= await store.readOrg();
    _loaded = true;
  }

  Future<bool> hasSession() async {
    await _ensureJar();
    return _jar.containsKey(_sessionCookie);
  }

  Future<void> setOrg(String? id) async {
    orgId = id;
    await store.writeOrg(id);
  }

  Future<void> clearSession() async {
    _jar = {};
    orgId = null;
    await store.clear();
  }

  Future<dynamic> get(String path, {Map<String, String>? query}) => _send('GET', path, query: query);
  Future<dynamic> post(String path, [Object? body]) => _send('POST', path, body: body ?? const {});
  Future<dynamic> patch(String path, Object body) => _send('PATCH', path, body: body);
  Future<dynamic> put(String path, Object body) => _send('PUT', path, body: body);

  Future<dynamic> _send(String method, String path, {Map<String, String>? query, Object? body}) async {
    await _ensureJar();
    final uri = Uri.parse('$baseUrl$path').replace(queryParameters: (query == null || query.isEmpty) ? null : query);
    final req = http.Request(method, uri);
    req.headers.addAll({
      'accept': 'application/json',
      'accept-language': locale,
      'x-nuzm-realm': 'web',
      if (_jar.isNotEmpty) 'cookie': _jar.entries.map((e) => '${e.key}=${e.value}').join('; '),
      if (orgId != null) 'x-nuzm-org': orgId!,
      if (method != 'GET' && _jar[_csrfCookie] != null) 'x-csrf-token': _jar[_csrfCookie]!,
      if (method == 'POST') 'idempotency-key': newIdempotencyKey(),
    });
    if (body != null && method != 'GET') {
      req.headers['content-type'] = 'application/json';
      req.body = jsonEncode(body);
    }
    http.Response res;
    try {
      res = await http.Response.fromStream(await _http.send(req).timeout(_timeout));
    } catch (e) {
      throw ApiException(0, 'network_error', e.toString());
    }
    await _absorbCookies(res);
    final text = utf8.decode(res.bodyBytes);
    final json = text.isEmpty ? null : _tryJson(text);
    if (res.statusCode >= 200 && res.statusCode < 300) return json;
    final p = json is Map ? json : const {};
    if (res.statusCode == 401) {
      // The session is gone (expired, revoked, signed out elsewhere): forget it.
      _jar.remove(_sessionCookie);
      await store.writeCookies(_jar);
    }
    throw ApiException(
      res.statusCode,
      (p['code'] ?? 'http_${res.statusCode}').toString(),
      (p['title'] ?? res.reasonPhrase ?? '').toString(),
      traceId: (p['traceId'] ?? res.headers['x-trace-id'])?.toString(),
      fields: [
        for (final e in (p['errors'] is List ? p['errors'] as List : const []))
          if (e is Map && e['field'] != null) e['field'].toString(),
      ],
    );
  }

  Future<void> _absorbCookies(http.Response res) async {
    final raw = res.headers['set-cookie'];
    if (raw == null || raw.isEmpty) return;
    var changed = false;
    for (final c in splitSetCookie(raw)) {
      final first = c.split(';').first;
      final eq = first.indexOf('=');
      if (eq <= 0) continue;
      final name = first.substring(0, eq).trim();
      final value = first.substring(eq + 1).trim();
      final expired = RegExp(r';\s*max-age=0', caseSensitive: false).hasMatch(c) || value.isEmpty;
      if (expired) {
        changed |= _jar.remove(name) != null;
      } else if (_jar[name] != value) {
        _jar[name] = value;
        changed = true;
      }
    }
    if (changed) await store.writeCookies(_jar);
  }

  static dynamic _tryJson(String s) {
    try {
      return jsonDecode(s);
    } catch (_) {
      return s;
    }
  }

  void close() => _http.close();
}

/// `package:http` joins several Set-Cookie headers with commas; split them without breaking `Expires=Wed, 21 Oct …`.
List<String> splitSetCookie(String header) =>
    header.split(RegExp(r',(?=\s*[A-Za-z0-9_\-.]+=)')).map((s) => s.trim()).where((s) => s.isNotEmpty).toList();

final _rand = Random.secure();

/// A random UUID v4 (the API dedupes side effects on it).
String newIdempotencyKey() {
  final b = List<int>.generate(16, (_) => _rand.nextInt(256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  final h = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
}
