import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

import 'config.dart';

class AuthException implements Exception {
  const AuthException(this.message);

  final String message;

  @override
  String toString() => message;
}

/// Where the session token lives. The platform keystore on a device; memory in tests. The token is never logged.
abstract class TokenStore {
  Future<String?> read();
  Future<void> write(String token);
  Future<void> clear();
}

class SecureTokenStore implements TokenStore {
  const SecureTokenStore();

  static const _key = 'session_token';
  static const _storage = FlutterSecureStorage();

  @override
  Future<String?> read() => _storage.read(key: _key);

  @override
  Future<void> write(String token) => _storage.write(key: _key, value: token);

  @override
  Future<void> clear() => _storage.delete(key: _key);
}

class MemoryTokenStore implements TokenStore {
  String? _token;

  @override
  Future<String?> read() async => _token;

  @override
  Future<void> write(String token) async => _token = token;

  @override
  Future<void> clear() async => _token = null;
}

abstract class AuthRepository {
  /// Returns the session token or throws [AuthException].
  Future<String> login(String email, String password);
}

/// Signs in against the generated back end (`POST {API_BASE_URL}/auth/login`). `API_BASE_URL` is a build-time `--dart-define`; without it the app says so instead of guessing.
class HttpAuthRepository implements AuthRepository {
  const HttpAuthRepository();

  @override
  Future<String> login(String email, String password) async {
    if (kApiBaseUrl.isEmpty) {
      throw const AuthException('not_configured');
    }
    final response = await http
        .post(
          Uri.parse('$kApiBaseUrl/auth/login'),
          headers: const {'content-type': 'application/json'},
          body: jsonEncode({'email': email, 'password': password}),
        )
        .timeout(const Duration(seconds: 15));
    if (response.statusCode == 401 || response.statusCode == 422) {
      throw const AuthException('invalid_credentials');
    }
    if (response.statusCode != 200) {
      throw const AuthException('server_error');
    }
    final body = jsonDecode(response.body);
    final token = body is Map<String, dynamic> ? body['token'] : null;
    if (token is! String || token.isEmpty) {
      throw const AuthException('server_error');
    }
    return token;
  }
}

enum AuthStatus { unknown, signedOut, signedIn }

final tokenStoreProvider = Provider<TokenStore>((ref) => const SecureTokenStore());
final authRepositoryProvider =
    Provider<AuthRepository>((ref) => const HttpAuthRepository());

class AuthNotifier extends Notifier<AuthStatus> {
  @override
  AuthStatus build() {
    Future<void>.microtask(restore);
    return AuthStatus.unknown;
  }

  Future<void> restore() async {
    final token = await ref.read(tokenStoreProvider).read();
    state = token == null ? AuthStatus.signedOut : AuthStatus.signedIn;
  }

  /// Returns null on success or an error code ([AuthException.message]) for the form to show.
  Future<String?> login(String email, String password) async {
    try {
      final token = await ref.read(authRepositoryProvider).login(email, password);
      await ref.read(tokenStoreProvider).write(token);
      state = AuthStatus.signedIn;
      return null;
    } on AuthException catch (e) {
      return e.message;
    } on Exception {
      return 'network_error';
    }
  }

  Future<void> logout() async {
    await ref.read(tokenStoreProvider).clear();
    state = AuthStatus.signedOut;
  }
}

final authProvider = NotifierProvider<AuthNotifier, AuthStatus>(AuthNotifier.new);
