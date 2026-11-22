import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../app_scope.dart';
import '../data/demo.dart';
import '../data/nav.dart';
import '../l10n/strings.dart';
import '../theme/nuzm_colors.dart';
import '../widgets/common.dart';
import 'notifications_screen.dart';
import 'section_screen.dart';

/// The menu: quick circles, every console section as a tile, and the recent Nuzm AI chats.
/// Pops with a chat text when a recent chat is picked (the home screen reopens it).
class MenuScreen extends StatefulWidget {
  const MenuScreen({super.key});

  @override
  State<MenuScreen> createState() => _MenuScreenState();
}

class _MenuScreenState extends State<MenuScreen> {
  final _search = TextEditingController();
  String _q = '';

  static const _quick = ['dashboard', 'cloud', 'hosting', 'domains', 'email'];

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    final app = AppScope.of(context);
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Scaffold(
      body: NzBackground(
        child: SafeArea(
          bottom: false,
          child: CustomScrollView(slivers: [
            SliverPadding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
              sliver: SliverList.list(children: [
                Row(children: [
                  CircleIconButton(
                    icon: dark ? LucideIcons.sun : LucideIcons.moon,
                    tooltip: (dark ? S.lightMode : S.darkMode).of(context),
                    onTap: () => app.toggleTheme(Theme.of(context).brightness),
                  ),
                  const SizedBox(width: 10),
                  CircleIconButton(icon: LucideIcons.languages, tooltip: S.language.of(context), onTap: app.toggleLocale),
                  const Spacer(),
                  CircleIconButton(
                    icon: LucideIcons.bell,
                    tooltip: S.notifications.of(context),
                    dot: true,
                    onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const NotificationsScreen())),
                  ),
                  const SizedBox(width: 10),
                  CircleIconButton(icon: LucideIcons.x, tooltip: S.close.of(context), onTap: () => Navigator.of(context).pop()),
                ]),
                const SizedBox(height: 18),
                _SearchField(controller: _search, onChanged: (v) => setState(() => _q = v.trim())),
                const SizedBox(height: 22),
              ]),
            ),
            if (_q.isNotEmpty) _results(context) else ..._browse(context, nz),
            const SliverToBoxAdapter(child: SizedBox(height: 32)),
          ]),
        ),
      ),
    );
  }

  List<Widget> _browse(BuildContext context, NuzmColors nz) => [
        SliverToBoxAdapter(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceAround,
              children: [for (final id in _quick) _QuickCircle(categoryById(id))],
            ),
          ),
        ),
        SliverToBoxAdapter(
          child: Center(
            child: Container(
              margin: const EdgeInsets.symmetric(vertical: 22),
              width: 56,
              height: 5,
              decoration: BoxDecoration(color: nz.border, borderRadius: BorderRadius.circular(3)),
            ),
          ),
        ),
        SliverPadding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          sliver: SliverGrid.builder(
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: 2,
              mainAxisSpacing: 14,
              crossAxisSpacing: 14,
              mainAxisExtent: 92,
            ),
            itemCount: kCategories.length,
            itemBuilder: (context, i) => _CategoryTile(kCategories[i]),
          ),
        ),
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(24, 28, 24, 10),
          sliver: SliverToBoxAdapter(
            child: Text(S.recentChats.of(context),
                style: TextStyle(color: nz.muted, fontSize: 16, fontWeight: FontWeight.w700)),
          ),
        ),
        SliverPadding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          sliver: SliverToBoxAdapter(
            child: NzCard(
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: Column(children: [
                for (final c in kRecentChats)
                  ListTile(
                    minTileHeight: 64,
                    contentPadding: const EdgeInsets.symmetric(horizontal: 20),
                    leading: Icon(LucideIcons.messageCircle, color: nz.muted),
                    title: Text(c.of(context), maxLines: 1, overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                    trailing: const ForwardChevron(),
                    onTap: () => Navigator.of(context).pop(c.of(context)),
                  ),
              ]),
            ),
          ),
        ),
      ];

  Widget _results(BuildContext context) {
    final q = _q.toLowerCase();
    final hits = <(NavCategory, NavPage)>[
      for (final c in kCategories)
        for (final p in c.pages)
          if ([p.label.ar, p.label.en, c.label.ar, c.label.en].any((s) => s.toLowerCase().contains(q))) (c, p),
    ];
    if (hits.isEmpty) {
      return SliverToBoxAdapter(
        child: StateView(icon: LucideIcons.search, title: S.noResults.of(context), hint: S.noResultsHint.of(context)),
      );
    }
    return SliverPadding(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      sliver: SliverList.separated(
        itemCount: hits.length,
        separatorBuilder: (_, __) => const SizedBox(height: 10),
        itemBuilder: (context, i) {
          final (c, p) = hits[i];
          return NzCard(
            onTap: () => openPage(context, p.id),
            padding: const EdgeInsets.all(12),
            child: Row(children: [
              IconTile(p.icon, size: 46),
              const SizedBox(width: 14),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(p.label.of(context), style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
                  Text(c.label.of(context), style: TextStyle(color: context.nz.muted, fontSize: 13)),
                ]),
              ),
              const ForwardChevron(),
            ]),
          );
        },
      ),
    );
  }
}

class _SearchField extends StatelessWidget {
  const _SearchField({required this.controller, required this.onChanged});
  final TextEditingController controller;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    return TextField(
      controller: controller,
      onChanged: onChanged,
      style: const TextStyle(fontSize: 16),
      decoration: InputDecoration(
        filled: true,
        fillColor: nz.card,
        hintText: S.search.of(context),
        hintStyle: TextStyle(color: nz.muted),
        prefixIcon: Padding(
          padding: const EdgeInsetsDirectional.only(start: 18, end: 8),
          child: Icon(LucideIcons.search, color: nz.muted),
        ),
        contentPadding: const EdgeInsets.symmetric(vertical: 22),
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(40), borderSide: BorderSide.none),
        focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(40), borderSide: BorderSide(color: nz.accentStrong, width: 1.5)),
      ),
    );
  }
}

class _QuickCircle extends StatelessWidget {
  const _QuickCircle(this.category);
  final NavCategory category;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    return Semantics(
      button: true,
      label: category.label.of(context),
      excludeSemantics: true,
      child: InkWell(
        borderRadius: BorderRadius.circular(20),
        onTap: () => openPage(context, category.pages.first.id),
        child: SizedBox(
          width: 72,
          child: Column(children: [
            Stack(clipBehavior: Clip.none, children: [
              Container(
                width: 64,
                height: 64,
                decoration: BoxDecoration(color: nz.card, shape: BoxShape.circle),
                child: Icon(category.icon, size: 26, color: nz.fg),
              ),
              if (category.badge > 0) PositionedDirectional(top: -4, end: -6, child: CountBadge(category.badge)),
            ]),
            const SizedBox(height: 8),
            Text(category.label.of(context),
                maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600)),
          ]),
        ),
      ),
    );
  }
}

class _CategoryTile extends StatelessWidget {
  const _CategoryTile(this.category);
  final NavCategory category;

  @override
  Widget build(BuildContext context) {
    return NzCard(
      onTap: () => openPage(context, category.pages.first.id),
      padding: const EdgeInsets.symmetric(horizontal: 14),
      child: Row(children: [
        IconTile(category.icon),
        const SizedBox(width: 14),
        Expanded(
          child: Text(category.label.of(context),
              maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
        ),
        if (category.badge > 0) CountBadge(category.badge, solidAccent: true),
      ]),
    );
  }
}
