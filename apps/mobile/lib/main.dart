import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'api/api_client.dart';
import 'api/config.dart';
import 'api/session_store.dart';
import 'app_scope.dart';
import 'screens/home_screen.dart';
import 'screens/onboarding_screen.dart';
import 'screens/sign_in_screen.dart';
import 'theme/nuzm_theme.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final controller = liveApiSupported
      ? AppController.live(ApiClient(baseUrl: apiBaseUrl(), store: SecureSessionStore()))
      // The web build has no live mode (see liveApiSupported): it opens on the sample data, or on one of the
      // signed-out screens for a design preview (`?screen=onboarding|signin|register`).
      : _webPreview(Uri.base.queryParameters['screen']);
  if (liveApiSupported) controller.start();
  runApp(NuzmApp(controller: controller));
}

AppController _webPreview(String? screen) => switch (screen) {
      'onboarding' => AppController(phase: AppPhase.onboarding),
      'signin' => AppController(phase: AppPhase.signedOut),
      'register' => AppController(phase: AppPhase.signedOut)..startOnRegister = true,
      _ => AppController(),
    };

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
          title: 'NUZM AI',
          debugShowCheckedModeBanner: false,
          locale: controller.locale,
          supportedLocales: const [Locale('ar'), Locale('en')],
          localizationsDelegates: GlobalMaterialLocalizations.delegates,
          themeMode: controller.themeMode,
          theme: NuzmTheme.build(Brightness.light, useGoogleFonts: useGoogleFonts),
          darkTheme: NuzmTheme.build(Brightness.dark, useGoogleFonts: useGoogleFonts),
          home: switch (controller.phase) {
            AppPhase.starting => const SplashScreen(),
            AppPhase.onboarding => const OnboardingScreen(),
            AppPhase.signedOut => const AuthScreen(),
            AppPhase.needsOrg => const CreateOrgScreen(),
            // Keyed by organization and mode so switching either starts fresh screens.
            AppPhase.ready => HomeScreen(key: ValueKey('${controller.data.isLive}:${controller.organization?.orgId}')),
          },
        ),
      ),
    );
  }
}
