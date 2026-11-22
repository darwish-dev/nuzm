import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Where the session cookies and the active organization are kept between launches.
abstract class SessionStore {
  Future<Map<String, String>> readCookies();
  Future<void> writeCookies(Map<String, String> cookies);
  Future<String?> readOrg();
  Future<void> writeOrg(String? orgId);
  Future<void> clear();
}

/// Keychain (iOS) / EncryptedSharedPreferences-Keystore (Android). The session cookie is a credential: never logged.
class SecureSessionStore implements SessionStore {
  SecureSessionStore([FlutterSecureStorage? storage]) : _s = storage ?? const FlutterSecureStorage();
  final FlutterSecureStorage _s;
  static const _kCookies = 'nuzm.cookies';
  static const _kOrg = 'nuzm.org';

  @override
  Future<Map<String, String>> readCookies() async {
    try {
      final raw = await _s.read(key: _kCookies);
      if (raw == null) return {};
      return (jsonDecode(raw) as Map).map((k, v) => MapEntry(k.toString(), v.toString()));
    } catch (_) {
      return {};
    }
  }

  @override
  Future<void> writeCookies(Map<String, String> cookies) => _s.write(key: _kCookies, value: jsonEncode(cookies));

  @override
  Future<String?> readOrg() async {
    try {
      return await _s.read(key: _kOrg);
    } catch (_) {
      return null;
    }
  }

  @override
  Future<void> writeOrg(String? orgId) => orgId == null ? _s.delete(key: _kOrg) : _s.write(key: _kOrg, value: orgId);

  @override
  Future<void> clear() async {
    await _s.delete(key: _kCookies);
    await _s.delete(key: _kOrg);
  }
}

/// For tests and the sample-data mode.
class MemorySessionStore implements SessionStore {
  Map<String, String> cookies = {};
  String? org;

  @override
  Future<Map<String, String>> readCookies() async => Map.of(cookies);
  @override
  Future<void> writeCookies(Map<String, String> c) async => cookies = Map.of(c);
  @override
  Future<String?> readOrg() async => org;
  @override
  Future<void> writeOrg(String? orgId) async => org = orgId;
  @override
  Future<void> clear() async {
    cookies = {};
    org = null;
  }
}
