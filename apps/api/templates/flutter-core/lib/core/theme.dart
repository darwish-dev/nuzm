import 'package:flutter/material.dart';

import '../generated/app_spec.dart';

/// Material 3 theme from the app's seed colours. Text scales with the system setting (no fixed sizes below the Material defaults).
ThemeData buildTheme(Brightness brightness) {
  final scheme = ColorScheme.fromSeed(
    seedColor: kPrimary,
    secondary: kSecondary,
    brightness: brightness,
  );
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    inputDecorationTheme: const InputDecorationTheme(
      border: OutlineInputBorder(),
    ),
    visualDensity: VisualDensity.standard,
  );
}
