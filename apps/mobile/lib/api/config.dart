import 'package:flutter/foundation.dart';

/// API base URL. Set it per build: `flutter run --dart-define=NUZM_API_URL=https://api.example.com`.
/// Without it, debug builds talk to the local dev stack (`pnpm --filter @nuzm/api dev:stack`, port 4000):
/// the Android emulator reaches the host as 10.0.2.2, the iOS simulator as 127.0.0.1.
/// Release builds must pass an https URL (cleartext is only allowed for local development).
String apiBaseUrl() {
  const fromEnv = String.fromEnvironment('NUZM_API_URL');
  if (fromEnv.isNotEmpty) return fromEnv;
  if (!kIsWeb && defaultTargetPlatform == TargetPlatform.android) return 'http://10.0.2.2:4000';
  return 'http://127.0.0.1:4000';
}

/// The browser keeps API cookies itself and blocks reading them, so the web build runs on sample data unless it is
/// served from the API's own origin. Native builds (Android, iOS) use the live API.
bool get liveApiSupported => !kIsWeb;
