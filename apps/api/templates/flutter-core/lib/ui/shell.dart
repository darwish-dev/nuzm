import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../core/models.dart';
import '../generated/app_spec.dart';

IconData _iconFor(ScreenKind kind) {
  switch (kind) {
    case ScreenKind.home:
      return Icons.home_outlined;
    case ScreenKind.list:
      return Icons.list_alt_outlined;
    case ScreenKind.form:
      return Icons.edit_note_outlined;
    case ScreenKind.detail:
      return Icons.article_outlined;
    case ScreenKind.settings:
      return Icons.settings_outlined;
  }
}

/// Bottom navigation over the tab screens. Screens that are not tabs are reached by route.
class AppShell extends StatelessWidget {
  const AppShell({super.key, required this.location, required this.child});

  final String location;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final tabs = [for (final s in kScreens) if (kTabs.contains(s.id)) s];
    var index = tabs.indexWhere((s) => location == '/${s.id}');
    if (index < 0) {
      index = 0;
    }
    return Scaffold(
      body: SafeArea(child: child),
      bottomNavigationBar: tabs.length < 2
          ? null
          : NavigationBar(
              selectedIndex: index,
              onDestinationSelected: (i) => context.go('/${tabs[i].id}'),
              destinations: [
                for (final s in tabs)
                  NavigationDestination(
                    icon: Icon(_iconFor(s.kind)),
                    label: s.title.of(context),
                    tooltip: s.title.of(context),
                  ),
              ],
            ),
    );
  }
}
