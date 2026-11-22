import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'app_scope.dart';
import 'screens/home_screen.dart';
import 'theme/nuzm_theme.dart';

void main() => runApp(NuzmApp(controller: AppController()));

class NuzmApp extends StatelessWidget {
  const NuzmApp({super.key, required this.controller, this.useGoogleFonts = true});
  final AppController controller;
  final bool useGoogleFonts;

  @override
  Widget build(BuildContext context) {
    return AppScope(
      controller: controller,
      child: ListenableBuilder(
        listenable: controller,
        builder: (context, _) => MaterialApp(
          title: 'Nuzm',
          debugShowCheckedModeBanner: false,
          locale: controller.locale,
          supportedLocales: const [Locale('ar'), Locale('en')],
          localizationsDelegates: GlobalMaterialLocalizations.delegates,
          themeMode: controller.themeMode,
          theme: NuzmTheme.build(Brightness.light, useGoogleFonts: useGoogleFonts),
          darkTheme: NuzmTheme.build(Brightness.dark, useGoogleFonts: useGoogleFonts),
          home: const HomeScreen(),
        ),
      ),
    );
  }
}
