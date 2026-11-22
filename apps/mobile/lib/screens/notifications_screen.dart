import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../app_scope.dart';
import '../data/data_source.dart';
import '../data/demo.dart';
import '../l10n/strings.dart';
import '../theme/nuzm_colors.dart';
import '../widgets/common.dart';
import 'section_screen.dart';

class NotificationsScreen extends StatefulWidget {
  const NotificationsScreen({super.key});

  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> {
  final _read = <String>{};
  late Future<List<Notice>> _future = AppScope.read(context).data.notifications();

  Future<void> _markRead(List<Notice> list, Iterable<String> ids) async {
    final todo = ids.where((id) => !_read.contains(id) && !list.firstWhere((n) => n.id == id).read).toList();
    setState(() => _read.addAll(ids));
    try {
      await AppScope.read(context).data.markNotificationsRead(todo);
    } catch (_) {
      // Shown as read locally; the server keeps it unread and it comes back on the next refresh.
    }
  }

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    return NzScaffold(
      header: Row(children: [
        CircleIconButton(icon: backIcon(context), tooltip: S.back.of(context), onTap: () => Navigator.of(context).pop()),
        const SizedBox(width: 12),
        Expanded(
          child: Text(S.notifications.of(context), style: TextStyle(color: nz.chromeFg, fontSize: 16, fontWeight: FontWeight.w700)),
        ),
        FutureBuilder<List<Notice>>(
          future: _future,
          builder: (context, snap) => TextButton(
            style: TextButton.styleFrom(foregroundColor: nz.chromeFg),
            onPressed: snap.hasData ? () => _markRead(snap.data!, snap.data!.map((n) => n.id)) : null,
            child: Text(S.markAllRead.of(context)),
          ),
        ),
      ]),
      body: ListView(padding: const EdgeInsets.fromLTRB(14, 16, 14, 32), children: [
            FutureBuilder<List<Notice>>(
              future: _future,
              builder: (context, snap) {
                if (snap.connectionState != ConnectionState.done) return const SkeletonList(rows: 3);
                if (snap.hasError) {
                  return StateView(
                    icon: LucideIcons.cloudOff,
                    tone: Tone.danger,
                    title: S.errorTitle.of(context),
                    hint: S.errorHint.of(context),
                    action: S.retry.of(context),
                    onAction: () => setState(() => _future = AppScope.read(context).data.notifications()),
                  );
                }
                final list = snap.data!;
                if (list.isEmpty) {
                  return StateView(icon: LucideIcons.bell, title: S.noNotifications.of(context), hint: S.emptyHint.of(context));
                }
                return Column(children: [
                  for (final n in list)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 10),
                      child: NzCard(
                        onTap: () {
                          _markRead(list, [n.id]);
                          openPage(context, n.pageId);
                        },
                        padding: const EdgeInsets.all(14),
                        child: Row(children: [
                          IconTile(_iconFor(n.tone), size: 48, tone: n.tone),
                          const SizedBox(width: 14),
                          Expanded(
                            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                              Text(n.title.of(context),
                                  style: TextStyle(fontWeight: (n.read || _read.contains(n.id)) ? FontWeight.w500 : FontWeight.w800, fontSize: 15.5)),
                              const SizedBox(height: 3),
                              Text(n.time.of(context), style: TextStyle(color: nz.muted, fontSize: 13)),
                            ]),
                          ),
                          if (!n.read && !_read.contains(n.id))
                            Container(width: 10, height: 10, decoration: BoxDecoration(color: nz.orange, shape: BoxShape.circle)),
                        ]),
                      ),
                    ),
                ]);
              },
            ),
      ]),
    );
  }

  IconData _iconFor(Tone t) => switch (t) {
        Tone.success => LucideIcons.circleCheck,
        Tone.danger => LucideIcons.triangleAlert,
        Tone.orange => LucideIcons.receipt,
        _ => LucideIcons.bell,
      };
}
