import 'package:flutter/material.dart';

import 'nuzm_colors.dart';

/// Builds the light or dark theme from the identity tokens. Cairo (the console's font, bundled in assets/fonts) covers
/// Arabic and Latin; `useGoogleFonts: false` keeps the platform font (tests).
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
      fontFamily: useGoogleFonts ? 'Cairo' : null,
      brightness: brightness,
      colorScheme: scheme,
      scaffoldBackgroundColor: nz.bg,
      extensions: [nz],
    );
    final text = base.textTheme.apply(bodyColor: nz.fg, displayColor: nz.fg);
    const r10 = RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(10)));
    OutlineInputBorder field(Color c, [double w = 1]) =>
        OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide(color: c, width: w));
    return base.copyWith(
      textTheme: text,
      iconTheme: IconThemeData(color: nz.fg, size: 22),
      // `.nz-btn`: the orange gradient (165deg) with dark ink, 10 px radius, weight 650.
      filledButtonTheme: FilledButtonThemeData(
        style: ButtonStyle(
          minimumSize: const WidgetStatePropertyAll(Size(64, 44)),
          padding: const WidgetStatePropertyAll(EdgeInsets.symmetric(horizontal: 18)),
          shape: const WidgetStatePropertyAll(r10),
          foregroundColor: WidgetStateProperty.resolveWith(
              (s) => s.contains(WidgetState.disabled) ? nz.orangeInk.withValues(alpha: 0.5) : nz.orangeInk),
          iconColor: WidgetStatePropertyAll(nz.orangeInk),
          backgroundColor: const WidgetStatePropertyAll(Colors.transparent),
          overlayColor: WidgetStatePropertyAll(nz.orangeInk.withValues(alpha: 0.08)),
          textStyle: const WidgetStatePropertyAll(TextStyle(fontWeight: FontWeight.w700, fontFamily: null)),
          backgroundBuilder: (context, states, child) => Opacity(
            opacity: states.contains(WidgetState.disabled) ? 0.55 : 1,
            child: DecoratedBox(decoration: BoxDecoration(gradient: NuzmColors.orangeGradient, borderRadius: BorderRadius.circular(10)), child: child),
          ),
        ),
      ),
      // `.nz-btn[data-variant=secondary]`: elevated surface, border, foreground text.
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          minimumSize: const Size(64, 44),
          shape: r10,
          backgroundColor: nz.elev,
          foregroundColor: nz.fg,
          side: BorderSide(color: nz.border),
          textStyle: const TextStyle(fontWeight: FontWeight.w700),
        ),
      ),
      textButtonTheme: TextButtonThemeData(style: TextButton.styleFrom(foregroundColor: nz.accent, shape: r10, minimumSize: const Size(44, 44))),
      // Fields: `--nzc-field`, `--nzc-field-border`, 14 px radius, accent focus ring.
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: nz.field,
        hintStyle: TextStyle(color: nz.muted),
        labelStyle: TextStyle(color: nz.muted),
        floatingLabelStyle: TextStyle(color: nz.accent),
        helperStyle: TextStyle(color: nz.muted),
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
        border: field(nz.fieldBorder),
        enabledBorder: field(nz.fieldBorder),
        focusedBorder: field(nz.accent, 2),
        errorBorder: field(nz.danger),
      ),
      // `.nzc-switch`: accent track when on, white knob.
      switchTheme: SwitchThemeData(
        thumbColor: const WidgetStatePropertyAll(Colors.white),
        trackColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? nz.accent : nz.border),
        trackOutlineColor: const WidgetStatePropertyAll(Colors.transparent),
      ),
      progressIndicatorTheme: ProgressIndicatorThemeData(color: nz.accentStrong, linearTrackColor: nz.elev),
      dividerTheme: DividerThemeData(color: nz.border, thickness: 1, space: 1),
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: nz.elev,
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      ),
      tooltipTheme: TooltipThemeData(
        decoration: BoxDecoration(color: nz.elev, borderRadius: BorderRadius.circular(8), border: Border.all(color: nz.border)),
        textStyle: TextStyle(color: nz.fg, fontSize: 12.5),
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: nz.elev,
        contentTextStyle: TextStyle(color: nz.fg, fontWeight: FontWeight.w600),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12), side: BorderSide(color: nz.border)),
      ),
      textSelectionTheme: TextSelectionThemeData(cursorColor: nz.accentStrong),
    );
  }
}
