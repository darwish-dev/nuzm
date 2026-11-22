import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../actions/action_model.dart';
import '../actions/action_sheet.dart';
import '../actions/registry.dart';
import '../data/demo.dart';
import '../data/nav.dart';
import '../l10n/strings.dart';
import '../theme/nuzm_colors.dart';
import '../widgets/common.dart';
import 'section_screen.dart';

/// Detail of one resource (server, site, invoice, member…): header, facts and actions.
class DetailScreen extends StatelessWidget {
  const DetailScreen({super.key, required this.item, required this.page});
  final Item item;
  final NavPage page;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    final title = item.title.of(context);
    // Actions that apply to this row in its current state (sample rows have no state: only state-free ones show).
    final actions = [
      for (final a in kItemActions[page.id] ?? const <ActionDef>[])
        if (a.visible == null || (item.raw.isNotEmpty && a.visible!(item.raw))) a,
    ];
    final facts = <(T, String)>[
      (T('النوع', 'Type'), page.label.of(context)),
      ...item.facts,
      if (item.meta != null) (T('القيمة', 'Value'), displayValue(item.meta!, context)),
      (T('مسار لوحة الويب', 'Web console path'), page.path),
    ];
    return NzScaffold(
      header: Row(children: [
        CircleIconButton(icon: backIcon(context), tooltip: S.back.of(context), onTap: () => Navigator.of(context).pop()),
        const SizedBox(width: 12),
        Expanded(
          child: Text(page.label.of(context),
              maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: nz.chromeFg, fontSize: 16, fontWeight: FontWeight.w700)),
        ),
        const SampleChip(),
      ]),
      body: ListView(padding: const EdgeInsets.fromLTRB(14, 16, 14, 32), children: [
            NzCard(
              padding: const EdgeInsets.all(22),
              child: Column(children: [
                IconTile(item.icon ?? page.icon, size: 72, tone: Tone.accent),
                const SizedBox(height: 14),
                item.ltrTitle
                    ? LtrText(title, style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800))
                    : Text(title, textAlign: TextAlign.center, style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
                const SizedBox(height: 4),
                Text(item.subtitle.of(context), textAlign: TextAlign.center, style: TextStyle(color: nz.muted)),
                if (item.status != null) ...[const SizedBox(height: 12), StatusChip(item.status!)],
              ]),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 22, 8, 10),
              child: Text(S.details.of(context), style: TextStyle(color: nz.muted, fontSize: 15, fontWeight: FontWeight.w800)),
            ),
            NzCard(
              padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 6),
              child: Column(children: [
                for (var i = 0; i < facts.length; i++) ...[
                  if (i > 0) Divider(color: nz.border, height: 1),
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    child: Row(children: [
                      Expanded(child: Text(facts[i].$1.of(context), style: TextStyle(color: nz.muted))),
                      const SizedBox(width: 12),
                      Flexible(child: LtrText(facts[i].$2, style: const TextStyle(fontWeight: FontWeight.w700))),
                    ]),
                  ),
                ],
              ]),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 22, 8, 10),
              child: Text(S.actions.of(context), style: TextStyle(color: nz.muted, fontSize: 15, fontWeight: FontWeight.w800)),
            ),
            for (final a in actions)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: OutlinedButton.icon(
                  onPressed: () async {
                    if (await runAction(context, a, item: item.raw) && context.mounted) Navigator.of(context).pop(true);
                  },
                  style: OutlinedButton.styleFrom(
                    minimumSize: const Size.fromHeight(50),
                    alignment: AlignmentDirectional.centerStart,
                    foregroundColor: a.destructive ? nz.danger : nz.fg,
                    side: BorderSide(color: a.destructive ? nz.danger.withValues(alpha: 0.4) : nz.border),
                    backgroundColor: a.destructive ? nz.danger.withValues(alpha: 0.08) : nz.elev,
                  ),
                  icon: Icon(a.icon, size: 18),
                  label: Text(a.label.of(context), style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w700)),
                ),
              ),
            if (actions.isEmpty && kWebOnlyWrites.contains(page.id))
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: Text(S.webOnlyWrites.of(context), style: TextStyle(color: nz.muted)),
              ),
            FilledButton.icon(
              onPressed: () => askAi(context, '${S.askAi.of(context)}: $title'),
              style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(50)),
              icon: const Icon(LucideIcons.sparkles, size: 18),
              label: Text(S.askAi.of(context), style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
            ),
      ]),
    );
  }
}
