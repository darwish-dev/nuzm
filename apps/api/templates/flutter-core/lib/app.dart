import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/router.dart';
import 'core/settings.dart';
import 'core/theme.dart';
import 'generated/app_spec.dart';

/// Root widget: localisation (Arabic and English, RTL follows the locale), theming and navigation.
class App extends ConsumerWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final settings = ref.watch(settingsProvider);
    final router = ref.watch(routerProvider);
    return MaterialApp.router(
      onGenerateTitle: (context) => kAppName.of(context),
      locale: settings.locale,
      supportedLocales: const [Locale('ar'), Locale('en')],
      localizationsDelegates: const [
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      theme: buildTheme(Brightness.light),
      darkTheme: kSupportsDark ? buildTheme(Brightness.dark) : null,
      themeMode: kSupportsDark ? settings.themeMode : ThemeMode.light,
      routerConfig: router,
    );
  }
}
