import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/auth.dart';
import '../../core/models.dart';
import '../../core/settings.dart';
import '../../generated/app_spec.dart';

class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final settings = ref.watch(settingsProvider);
    final notifier = ref.read(settingsProvider.notifier);
    return Scaffold(
      appBar: AppBar(title: Text(const L('الإعدادات', 'Settings').of(context))),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text(const L('اللغة', 'Language').of(context),
              style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          SegmentedButton<String>(
            key: const ValueKey('language_toggle'),
            segments: const [
              ButtonSegment(value: 'ar', label: Text('العربية')),
              ButtonSegment(value: 'en', label: Text('English')),
            ],
            selected: {settings.locale.languageCode},
            onSelectionChanged: (s) => notifier.setLocale(Locale(s.first)),
          ),
          if (kSupportsDark) ...[
            const SizedBox(height: 24),
            Text(const L('المظهر', 'Appearance').of(context),
                style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            SegmentedButton<ThemeMode>(
              key: const ValueKey('theme_toggle'),
              segments: [
                ButtonSegment(
                  value: ThemeMode.system,
                  label: Text(const L('النظام', 'System').of(context)),
                ),
                ButtonSegment(
                  value: ThemeMode.light,
                  label: Text(const L('فاتح', 'Light').of(context)),
                ),
                ButtonSegment(
                  value: ThemeMode.dark,
                  label: Text(const L('داكن', 'Dark').of(context)),
                ),
              ],
              selected: {settings.themeMode},
              onSelectionChanged: (s) => notifier.setThemeMode(s.first),
            ),
          ],
          if (kAuthEnabled) ...[
            const SizedBox(height: 32),
            OutlinedButton(
              key: const ValueKey('logout'),
              onPressed: () => ref.read(authProvider.notifier).logout(),
              child: Text(const L('تسجيل الخروج', 'Sign out').of(context)),
            ),
          ],
        ],
      ),
    );
  }
}
