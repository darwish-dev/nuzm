import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'api/api_client.dart';
import 'api/config.dart';
import 'api/session_store.dart';
import 'app_scope.dart';
import 'screens/home_screen.dart';
import 'screens/sign_in_screen.dart';
import 'theme/nuzm_theme.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final controller = liveApiSupported
      ? AppController.live(ApiClient(baseUrl: apiBaseUrl(), store: SecureSessionStore()))
      // The web build has no live mode (see liveApiSupported): it opens straight on the sample data.
      : AppController();
  if (liveApiSupported) controller.start();
  runApp(NuzmApp(controller: controller));
}

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
            AppPhase.signedOut => const SignInScreen(),
            AppPhase.needsOrg => const CreateOrgScreen(),
            // Keyed by organization and mode so switching either starts fresh screens.
            AppPhase.ready => HomeScreen(key: ValueKey('${controller.data.isLive}:${controller.organization?.orgId}')),
          },
        ),
      ),
    );
  }
}
