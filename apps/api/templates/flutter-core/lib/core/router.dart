import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../generated/app_spec.dart';
import '../ui/screens/form_screen.dart';
import '../ui/screens/info_screen.dart';
import '../ui/screens/list_screen.dart';
import '../ui/screens/login_screen.dart';
import '../ui/screens/settings_screen.dart';
import '../ui/shell.dart';
import 'auth.dart';
import 'models.dart';

Widget _screenFor(ScreenDef def) {
  switch (def.kind) {
    case ScreenKind.home:
    case ScreenKind.detail:
      return InfoScreen(def: def);
    case ScreenKind.list:
      return ListScreen(def: def);
    case ScreenKind.form:
      return FormScreen(def: def);
    case ScreenKind.settings:
      return const SettingsScreen();
  }
}

final routerProvider = Provider<GoRouter>((ref) {
  final refresh = ValueNotifier<int>(0);
  ref.listen<AuthStatus>(authProvider, (_, _) => refresh.value++);
  ref.onDispose(refresh.dispose);

  String? redirect(BuildContext context, GoRouterState state) {
    if (!kAuthEnabled) {
      return state.uri.path == '/login' ? kInitialRoute : null;
    }
    final status = ref.read(authProvider);
    if (status == AuthStatus.unknown) {
      return null;
    }
    final onLogin = state.uri.path == '/login';
    if (status == AuthStatus.signedOut && !onLogin) {
      return '/login';
    }
    if (status == AuthStatus.signedIn && onLogin) {
      return kInitialRoute;
    }
    return null;
  }

  final tabScreens = [for (final s in kScreens) if (kTabs.contains(s.id)) s];
  final otherScreens = [for (final s in kScreens) if (!kTabs.contains(s.id)) s];

  return GoRouter(
    initialLocation: kAuthEnabled ? '/login' : kInitialRoute,
    refreshListenable: refresh,
    redirect: redirect,
    routes: [
      GoRoute(path: '/login', builder: (context, state) => const LoginScreen()),
      ShellRoute(
        builder: (context, state, child) =>
            AppShell(location: state.uri.path, child: child),
        routes: [
          for (final s in tabScreens)
            GoRoute(
              path: '/${s.id}',
              pageBuilder: (context, state) =>
                  NoTransitionPage(child: _screenFor(s)),
            ),
        ],
      ),
      for (final s in otherScreens)
        GoRoute(path: '/${s.id}', builder: (context, state) => _screenFor(s)),
    ],
  );
});
