import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../generated/app_spec.dart';

/// Key/value storage for user settings. `memory()` is for tests.
class SettingsStore {
  SettingsStore._(this._prefs);

  final SharedPreferences? _prefs;
  final Map<String, String> _memory = {};

  static Future<SettingsStore> load() async =>
      SettingsStore._(await SharedPreferences.getInstance());

  factory SettingsStore.memory() => SettingsStore._(null);

  String? read(String key) {
    final prefs = _prefs;
    return prefs != null ? prefs.getString(key) : _memory[key];
  }

  Future<void> write(String key, String value) async {
    final prefs = _prefs;
    if (prefs != null) {
      await prefs.setString(key, value);
    } else {
      _memory[key] = value;
    }
  }
}

final settingsStoreProvider = Provider<SettingsStore>(
  (ref) => throw UnimplementedError('override settingsStoreProvider in main()'),
);

class SettingsState {
  const SettingsState({required this.locale, required this.themeMode});

  final Locale locale;
  final ThemeMode themeMode;

  SettingsState copyWith({Locale? locale, ThemeMode? themeMode}) =>
      SettingsState(
        locale: locale ?? this.locale,
        themeMode: themeMode ?? this.themeMode,
      );
}

class SettingsNotifier extends Notifier<SettingsState> {
  @override
  SettingsState build() {
    final store = ref.watch(settingsStoreProvider);
    final lang = store.read('locale') ?? kDefaultLocale;
    final mode = store.read('themeMode') ?? 'system';
    return SettingsState(
      locale: Locale(lang == 'en' ? 'en' : 'ar'),
      themeMode: ThemeMode.values.firstWhere(
        (m) => m.name == mode,
        orElse: () => ThemeMode.system,
      ),
    );
  }

  Future<void> setLocale(Locale locale) async {
    state = state.copyWith(locale: locale);
    await ref.read(settingsStoreProvider).write('locale', locale.languageCode);
  }

  Future<void> setThemeMode(ThemeMode mode) async {
    state = state.copyWith(themeMode: mode);
    await ref.read(settingsStoreProvider).write('themeMode', mode.name);
  }
}

final settingsProvider =
    NotifierProvider<SettingsNotifier, SettingsState>(SettingsNotifier.new);
