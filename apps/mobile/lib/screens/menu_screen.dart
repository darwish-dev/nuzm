import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../app_scope.dart';
import '../data/data_source.dart';
import '../data/demo.dart' show Tone;
import '../data/nav.dart';
import '../l10n/strings.dart';
import '../theme/nuzm_colors.dart';
import '../widgets/common.dart';
import 'notifications_screen.dart';
import 'section_screen.dart';

/// The menu: the wallet and AI credits, the organization switcher, every console section as a compact tile, the
/// recent Nuzm AI chats and the account. Pops with a chat when a recent chat is picked (the home screen reopens it).
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
    final app = AppScope.of(context);
    final dark = Theme.of(context).brightness == Brightness.dark;
    return NzScaffold(
      header: Row(children: [
        CircleIconButton(
          icon: dark ? LucideIcons.sun : LucideIcons.moon,
          tooltip: (dark ? S.lightMode : S.darkMode).of(context),
          onTap: () => app.toggleTheme(Theme.of(context).brightness),
        ),
        const SizedBox(width: 6),
        CircleIconButton(icon: LucideIcons.languages, tooltip: S.language.of(context), onTap: app.toggleLocale),
        const Spacer(),
        CircleIconButton(
          icon: LucideIcons.bell,
          tooltip: S.notifications.of(context),
          dot: true,
          onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const NotificationsScreen())),
        ),
        const SizedBox(width: 6),
        CircleIconButton(icon: LucideIcons.x, tooltip: S.close.of(context), onTap: () => Navigator.of(context).pop()),
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
        Padding(
          padding: const EdgeInsets.fromLTRB(8, 22, 8, 8),
          child: Text(S.recentChats.of(context), style: TextStyle(color: nz.muted, fontSize: 14, fontWeight: FontWeight.w700)),
        ),
        NzCard(
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
        const SizedBox(height: 14),
        const _AccountCard(),
      ]),
    );
  }
}

/// The console's two balances: the prepaid wallet and the Nuzm AI credits. Each opens its page.
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
        Widget cell(IconData icon, T label, String? value, String pageId, {bool warn = false}) => Expanded(
              child: InkWell(
                borderRadius: BorderRadius.circular(12),
                onTap: () => openPage(context, pageId),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  child: Row(children: [
                    IconTile(icon, size: 34, tone: warn ? Tone.orange : Tone.accent),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(label.of(context), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: nz.muted, fontSize: 12)),
                        const SizedBox(height: 2),
                        FittedBox(
                          fit: BoxFit.scaleDown,
                          alignment: AlignmentDirectional.centerStart,
                          child: value == null
                              ? Text(snap.hasData ? '—' : '…', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15))
                              : LtrText(value, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
                        ),
                      ]),
                    ),
                  ]),
                ),
              ),
            );
        return NzCard(
          padding: const EdgeInsets.all(4),
          child: IntrinsicHeight(
            child: Row(children: [
              cell(LucideIcons.wallet, S.wallet, b?.walletMinor == null ? null : displayValue('money:${b!.walletMinor}:${b.currency}', context),
                  'billingOverview'),
              VerticalDivider(width: 1, color: nz.border),
              cell(LucideIcons.sparkles, S.credits, b?.credits == null ? null : groupDigits(b!.credits!), 'aiUsage', warn: b?.lowCredit == true),
            ]),
          ),
        );
      },
    );
  }
}

/// The active organization as a dropdown (the console's organization chip). Switching reloads the app's data.
class _OrgPicker extends StatelessWidget {
  const _OrgPicker();

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    final app = AppScope.of(context);
    final live = app.data.isLive && app.organizations.isNotEmpty;
    final current = live ? app.organization?.orgId : '_sample';
    final options = live
        ? [for (final o in app.organizations) (o.orgId, o.name, o.role)]
        : [('_sample', app.data.orgName.of(context), S.sampleData.of(context))];
    return DropdownButtonFormField<String>(
      initialValue: current,
      isExpanded: true,
      dropdownColor: nz.elev,
      borderRadius: BorderRadius.circular(14),
      decoration: InputDecoration(
        labelText: S.organization.of(context),
        prefixIcon: Icon(LucideIcons.building2, size: 18, color: nz.accent),
        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        isDense: true,
      ),
      items: [
        for (final (id, name, role) in options)
          DropdownMenuItem(
            value: id,
            child: Row(children: [
              Expanded(child: Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700))),
              const SizedBox(width: 8),
              Text(role, style: TextStyle(color: nz.muted, fontSize: 12)),
            ]),
          ),
      ],
      onChanged: !live || app.organizations.length < 2
          ? null
          : (id) {
              if (id == null || id == app.organization?.orgId) return;
              Navigator.of(context).popUntil((r) => r.isFirst);
              app.switchOrg(id);
            },
    );
  }
}

/// Who is signed in, and sign-out (or sign-in from sample mode).
class _AccountCard extends StatelessWidget {
  const _AccountCard();

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    final app = AppScope.of(context);
    final live = app.data.isLive;
    return NzCard(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: ListTile(
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
