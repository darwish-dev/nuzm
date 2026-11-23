import 'package:flutter/material.dart';

import '../actions/action_model.dart';
import '../actions/action_sheet.dart';
import '../actions/registry.dart';
import '../api/api_client.dart';
import '../app_scope.dart';
import '../data/data_source.dart';
import '../data/demo.dart';
import '../data/nav.dart';
import '../l10n/strings.dart';
import '../theme/nuzm_colors.dart';
import '../widgets/common.dart';
import '../widgets/nz_icons.dart';
import 'detail_screen.dart';
import 'domain_add_screen.dart';
import 'plans_screen.dart';
import 'section_screen.dart';
import 'sign_in_screen.dart';

enum LoadState { loading, ready, error, forbidden, notEnabled }

/// One console page: loads its data from the app's [DataSource] (the live API or the sample data), shows
/// loading → content, or the empty / error / forbidden / not-enabled state. Pull-to-refresh reloads it.
class PageBody extends StatefulWidget {
  const PageBody({super.key, required this.page, this.forceError = false, this.onOpenTab});
  final NavPage page;

  /// Switches the section to another of its pages (the domains button opens the search tab).
  final ValueChanged<String>? onOpenTab;

  /// Shows the error state without loading (tests).
  final bool forceError;

  @override
  State<PageBody> createState() => _PageBodyState();
}

class _PageBodyState extends State<PageBody> {
  LoadState _state = LoadState.loading;
  PageData? _data;
  DashboardData? _dash;
  int _gen = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    if (!mounted) return;
    final gen = ++_gen;
    setState(() => _state = LoadState.loading);
    if (widget.forceError) {
      setState(() => _state = LoadState.error);
      return;
    }
    final app = AppScope.read(context);
    try {
      final p = widget.page;
      if (p.kind == PageKind.dashboard) {
        final d = await app.data.dashboard();
        if (!mounted || gen != _gen) return;
        _dash = d;
      } else if (p.kind != PageKind.builder && p.kind != PageKind.domainSearch) {
        final d = await app.data.load(p.id);
        if (!mounted || gen != _gen) return;
        _data = d;
      }
      setState(() => _state = LoadState.ready);
    } on ApiException catch (e) {
      if (!mounted || gen != _gen) return;
      if (e.unauthenticated) return app.sessionExpired();
      setState(() => _state = e.forbidden ? LoadState.forbidden : (e.notFound ? LoadState.notEnabled : LoadState.error));
    } catch (_) {
      if (mounted && gen == _gen) setState(() => _state = LoadState.error);
    }
  }

  @override
  Widget build(BuildContext context) {
    final Widget body = switch (_state) {
      LoadState.loading => const SkeletonList(),
      LoadState.error => StateView(
          icon: NzIcons.cloudOff,
          tone: Tone.danger,
          title: S.errorTitle.of(context),
          hint: S.errorHint.of(context),
          action: S.retry.of(context),
          onAction: _load,
        ),
      LoadState.forbidden => StateView(
          icon: NzIcons.lock, tone: Tone.warn, title: S.forbiddenTitle.of(context), hint: S.forbiddenHint.of(context)),
      LoadState.notEnabled => StateView(
          icon: NzIcons.power, tone: Tone.neutral, title: S.notEnabledTitle.of(context), hint: S.notEnabledHint.of(context)),
      LoadState.ready => PageRefresh(reload: _load, child: _content(context)),
    };
    final fab = pageFab(widget.page.id);
    final list = RefreshIndicator(
      onRefresh: _load,
      color: context.nz.accentStrong,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        // Room under the last item for the floating button.
        padding: EdgeInsets.fromLTRB(16, 8, 16, fab == null ? 32 : 100),
        children: [body],
      ),
    );
    if (fab == null || _state != LoadState.ready) return list;
    return Stack(children: [
      Positioned.fill(child: list),
      PositionedDirectional(
        end: 18,
        bottom: 18,
        child: FloatingAdd(
          tooltip: fab.label.of(context),
          onTap: () async {
            if (await fab.run(context, widget.onOpenTab)) await _load();
          },
        ),
      ),
    ]);
  }

  Widget _content(BuildContext context) {
    final p = widget.page;
    switch (p.kind) {
      case PageKind.dashboard:
        return DashboardView(data: _dash!);
      case PageKind.domainSearch:
        return const DomainSearchView();
      case PageKind.builder:
        return const BuilderStartView();
      default:
        return PageDataView(page: p, data: _data ?? const PageData());
    }
  }
}

/// Draws whatever a page returned: stats, catalog cards, form fields, list rows, then a related list.
class PageDataView extends StatelessWidget {
  const PageDataView({super.key, required this.page, required this.data});
  final NavPage page;
  final PageData data;

  @override
  Widget build(BuildContext context) {
    final d = data;
    final nothing = (d.stats?.isEmpty ?? true) &&
        (d.catalog?.isEmpty ?? true) &&
        (d.fields?.isEmpty ?? true) &&
        (d.items?.isEmpty ?? true) &&
        (d.related?.isEmpty ?? true);
    final fab = pageFab(page.id);
    // Pages with the floating button create from it, not from the bar.
    final actions = [for (final a in kPageActions[page.id] ?? const <ActionDef>[]) if (fab == null || a.id != 'create') a];
    if (nothing) {
      final create = (kPageActions[page.id] ?? const <ActionDef>[]).where((a) => a.id == 'create').firstOrNull;
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        if (create == null && actions.isNotEmpty) PageActionsBar(actions: actions, raw: d.raw),
        StateView(
          icon: page.icon,
          title: S.emptyTitle.of(context),
          hint: create == null && fab == null && kWebOnlyWrites.contains(page.id) ? S.webOnlyWrites.of(context) : S.emptyHint.of(context),
          action: fab != null ? fab.label.of(context) : create?.label.of(context),
          onAction: fab != null
              ? () async {
                  final refresh = PageRefresh.of(context);
                  if (await fab.run(context, null)) await refresh?.call();
                }
              : create == null
                  ? null
                  : () => _runAndRefresh(context, create, d.raw),
        ),
      ]);
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (actions.isNotEmpty) PageActionsBar(actions: actions, raw: d.raw),
      if (d.stats != null)
        for (final s in d.stats!) Padding(padding: const EdgeInsets.only(bottom: 12), child: _StatCard(s)),
      if (d.catalog != null && d.catalog!.isNotEmpty) CatalogView(items: d.catalog!),
      if (d.fields != null && d.fields!.isNotEmpty) FormView(fields: d.fields!),
      if (d.items != null && d.items!.isNotEmpty) ResourceListView(page: page, items: d.items!),
      if (d.related != null && d.related!.isNotEmpty) ...[
        _SectionTitle(pageLabel(d.relatedPage!).of(context),
            trailing: TextButton(onPressed: () => openPage(context, d.relatedPage!), child: Text(S.viewAll.of(context)))),
        for (final it in d.related!)
          Padding(padding: const EdgeInsets.only(bottom: 12), child: ItemCard(item: it, page: findPage(d.relatedPage!).$2)),
      ],
    ]);
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text, {this.trailing});
  final String text;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(8, 18, 8, 10),
        child: Row(children: [
          Expanded(
            child: Text(text, style: TextStyle(color: context.nz.muted, fontSize: 15, fontWeight: FontWeight.w800)),
          ),
          if (trailing != null) trailing!,
        ]),
      );
}

// ---------------------------------------------------------------- dashboard

class DashboardView extends StatelessWidget {
  const DashboardView({super.key, required this.data});
  final DashboardData data;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      // `.nzc-hero`: 18 px card (no stroke), an accent glow at the top end over a 135deg accent wash.
      Container(
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(18),
          gradient: nz.heroLayers[1],
        ),
        child: DecoratedBox(
          decoration: BoxDecoration(gradient: nz.heroLayers[0]),
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Row(children: [
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(AppScope.of(context).data.orgName.of(context),
                      style: TextStyle(color: nz.fg, fontSize: 20, fontWeight: FontWeight.w700, height: 1.3)),
                  const SizedBox(height: 4),
                  Text('${S.services.of(context)}: ${kCategories.length - 1}', style: TextStyle(color: nz.muted)),
                  const SizedBox(height: 14),
                  FilledButton.icon(
                    onPressed: () => askAi(context, S.heroLine.of(context)),
                    icon: const Icon(NzIcons.sparkles, size: 18),
                    label: Text(S.askAi.of(context)),
                  ),
                ]),
              ),
              brandMark(context, size: 84),
            ]),
          ),
        ),
      ),
      const SizedBox(height: 14),
      GridView.count(
        crossAxisCount: 2,
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        mainAxisSpacing: 12,
        crossAxisSpacing: 12,
        childAspectRatio: 1.18,
        children: [for (final s in data.stats) _StatCard(s, compact: true)],
      ),
      _SectionTitle(S.needsAttention.of(context)),
      NzCard(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Column(children: [
          if (data.attention.isEmpty)
            ListTile(
              minTileHeight: 60,
              leading: Icon(NzIcons.circleCheck, color: toneColors(context, Tone.success).$2),
              title: Text(S.allClear.of(context)),
            ),
          for (final (text, pageId, tone) in data.attention)
            ListTile(
              minTileHeight: 60,
              leading: Container(width: 10, height: 10, decoration: BoxDecoration(color: toneColors(context, tone).$2, shape: BoxShape.circle)),
              title: Text(text.of(context), style: const TextStyle(fontWeight: FontWeight.w600)),
              trailing: const ForwardChevron(),
              onTap: () => openPage(context, pageId),
            ),
        ]),
      ),
      _SectionTitle(S.allServices.of(context)),
      Wrap(spacing: 10, runSpacing: 10, children: [
        for (final c in kCategories.where((c) => c.id != 'dashboard'))
          ActionChip(
            avatar: Icon(c.icon, size: 17, color: nz.accent),
            label: Text(c.label.of(context)),
            backgroundColor: nz.card,
            side: BorderSide.none,
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
            labelStyle: TextStyle(color: nz.fg, fontWeight: FontWeight.w600),
            onPressed: () => openPage(context, c.pages.first.id),
          ),
      ]),
    ]);
  }
}

// ---------------------------------------------------------------- lists

class ResourceListView extends StatelessWidget {
  const ResourceListView({super.key, required this.page, required this.items});
  final NavPage page;
  final List<Item> items;

  @override
  Widget build(BuildContext context) {
    if (items.isEmpty) {
      return StateView(icon: page.icon, title: S.emptyTitle.of(context), hint: S.emptyHint.of(context));
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(8, 4, 0, 12),
        child: Row(children: [
          Expanded(
            child: Text('${page.label.of(context)} · ${items.length}',
                style: TextStyle(color: context.nz.muted, fontWeight: FontWeight.w700)),
          ),
        ]),
      ),
      for (final it in items)
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: ItemCard(item: it, page: page),
        ),
    ]);
  }
}

class ItemCard extends StatelessWidget {
  const ItemCard({super.key, required this.item, required this.page});
  final Item item;
  final NavPage page;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    final titleStyle = const TextStyle(fontSize: 16, fontWeight: FontWeight.w700);
    return NzCard(
      onTap: () async {
        final refresh = PageRefresh.of(context);
        final changed = await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => DetailScreen(item: item, page: page)));
        if (changed == true) refresh?.call();
      },
      padding: const EdgeInsets.all(14),
      child: Row(children: [
        IconTile(item.icon ?? page.icon, size: 50),
        const SizedBox(width: 14),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            item.ltrTitle ? LtrText(item.title.of(context), style: titleStyle) : Text(item.title.of(context), style: titleStyle, maxLines: 1, overflow: TextOverflow.ellipsis),
            const SizedBox(height: 3),
            Text(item.subtitle.of(context), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: nz.muted, fontSize: 13.5)),
            if (item.status != null || item.meta != null) ...[
              const SizedBox(height: 8),
              Row(children: [
                if (item.status != null) StatusChip(item.status!),
                const Spacer(),
                if (item.meta != null)
                  Flexible(
                    flex: 4,
                    child: LtrText(displayValue(item.meta!, context),
                        style: TextStyle(fontWeight: FontWeight.w800, color: nz.fg, fontSize: 14)),
                  ),
              ]),
            ],
          ]),
        ),
        const SizedBox(width: 4),
        const ForwardChevron(),
      ]),
    );
  }
}

// ---------------------------------------------------------------- stats

class _StatCard extends StatelessWidget {
  const _StatCard(this.stat, {this.compact = false});
  final Stat stat;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    final value = displayValue(stat.value, context);
    return NzCard(
      padding: EdgeInsets.all(compact ? 14 : 18),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
        Row(children: [
          if (stat.icon != null) IconTile(stat.icon!, size: compact ? 36 : 42, tone: Tone.accent),
          const SizedBox(width: 10),
          Expanded(
            child: Text(stat.label.of(context),
                maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: nz.muted, fontWeight: FontWeight.w700, fontSize: 13.5)),
          ),
        ]),
        SizedBox(height: compact ? 10 : 14),
        FittedBox(
          fit: BoxFit.scaleDown,
          alignment: AlignmentDirectional.centerStart,
          child: LtrText(value, style: TextStyle(fontSize: compact ? 22 : 28, fontWeight: FontWeight.w800, color: nz.fg)),
        ),
        if (stat.progress != null) ...[
          const SizedBox(height: 10),
          NzMeter(stat.progress!, label: stat.label.of(context)),
        ],
        if (stat.hint != null && !compact) ...[
          const SizedBox(height: 8),
          Text(stat.hint!.of(context), style: TextStyle(color: nz.muted, fontSize: 13)),
        ],
      ]),
    );
  }
}

// ---------------------------------------------------------------- catalog

class CatalogView extends StatelessWidget {
  const CatalogView({super.key, required this.items});
  final List<CatalogItem> items;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    return GridView.builder(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      itemCount: items.length,
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(crossAxisCount: 2, mainAxisSpacing: 12, crossAxisSpacing: 12, mainAxisExtent: 196),
      itemBuilder: (context, i) {
        final c = items[i];
        return NzCard(
          onTap: () => showSoon(context),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              IconTile(c.icon, size: 46, tone: Tone.accent),
              const SizedBox(width: 8),
              const Spacer(),
              if (c.tag != null)
                Flexible(flex: 6, child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
                  decoration: BoxDecoration(color: nz.orangeSoft, borderRadius: BorderRadius.circular(99)),
                  child: Text(c.tag!.of(context), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: nz.orangeText, fontSize: 11.5, fontWeight: FontWeight.w800)),
                )),
            ]),
            const Spacer(),
            Text(c.name.of(context), maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
            const SizedBox(height: 4),
            Text(c.desc.of(context), maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: nz.muted, fontSize: 13)),
          ]),
        );
      },
    );
  }
}

// ---------------------------------------------------------------- forms

class FormView extends StatefulWidget {
  const FormView({super.key, required this.fields});
  final List<FieldSpec> fields;

  @override
  State<FormView> createState() => _FormViewState();
}

class _FormViewState extends State<FormView> {
  /// Read-only label/value rows; changes go through the page's Edit action (one validated, versioned write).
  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    return NzCard(
      padding: const EdgeInsets.fromLTRB(18, 4, 18, 4),
      child: Column(children: [
        for (var i = 0; i < widget.fields.length; i++) ...[
          if (i > 0) Divider(color: nz.border, height: 1),
          _row(context, widget.fields[i]),
        ],
      ]),
    );
  }

  Widget _row(BuildContext context, FieldSpec f) {
    final nz = context.nz;
    final value = f.toggle != null
        ? (f.toggle! ? const T('مفعّل', 'On') : const T('غير مفعّل', 'Off')).of(context)
        : (f.value.isEmpty || f.value == 'null' ? '—' : f.value);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 14),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(
          flex: 5,
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(f.label.of(context), style: TextStyle(color: nz.muted, fontWeight: FontWeight.w600)),
            if (f.hint != null) Text(f.hint!.of(context), style: TextStyle(color: nz.muted, fontSize: 12.5)),
          ]),
        ),
        const SizedBox(width: 12),
        Expanded(
          flex: 6,
          child: f.ltr
              ? Align(alignment: AlignmentDirectional.centerEnd, child: LtrText(value, style: const TextStyle(fontWeight: FontWeight.w700)))
              : Text(value, textAlign: TextAlign.end, style: const TextStyle(fontWeight: FontWeight.w700)),
        ),
      ]),
    );
  }
}

// ---------------------------------------------------------------- domain search

class DomainSearchView extends StatefulWidget {
  const DomainSearchView({super.key, this.plain = false, this.onRegistered});

  /// Drawn straight on a hero background (the add-domain page), without its own card.
  final bool plain;

  /// Called after a registration was requested.
  final VoidCallback? onRegistered;

  @override
  State<DomainSearchView> createState() => _DomainSearchViewState();
}

/// The extensions the platform sells (the website's `SOLD_TLDS`).
const kSoldTlds = ['com', 'net', 'org'];

/// The website's domain tool on a phone: a hero card with the search field and the extension chips, then the
/// answer: the top match highlighted with its yearly price and Register, the other extensions below. Unknown is
/// never shown as available; blocked extensions say why.
class _DomainSearchViewState extends State<DomainSearchView> {
  final _ctrl = TextEditingController();
  final _picked = <String>{};
  List<DomainResult>? _results;
  String _asked = '';
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  Future<void> _check() async {
    final q = _ctrl.text.trim().toLowerCase();
    if (q.isEmpty || _busy) return;
    FocusScope.of(context).unfocus();
    final app = AppScope.read(context);
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final r = await app.data.searchDomains(q, tlds: [for (final t in kSoldTlds) if (_picked.contains(t)) t]);
      if (mounted) {
        setState(() {
          _results = r;
          _asked = q;
        });
      }
    } on ApiException catch (e) {
      if (e.unauthenticated) return app.sessionExpired();
      if (mounted) setState(() => _error = e.notFound ? S.notEnabledTitle.of(context) : problemText(context, e));
    } catch (e) {
      if (mounted) setState(() => _error = problemText(context, e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _register(DomainResult r) async {
    final a = kItemActions['domainSearch']?.firstOrNull;
    if (a != null && await runAction(context, a, item: {'name': r.name})) widget.onRegistered?.call();
  }

  String _status(DomainResult r) {
    if (r.blocked) return '${S.domBlocked.of(context)}: ${(S.domReasons[r.blockedRule] ?? S.domReasonOther).of(context)}';
    if (r.available == true) return S.domAvailable.of(context) + (r.premium ? ' — ${S.domPremium.of(context)}' : '');
    if (r.available == false) return S.domTaken.of(context);
    return S.domUnknown.of(context);
  }

  Color _statusColor(DomainResult r) {
    final nz = context.nz;
    if (r.blocked) return nz.muted;
    if (r.available == true) return toneColors(context, Tone.success).$2;
    if (r.available == false) return nz.danger;
    return toneColors(context, Tone.warn).$2;
  }

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    final results = _results;
    DomainResult? best;
    if (results != null) {
      best = results.where((r) => r.name == _asked && r.available == true && !r.blocked).firstOrNull ??
          results.where((r) => r.canBuy).firstOrNull ??
          results.where((r) => r.available == true && !r.blocked).firstOrNull;
    }
    final rest = [for (final r in results ?? const <DomainResult>[]) if (!identical(r, best)) r];

    Widget hero = Padding(
      padding: widget.plain ? const EdgeInsets.fromLTRB(4, 10, 4, 4) : const EdgeInsets.fromLTRB(16, 18, 16, 16),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text(S.domEyebrow.of(context), style: TextStyle(color: nz.accent, fontSize: 12, fontWeight: FontWeight.w800, letterSpacing: 0.4)),
        const SizedBox(height: 4),
        Text(S.domHero.of(context), style: TextStyle(color: nz.fg, fontSize: 21, fontWeight: FontWeight.w800)),
        const SizedBox(height: 4),
        Text(S.domBody.of(context), style: TextStyle(color: nz.muted, fontSize: 13.5, height: 1.5)),
        const SizedBox(height: 16),
        // The field with the accent ring and glow (`.dt-field`).
        Container(
          padding: const EdgeInsets.all(1.5),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(18),
            gradient: cssLinear(100, [nz.accentStrong, nz.accent, nz.accentStrong], const [0, 0.5, 1]),
            boxShadow: [BoxShadow(color: nz.accent.withValues(alpha: 0.16), blurRadius: 28, offset: const Offset(0, 8), spreadRadius: -8)],
          ),
          child: Container(
            padding: const EdgeInsetsDirectional.fromSTEB(12, 5, 5, 5),
            decoration: BoxDecoration(color: nz.card, borderRadius: BorderRadius.circular(16.5)),
            child: Row(children: [
              Icon(NzIcons.search, color: nz.muted, size: 21),
              Expanded(
                child: TextField(
                  controller: _ctrl,
                  textDirection: TextDirection.ltr,
                  autocorrect: false,
                  enableSuggestions: false,
                  keyboardType: TextInputType.url,
                  textInputAction: TextInputAction.search,
                  onSubmitted: (_) => _check(),
                  style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
                  decoration: InputDecoration(
                    hintText: S.domPlaceholder.of(context),
                    hintStyle: TextStyle(color: nz.muted, fontSize: 14, fontWeight: FontWeight.w400),
                    filled: false,
                    border: InputBorder.none,
                    enabledBorder: InputBorder.none,
                    focusedBorder: InputBorder.none,
                    contentPadding: const EdgeInsets.symmetric(horizontal: 10),
                  ),
                ),
              ),
              FilledButton(
                onPressed: _busy ? null : _check,
                style: FilledButton.styleFrom(minimumSize: const Size(0, 46), padding: const EdgeInsets.symmetric(horizontal: 16)),
                child: _busy
                    ? SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: nz.orangeInk))
                    : Text(S.domSearchGo.of(context)),
              ),
            ]),
          ),
        ),
        const SizedBox(height: 14),
        Text(S.domExtensions.of(context), style: TextStyle(color: nz.muted, fontSize: 12.5, fontWeight: FontWeight.w700)),
        const SizedBox(height: 8),
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final t in kSoldTlds)
            _TldChip(
              tld: t,
              selected: _picked.contains(t),
              onTap: () {
                setState(() => _picked.contains(t) ? _picked.remove(t) : _picked.add(t));
                if (_results != null) _check();
              },
            ),
        ]),
        const SizedBox(height: 12),
        Text(S.domHelp.of(context), style: TextStyle(color: nz.muted, fontSize: 11.5, height: 1.5)),
      ]),
    );
    if (!widget.plain) {
      // Wrapping in list order puts the last layer (the opaque wash) at the bottom and the glows above it.
    for (final g in nz.heroLayers) {
        hero = DecoratedBox(decoration: BoxDecoration(gradient: g), child: hero);
      }
      hero = ClipRRect(borderRadius: BorderRadius.circular(22), child: Material(color: nz.card, child: hero));
    }

    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      hero,
      if (_error != null)
        Padding(
          padding: const EdgeInsets.only(top: 14),
          child: Text(_error!, textAlign: TextAlign.center, style: TextStyle(color: nz.danger, fontWeight: FontWeight.w700)),
        ),
      if (results != null) ...[
        Padding(
          padding: const EdgeInsets.fromLTRB(6, 20, 6, 10),
          child: Text(S.domResults.of(context), style: TextStyle(color: nz.muted, fontSize: 13, fontWeight: FontWeight.w700)),
        ),
        if (results.isEmpty) StateView(icon: NzIcons.globe, title: S.noResults.of(context), hint: S.noResultsHint.of(context)),
        if (best != null) _bestCard(best),
        if (rest.isNotEmpty)
          Padding(
            padding: EdgeInsets.only(top: best == null ? 0 : 12),
            child: NzCard(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Column(children: [
                for (final (i, r) in rest.indexed) ...[
                  if (i > 0) Divider(height: 1, indent: 16, endIndent: 16, color: nz.fg.withValues(alpha: 0.06)),
                  _row(r),
                ],
              ]),
            ),
          ),
      ],
    ]);
  }

  Widget _price(DomainResult r, {double size = 15}) {
    final nz = context.nz;
    if (r.price != null) {
      return Column(crossAxisAlignment: CrossAxisAlignment.end, mainAxisSize: MainAxisSize.min, children: [
        LtrText(displayValue(r.price!, context), style: TextStyle(color: nz.fg, fontSize: size, fontWeight: FontWeight.w800)),
        Text(S.domPerYear.of(context), style: TextStyle(color: nz.muted, fontSize: 11)),
      ]);
    }
    if (r.available == true && !r.blocked) return Text(S.domNoPrice.of(context), style: TextStyle(color: nz.muted, fontSize: 11.5));
    return const SizedBox.shrink();
  }

  Widget _bestCard(DomainResult r) {
    final nz = context.nz;
    return Container(
      padding: const EdgeInsets.all(1.5),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(22),
        gradient: NuzmColors.brandGradient,
        boxShadow: [BoxShadow(color: nz.accent.withValues(alpha: 0.16), blurRadius: 26, offset: const Offset(0, 10), spreadRadius: -10)],
      ),
      child: Container(
        padding: const EdgeInsets.fromLTRB(18, 16, 18, 16),
        decoration: BoxDecoration(color: nz.card, borderRadius: BorderRadius.circular(20.5)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [
            Icon(NzIcons.circleCheck, size: 16, color: nz.accent),
            const SizedBox(width: 6),
            Text(S.domBest.of(context), style: TextStyle(color: nz.accent, fontSize: 12.5, fontWeight: FontWeight.w800)),
          ]),
          const SizedBox(height: 10),
          Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                FittedBox(
                  fit: BoxFit.scaleDown,
                  alignment: AlignmentDirectional.centerStart,
                  child: LtrText(r.name, style: TextStyle(color: nz.fg, fontSize: 22, fontWeight: FontWeight.w800)),
                ),
                const SizedBox(height: 4),
                Text(_status(r), style: TextStyle(color: _statusColor(r), fontSize: 13, fontWeight: FontWeight.w700)),
              ]),
            ),
            const SizedBox(width: 10),
            _price(r, size: 18),
          ]),
          const SizedBox(height: 14),
          if (r.canBuy)
            FilledButton.icon(onPressed: () => _register(r), icon: Icon(NzIcons.globe, size: 18), label: Text(S.domRegister.of(context)))
          else
            Text(S.domNotForSale.of(context), style: TextStyle(color: nz.muted, fontSize: 12.5)),
        ]),
      ),
    );
  }

  Widget _row(DomainResult r) {
    final nz = context.nz;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 12, 12),
      child: Row(children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            LtrText(r.name, style: TextStyle(color: nz.fg, fontSize: 15, fontWeight: FontWeight.w700)),
            const SizedBox(height: 2),
            Text(_status(r), maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: _statusColor(r), fontSize: 12)),
          ]),
        ),
        const SizedBox(width: 8),
        _price(r),
        if (r.canBuy) ...[
          const SizedBox(width: 8),
          Tooltip(
            message: S.domRegister.of(context),
            child: Material(
              color: nz.accentSoft,
              shape: const CircleBorder(),
              child: InkWell(
                customBorder: const CircleBorder(),
                onTap: () => _register(r),
                child: SizedBox(width: 38, height: 38, child: Icon(NzIcons.plus, size: 18, color: nz.accent)),
              ),
            ),
          ),
        ],
      ]),
    );
  }
}

class _TldChip extends StatelessWidget {
  const _TldChip({required this.tld, required this.selected, required this.onTap});
  final String tld;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    return Semantics(
      button: true,
      selected: selected,
      child: Material(
        color: selected ? nz.accent : nz.elev,
        borderRadius: BorderRadius.circular(12),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              if (selected) ...[Icon(NzIcons.check, size: 14, color: nz.onAccent), const SizedBox(width: 4)],
              Text('.$tld',
                  textDirection: TextDirection.ltr,
                  style: TextStyle(color: selected ? nz.onAccent : nz.fg, fontSize: 14, fontWeight: FontWeight.w800)),
            ]),
          ),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------- builder

class BuilderStartView extends StatefulWidget {
  const BuilderStartView({super.key});

  @override
  State<BuilderStartView> createState() => _BuilderStartViewState();
}

class _BuilderStartViewState extends State<BuilderStartView> {
  final _ctrl = TextEditingController();

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      NzCard(
        padding: const EdgeInsets.all(20),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [
            const IconTile(NzIcons.sparkles, size: 44, tone: Tone.accent),
            const SizedBox(width: 12),
            Expanded(child: Text(S.builderPrompt.of(context), style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800))),
          ]),
          const SizedBox(height: 16),
          TextField(
            controller: _ctrl,
            minLines: 4,
            maxLines: 8,
            decoration: InputDecoration(
              hintText: S.builderHint.of(context),
            ),
          ),
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: () {
              final t = _ctrl.text.trim();
              if (t.isNotEmpty) askAi(context, t);
            },
            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(50)),
            icon: const Icon(NzIcons.sparkles, size: 18),
            label: Text(S.startBuilding.of(context), style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
          ),
        ]),
      ),
      _SectionTitle(S.ideas.of(context)),
      for (final c in kSuggestions)
        Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: NzCard(
            onTap: () => _ctrl.text = c.of(context),
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 16),
            child: Row(children: [
              Icon(NzIcons.sparkles, size: 18, color: nz.accent),
              const SizedBox(width: 12),
              Expanded(child: Text(c.of(context), style: const TextStyle(fontWeight: FontWeight.w600))),
            ]),
          ),
        ),
    ]);
  }
}


/// Lets anything inside a page reload it after a successful write.
class PageRefresh extends InheritedWidget {
  const PageRefresh({super.key, required this.reload, required super.child});
  final Future<void> Function() reload;

  static Future<void> Function()? of(BuildContext context) => context.getInheritedWidgetOfExactType<PageRefresh>()?.reload;

  @override
  bool updateShouldNotify(PageRefresh old) => false;
}

Future<void> _runAndRefresh(BuildContext context, ActionDef a, Map<String, dynamic> raw) async {
  final refresh = PageRefresh.of(context);
  if (await runAction(context, a, item: raw)) await refresh?.call();
}

/// The page's own writes (create, edit, set) as buttons: the first in the orange primary style.
class PageActionsBar extends StatelessWidget {
  const PageActionsBar({super.key, required this.actions, this.raw = const {}});
  final List<ActionDef> actions;
  final Map<String, dynamic> raw;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 14),
        child: Wrap(spacing: 10, runSpacing: 10, children: [
          for (final (i, a) in actions.indexed)
            i == 0
                ? FilledButton.icon(
                    onPressed: () => _runAndRefresh(context, a, raw),
                    icon: Icon(a.icon, size: 18),
                    label: Text(a.label.of(context)),
                  )
                : OutlinedButton.icon(
                    onPressed: () => _runAndRefresh(context, a, raw),
                    icon: Icon(a.icon, size: 18),
                    label: Text(a.label.of(context)),
                  ),
        ]),
      );
}

// ---------------------------------------------------------------- floating add button

/// What the floating "+" does on a page: hosting and cloud open their plans, domains open the search, email pages
/// run their create form. Only the sections the app treats as "my items" lists get one.
class PageFab {
  const PageFab(this.label, this.run);
  final T label;

  /// True when something was created (the page reloads).
  final Future<bool> Function(BuildContext context, ValueChanged<String>? openTab) run;
}

const _fabCategories = {'cloud', 'hosting', 'domains', 'email'};

PageFab? pageFab(String pageId) {
  switch (pageId) {
    case 'sites':
      return PageFab(S.hostingPlans, (c, _) => openPlans(c, 'hosting'));
    case 'instances':
      return PageFab(S.cloudPlans, (c, _) => openPlans(c, 'cloud'));
    case 'domainList':
      return PageFab(S.addDomain, (c, _) => openDomainAdd(c));
  }
  final cat = findPage(pageId).$1;
  final create = (kPageActions[pageId] ?? const <ActionDef>[]).where((a) => a.id == 'create').firstOrNull;
  if (!_fabCategories.contains(cat.id) || create == null) return null;
  return PageFab(create.label, (c, _) => runAction(c, create));
}

/// The floating "+": the orange gradient disc of the console's primary action.
class FloatingAdd extends StatelessWidget {
  const FloatingAdd({super.key, required this.tooltip, required this.onTap});
  final String tooltip;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    return Tooltip(
      message: tooltip,
      child: Semantics(
        button: true,
        label: tooltip,
        child: Container(
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            boxShadow: [BoxShadow(color: nz.orange.withValues(alpha: 0.35), blurRadius: 22, offset: const Offset(0, 8), spreadRadius: -4)],
          ),
          child: Material(
            shape: const CircleBorder(),
            clipBehavior: Clip.antiAlias,
            color: Colors.transparent,
            child: Ink(
              decoration: BoxDecoration(shape: BoxShape.circle, gradient: NuzmColors.orangeGradient),
              child: InkWell(
                onTap: onTap,
                child: SizedBox(width: 58, height: 58, child: Icon(NzIcons.plus, size: 26, color: nz.orangeInk)),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
