import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../app_scope.dart';
import '../data/data_source.dart';
import '../data/demo.dart';
import '../l10n/strings.dart';
import '../theme/nuzm_colors.dart';

/// The console's window: the chrome gradient (`--nzc-chrome`, dark 180deg / light 98deg) with its glows.
class NzBackground extends StatelessWidget {
  const NzBackground({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    return DecoratedBox(
      decoration: BoxDecoration(gradient: nz.chrome),
      child: Stack(children: [
        for (final g in nz.chromeGlows) Positioned.fill(child: DecoratedBox(decoration: BoxDecoration(gradient: g))),
        child,
      ]),
    );
  }
}

/// The console's layout on a phone: the header sits on the chrome, the content in the frame (`.nzc-frame`:
/// `--nzc-bg` with its glow, 6 px from the window's edges, 22 px top corners, 1 px border, no bottom border).
class NzScaffold extends StatelessWidget {
  const NzScaffold({super.key, required this.header, required this.body});
  final Widget header;
  final Widget body;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    const top = Radius.circular(22);
    return Scaffold(
      backgroundColor: nz.bg,
      body: NzBackground(
        child: SafeArea(
          bottom: false,
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            // Compact top bar (about 54 px with the 38 px buttons), like the console's 64 px bar on a phone.
            Padding(padding: const EdgeInsets.fromLTRB(12, 4, 12, 8), child: header),
            Expanded(
              child: Container(
                margin: const EdgeInsets.symmetric(horizontal: 6),
                clipBehavior: Clip.antiAlias,
                decoration: BoxDecoration(
                  color: nz.bg,
                  borderRadius: const BorderRadius.only(topLeft: top, topRight: top),
                  border: Border(top: BorderSide(color: nz.border), left: BorderSide(color: nz.border), right: BorderSide(color: nz.border)),
                ),
                child: Stack(children: [
                  Positioned.fill(child: IgnorePointer(child: DecoratedBox(decoration: BoxDecoration(gradient: nz.frameGlow)))),
                  SafeArea(top: false, child: body),
                ]),
              ),
            ),
          ]),
        ),
      ),
    );
  }
}

/// Round icon button. On the chrome (headers) it is a translucent disc; inside the frame a bordered card disc.
class CircleIconButton extends StatelessWidget {
  const CircleIconButton({
    super.key,
    required this.icon,
    required this.tooltip,
    this.onTap,
    this.dot = false,
    this.size = 38,
    this.onChrome = true,
  });
  final IconData icon;
  final String tooltip;
  final VoidCallback? onTap;
  final bool dot;
  final double size;
  final bool onChrome;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    return Tooltip(
      message: tooltip,
      child: Semantics(
        button: true,
        label: tooltip,
        child: Material(
          color: onChrome ? nz.chromeButton : nz.card,
          shape: CircleBorder(side: BorderSide(color: onChrome ? nz.chromeFg.withValues(alpha: 0.12) : nz.border)),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onTap,
            child: SizedBox(
              width: size,
              height: size,
              child: Stack(alignment: Alignment.center, children: [
                Icon(icon, size: size * 0.47, color: onChrome ? nz.chromeFg : nz.fg),
                if (dot)
                  PositionedDirectional(
                    top: size * 0.14,
                    end: size * 0.16,
                    child: Container(
                      width: 7,
                      height: 7,
                      decoration: BoxDecoration(gradient: NuzmColors.orangeGradient, shape: BoxShape.circle),
                    ),
                  ),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

/// Count badge (`.nzc-dot`: the orange gradient with dark ink), or the accent fill on tiles.
class CountBadge extends StatelessWidget {
  const CountBadge(this.count, {super.key, this.solidAccent = false});
  final int count;
  final bool solidAccent;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    final fg = solidAccent ? nz.onPrimaryFill : nz.orangeInk;
    // No `alignment` on the Container: that would make it fill the height of the row it sits in.
    return Container(
      constraints: const BoxConstraints(minWidth: 24, minHeight: 24, maxHeight: 24),
      padding: const EdgeInsets.symmetric(horizontal: 6),
      decoration: BoxDecoration(
        color: solidAccent ? nz.primaryFill : null,
        gradient: solidAccent ? null : NuzmColors.orangeGradient,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: nz.bg, width: 2),
      ),
      child: Center(
        widthFactor: 1,
        child: Text('$count', style: TextStyle(color: fg, fontSize: 11.5, fontWeight: FontWeight.w800, height: 1.1)),
      ),
    );
  }
}

/// `.nz-card`: card background (light: the 4 % accent wash), 1 px border, 18 px radius.
class NzCard extends StatelessWidget {
  const NzCard(
      {super.key, required this.child, this.onTap, this.padding = const EdgeInsets.all(16), this.radius = 18, this.color, this.gradient, this.bordered = true});
  final Widget child;
  final bool bordered;
  final VoidCallback? onTap;
  final EdgeInsetsGeometry padding;
  final double radius;
  final Color? color;
  final Gradient? gradient;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    final shape = RoundedRectangleBorder(borderRadius: BorderRadius.circular(radius), side: bordered ? BorderSide(color: nz.border) : BorderSide.none);
    return Material(
      shape: shape,
      color: Colors.transparent,
      clipBehavior: Clip.antiAlias,
      child: Ink(
        decoration: ShapeDecoration(
          shape: shape,
          color: color ?? (gradient == null && nz.cardWash == null ? nz.card : null),
          gradient: color != null ? null : (gradient ?? nz.cardWash),
        ),
        child: InkWell(onTap: onTap, child: Padding(padding: padding, child: child)),
      ),
    );
  }
}

/// Meter (`.nz-bars .nz-bar`): accent-strong → accent, fully rounded.
class NzMeter extends StatelessWidget {
  const NzMeter(this.value, {super.key, this.label, this.height = 8, this.warnAbove = 0.8});
  final double value;
  final String? label;
  final double height;
  final double warnAbove;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    final v = value.clamp(0.0, 1.0);
    return Semantics(
      label: label,
      value: '${(v * 100).round()}%',
      child: Container(
        height: height,
        decoration: BoxDecoration(color: nz.elev, borderRadius: BorderRadius.circular(999)),
        alignment: AlignmentDirectional.centerStart,
        child: FractionallySizedBox(
          widthFactor: v,
          heightFactor: 1,
          child: DecoratedBox(
            decoration: BoxDecoration(
              gradient: v >= warnAbove ? NuzmColors.orangeGradient : nz.meterGradient,
              borderRadius: BorderRadius.circular(999),
            ),
          ),
        ),
      ),
    );
  }
}

/// Rounded-square icon holder (the soft square in the menu tiles).
class IconTile extends StatelessWidget {
  const IconTile(this.icon, {super.key, this.size = 52, this.tone});
  final IconData icon;
  final double size;
  final Tone? tone;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    final (bg, fg) = toneColors(context, tone ?? Tone.neutral, soft: true);
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(color: tone == null ? nz.elev : bg, borderRadius: BorderRadius.circular(size * 0.3)),
      child: Icon(icon, size: size * 0.44, color: tone == null ? nz.accent : fg),
    );
  }
}

(Color, Color) toneColors(BuildContext context, Tone tone, {bool soft = true}) {
  final nz = context.nz;
  final dark = Theme.of(context).brightness == Brightness.dark;
  switch (tone) {
    case Tone.success:
      final c = dark ? const Color(0xFF76D6AC) : const Color(0xFF0C7A52);
      return (c.withValues(alpha: 0.14), c);
    case Tone.warn:
      final c = dark ? const Color(0xFFF0B34A) : const Color(0xFF946000);
      return (c.withValues(alpha: 0.14), c);
    case Tone.danger:
      return (nz.danger.withValues(alpha: 0.13), nz.danger);
    case Tone.accent:
      return (nz.accentSoft, nz.accent);
    case Tone.orange:
      return (nz.orangeSoft, nz.orangeText);
    case Tone.neutral:
      return (nz.elev, nz.muted);
  }
}

class StatusChip extends StatelessWidget {
  const StatusChip(this.status, {super.key});
  final Status status;

  @override
  Widget build(BuildContext context) {
    final (bg, fg) = toneColors(context, status.tone);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(99)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Container(width: 6, height: 6, decoration: BoxDecoration(color: fg, shape: BoxShape.circle)),
        const SizedBox(width: 6),
        Text(status.label.of(context), style: TextStyle(color: fg, fontSize: 12, fontWeight: FontWeight.w700)),
      ]),
    );
  }
}

/// The small "Sample data" chip every data screen carries until the API is connected.
class SampleChip extends StatelessWidget {
  const SampleChip({super.key});

  @override
  Widget build(BuildContext context) {
    if (AppScope.of(context).data.isLive) return const SizedBox.shrink();
    final nz = context.nz;
    return Tooltip(
      message: S.sampleNote.of(context),
      triggerMode: TooltipTriggerMode.tap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        decoration: BoxDecoration(color: nz.orangeSoft, borderRadius: BorderRadius.circular(99)),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(LucideIcons.info, size: 13, color: nz.orangeText),
          const SizedBox(width: 5),
          Text(S.sampleData.of(context), style: TextStyle(color: nz.orangeText, fontSize: 11.5, fontWeight: FontWeight.w700)),
        ]),
      ),
    );
  }
}

/// The Nuzm mark with a soft glow behind it.
class NuzmMark extends StatelessWidget {
  const NuzmMark({super.key, this.size = 120});
  final double size;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    return SizedBox(
      width: size * 1.5,
      height: size * 1.3,
      child: Stack(alignment: Alignment.center, children: [
        Container(
          width: size * 1.3,
          height: size * 1.1,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            gradient: RadialGradient(colors: [nz.accentStrong.withValues(alpha: 0.35), nz.accentStrong.withValues(alpha: 0)]),
          ),
        ),
        _logo(context, Image.asset('assets/brand/nuzm-mark.png', width: size, semanticLabel: S.appName.of(context))),
      ]),
    );
  }
}

/// The mark as the console draws it: darkened on light surfaces (`brightness(0.62) saturate(1.5)`).
Widget _logo(BuildContext context, Widget image) {
  final f = context.nz.logoFilter;
  return f == null ? image : ColorFiltered(colorFilter: f, child: image);
}

/// Public for screens that draw the mark themselves.
Widget brandMark(BuildContext context, {double size = 28}) =>
    _logo(context, Image.asset('assets/brand/nuzm-mark.png', width: size, excludeFromSemantics: true));

/// Text that stays left-to-right inside Arabic (hosts, emails, amounts).
class LtrText extends StatelessWidget {
  const LtrText(this.text, {super.key, this.style, this.maxLines = 1});
  final String text;
  final TextStyle? style;
  final int maxLines;

  @override
  Widget build(BuildContext context) => Text(
        '${String.fromCharCode(0x2066)}$text${String.fromCharCode(0x2069)}',
        style: style,
        maxLines: maxLines,
        overflow: TextOverflow.ellipsis,
      );
}

/// Chevron pointing "forward" in the reading direction.
class ForwardChevron extends StatelessWidget {
  const ForwardChevron({super.key, this.size = 20, this.color});
  final double size;
  final Color? color;

  @override
  Widget build(BuildContext context) =>
      Icon(isAr(context) ? LucideIcons.chevronLeft : LucideIcons.chevronRight, size: size, color: color ?? context.nz.muted);
}

IconData backIcon(BuildContext context) => isAr(context) ? LucideIcons.chevronRight : LucideIcons.chevronLeft;

class StateView extends StatelessWidget {
  const StateView({super.key, required this.icon, required this.title, required this.hint, this.action, this.onAction, this.tone});
  final IconData icon;
  final String title;
  final String hint;
  final String? action;
  final VoidCallback? onAction;
  final Tone? tone;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    // `.nz-state`: a card (18 px, 1 px border) with the message centred.
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: NzCard(
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 40),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        IconTile(icon, size: 64, tone: tone ?? Tone.accent),
        const SizedBox(height: 16),
        Text(title, textAlign: TextAlign.center, style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
        const SizedBox(height: 6),
        Text(hint, textAlign: TextAlign.center, style: TextStyle(color: nz.muted)),
        if (action != null) ...[
          const SizedBox(height: 18),
          FilledButton(
            onPressed: onAction,
            style: FilledButton.styleFrom(minimumSize: const Size(140, 48)),
            child: Text(action!),
          ),
        ],
      ]),
    ));
  }
}

/// Loading placeholder rows.
class SkeletonList extends StatelessWidget {
  const SkeletonList({super.key, this.rows = 4});
  final int rows;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    Widget bar(double w, double h) => Container(width: w, height: h, decoration: BoxDecoration(color: nz.elev, borderRadius: BorderRadius.circular(8)));
    return Semantics(
      label: S.loading.of(context),
      child: Column(children: [
        for (var i = 0; i < rows; i++)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: NzCard(
              child: Row(children: [
                bar(48, 48),
                const SizedBox(width: 14),
                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [bar(160, 14), const SizedBox(height: 8), bar(100, 12)])),
              ]),
            ),
          ),
      ]),
    );
  }
}

void showSoon(BuildContext context) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(S.comingSoon.of(context))));
}

/// Resolves the 'amount:NNN' convention of the sample data into a formatted amount.
/// and the live API's `money:minor:currency` (integer minor units, never floats).
String displayValue(String raw, BuildContext context) {
  if (raw.startsWith('amount:')) return money(int.parse(raw.substring(7)), context);
  if (raw.startsWith('money:')) {
    final parts = raw.split(':');
    return money(int.tryParse(parts[1]) ?? 0, context, currency: parts.length > 2 ? parts[2] : 'SAR');
  }
  return raw;
}


/// AI credits as the console's top-bar balance chip (`.nzc-chip`, 10 px radius): on the chrome, compact.
class CreditChip extends StatelessWidget {
  const CreditChip({super.key, this.onTap});
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    final app = AppScope.of(context);
    return FutureBuilder<Balances>(
      future: app.balances(),
      builder: (context, snap) {
        final credits = snap.data?.credits;
        if (snap.hasData && credits == null) return const SizedBox.shrink();
        final low = snap.data?.lowCredit == true;
        final label = S.aiCredits.of(context);
        return Semantics(
          button: onTap != null,
          label: credits == null ? label : '$label: $credits',
          excludeSemantics: true,
          child: Material(
            color: nz.chromeButton,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(10),
              side: BorderSide(color: low ? nz.orange : nz.chromeFg.withValues(alpha: 0.12)),
            ),
            clipBehavior: Clip.antiAlias,
            child: InkWell(
              onTap: onTap,
              child: SizedBox(
                height: 38,
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    Icon(LucideIcons.sparkles, size: 15, color: low ? nz.orangeText : nz.chromeFg),
                    const SizedBox(width: 6),
                    credits == null
                        ? SizedBox(width: 12, height: 12, child: CircularProgressIndicator(strokeWidth: 1.6, color: nz.chromeFg))
                        : LtrText(groupDigits(credits), style: TextStyle(color: nz.chromeFg, fontWeight: FontWeight.w700, fontSize: 13.5)),
                  ]),
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}

/// 7420 → "7,420".
String groupDigits(int n) => n.toString().replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (_) => ',');
