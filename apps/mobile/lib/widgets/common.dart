import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../data/demo.dart';
import '../l10n/strings.dart';
import '../theme/nuzm_colors.dart';

/// Page background: the theme colour with a soft mint glow at the top and a faint orange one at the bottom.
class NzBackground extends StatelessWidget {
  const NzBackground({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    return DecoratedBox(
      decoration: BoxDecoration(color: nz.bg),
      child: Stack(children: [
        Positioned.fill(
          child: DecoratedBox(
            decoration: BoxDecoration(
              gradient: RadialGradient(
                center: const Alignment(0.9, -1.1),
                radius: 1.25,
                colors: [nz.glowTop, nz.glowTop.withValues(alpha: 0)],
              ),
            ),
          ),
        ),
        Positioned.fill(
          child: DecoratedBox(
            decoration: BoxDecoration(
              gradient: RadialGradient(
                center: const Alignment(-1, 1.2),
                radius: 1.1,
                colors: [nz.glowBottom, nz.glowBottom.withValues(alpha: 0)],
              ),
            ),
          ),
        ),
        child,
      ]),
    );
  }
}

/// Round icon button (56 px) used in every top bar.
class CircleIconButton extends StatelessWidget {
  const CircleIconButton({super.key, required this.icon, required this.tooltip, this.onTap, this.dot = false, this.size = 56});
  final IconData icon;
  final String tooltip;
  final VoidCallback? onTap;
  final bool dot;
  final double size;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    return Tooltip(
      message: tooltip,
      child: Semantics(
        button: true,
        label: tooltip,
        child: Material(
          color: nz.card,
          shape: const CircleBorder(),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onTap,
            child: SizedBox(
              width: size,
              height: size,
              child: Stack(alignment: Alignment.center, children: [
                Icon(icon, size: 24, color: nz.fg),
                if (dot)
                  PositionedDirectional(
                    top: size * 0.14,
                    end: size * 0.18,
                    child: Container(width: 9, height: 9, decoration: BoxDecoration(color: nz.orange, shape: BoxShape.circle)),
                  ),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

/// Count badge (orange: the identity's second colour).
class CountBadge extends StatelessWidget {
  const CountBadge(this.count, {super.key, this.solidAccent = false});
  final int count;
  final bool solidAccent;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    final bg = solidAccent ? nz.primaryFill : nz.orange;
    final fg = solidAccent ? nz.onPrimaryFill : nz.orangeInk;
    return Container(
      constraints: const BoxConstraints(minWidth: 26, minHeight: 26),
      padding: const EdgeInsets.symmetric(horizontal: 6),
      alignment: Alignment.center,
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(13), border: Border.all(color: nz.bg, width: 2)),
      child: Text('$count', style: TextStyle(color: fg, fontSize: 12.5, fontWeight: FontWeight.w800)),
    );
  }
}

/// White / dark card with large radius and no outline.
class NzCard extends StatelessWidget {
  const NzCard({super.key, required this.child, this.onTap, this.padding = const EdgeInsets.all(16), this.radius = 26, this.color});
  final Widget child;
  final VoidCallback? onTap;
  final EdgeInsetsGeometry padding;
  final double radius;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    return Material(
      color: color ?? nz.card,
      borderRadius: BorderRadius.circular(radius),
      clipBehavior: Clip.antiAlias,
      child: InkWell(onTap: onTap, child: Padding(padding: padding, child: child)),
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
      child: Icon(icon, size: size * 0.44, color: tone == null ? nz.fg : fg),
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
        Image.asset('assets/brand/nuzm-mark.png', width: size, semanticLabel: S.appName.of(context)),
      ]),
    );
  }
}

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
  const ForwardChevron({super.key, this.size = 20});
  final double size;

  @override
  Widget build(BuildContext context) =>
      Icon(isAr(context) ? LucideIcons.chevronLeft : LucideIcons.chevronRight, size: size, color: context.nz.muted);
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
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 48),
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
            style: FilledButton.styleFrom(minimumSize: const Size(140, 48), shape: const StadiumBorder()),
            child: Text(action!),
          ),
        ],
      ]),
    );
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
String displayValue(String raw, BuildContext context) =>
    raw.startsWith('amount:') ? money(int.parse(raw.substring(7)), context) : raw;
