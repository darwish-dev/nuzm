import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../app_scope.dart';
import '../l10n/strings.dart';
import '../theme/nuzm_colors.dart';
import '../widgets/common.dart';
import '../widgets/nz_icons.dart';

const _fg = Color(0xFFF4F0E8);
const _muted = Color(0xFFB9C2C0);
const _ink = Color(0xFF15302A);

/// First launch: what NUZM AI does in three slides on the brand surface (the console's dark chrome with its mint
/// and orange glows), each with a floating orb and the things it covers, then "Create an account" or "Sign in".
/// Shown once per device ([AppController.finishOnboarding]).
class OnboardingScreen extends StatefulWidget {
  const OnboardingScreen({super.key});

  @override
  State<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends State<OnboardingScreen> with TickerProviderStateMixin {
  final _pager = PageController();
  late final _float = AnimationController(vsync: this, duration: const Duration(milliseconds: 3600))..repeat(reverse: true);
  late final _spin = AnimationController(vsync: this, duration: const Duration(seconds: 14))..repeat();
  int _page = 0;

  static const _icons = [NzIcons.sparkles, NzIcons.cloud, NzIcons.wallet];

  @override
  void dispose() {
    _pager.dispose();
    _float.dispose();
    _spin.dispose();
    super.dispose();
  }

  bool get _last => _page == S.onbPages.length - 1;

  void _next() => _pager.nextPage(duration: const Duration(milliseconds: 420), curve: Curves.easeOutCubic);

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final panel = NuzmColors.dark;
    final reduce = MediaQuery.of(context).disableAnimations;
    return Scaffold(
      backgroundColor: panel.bg,
      body: Stack(children: [
        // The brand surface: near-black with a mint glow behind the orb and a warm one low on the start side.
        Positioned.fill(child: DecoratedBox(decoration: BoxDecoration(color: panel.bg))),
        Positioned.fill(
          child: AnimatedBuilder(
            animation: _pager,
            builder: (context, _) {
              final p = _pager.hasClients && _pager.position.haveDimensions ? (_pager.page ?? 0) : 0.0;
              return DecoratedBox(
                decoration: BoxDecoration(
                  gradient: RadialGradient(
                    // The glow drifts a little with the slides.
                    center: Alignment(math.sin(p * 1.4) * 0.35, -0.38),
                    radius: 0.85,
                    colors: [panel.accent.withValues(alpha: 0.26), panel.accent.withValues(alpha: 0.06), panel.accent.withValues(alpha: 0)],
                    stops: const [0, 0.5, 1],
                  ),
                ),
              );
            },
          ),
        ),
        Positioned.fill(
          child: DecoratedBox(
            decoration: BoxDecoration(
              gradient: RadialGradient(
                center: AlignmentDirectional(-1, 1).resolve(Directionality.of(context)),
                radius: 0.9,
                colors: [panel.orange.withValues(alpha: 0.16), panel.orange.withValues(alpha: 0)],
              ),
            ),
          ),
        ),
        SafeArea(
          child: Column(children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 8, 0),
              child: Row(children: [
                brandMark(context, size: 24),
                const SizedBox(width: 8),
                const Expanded(
                  child: Text('NUZM AI',
                      maxLines: 1,
                      overflow: TextOverflow.fade,
                      softWrap: false,
                      style: TextStyle(color: _fg, fontSize: 14, fontWeight: FontWeight.w800, letterSpacing: 0.6)),
                ),
                TextButton(
                  onPressed: app.toggleLocale,
                  child: Text(app.isArabic ? 'English' : 'العربية', style: const TextStyle(color: _fg, fontWeight: FontWeight.w700)),
                ),
                AnimatedOpacity(
                  opacity: _last ? 0 : 1,
                  duration: const Duration(milliseconds: 200),
                  child: TextButton(
                    onPressed: _last ? null : () => _pager.animateToPage(S.onbPages.length - 1, duration: const Duration(milliseconds: 500), curve: Curves.easeOutCubic),
                    child: Text(S.onbSkip.of(context), style: const TextStyle(color: _muted, fontWeight: FontWeight.w600)),
                  ),
                ),
              ]),
            ),
            Expanded(
              child: PageView.builder(
                controller: _pager,
                itemCount: S.onbPages.length,
                onPageChanged: (i) => setState(() => _page = i),
                itemBuilder: (context, i) => AnimatedBuilder(
                  animation: Listenable.merge([_pager, _float, _spin]),
                  builder: (context, _) {
                    final p = _pager.hasClients && _pager.position.haveDimensions ? (_pager.page ?? 0) : 0.0;
                    final offset = (p - i).clamp(-1.0, 1.0);
                    final shown = 1 - offset.abs();
                    return _Slide(
                      icon: _icons[i],
                      title: S.onbPages[i].$1.of(context),
                      body: S.onbPages[i].$2.of(context),
                      chips: [for (final c in S.onbChips[i]) c.of(context)],
                      shown: shown,
                      parallax: offset,
                      float: reduce ? 0.5 : _float.value,
                      spin: reduce ? 0 : _spin.value,
                    );
                  },
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 18),
              child: Column(children: [
                Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                  for (var i = 0; i < S.onbPages.length; i++)
                    AnimatedContainer(
                      duration: const Duration(milliseconds: 240),
                      curve: Curves.easeOut,
                      margin: const EdgeInsets.symmetric(horizontal: 3),
                      width: i == _page ? 22 : 7,
                      height: 7,
                      decoration: BoxDecoration(
                        gradient: i == _page ? NuzmColors.brandGradient : null,
                        color: i == _page ? null : _fg.withValues(alpha: 0.22),
                        borderRadius: BorderRadius.circular(4),
                      ),
                    ),
                ]),
                const SizedBox(height: 18),
                AnimatedSize(
                  duration: const Duration(milliseconds: 260),
                  curve: Curves.easeOutCubic,
                  child: _last
                      ? Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                          FilledButton(
                            onPressed: () => app.finishOnboarding(register: true),
                            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(54)),
                            child: Text(S.onbCreate.of(context), style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
                          ),
                          const SizedBox(height: 10),
                          OutlinedButton(
                            onPressed: () => app.finishOnboarding(),
                            style: OutlinedButton.styleFrom(
                              minimumSize: const Size.fromHeight(54),
                              backgroundColor: _fg.withValues(alpha: 0.06),
                              side: BorderSide(color: _fg.withValues(alpha: 0.22)),
                              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                            ),
                            child: Text(S.onbHaveAccount.of(context), style: const TextStyle(color: _fg, fontSize: 15, fontWeight: FontWeight.w700)),
                          ),
                          TextButton(
                            onPressed: app.useSampleData,
                            child: Text(S.exploreSample.of(context), style: const TextStyle(color: _muted, fontWeight: FontWeight.w600)),
                          ),
                        ])
                      : Align(
                          alignment: AlignmentDirectional.centerEnd,
                          child: Tooltip(
                            message: S.onbNext.of(context),
                            child: Material(
                              shape: const CircleBorder(),
                              clipBehavior: Clip.antiAlias,
                              color: Colors.transparent,
                              child: Ink(
                                decoration: BoxDecoration(shape: BoxShape.circle, gradient: NuzmColors.orangeGradient),
                                child: InkWell(
                                  onTap: _next,
                                  child: SizedBox(
                                    width: 60,
                                    height: 60,
                                    child: Icon(isAr(context) ? NzIcons.chevronLeft : NzIcons.chevronRight, size: 26, color: const Color(0xFF3A2414)),
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ),
                ),
              ]),
            ),
          ]),
        ),
      ]),
    );
  }
}

class _Slide extends StatelessWidget {
  const _Slide({
    required this.icon,
    required this.title,
    required this.body,
    required this.chips,
    required this.shown,
    required this.parallax,
    required this.float,
    required this.spin,
  });
  final IconData icon;
  final String title;
  final String body;
  final List<String> chips;

  /// 1 when the slide is centred, 0 when it is a full page away.
  final double shown;

  /// -1..1, how far the slide is from the centre (drives the parallax).
  final double parallax;
  final double float;
  final double spin;

  @override
  Widget build(BuildContext context) {
    final w = MediaQuery.sizeOf(context).width;
    final orb = math.min(w * 0.42, 176.0);
    final bob = (float - 0.5) * 14;
    // Chips sit on a ring around the orb and drift in from the side as the slide arrives.
    final ring = orb * 0.86;
    return LayoutBuilder(builder: (context, c) {
      final artH = math.min(c.maxHeight * 0.58, orb * 2.3);
      return Column(children: [
        SizedBox(
          height: artH,
          child: Stack(alignment: Alignment.center, clipBehavior: Clip.none, children: [
            Transform.translate(
              offset: Offset(parallax * -60, bob),
              child: SizedBox(
                width: orb,
                height: orb,
                child: Stack(alignment: Alignment.center, children: [
                  // A slowly turning gradient ring.
                  Transform.rotate(
                    angle: spin * 2 * math.pi,
                    child: Container(
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        gradient: SweepGradient(colors: [
                          const Color(0xFFBCDCCB),
                          const Color(0xFF93B6B3).withValues(alpha: 0.2),
                          const Color(0xFFE9A16D),
                          const Color(0xFFBCDCCB).withValues(alpha: 0.2),
                          const Color(0xFFBCDCCB),
                        ]),
                      ),
                    ),
                  ),
                  Container(
                    margin: const EdgeInsets.all(3),
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: const Color(0xFF111316),
                      boxShadow: [BoxShadow(color: const Color(0xFFBCDCCB).withValues(alpha: 0.25), blurRadius: 50, spreadRadius: 4)],
                    ),
                  ),
                  Container(
                    width: orb * 0.52,
                    height: orb * 0.52,
                    decoration: BoxDecoration(shape: BoxShape.circle, gradient: NuzmColors.brandGradient),
                    child: Icon(icon, size: orb * 0.24, color: _ink),
                  ),
                ]),
              ),
            ),
            for (final (j, label) in chips.indexed)
              Builder(builder: (context) {
                final a = -math.pi / 2 + (j + 0.5) * (2 * math.pi / chips.length) + 0.35;
                final appear = Curves.easeOutBack.transform(((shown - 0.25 - j * 0.12) / 0.6).clamp(0.0, 1.0));
                final drift = math.sin(float * math.pi * 2 + j) * 4;
                return Transform.translate(
                  // Kept inside the screen: at most a chip's width from the edge.
                  offset: Offset(
                      (math.cos(a) * ring).clamp(-(w / 2 - 70), w / 2 - 70) + parallax * (-110 - j * 30), math.sin(a) * ring * 0.95 + drift),
                  child: Opacity(
                    opacity: appear.clamp(0.0, 1.0),
                    child: Transform.scale(scale: 0.7 + 0.3 * appear, child: _Chip(label)),
                  ),
                );
              }),
          ]),
        ),
        const SizedBox(height: 8),
        Opacity(
          opacity: shown.clamp(0.0, 1.0),
          child: Transform.translate(
            offset: Offset(parallax * -40, (1 - shown) * 16),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 28),
              child: Column(children: [
                Text(title, textAlign: TextAlign.center, style: const TextStyle(color: _fg, fontSize: 27, fontWeight: FontWeight.w800, height: 1.25)),
                const SizedBox(height: 10),
                Text(body, textAlign: TextAlign.center, style: const TextStyle(color: _muted, fontSize: 15, height: 1.6)),
              ]),
            ),
          ),
        ),
      ]);
    });
  }
}

class _Chip extends StatelessWidget {
  const _Chip(this.label);
  final String label;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
        decoration: BoxDecoration(
          color: const Color(0xFF1A1D21).withValues(alpha: 0.92),
          borderRadius: BorderRadius.circular(20),
          boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.35), blurRadius: 14, offset: const Offset(0, 6))],
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Container(width: 7, height: 7, decoration: const BoxDecoration(shape: BoxShape.circle, color: Color(0xFFBCDCCB))),
          const SizedBox(width: 7),
          Text(label, style: const TextStyle(color: _fg, fontSize: 12.5, fontWeight: FontWeight.w700)),
        ]),
      );
}
