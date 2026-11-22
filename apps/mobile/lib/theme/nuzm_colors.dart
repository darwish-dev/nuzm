import 'package:flutter/material.dart';

/// Nuzm identity tokens. Same values as the customer console (`packages/ui/src/console-css.ts`, `--nzc-*`):
/// mint / teal-sage is the main colour, orange is the second colour used in small touches (badges, one highlight).
@immutable
class NuzmColors extends ThemeExtension<NuzmColors> {
  const NuzmColors({
    required this.bg,
    required this.card,
    required this.cardHi,
    required this.elev,
    required this.border,
    required this.fg,
    required this.muted,
    required this.accent,
    required this.accentStrong,
    required this.accentSoft,
    required this.onAccent,
    required this.primaryFill,
    required this.onPrimaryFill,
    required this.orange,
    required this.orangeText,
    required this.orangeInk,
    required this.orangeSoft,
    required this.danger,
    required this.glowTop,
    required this.glowBottom,
  });

  final Color bg;
  final Color card;
  final Color cardHi;
  final Color elev;
  final Color border;
  final Color fg;
  final Color muted;
  final Color accent;
  final Color accentStrong;
  final Color accentSoft;
  final Color onAccent;

  /// Solid fill of the main action (mic / send button).
  final Color primaryFill;
  final Color onPrimaryFill;
  final Color orange;

  /// Orange for text and thin icons (deeper on white for contrast).
  final Color orangeText;
  final Color orangeInk;
  final Color orangeSoft;
  final Color danger;

  /// Soft page glows (mint at the top, a faint orange at the bottom).
  final Color glowTop;
  final Color glowBottom;

  /// Brand gradient (mint → teal-sage), the console's `--nzc-grad`.
  static const LinearGradient brandGradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [Color(0xFFCFE8DA), Color(0xFF93B6B3)],
  );

  static const NuzmColors dark = NuzmColors(
    bg: Color(0xFF0B0B0C),
    card: Color(0xFF161618),
    cardHi: Color(0xFF1B1B1E),
    elev: Color(0xFF1F1F23),
    border: Color(0xFF27272C),
    fg: Color(0xFFF4F0E8),
    muted: Color(0xFFA0A6A5),
    accent: Color(0xFFBCDCCB),
    accentStrong: Color(0xFF93B6B3),
    accentSoft: Color(0x21BCDCCB),
    onAccent: Color(0xFF14181B),
    primaryFill: Color(0xFFBCDCCB),
    onPrimaryFill: Color(0xFF14181B),
    orange: Color(0xFFE9A16D),
    orangeText: Color(0xFFE9A16D),
    orangeInk: Color(0xFF2A1A0E),
    orangeSoft: Color(0x29E9A16D),
    danger: Color(0xFFF2766F),
    glowTop: Color(0x2E93B6B3),
    glowBottom: Color(0x14E9A16D),
  );

  static const NuzmColors light = NuzmColors(
    bg: Color(0xFFF4F4F5),
    card: Color(0xFFFFFFFF),
    cardHi: Color(0xFFF1F1F3),
    elev: Color(0xFFECEFEE),
    border: Color(0xFFDCDCE1),
    fg: Color(0xFF17181A),
    muted: Color(0xFF5B5F63),
    accent: Color(0xFF2C6A5F),
    accentStrong: Color(0xFF2C6A5F),
    accentSoft: Color(0x1A2C6A5F),
    onAccent: Color(0xFF14181B),
    primaryFill: Color(0xFF2C6A5F),
    onPrimaryFill: Color(0xFFFFFFFF),
    orange: Color(0xFFE9A16D),
    orangeText: Color(0xFFA1521F),
    orangeInk: Color(0xFF2A1A0E),
    orangeSoft: Color(0x33E9A16D),
    danger: Color(0xFFB42D26),
    glowTop: Color(0x66BCDCCB),
    glowBottom: Color(0x26E9A16D),
  );

  @override
  NuzmColors copyWith() => this;

  @override
  NuzmColors lerp(ThemeExtension<NuzmColors>? other, double t) {
    if (other is! NuzmColors) return this;
    Color l(Color a, Color b) => Color.lerp(a, b, t)!;
    return NuzmColors(
      bg: l(bg, other.bg),
      card: l(card, other.card),
      cardHi: l(cardHi, other.cardHi),
      elev: l(elev, other.elev),
      border: l(border, other.border),
      fg: l(fg, other.fg),
      muted: l(muted, other.muted),
      accent: l(accent, other.accent),
      accentStrong: l(accentStrong, other.accentStrong),
      accentSoft: l(accentSoft, other.accentSoft),
      onAccent: l(onAccent, other.onAccent),
      primaryFill: l(primaryFill, other.primaryFill),
      onPrimaryFill: l(onPrimaryFill, other.onPrimaryFill),
      orange: l(orange, other.orange),
      orangeText: l(orangeText, other.orangeText),
      orangeInk: l(orangeInk, other.orangeInk),
      orangeSoft: l(orangeSoft, other.orangeSoft),
      danger: l(danger, other.danger),
      glowTop: l(glowTop, other.glowTop),
      glowBottom: l(glowBottom, other.glowBottom),
    );
  }
}

extension NuzmColorsX on BuildContext {
  NuzmColors get nz => Theme.of(this).extension<NuzmColors>()!;
}
