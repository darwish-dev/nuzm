import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

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
  final _read = <int>{};

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    return Scaffold(
      body: NzBackground(
        child: SafeArea(
          child: ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 32), children: [
            Row(children: [
              CircleIconButton(icon: backIcon(context), tooltip: S.back.of(context), onTap: () => Navigator.of(context).pop()),
              const SizedBox(width: 14),
              Expanded(
                child: Text(S.notifications.of(context),
                    style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
              ),
              TextButton(
                onPressed: () => setState(() => _read.addAll(List.generate(kNotifications.length, (i) => i))),
                child: Text(S.markAllRead.of(context)),
              ),
            ]),
            const SizedBox(height: 18),
            for (final (i, (title, time, pageId, tone)) in kNotifications.indexed)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: NzCard(
                  onTap: () {
                    setState(() => _read.add(i));
                    openPage(context, pageId);
                  },
                  padding: const EdgeInsets.all(14),
                  child: Row(children: [
                    IconTile(_iconFor(tone), size: 48, tone: tone),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(title.of(context),
                            style: TextStyle(fontWeight: _read.contains(i) ? FontWeight.w500 : FontWeight.w800, fontSize: 15.5)),
                        const SizedBox(height: 3),
                        Text(time.of(context), style: TextStyle(color: nz.muted, fontSize: 13)),
                      ]),
                    ),
                    if (!_read.contains(i))
                      Container(width: 10, height: 10, decoration: BoxDecoration(color: nz.orange, shape: BoxShape.circle)),
                  ]),
                ),
              ),
          ]),
        ),
      ),
    );
  }

  IconData _iconFor(Tone t) => switch (t) {
        Tone.success => LucideIcons.circleCheck,
        Tone.danger => LucideIcons.triangleAlert,
        Tone.orange => LucideIcons.receipt,
        _ => LucideIcons.bell,
      };
}
