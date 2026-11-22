import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../app_scope.dart';
import '../data/data_source.dart';
import '../data/nav.dart';
import '../l10n/strings.dart';
import '../theme/nuzm_colors.dart';
import '../widgets/common.dart';
import 'notifications_screen.dart';
import 'section_screen.dart';

/// The menu: the wallet and AI credits, the organization switcher, every console section as a compact borderless
/// tile, the recent Nuzm AI chats, and settings (appearance, language, sign-out). Pops with a chat when a recent chat is picked (the home screen reopens it).
class MenuScreen extends StatefulWidget {
  const MenuScreen({super.key});

  @override
  State<MenuScreen> createState() => _MenuScreenState();
}

class _MenuScreenState extends State<MenuScreen> {
  late final Future<List<ChatSummary>> _chats = AppScope.read(context).data.recentChats();

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    return NzScaffold(
      // Close sits where the menu button was, so the circle opens and closes on the same spot.
      header: Row(children: [
        CircleIconButton(icon: LucideIcons.x, tooltip: S.close.of(context), onTap: () => Navigator.of(context).pop()),
        const Spacer(),
        CircleIconButton(
          icon: LucideIcons.bell,
          tooltip: S.notifications.of(context),
          dot: true,
          onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const NotificationsScreen())),
        ),
      ]),
      body: ListView(padding: const EdgeInsets.fromLTRB(12, 12, 12, 28), children: [
        const _WalletCard(),
        const SizedBox(height: 10),
        const _OrgPicker(),
        const SizedBox(height: 14),
        GridView.builder(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: 2,
            mainAxisSpacing: 10,
            crossAxisSpacing: 10,
            mainAxisExtent: 60,
          ),
          itemCount: kCategories.length,
          itemBuilder: (context, i) => _CategoryTile(kCategories[i]),
        ),
        _SectionLabel(S.recentChats),
        NzCard(
          bordered: false,
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: FutureBuilder<List<ChatSummary>>(
            future: _chats,
            builder: (context, snap) {
              if (snap.connectionState != ConnectionState.done) {
                return const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator(strokeWidth: 2.5)));
              }
              final chats = snap.data ?? const <ChatSummary>[];
              if (chats.isEmpty) {
                return ListTile(
                  minTileHeight: 50,
                  leading: Icon(LucideIcons.messageCircle, size: 18, color: nz.muted),
                  title: Text(snap.hasError ? S.errorTitle.of(context) : S.noChats.of(context),
                      style: TextStyle(color: nz.muted, fontSize: 13.5)),
                );
              }
              return Column(children: [
                for (final c in chats)
                  ListTile(
                    minTileHeight: 50,
                    dense: true,
                    contentPadding: const EdgeInsets.symmetric(horizontal: 16),
                    leading: Icon(LucideIcons.messageCircle, size: 18, color: nz.muted),
                    title: Text(c.title.of(context),
                        maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
                    trailing: const ForwardChevron(size: 18),
                    onTap: () => Navigator.of(context).pop(c),
                  ),
              ]);
            },
          ),
        ),
        _SectionLabel(S.settings),
        const _SettingsCard(),
      ]),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text);
  final T text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(8, 22, 8, 8),
        child: Text(text.of(context), style: TextStyle(color: context.nz.muted, fontSize: 13, fontWeight: FontWeight.w700)),
      );
}

/// The console's two balances on its hero surface (accent glow over a 135deg wash): the prepaid wallet and the
/// Nuzm AI credits, large and readable. Each half opens its page.
class _WalletCard extends StatelessWidget {
  const _WalletCard();

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    final app = AppScope.of(context);
    return FutureBuilder<Balances>(
      future: app.balances(),
      builder: (context, snap) {
        final b = snap.data;
        Widget half(IconData icon, T label, String? value, String pageId, {bool low = false}) => Expanded(
              child: InkWell(
                borderRadius: BorderRadius.circular(16),
                onTap: () => openPage(context, pageId),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Row(children: [
                      Icon(icon, size: 15, color: low ? nz.orangeText : nz.accent),
                      const SizedBox(width: 6),
                      Flexible(
                        child: Text(label.of(context),
                            maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: nz.muted, fontSize: 12, fontWeight: FontWeight.w600)),
                      ),
                      if (low) ...[
                        const SizedBox(width: 6),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                          decoration: BoxDecoration(color: nz.orangeSoft, borderRadius: BorderRadius.circular(6)),
                          child: Text(S.lowCredit.of(context), style: TextStyle(color: nz.orangeText, fontSize: 10.5, fontWeight: FontWeight.w700)),
                        ),
                      ],
                    ]),
                    const SizedBox(height: 6),
                    SizedBox(
                      height: 30,
                      child: FittedBox(
                        fit: BoxFit.scaleDown,
                        alignment: AlignmentDirectional.centerStart,
                        child: value == null
                            ? Text(snap.hasData ? '—' : '…', style: TextStyle(color: nz.fg, fontWeight: FontWeight.w800, fontSize: 22))
                            : LtrText(value, style: TextStyle(color: nz.fg, fontWeight: FontWeight.w800, fontSize: 22)),
                      ),
                    ),
                    const SizedBox(height: 2),
                    Row(children: [
                      Text(S.topUp.of(context), style: TextStyle(color: nz.accent, fontSize: 11.5, fontWeight: FontWeight.w700)),
                      const SizedBox(width: 2),
                      ForwardChevron(size: 13, color: nz.accent),
                    ]),
                  ]),
                ),
              ),
            );
        Widget layered = IntrinsicHeight(
          child: Row(children: [
            half(LucideIcons.wallet, S.wallet, b?.walletMinor == null ? null : displayValue('money:${b!.walletMinor}:${b.currency}', context),
                'billingOverview'),
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 16),
              child: VerticalDivider(width: 1, thickness: 1, color: nz.fg.withValues(alpha: 0.08)),
            ),
            half(LucideIcons.sparkles, S.credits, b?.credits == null ? null : groupDigits(b!.credits!), 'aiUsage', low: b?.lowCredit == true),
          ]),
        );
        for (final g in nz.heroLayers.reversed) {
          layered = DecoratedBox(decoration: BoxDecoration(gradient: g), child: layered);
        }
        return ClipRRect(
          borderRadius: BorderRadius.circular(20),
          child: Material(color: nz.card, child: layered),
        );
      },
    );
  }
}

/// The active organization: its initial, name and role; tapping opens the list to switch (the console's
/// organization chip). Switching reloads the app's data.
class _OrgPicker extends StatelessWidget {
  const _OrgPicker();

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    final app = AppScope.of(context);
    final live = app.data.isLive && app.organizations.isNotEmpty;
    final name = live ? (app.organization?.name ?? '') : app.data.orgName.of(context);
    final role = live ? (app.organization?.role ?? '') : S.sampleData.of(context);
    final canSwitch = live && app.organizations.length > 1;
    return NzCard(
      bordered: false,
      radius: 16,
      padding: const EdgeInsets.fromLTRB(10, 8, 12, 8),
      onTap: canSwitch ? () => _pick(context) : null,
      child: Row(children: [
        _OrgAvatar(name),
        const SizedBox(width: 10),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text(S.organization.of(context), style: TextStyle(color: nz.muted, fontSize: 11.5, fontWeight: FontWeight.w600)),
            Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: nz.fg, fontSize: 14.5, fontWeight: FontWeight.w800)),
          ]),
        ),
        if (role.isNotEmpty)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(color: nz.elev, borderRadius: BorderRadius.circular(8)),
            child: Text(role, style: TextStyle(color: nz.muted, fontSize: 11.5, fontWeight: FontWeight.w700)),
          ),
        if (canSwitch) ...[
          const SizedBox(width: 8),
          Icon(LucideIcons.chevronsUpDown, size: 17, color: nz.muted),
        ],
      ]),
    );
  }

  Future<void> _pick(BuildContext context) async {
    final app = AppScope.read(context);
    final nz = context.nz;
    final id = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (sheet) => SafeArea(
        child: ListView(shrinkWrap: true, padding: const EdgeInsets.fromLTRB(12, 0, 12, 16), children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(8, 0, 8, 10),
            child: Text(S.switchOrg.of(sheet), style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
          ),
          for (final o in app.organizations)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: NzCard(
                bordered: false,
                radius: 14,
                color: o.orgId == app.organization?.orgId ? nz.accentSoft : nz.elev,
                padding: const EdgeInsets.fromLTRB(10, 8, 12, 8),
                onTap: () => Navigator.of(sheet).pop(o.orgId),
                child: Row(children: [
                  _OrgAvatar(o.name),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(o.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w700)),
                  ),
                  Text(o.role, style: TextStyle(color: nz.muted, fontSize: 12)),
                  if (o.orgId == app.organization?.orgId) ...[
                    const SizedBox(width: 8),
                    Icon(LucideIcons.check, size: 18, color: nz.accent),
                  ],
                ]),
              ),
            ),
        ]),
      ),
    );
    if (id == null || id == app.organization?.orgId || !context.mounted) return;
    Navigator.of(context).popUntil((r) => r.isFirst);
    app.switchOrg(id);
  }
}

class _OrgAvatar extends StatelessWidget {
  const _OrgAvatar(this.name);
  final String name;

  @override
  Widget build(BuildContext context) {
    final t = name.trim();
    return Container(
      width: 36,
      height: 36,
      alignment: Alignment.center,
      decoration: BoxDecoration(gradient: NuzmColors.brandGradient, borderRadius: BorderRadius.circular(11)),
      child: Text(t.isEmpty ? '•' : t.characters.first.toUpperCase(),
          style: const TextStyle(color: Color(0xFF15302A), fontSize: 16, fontWeight: FontWeight.w800, height: 1.1)),
    );
  }
}

/// Settings in the footer: appearance, language, and sign-out (or sign-in from sample mode).
class _SettingsCard extends StatelessWidget {
  const _SettingsCard();

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    final app = AppScope.of(context);
    final live = app.data.isLive;
    final dark = Theme.of(context).brightness == Brightness.dark;
    Widget row(IconData icon, T label, Widget trailing) => Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 10, 8),
          child: Row(children: [
            Icon(icon, size: 18, color: nz.muted),
            const SizedBox(width: 12),
            Expanded(child: Text(label.of(context), style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600))),
            trailing,
          ]),
        );
    final divider = Divider(height: 1, thickness: 1, indent: 16, endIndent: 16, color: nz.fg.withValues(alpha: 0.06));
    return NzCard(
      bordered: false,
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Column(children: [
        row(
          dark ? LucideIcons.moon : LucideIcons.sun,
          S.appearance,
          _Segments(
            options: [S.light, S.dark],
            selected: dark ? 1 : 0,
            onSelect: (i) => app.setThemeMode(i == 1 ? ThemeMode.dark : ThemeMode.light),
          ),
        ),
        divider,
        row(
          LucideIcons.languages,
          S.languageLabel,
          _Segments(
            options: [S.arabicName, S.englishName],
            selected: app.isArabic ? 0 : 1,
            onSelect: (i) {
              if ((i == 0) != app.isArabic) app.toggleLocale();
            },
          ),
        ),
        divider,
        ListTile(
          minTileHeight: 50,
          contentPadding: const EdgeInsets.symmetric(horizontal: 16),
          leading: Icon(live || !app.canUseLive ? LucideIcons.logOut : LucideIcons.user, size: 18, color: nz.danger),
          title: Text(live || !app.canUseLive ? S.signOut.of(context) : S.signIn.of(context),
              style: TextStyle(color: nz.danger, fontWeight: FontWeight.w700, fontSize: 14)),
          subtitle: live && app.email != null ? LtrText('${app.email}', style: TextStyle(color: nz.muted, fontSize: 12)) : null,
          onTap: () {
            Navigator.of(context).popUntil((r) => r.isFirst);
            app.signOut();
          },
        ),
      ]),
    );
  }
}

/// A two-option pill switch (the console's segmented control).
class _Segments extends StatelessWidget {
  const _Segments({required this.options, required this.selected, required this.onSelect});
  final List<T> options;
  final int selected;
  final ValueChanged<int> onSelect;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(color: nz.elev, borderRadius: BorderRadius.circular(10)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        for (var i = 0; i < options.length; i++)
          Semantics(
            button: true,
            selected: i == selected,
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () => onSelect(i),
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 200),
                curve: Curves.easeOut,
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
                decoration: BoxDecoration(
                  color: i == selected ? nz.card : Colors.transparent,
                  borderRadius: BorderRadius.circular(8),
                  boxShadow: i == selected ? [BoxShadow(color: nz.shadow.withValues(alpha: 0.12), blurRadius: 6, offset: const Offset(0, 1))] : null,
                ),
                child: Text(options[i].of(context),
                    style: TextStyle(
                      fontSize: 12.5,
                      fontWeight: i == selected ? FontWeight.w800 : FontWeight.w600,
                      color: i == selected ? nz.fg : nz.muted,
                    )),
              ),
            ),
          ),
      ]),
    );
  }
}

/// A console section: compact tile (60 px), the count on the icon's corner.
class _CategoryTile extends StatelessWidget {
  const _CategoryTile(this.category);
  final NavCategory category;

  @override
  Widget build(BuildContext context) {
    return NzCard(
      bordered: false,
      onTap: () => openPage(context, category.pages.first.id),
      radius: 14,
      padding: const EdgeInsets.symmetric(horizontal: 10),
      child: Row(children: [
        Stack(clipBehavior: Clip.none, children: [
          IconTile(category.icon, size: 34),
          if (category.badge > 0) PositionedDirectional(top: -7, end: -7, child: CountBadge(category.badge)),
        ]),
        const SizedBox(width: 10),
        Expanded(
          child: Text(category.label.of(context),
              maxLines: 2, overflow: TextOverflow.fade, style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700, height: 1.2)),
        ),
      ]),
    );
  }
}
