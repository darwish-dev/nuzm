import 'package:flutter/material.dart';

import '../actions/action_sheet.dart';
import '../actions/registry.dart';
import '../api/api_client.dart';
import '../app_scope.dart';
import '../data/data_source.dart';
import '../data/nav.dart';
import '../l10n/strings.dart';
import '../theme/nuzm_colors.dart';
import '../widgets/common.dart';
import '../widgets/nz_icons.dart';
import 'page_views.dart';
import 'sign_in_screen.dart';

/// Opens "Add a domain". True when a domain was registered or a transfer started (the list reloads).
Future<bool> openDomainAdd(BuildContext context) async =>
    await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => const DomainAddScreen())) == true;

/// The domains list's "+": two tabs, register a new domain (the search, on the dashboard's hero gradient) or
/// transfer one in (the steps, the transfer form, and the transfers already running).
class DomainAddScreen extends StatefulWidget {
  const DomainAddScreen({super.key, this.initialTab = 0});
  final int initialTab;

  @override
  State<DomainAddScreen> createState() => _DomainAddScreenState();
}

class _DomainAddScreenState extends State<DomainAddScreen> {
  late int _tab = widget.initialTab;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    return NzScaffold(
      header: Row(children: [
        CircleIconButton(icon: backIcon(context), tooltip: S.back.of(context), onTap: () => Navigator.of(context).pop()),
        const SizedBox(width: 10),
        Expanded(
          child: Text(S.addDomain.of(context),
              maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: nz.chromeFg, fontSize: 16, fontWeight: FontWeight.w700)),
        ),
      ]),
      body: Stack(children: [
        // The dashboard's hero surface across the whole page: an accent glow at the top end over a 135deg wash,
        // with a faint orange glow low on the start side.
        Positioned.fill(child: _HeroBackground(nz: nz)),
        Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
            child: Container(
              height: 46,
              padding: const EdgeInsets.all(4),
              decoration: BoxDecoration(color: nz.card.withValues(alpha: 0.85), borderRadius: BorderRadius.circular(14)),
              child: Row(children: [
                for (final (i, (icon, label)) in [(NzIcons.globe, S.registerTab), (NzIcons.arrowLeftRight, S.transferTab)].indexed)
                  Expanded(child: _Segment(icon: icon, label: label.of(context), selected: _tab == i, onTap: () => setState(() => _tab = i))),
              ]),
            ),
          ),
          Expanded(
            child: AnimatedSwitcher(
              duration: const Duration(milliseconds: 220),
              child: _tab == 0
                  ? ListView(
                      key: const ValueKey('register'),
                      padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
                      children: [DomainSearchView(plain: true, onRegistered: () => Navigator.of(context).pop(true))],
                    )
                  : const _TransferTab(key: ValueKey('transfer')),
            ),
          ),
        ]),
      ]),
    );
  }
}

class _HeroBackground extends StatelessWidget {
  const _HeroBackground({required this.nz});
  final NuzmColors nz;

  @override
  Widget build(BuildContext context) {
    final rtl = Directionality.of(context) == TextDirection.rtl;
    Widget layer = const SizedBox.expand();
    // The dashboard hero's palette, turned up for a full page: a mint glow over the search (top end), a warm
    // orange glow low on the start side, over the 135deg accent wash.
    final layers = <Gradient>[
      RadialGradient(
        center: Alignment(rtl ? -0.9 : 0.9, -0.75),
        radius: 0.95,
        colors: [nz.accent.withValues(alpha: 0.30), nz.accent.withValues(alpha: 0.08), nz.accent.withValues(alpha: 0)],
        stops: const [0, 0.45, 1],
      ),
      RadialGradient(
        center: Alignment(rtl ? 1 : -1, 0.85),
        radius: 0.9,
        colors: [nz.orange.withValues(alpha: 0.16), nz.orange.withValues(alpha: 0)],
      ),
      cssLinear(135, [Color.lerp(nz.bg, nz.accentStrong, 0.16)!, nz.bg], const [0, 0.7]),
    ];
    // Wrapping in list order puts the last layer (the opaque wash) at the bottom and the glows above it.
    for (final g in layers) {
      layer = DecoratedBox(decoration: BoxDecoration(gradient: g), child: layer);
    }
    return layer;
  }
}

class _Segment extends StatelessWidget {
  const _Segment({required this.icon, required this.label, required this.selected, required this.onTap});
  final IconData icon;
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    final fg = selected ? nz.onAccent : nz.muted;
    return Semantics(
      button: true,
      selected: selected,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 220),
          curve: Curves.easeOut,
          decoration: BoxDecoration(color: selected ? nz.accent : Colors.transparent, borderRadius: BorderRadius.circular(10)),
          alignment: Alignment.center,
          child: FittedBox(
            fit: BoxFit.scaleDown,
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Icon(icon, size: 16, color: fg),
              const SizedBox(width: 6),
              Text(label, style: TextStyle(color: fg, fontSize: 13.5, fontWeight: selected ? FontWeight.w800 : FontWeight.w600)),
            ]),
          ),
        ),
      ),
    );
  }
}

/// Transfer in: the three steps, the domain field that opens the transfer form (price → confirm), and the
/// transfers already running.
class _TransferTab extends StatefulWidget {
  const _TransferTab({super.key});

  @override
  State<_TransferTab> createState() => _TransferTabState();
}

class _TransferTabState extends State<_TransferTab> {
  final _ctrl = TextEditingController();
  late Future<PageData> _transfers = AppScope.read(context).data.load('transfers');

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  Future<void> _start() async {
    final ok = await runAction(context, kDomainTransfer, item: {'name': _ctrl.text.trim().toLowerCase()});
    if (ok && mounted) Navigator.of(context).pop(true);
  }

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    return ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 32), children: [
      Text(S.transferTab.of(context), style: TextStyle(color: nz.accent, fontSize: 12, fontWeight: FontWeight.w800, letterSpacing: 0.4)),
      const SizedBox(height: 4),
      Text(S.trTitle.of(context), style: TextStyle(color: nz.fg, fontSize: 21, fontWeight: FontWeight.w800)),
      const SizedBox(height: 4),
      Text(S.trBody.of(context), style: TextStyle(color: nz.muted, fontSize: 13.5, height: 1.5)),
      const SizedBox(height: 18),
      for (final (i, step) in S.trSteps.indexed)
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Container(
              width: 28,
              height: 28,
              alignment: Alignment.center,
              decoration: BoxDecoration(shape: BoxShape.circle, gradient: NuzmColors.brandGradient),
              child: Text('${i + 1}', style: const TextStyle(color: Color(0xFF15302A), fontWeight: FontWeight.w800, fontSize: 13)),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(step.of(context), style: TextStyle(color: nz.fg, fontSize: 14, height: 1.45)),
              ),
            ),
          ]),
        ),
      const SizedBox(height: 6),
      Container(
        padding: const EdgeInsetsDirectional.fromSTEB(12, 5, 5, 5),
        decoration: BoxDecoration(color: nz.card, borderRadius: BorderRadius.circular(16)),
        child: Row(children: [
          Icon(NzIcons.globe, color: nz.muted, size: 21),
          Expanded(
            child: TextField(
              controller: _ctrl,
              textDirection: TextDirection.ltr,
              autocorrect: false,
              enableSuggestions: false,
              keyboardType: TextInputType.url,
              onSubmitted: (_) => _start(),
              style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
              decoration: InputDecoration(
                hintText: 'mybrand.com',
                hintStyle: TextStyle(color: nz.muted, fontWeight: FontWeight.w400),
                filled: false,
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                contentPadding: const EdgeInsets.symmetric(horizontal: 10),
              ),
            ),
          ),
          FilledButton(
            onPressed: _start,
            style: FilledButton.styleFrom(minimumSize: const Size(0, 46), padding: const EdgeInsets.symmetric(horizontal: 16)),
            child: Text(S.trStart.of(context)),
          ),
        ]),
      ),
      Padding(
        padding: const EdgeInsets.fromLTRB(6, 24, 6, 10),
        child: Text(S.trInProgress.of(context), style: TextStyle(color: nz.muted, fontSize: 13, fontWeight: FontWeight.w700)),
      ),
      FutureBuilder<PageData>(
        future: _transfers,
        builder: (context, snap) {
          if (snap.connectionState != ConnectionState.done) {
            return const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator(strokeWidth: 2.5)));
          }
          if (snap.hasError) {
            final e = snap.error;
            if (e is ApiException && e.unauthenticated) AppScope.read(context).sessionExpired();
            return StateView(
              icon: NzIcons.cloudOff,
              title: S.errorTitle.of(context),
              hint: problemText(context, e ?? ''),
              action: S.retry.of(context),
              onAction: () => setState(() => _transfers = AppScope.read(context).data.load('transfers')),
            );
          }
          final items = snap.data?.items ?? const [];
          if (items.isEmpty) {
            return NzCard(
              child: Row(children: [
                Icon(NzIcons.arrowLeftRight, size: 18, color: nz.muted),
                const SizedBox(width: 10),
                Expanded(child: Text(S.trNone.of(context), style: TextStyle(color: nz.muted))),
              ]),
            );
          }
          final page = NavPage('transfers', S.trInProgress, NzIcons.arrowLeftRight, PageKind.list, '/domains/transfers');
          return Column(children: [
            for (final it in items) Padding(padding: const EdgeInsets.only(bottom: 12), child: ItemCard(item: it, page: page)),
          ]);
        },
      ),
    ]);
  }
}
