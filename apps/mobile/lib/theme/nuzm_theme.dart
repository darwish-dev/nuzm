import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

import 'nuzm_colors.dart';

/// Builds the light or dark theme from the identity tokens. Cairo (the console's font) covers Arabic and Latin;
/// tests pass `useGoogleFonts: false` so they never reach the network.
class NuzmTheme {
  static ThemeData build(Brightness brightness, {bool useGoogleFonts = true}) {
    final nz = brightness == Brightness.dark ? NuzmColors.dark : NuzmColors.light;
    final scheme = ColorScheme.fromSeed(
      seedColor: const Color(0xFF93B6B3),
      brightness: brightness,
    ).copyWith(
      primary: nz.primaryFill,
      onPrimary: nz.onPrimaryFill,
      secondary: nz.orange,
      onSecondary: nz.orangeInk,
      surface: nz.card,
      onSurface: nz.fg,
      onSurfaceVariant: nz.muted,
      error: nz.danger,
      outline: nz.border,
    );
    final base = ThemeData(
      useMaterial3: true,
      brightness: brightness,
      colorScheme: scheme,
      scaffoldBackgroundColor: nz.bg,
      splashFactory: InkSparkle.splashFactory,
      extensions: [nz],
    );
    final text = base.textTheme.apply(bodyColor: nz.fg, displayColor: nz.fg);
    return base.copyWith(
      textTheme: useGoogleFonts ? GoogleFonts.cairoTextTheme(text) : text,
      iconTheme: IconThemeData(color: nz.fg, size: 22),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: nz.fg,
        contentTextStyle: TextStyle(color: nz.bg, fontWeight: FontWeight.w600),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      ),
      textSelectionTheme: TextSelectionThemeData(cursorColor: nz.accentStrong),
    );
  }
}
