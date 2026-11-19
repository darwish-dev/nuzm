import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app.dart';
import 'core/settings.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final store = await SettingsStore.load();
  runApp(
    ProviderScope(
      overrides: [settingsStoreProvider.overrideWithValue(store)],
      child: const App(),
    ),
  );
}
