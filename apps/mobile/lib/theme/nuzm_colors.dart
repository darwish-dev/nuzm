import 'dart:math' as math;

import 'package:flutter/material.dart';

/// A CSS `linear-gradient(<deg>deg, ...)` in Flutter: CSS measures the angle clockwise from "to top", so 180deg runs
/// top → bottom and 90deg left → right. The angle is not mirrored in RTL (CSS does not mirror it either).
LinearGradient cssLinear(double deg, List<Color> colors, [List<double>? stops]) => LinearGradient(
      begin: Alignment.centerLeft,
      end: Alignment.centerRight,
      colors: colors,
      stops: stops,
      transform: GradientRotation((deg - 90) * math.pi / 180),
    );

/// Nuzm identity tokens: the customer console's design system (`packages/ui/src/console-css.ts`, `--nzc-*`),
/// value for value and gradient angle for gradient angle. Teal/mint is the main colour; orange the second colour
/// (primary buttons, badges, small touches).
@immutable
class NuzmColors extends ThemeExtension<NuzmColors> {
  const NuzmColors({
    required this.chrome,
    required this.chromeGlows,
    required this.bg,
    required this.frameGlow,
    required this.card,
    required this.cardHi,
    required this.cardWash,
    required this.elev,
    required this.border,
    required this.field,
    required this.fieldBorder,
    required this.fg,
    required this.muted,
    required this.accent,
    required this.accentStrong,
    required this.accentSoft,
    required this.onAccent,
    required this.primaryFill,
    required this.onPrimaryFill,
    required this.orange,
    required this.orangeStrong,
    required this.orangeText,
    required this.orangeInk,
    required this.orangeSoft,
    required this.success,
    required this.warn,
    required this.danger,
    required this.shadow,
    required this.chromeFg,
    required this.chromeButton,
    required this.chromeButtonFg,
    required this.logoFilter,
  });

  /// `--nzc-chrome`: the window behind the frame (top bar and the 6 px edges).
  final LinearGradient chrome;

  /// `--nzc-chrome-glow`: radial glows over the chrome.
  final List<RadialGradient> chromeGlows;

  /// `--nzc-bg`: the frame's surface.
  final Color bg;

  /// `--nzc-glow`: the frame's faint accent glow (top end).
  final RadialGradient frameGlow;

  final Color card;
  final Color cardHi;

  /// `--nzc-card-bg` in the light theme: a 4 % accent wash at 180deg (null in dark: plain card).
  final LinearGradient? cardWash;
  final Color elev;
  final Color border;
  final Color field;
  final Color fieldBorder;
  final Color fg;
  final Color muted;
  final Color accent;
  final Color accentStrong;
  final Color accentSoft;
  final Color onAccent;

  /// Solid accent fill (selected chips, counts on tiles, the user's chat bubble).
  final Color primaryFill;
  final Color onPrimaryFill;
  final Color orange;
  final Color orangeStrong;

  /// Orange for text and thin icons (deeper on white for contrast, 5.6:1).
  final Color orangeText;
  final Color orangeInk;
  final Color orangeSoft;
  final Color success;
  final Color warn;
  final Color danger;
  final Color shadow;

  /// Text and icons drawn directly on the chrome.
  final Color chromeFg;
  /// Top-bar buttons and the credit chip: a dark, borderless disc in both themes.
  final Color chromeButton;
  final Color chromeButtonFg;

  /// The console darkens the mint logo on light surfaces (`brightness(0.62) saturate(1.5)`).
  final ColorFilter? logoFilter;

  /// `--nzc-grad` (165deg): mint → teal-sage, the brand square.
  static final LinearGradient brandGradient = cssLinear(165, const [Color(0xFFCFE8DA), Color(0xFF93B6B3)]);

  /// `--nzc-orange-grad` (165deg): primary buttons, counts.
  static final LinearGradient orangeGradient = cssLinear(165, const [Color(0xFFF2B98C), Color(0xFFE9A16D)]);

  /// Meter fill (`.nz-bars`): accent-strong → accent at 90deg.
  LinearGradient get meterGradient => cssLinear(90, [accentStrong, accent]);

  /// `.nzc-hero`: an accent glow at the top end over a 135deg accent wash.
  List<Gradient> get heroLayers => [
        RadialGradient(
          center: const Alignment(1, -1),
          radius: 1.1,
          colors: [Color.alphaBlend(accent.withValues(alpha: 0.18), Colors.transparent), accent.withValues(alpha: 0)],
          stops: const [0, 0.7],
        ),
        cssLinear(135, [Color.lerp(card, accentStrong, 0.12)!, card], const [0, 0.65]),
      ];

  static final NuzmColors dark = NuzmColors(
    chrome: cssLinear(180, const [
      Color(0xFF202429),
      Color(0xFF262C33),
      Color(0xFF34434D),
      Color(0xFF587079),
      Color(0xFF93B6B3),
      Color(0xFFBCDCCB),
    ], const [0, .22, .48, .72, .90, 1]),
    chromeGlows: const [
      RadialGradient(center: Alignment(0.76, -1.15), radius: 1.6, colors: [Color(0x29BCDCCB), Color(0x00BCDCCB)], stops: [0, 0.7]),
    ],
    bg: const Color(0xFF0B0B0C),
    frameGlow: const RadialGradient(center: Alignment(0.76, -1.2), radius: 1.6, colors: [Color(0x0D93B6B3), Color(0x0093B6B3)], stops: [0, 0.7]),
    card: const Color(0xFF161618),
    cardHi: const Color(0xFF1B1B1E),
    cardWash: null,
    elev: const Color(0xFF1F1F23),
    border: const Color(0xFF27272C),
    field: const Color(0xFF0F0F11),
    fieldBorder: const Color(0xFF323238),
    fg: const Color(0xFFF4F0E8),
    muted: const Color(0xFFA0A6A5),
    accent: const Color(0xFFBCDCCB),
    accentStrong: const Color(0xFF93B6B3),
    accentSoft: const Color(0x21BCDCCB),
    onAccent: const Color(0xFF14181B),
    primaryFill: const Color(0xFFBCDCCB),
    onPrimaryFill: const Color(0xFF14181B),
    orange: const Color(0xFFE9A16D),
    orangeStrong: const Color(0xFFC9784A),
    orangeText: const Color(0xFFE9A16D),
    orangeInk: const Color(0xFF2A1A0E),
    orangeSoft: const Color(0x29E9A16D),
    success: const Color(0xFF76D6AC),
    warn: const Color(0xFFF0B34A),
    danger: const Color(0xFFF2766F),
    shadow: const Color(0x80000000),
    chromeFg: const Color(0xFFF4F0E8),
    chromeButton: const Color(0xD90D0E10),
    chromeButtonFg: const Color(0xFFF4F0E8),
    logoFilter: null,
  );

  static final NuzmColors light = NuzmColors(
    chrome: cssLinear(98, const [Color(0xFF8FB2AF), Color(0xFFA9CBC1), Color(0xFFBCDCCB), Color(0xFFD3EBDD)], const [0, .34, .62, 1]),
    chromeGlows: const [
      RadialGradient(center: Alignment(-0.8, -1.25), radius: 1.5, colors: [Color(0x57587079), Color(0x00587079)], stops: [0, 0.7]),
      RadialGradient(center: Alignment(0.84, -1.15), radius: 1.5, colors: [Color(0x80FFFFFF), Color(0x00FFFFFF)], stops: [0, 0.7]),
    ],
    bg: const Color(0xFFF4F4F5),
    frameGlow: const RadialGradient(center: Alignment(0.76, -1.2), radius: 1.6, colors: [Color(0x0F2C6A5F), Color(0x002C6A5F)], stops: [0, 0.7]),
    card: const Color(0xFFFFFFFF),
    cardHi: const Color(0xFFF1F1F3),
    // color-mix(in srgb, #2c6a5f 4%, #fff) → #fff at 70%
    cardWash: cssLinear(180, const [Color(0xFFF7FAF9), Color(0xFFFFFFFF)], const [0, 0.7]),
    elev: const Color(0xFFECECEF),
    border: const Color(0xFFDCDCE1),
    field: const Color(0xFFFBFBFC),
    fieldBorder: const Color(0xFFCFCFD6),
    fg: const Color(0xFF17181A),
    muted: const Color(0xFF5B5F63),
    accent: const Color(0xFF2C6A5F),
    accentStrong: const Color(0xFF2C6A5F),
    accentSoft: const Color(0x1A2C6A5F),
    onAccent: const Color(0xFF14181B),
    primaryFill: const Color(0xFF2C6A5F),
    onPrimaryFill: const Color(0xFFFFFFFF),
    orange: const Color(0xFFE9A16D),
    orangeStrong: const Color(0xFFC9784A),
    orangeText: const Color(0xFFA1521F),
    orangeInk: const Color(0xFF2A1A0E),
    orangeSoft: const Color(0x33E9A16D),
    success: const Color(0xFF0C7A52),
    warn: const Color(0xFF946000),
    danger: const Color(0xFFB42D26),
    shadow: const Color(0x1F141428),
    chromeFg: const Color(0xFF17181A),
    chromeButton: const Color(0xF0181A1D),
    chromeButtonFg: const Color(0xFFF4F0E8),
    logoFilter: _brightnessSaturate(0.62, 1.5),
  );

  /// CSS `brightness(b) saturate(s)` as a colour matrix.
  static ColorFilter _brightnessSaturate(double b, double s) {
    const lr = 0.2126, lg = 0.7152, lb = 0.0722;
    List<double> row(double r, double g, double bl) => [r * b, g * b, bl * b, 0, 0];
    return ColorFilter.matrix([
      ...row(lr + (1 - lr) * s, lg - lg * s, lb - lb * s),
      ...row(lr - lr * s, lg + (1 - lg) * s, lb - lb * s),
      ...row(lr - lr * s, lg - lg * s, lb + (1 - lb) * s),
      0, 0, 0, 1, 0,
    ]);
  }

  @override
  NuzmColors copyWith() => this;

  /// Theme switches are instant (the console swaps palettes the same way), so no interpolation.
  @override
  NuzmColors lerp(ThemeExtension<NuzmColors>? other, double t) => (other is NuzmColors && t >= 0.5) ? other : this;
}

extension NuzmColorsX on BuildContext {
  NuzmColors get nz => Theme.of(this).extension<NuzmColors>()!;
}
