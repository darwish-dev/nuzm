import 'package:flutter/material.dart';

import '../actions/action_sheet.dart';
import '../actions/registry.dart';
import '../api/api_client.dart';
import '../app_scope.dart';
import '../data/demo.dart' show Tone, money;
import '../data/plans.dart';
import '../l10n/strings.dart';
import '../theme/nuzm_colors.dart';
import '../widgets/common.dart';
import '../widgets/nz_icons.dart';
import 'sign_in_screen.dart';

/// Opens the plans of [service] ('hosting' or 'cloud'). True when something was created from a plan.
Future<bool> openPlans(BuildContext context, String service) async =>
    await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => PlansScreen(service: service))) == true;

/// `9900` → "99 ر.س" (no ".00" on whole prices, as the website shows them). Display only; minor units in.
String planPrice(BuildContext context, int minor, String currency) {
  final s = money(minor, context, currency: currency);
  return minor % 100 == 0 ? s.replaceFirst('.00', '') : s;
}

/// The website's plan section on a phone: the plan families as tabs, the plans as cards you slide through
/// (cheapest first, the middle of three highlighted), each with its price, what it includes and what it runs.
/// Choosing a plan opens the create form with that plan picked; the price is confirmed there before anything is bought.
class PlansScreen extends StatefulWidget {
  const PlansScreen({super.key, required this.service});
  final String service;

  @override
  State<PlansScreen> createState() => _PlansScreenState();
}

class _PlansScreenState extends State<PlansScreen> {
  late Future<List<PlanGroup>> _plans = AppScope.read(context).data.plans(widget.service);
  int _group = 0;
  int _page = 0;
  PageController _pager = PageController(viewportFraction: 0.86);

  @override
  void dispose() {
    _pager.dispose();
    super.dispose();
  }

  void _pickGroup(int i, PlanGroup g) {
    if (i == _group) return;
    final old = _pager;
    setState(() {
      _group = i;
      // Start the new family on its middle card when it has three, like the website's highlighted plan.
      _page = g.cards.length == 3 ? 1 : 0;
      _pager = PageController(viewportFraction: 0.86, initialPage: _page);
    });
    WidgetsBinding.instance.addPostFrameCallback((_) => old.dispose());
  }

  Future<void> _choose(PlanCard card) async {
    final app = AppScope.read(context);
    final create = kPageActions[card.kind == PlanKind.hosting ? 'sites' : 'instances']?.where((a) => a.id == 'create').firstOrNull;
    if (create == null) return;
    var item = <String, dynamic>{};
    if (card.kind == PlanKind.hosting && app.data.isLive && app.api != null) {
      // The public key → the plan as offered to this organization (it is hidden there without capacity or residency).
      String? id;
      try {
        final r = await app.api!.get('/v1/hosting/plans');
        final items = r is Map && r['items'] is List ? r['items'] as List : (r is List ? r : const []);
        for (final p in items.whereType<Map>()) {
          if ('${p['key']}' == card.key) id = '${p['id']}';
        }
      } on ApiException catch (e) {
        if (e.unauthenticated) return app.sessionExpired();
      } catch (_) {}
      if (!mounted) return;
      if (id == null) {
        ScaffoldMessenger.of(context)
          ..hideCurrentSnackBar()
          ..showSnackBar(SnackBar(content: Text(S.planNotOffered.of(context))));
      } else {
        item = {'planId': id};
      }
    }
    if (!mounted) return;
    final ok = await runAction(context, create, item: item);
    if (ok && mounted) Navigator.of(context).pop(true);
  }

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    return NzScaffold(
      header: Row(children: [
        CircleIconButton(icon: backIcon(context), tooltip: S.back.of(context), onTap: () => Navigator.of(context).pop()),
        const SizedBox(width: 10),
        Expanded(
          child: Text((widget.service == 'cloud' ? S.cloudPlans : S.hostingPlans).of(context),
              maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: nz.chromeFg, fontSize: 16, fontWeight: FontWeight.w700)),
        ),
      ]),
      body: FutureBuilder<List<PlanGroup>>(
        future: _plans,
        builder: (context, snap) {
          if (snap.connectionState != ConnectionState.done) return const Center(child: CircularProgressIndicator(strokeWidth: 2.5));
          if (snap.hasError) {
            final e = snap.error;
            if (e is ApiException && e.unauthenticated) AppScope.read(context).sessionExpired();
            return Padding(
              padding: const EdgeInsets.all(16),
              child: StateView(
                icon: NzIcons.cloudOff,
                tone: Tone.danger,
                title: S.errorTitle.of(context),
                hint: problemText(context, e ?? ''),
                action: S.retry.of(context),
                onAction: () => setState(() => _plans = AppScope.read(context).data.plans(widget.service)),
              ),
            );
          }
          final groups = snap.data ?? const <PlanGroup>[];
          if (groups.isEmpty) {
            return Padding(
              padding: const EdgeInsets.all(16),
              child: StateView(icon: NzIcons.layers, title: S.noPlans.of(context), hint: S.emptyHint.of(context)),
            );
          }
          final g = groups[_group.clamp(0, groups.length - 1)];
          return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 16, 20, 4),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(S.plansEyebrow.of(context),
                    style: TextStyle(color: nz.accent, fontSize: 12, fontWeight: FontWeight.w800, letterSpacing: 0.4)),
                const SizedBox(height: 2),
                Text(S.plansHeadline.of(context), style: TextStyle(color: nz.fg, fontSize: 21, fontWeight: FontWeight.w800)),
              ]),
            ),
            if (groups.length > 1)
              // The plan families as one segmented control (the website's `.pl-tabs`): all visible, equal width.
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                child: Container(
                  height: 44,
                  padding: const EdgeInsets.all(4),
                  decoration: BoxDecoration(color: nz.card, borderRadius: BorderRadius.circular(14)),
                  child: Row(children: [
                    for (final (i, x) in groups.indexed)
                      Expanded(child: _GroupPill(label: x.title.of(context), selected: x == g, onTap: () => _pickGroup(i, x))),
                  ]),
                ),
              ),
            Expanded(
              child: PageView.builder(
                key: ValueKey(g.id),
                controller: _pager,
                padEnds: true,
                itemCount: g.cards.length,
                onPageChanged: (i) => setState(() => _page = i),
                itemBuilder: (context, i) => AnimatedBuilder(
                  animation: _pager,
                  builder: (context, child) {
                    // The cards beside the current one sit a little smaller and fainter while sliding.
                    var d = (i - _page).abs().toDouble();
                    if (_pager.hasClients && _pager.position.haveDimensions) d = ((_pager.page ?? _page.toDouble()) - i).abs();
                    final t = d.clamp(0.0, 1.0);
                    return Transform.scale(scale: 1 - 0.05 * t, child: Opacity(opacity: 1 - 0.35 * t, child: child));
                  },
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(6, 10, 6, 6),
                    child: _PlanCardView(
                      card: g.cards[i],
                      featured: g.cards.length == 3 && i == 1,
                      onChoose: () => _choose(g.cards[i]),
                    ),
                  ),
                ),
              ),
            ),
            _Dots(count: g.cards.length, current: _page),
          ]);
        },
      ),
    );
  }
}

class _GroupPill extends StatelessWidget {
  const _GroupPill({required this.label, required this.selected, required this.onTap});
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    return Semantics(
      button: true,
      selected: selected,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 220),
          curve: Curves.easeOut,
          padding: const EdgeInsets.symmetric(horizontal: 6),
          decoration: BoxDecoration(color: selected ? nz.accent : Colors.transparent, borderRadius: BorderRadius.circular(10)),
          alignment: Alignment.center,
          child: FittedBox(
            fit: BoxFit.scaleDown,
            child: Text(label,
                maxLines: 1,
                style: TextStyle(
                  color: selected ? nz.onAccent : nz.muted,
                  fontSize: 13,
                  fontWeight: selected ? FontWeight.w800 : FontWeight.w600,
                )),
          ),
        ),
      ),
    );
  }
}

class _Dots extends StatelessWidget {
  const _Dots({required this.count, required this.current});
  final int count;
  final int current;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    if (count < 2) return const SizedBox(height: 18);
    return Padding(
      padding: const EdgeInsets.fromLTRB(0, 4, 0, 16),
      child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
        for (var i = 0; i < count; i++)
          AnimatedContainer(
            duration: const Duration(milliseconds: 220),
            curve: Curves.easeOut,
            margin: const EdgeInsets.symmetric(horizontal: 3),
            width: i == current ? 20 : 7,
            height: 7,
            decoration: BoxDecoration(
              color: i == current ? nz.accent : nz.muted.withValues(alpha: 0.35),
              borderRadius: BorderRadius.circular(4),
            ),
          ),
      ]),
    );
  }
}

/// One plan as the website's `.pl-card`: name, sub-line, price per month, the button, the fine print, then
/// "Included" and (hosting) "Runs".
class _PlanCardView extends StatelessWidget {
  const _PlanCardView({required this.card, required this.featured, required this.onChoose});
  final PlanCard card;
  final bool featured;
  final VoidCallback onChoose;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    final compute = card.kind == PlanKind.compute;
    Widget check(bool on) => on
        ? Icon(NzIcons.check, size: 16, color: nz.accent)
        : SizedBox(width: 16, child: Text('–', textAlign: TextAlign.center, style: TextStyle(color: nz.muted)));
    Widget blockTitle(T t) => Padding(
          padding: const EdgeInsets.only(top: 18, bottom: 8),
          child: Text(t.of(context), style: TextStyle(color: nz.muted, fontSize: 12.5, fontWeight: FontWeight.w800)),
        );
    final body = Container(
      decoration: BoxDecoration(
        color: nz.card,
        borderRadius: BorderRadius.circular(featured ? 22.5 : 24),
        gradient: featured ? null : nz.cardWash,
      ),
      child: Stack(children: [
        if (featured)
          Positioned.fill(
            child: DecoratedBox(
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(22.5),
                gradient: RadialGradient(
                  center: const AlignmentDirectional(1, -1).resolve(Directionality.of(context)),
                  radius: 1.2,
                  colors: [nz.accent.withValues(alpha: 0.16), nz.accent.withValues(alpha: 0)],
                ),
              ),
            ),
          ),
        SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(20, 22, 20, 20),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(card.name.of(context), style: TextStyle(color: nz.fg, fontSize: 19, fontWeight: FontWeight.w800)),
            const SizedBox(height: 4),
            Text(card.sub.of(context), style: TextStyle(color: nz.muted, fontSize: 13)),
            const SizedBox(height: 16),
            Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
              Flexible(
                child: FittedBox(
                  fit: BoxFit.scaleDown,
                  alignment: AlignmentDirectional.centerStart,
                  child: LtrText(planPrice(context, card.priceMinor, card.currency),
                      style: TextStyle(color: nz.fg, fontSize: 32, fontWeight: FontWeight.w800, height: 1.1)),
                ),
              ),
              const SizedBox(width: 4),
              Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Text(S.perMonth.of(context), style: TextStyle(color: nz.muted, fontSize: 14, fontWeight: FontWeight.w600)),
              ),
            ]),
            const SizedBox(height: 16),
            SizedBox(
              width: double.infinity,
              child: featured
                  ? FilledButton(onPressed: onChoose, child: Text((compute ? S.chooseServer : S.choosePlan).of(context)))
                  : OutlinedButton(
                      onPressed: onChoose,
                      style: OutlinedButton.styleFrom(minimumSize: const Size(0, 46), side: BorderSide(color: nz.accent.withValues(alpha: 0.5))),
                      child: Text((compute ? S.chooseServer : S.choosePlan).of(context),
                          style: TextStyle(color: nz.fg, fontWeight: FontWeight.w700)),
                    ),
            ),
            const SizedBox(height: 10),
            Text((compute ? S.fineServer : S.fineHosting).of(context), style: TextStyle(color: nz.muted, fontSize: 11.5, height: 1.5)),
            blockTitle(S.included),
            for (final f in card.features)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Padding(padding: const EdgeInsets.only(top: 2), child: check(true)),
                  const SizedBox(width: 8),
                  Expanded(child: Text(f.of(context), style: TextStyle(color: nz.fg, fontSize: 14))),
                ]),
              ),
            if (card.runs.isNotEmpty) ...[
              blockTitle(S.runsOn),
              Wrap(spacing: 8, runSpacing: 8, children: [
                for (final (name, on) in card.runs)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                    decoration: BoxDecoration(
                      color: on ? nz.accentSoft : nz.elev,
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Row(mainAxisSize: MainAxisSize.min, children: [
                      check(on),
                      const SizedBox(width: 4),
                      Text(name,
                          textDirection: TextDirection.ltr,
                          style: TextStyle(
                            color: on ? nz.fg : nz.muted,
                            fontSize: 12.5,
                            fontWeight: FontWeight.w700,
                            decoration: on ? null : TextDecoration.lineThrough,
                          )),
                    ]),
                  ),
              ]),
            ],
          ]),
        ),
      ]),
    );
    if (!featured) return body;
    // The highlighted plan: the brand gradient as a 1.5 px ring and a soft accent glow.
    return Container(
      padding: const EdgeInsets.all(1.5),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(24),
        gradient: NuzmColors.brandGradient,
        boxShadow: [BoxShadow(color: nz.accent.withValues(alpha: 0.18), blurRadius: 30, offset: const Offset(0, 10), spreadRadius: -10)],
      ),
      child: body,
    );
  }
}
