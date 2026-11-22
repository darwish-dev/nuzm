import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../data/demo.dart';
import '../data/nav.dart';
import '../l10n/strings.dart';
import '../theme/nuzm_colors.dart';
import '../widgets/common.dart';
import 'detail_screen.dart';
import 'section_screen.dart';

enum LoadState { loading, ready, error }

/// One console page. Shows loading → content (or the empty / error state), and pull-to-refresh reloads it.
class PageBody extends StatefulWidget {
  const PageBody({super.key, required this.page, this.loadDelay = const Duration(milliseconds: 450), this.forceError = false});
  final NavPage page;
  final Duration loadDelay;

  /// Shows the error state (used by tests; the sample data never fails).
  final bool forceError;

  @override
  State<PageBody> createState() => _PageBodyState();
}

class _PageBodyState extends State<PageBody> {
  LoadState _state = LoadState.loading;
  Timer? _t;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _t?.cancel();
    super.dispose();
  }

  Future<void> _load() {
    final done = Completer<void>();
    setState(() => _state = LoadState.loading);
    _t?.cancel();
    _t = Timer(widget.loadDelay, () {
      if (mounted) setState(() => _state = widget.forceError ? LoadState.error : LoadState.ready);
      done.complete();
    });
    return done.future;
  }

  @override
  Widget build(BuildContext context) {
    final Widget body = switch (_state) {
      LoadState.loading => const SkeletonList(),
      LoadState.error => StateView(
          icon: LucideIcons.cloudOff,
          tone: Tone.danger,
          title: S.errorTitle.of(context),
          hint: S.errorHint.of(context),
          action: S.retry.of(context),
          onAction: _load,
        ),
      LoadState.ready => _content(context),
    };
    return RefreshIndicator(
      onRefresh: _load,
      color: context.nz.accentStrong,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
        children: [body],
      ),
    );
  }

  Widget _content(BuildContext context) {
    final p = widget.page;
    return switch (p.kind) {
      PageKind.dashboard => const DashboardView(),
      PageKind.list => ResourceListView(page: p, items: kLists[p.id] ?? const []),
      PageKind.stats => StatsView(page: p),
      PageKind.catalog => CatalogView(items: kCatalogs[p.id] ?? const []),
      PageKind.form => FormView(fields: kForms[p.id] ?? const []),
      PageKind.domainSearch => const DomainSearchView(),
      PageKind.builder => const BuilderStartView(),
    };
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
  const DashboardView({super.key});

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      // Highlight card in the brand gradient.
      Container(
        padding: const EdgeInsets.all(20),
        decoration: BoxDecoration(gradient: NuzmColors.brandGradient, borderRadius: BorderRadius.circular(28)),
        child: Row(children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(kOrgName.of(context), style: const TextStyle(color: Color(0xFF14181B), fontSize: 18, fontWeight: FontWeight.w800)),
              const SizedBox(height: 4),
              Text('${S.services.of(context)}: 13 · ${kRegion.of(context)}',
                  style: const TextStyle(color: Color(0xFF34434D), fontWeight: FontWeight.w600)),
              const SizedBox(height: 14),
              FilledButton.icon(
                onPressed: () => askAi(context, S.heroLine.of(context)),
                style: FilledButton.styleFrom(
                  backgroundColor: const Color(0xFF14181B),
                  foregroundColor: const Color(0xFFF4F0E8),
                  minimumSize: const Size(0, 46),
                  shape: const StadiumBorder(),
                ),
                icon: const Icon(LucideIcons.sparkles, size: 18),
                label: Text(S.askAi.of(context)),
              ),
            ]),
          ),
          Image.asset('assets/brand/nuzm-mark.png', width: 92, excludeFromSemantics: true),
        ]),
      ),
      const SizedBox(height: 14),
      GridView.count(
        crossAxisCount: 2,
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        mainAxisSpacing: 12,
        crossAxisSpacing: 12,
        childAspectRatio: 1.35,
        children: [for (final s in kDashboardStats) _StatCard(s, compact: true)],
      ),
      _SectionTitle(S.needsAttention.of(context)),
      NzCard(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Column(children: [
          for (final (text, pageId, tone) in kAttention)
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
            avatar: Icon(c.icon, size: 17, color: nz.accentStrong),
            label: Text(c.label.of(context)),
            backgroundColor: nz.card,
            side: BorderSide.none,
            shape: const StadiumBorder(),
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
      return StateView(
        icon: page.icon,
        title: S.emptyTitle.of(context),
        hint: S.emptyHint.of(context),
        action: S.create.of(context),
        onAction: () => showSoon(context),
      );
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(8, 4, 0, 12),
        child: Row(children: [
          Expanded(
            child: Text('${page.label.of(context)} · ${items.length}',
                style: TextStyle(color: context.nz.muted, fontWeight: FontWeight.w700)),
          ),
          FilledButton.icon(
            onPressed: () => showSoon(context),
            style: FilledButton.styleFrom(minimumSize: const Size(0, 44), shape: const StadiumBorder()),
            icon: const Icon(LucideIcons.plus, size: 18),
            label: Text(S.create.of(context)),
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
      onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => DetailScreen(item: item, page: page))),
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

class StatsView extends StatelessWidget {
  const StatsView({super.key, required this.page});
  final NavPage page;

  @override
  Widget build(BuildContext context) {
    final stats = kStats[page.id] ?? const [];
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      for (final s in stats) Padding(padding: const EdgeInsets.only(bottom: 12), child: _StatCard(s)),
      if (page.id == 'billingOverview') ...[
        _SectionTitle(pageLabel('invoices').of(context),
            trailing: TextButton(onPressed: () => openPage(context, 'invoices'), child: Text(S.viewAll.of(context)))),
        for (final it in kLists['invoices']!.take(2))
          Padding(padding: const EdgeInsets.only(bottom: 12), child: ItemCard(item: it, page: findPage('invoices').$2)),
      ],
    ]);
  }
}

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
          ClipRRect(
            borderRadius: BorderRadius.circular(6),
            child: LinearProgressIndicator(
              value: stat.progress,
              minHeight: 8,
              backgroundColor: nz.elev,
              color: stat.progress! >= 0.8 ? nz.orange : nz.accentStrong,
              semanticsLabel: stat.label.of(context),
            ),
          ),
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
  late final List<bool> _toggles = [for (final f in widget.fields) f.toggle ?? false];

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      NzCard(
        padding: const EdgeInsets.fromLTRB(18, 8, 18, 8),
        child: Column(children: [
          for (var i = 0; i < widget.fields.length; i++) ...[
            if (i > 0) Divider(color: nz.border, height: 1),
            _field(context, i),
          ],
        ]),
      ),
      const SizedBox(height: 18),
      FilledButton(
        onPressed: () => showSoon(context),
        style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(54), shape: const StadiumBorder()),
        child: Text(S.save.of(context), style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
      ),
    ]);
  }

  Widget _field(BuildContext context, int i) {
    final nz = context.nz;
    final f = widget.fields[i];
    if (f.toggle != null) {
      return SwitchListTile(
        contentPadding: EdgeInsets.zero,
        value: _toggles[i],
        activeThumbColor: nz.onPrimaryFill,
        activeTrackColor: nz.primaryFill,
        onChanged: (v) => setState(() => _toggles[i] = v),
        title: Text(f.label.of(context), style: const TextStyle(fontWeight: FontWeight.w700)),
        subtitle: f.hint == null ? null : Text(f.hint!.of(context), style: TextStyle(color: nz.muted)),
      );
    }
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: TextFormField(
        initialValue: f.value,
        textDirection: f.ltr ? TextDirection.ltr : null,
        decoration: InputDecoration(
          labelText: f.label.of(context),
          helperText: f.hint?.of(context),
          helperMaxLines: 2,
          filled: true,
          fillColor: nz.elev.withValues(alpha: 0.6),
          border: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: BorderSide.none),
          focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: BorderSide(color: nz.accentStrong, width: 1.5)),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------- domain search

class DomainSearchView extends StatefulWidget {
  const DomainSearchView({super.key});

  @override
  State<DomainSearchView> createState() => _DomainSearchViewState();
}

class _DomainSearchViewState extends State<DomainSearchView> {
  final _ctrl = TextEditingController();
  List<(String, bool)> _results = const [];

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  void _check() {
    final base = _ctrl.text.trim().toLowerCase().split('.').first.replaceAll(RegExp(r'[^a-z0-9-]'), '');
    if (base.isEmpty) return;
    // Sample result: deterministic, not a live availability check.
    setState(() => _results = [
          for (final (i, tld) in ['.sa', '.com', '.com.sa', '.net', '.store'].indexed) ('$base$tld', (base.length + i).isEven),
        ]);
  }

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      NzCard(
        padding: const EdgeInsets.all(8),
        radius: 40,
        child: Row(children: [
          const SizedBox(width: 12),
          Icon(LucideIcons.globe, color: nz.muted),
          Expanded(
            child: TextField(
              controller: _ctrl,
              textDirection: TextDirection.ltr,
              onSubmitted: (_) => _check(),
              decoration: InputDecoration(
                hintText: S.searchDomain.of(context),
                border: InputBorder.none,
                contentPadding: const EdgeInsets.symmetric(horizontal: 12),
              ),
            ),
          ),
          FilledButton(
            onPressed: _check,
            style: FilledButton.styleFrom(minimumSize: const Size(0, 48), shape: const StadiumBorder()),
            child: Text(S.check.of(context)),
          ),
        ]),
      ),
      const SizedBox(height: 14),
      for (final (name, ok) in _results)
        Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: NzCard(
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 16),
            child: Row(children: [
              Expanded(child: LtrText(name, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700))),
              StatusChip(ok ? Status(S.available, Tone.success) : Status(S.taken, Tone.neutral)),
            ]),
          ),
        ),
    ]);
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
            const IconTile(LucideIcons.sparkles, size: 44, tone: Tone.accent),
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
              hintStyle: TextStyle(color: nz.muted),
              filled: true,
              fillColor: nz.elev.withValues(alpha: 0.6),
              border: OutlineInputBorder(borderRadius: BorderRadius.circular(18), borderSide: BorderSide.none),
            ),
          ),
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: () {
              final t = _ctrl.text.trim();
              if (t.isNotEmpty) askAi(context, t);
            },
            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(54), shape: const StadiumBorder()),
            icon: const Icon(LucideIcons.sparkles, size: 18),
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
              Icon(LucideIcons.sparkles, size: 18, color: nz.accent),
              const SizedBox(width: 12),
              Expanded(child: Text(c.of(context), style: const TextStyle(fontWeight: FontWeight.w600))),
            ]),
          ),
        ),
    ]);
  }
}
