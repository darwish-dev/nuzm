import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../app_scope.dart';
import '../data/data_source.dart';
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
  late Future<List<ChatSummary>> _chats;

  @override
  void initState() {
    super.initState();
    _chats = AppScope.read(context).data.recentChats();
  }

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
    return NzScaffold(
      header: Row(children: [
        CircleIconButton(
          icon: dark ? LucideIcons.sun : LucideIcons.moon,
          tooltip: (dark ? S.lightMode : S.darkMode).of(context),
          onTap: () => app.toggleTheme(Theme.of(context).brightness),
        ),
        const SizedBox(width: 8),
        CircleIconButton(icon: LucideIcons.languages, tooltip: S.language.of(context), onTap: app.toggleLocale),
        const Spacer(),
        CircleIconButton(
          icon: LucideIcons.bell,
          tooltip: S.notifications.of(context),
          dot: true,
          onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const NotificationsScreen())),
        ),
        const SizedBox(width: 8),
        CircleIconButton(icon: LucideIcons.x, tooltip: S.close.of(context), onTap: () => Navigator.of(context).pop()),
      ]),
      body: CustomScrollView(slivers: [
            SliverPadding(
              padding: const EdgeInsets.fromLTRB(14, 16, 14, 0),
              sliver: SliverList.list(children: [
                _SearchField(controller: _search, onChanged: (v) => setState(() => _q = v.trim())),
                const SizedBox(height: 20),
              ]),
            ),
            if (_q.isNotEmpty) _results(context) else ..._browse(context, nz),
            const SliverToBoxAdapter(child: SizedBox(height: 32)),
      ]),
    );
  }

  List<Widget> _browse(BuildContext context, NuzmColors nz) => [
        SliverToBoxAdapter(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [for (final id in _quick) Expanded(child: _QuickCircle(categoryById(id)))],
            ),
          ),
        ),
        SliverToBoxAdapter(
          child: Center(
            child: Container(
              margin: const EdgeInsets.symmetric(vertical: 22),
              width: 48,
              height: 4,
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
              child: FutureBuilder<List<ChatSummary>>(
                future: _chats,
                builder: (context, snap) {
                  if (snap.connectionState != ConnectionState.done) {
                    return const Padding(padding: EdgeInsets.all(20), child: Center(child: CircularProgressIndicator(strokeWidth: 2.5)));
                  }
                  final chats = snap.data ?? const <ChatSummary>[];
                  if (chats.isEmpty) {
                    return ListTile(
                      minTileHeight: 64,
                      contentPadding: const EdgeInsets.symmetric(horizontal: 20),
                      leading: Icon(LucideIcons.messageCircle, color: nz.muted),
                      title: Text(snap.hasError ? S.errorTitle.of(context) : S.noChats.of(context), style: TextStyle(color: nz.muted)),
                    );
                  }
                  return Column(children: [
                    for (final c in chats)
                      ListTile(
                        minTileHeight: 64,
                        contentPadding: const EdgeInsets.symmetric(horizontal: 20),
                        leading: Icon(LucideIcons.messageCircle, color: nz.muted),
                        title: Text(c.title.of(context),
                            maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                        trailing: const ForwardChevron(),
                        onTap: () => Navigator.of(context).pop(c),
                      ),
                  ]);
                },
              ),
            ),
          ),
        ),
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(16, 18, 16, 0),
          sliver: SliverToBoxAdapter(child: _AccountCard()),
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

/// Who is signed in, which organization is active (switchable), and sign-out.
class _AccountCard extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    final app = AppScope.of(context);
    final live = app.data.isLive;
    return NzCard(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Column(children: [
        ListTile(
          minTileHeight: 64,
          contentPadding: const EdgeInsets.symmetric(horizontal: 20),
          leading: const IconTile(LucideIcons.building2, size: 44, tone: Tone.accent),
          title: Text(app.data.orgName.of(context), style: const TextStyle(fontWeight: FontWeight.w800)),
          subtitle: live && app.email != null
              ? LtrText('${app.email}', style: TextStyle(color: nz.muted, fontSize: 13))
              : Text(S.sampleData.of(context), style: TextStyle(color: nz.orangeText, fontSize: 13)),
          trailing: live && app.organizations.length > 1 ? const ForwardChevron() : null,
          onTap: live && app.organizations.length > 1 ? () => _pickOrg(context, app) : null,
        ),
        Divider(height: 1, color: nz.border),
        ListTile(
          minTileHeight: 56,
          contentPadding: const EdgeInsets.symmetric(horizontal: 20),
          leading: Icon(live || !app.canUseLive ? LucideIcons.logOut : LucideIcons.user, color: nz.danger),
          title: Text(live || !app.canUseLive ? S.signOut.of(context) : S.signIn.of(context),
              style: TextStyle(color: nz.danger, fontWeight: FontWeight.w700)),
          onTap: () {
            Navigator.of(context).popUntil((r) => r.isFirst);
            app.signOut();
          },
        ),
      ]),
    );
  }

  void _pickOrg(BuildContext context, AppController app) {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      backgroundColor: context.nz.card,
      builder: (sheet) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Text(S.switchOrg.of(context), style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800)),
          ),
          for (final o in app.organizations)
            ListTile(
              leading: Icon(o.orgId == app.organization?.orgId ? LucideIcons.circleCheck : LucideIcons.building2),
              title: Text(o.name),
              subtitle: Text(o.role),
              onTap: () {
                Navigator.of(sheet).pop();
                Navigator.of(context).popUntil((r) => r.isFirst);
                app.switchOrg(o.orgId);
              },
            ),
        ]),
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
      style: const TextStyle(fontSize: 15.5),
      decoration: InputDecoration(
        hintText: S.search.of(context),
        prefixIcon: Padding(
          padding: const EdgeInsetsDirectional.only(start: 14, end: 6),
          child: Icon(LucideIcons.search, color: nz.muted, size: 20),
        ),
        contentPadding: const EdgeInsets.symmetric(vertical: 16),
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
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 2),
          child: Column(children: [
            Stack(clipBehavior: Clip.none, children: [
              Container(
                width: 64,
                height: 64,
                decoration: BoxDecoration(color: nz.card, shape: BoxShape.circle, border: Border.all(color: nz.border)),
                child: Icon(category.icon, size: 24, color: nz.accent),
              ),
              if (category.badge > 0) PositionedDirectional(top: -4, end: -6, child: CountBadge(category.badge)),
            ]),
            const SizedBox(height: 8),
            Text(category.label.of(context),
                maxLines: 2,
                textAlign: TextAlign.center,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, height: 1.25)),
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
      padding: const EdgeInsets.symmetric(horizontal: 12),
      child: Row(children: [
        // The count sits on the icon's corner so the label keeps the full width (no mid-word breaks).
        Stack(clipBehavior: Clip.none, children: [
          IconTile(category.icon, size: 44),
          if (category.badge > 0) PositionedDirectional(top: -7, end: -7, child: CountBadge(category.badge)),
        ]),
        const SizedBox(width: 10),
        Expanded(
          child: Text(category.label.of(context),
              maxLines: 2, softWrap: true, overflow: TextOverflow.fade,
              style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700, height: 1.25)),
        ),
      ]),
    );
  }
}
