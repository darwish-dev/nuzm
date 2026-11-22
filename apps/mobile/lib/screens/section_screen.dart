import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../app_scope.dart';
import '../data/nav.dart';
import '../l10n/strings.dart';
import '../theme/nuzm_colors.dart';
import '../widgets/common.dart';
import 'page_views.dart';

T pageLabel(String pageId) => findPage(pageId).$2.label;

/// Opens the section that holds [pageId], on that page.
void openPage(BuildContext context, String pageId) {
  final (cat, page) = findPage(pageId);
  Navigator.of(context).push(MaterialPageRoute(builder: (_) => SectionScreen(category: cat, initialPage: page.id)));
}

/// Sends [prompt] to Nuzm AI on the home screen.
void askAi(BuildContext context, String prompt) => AppScope.of(context).pendingPrompt.value = prompt;

/// One console category: its pages as pill tabs (grouped like the web console) and the selected page below.
class SectionScreen extends StatefulWidget {
  const SectionScreen({super.key, required this.category, required this.initialPage});
  final NavCategory category;
  final String initialPage;

  @override
  State<SectionScreen> createState() => _SectionScreenState();
}

class _SectionScreenState extends State<SectionScreen> {
  late String _page = widget.initialPage;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    final cat = widget.category;
    final page = cat.pages.firstWhere((p) => p.id == _page);
    final multi = cat.pages.length > 1;
    return NzScaffold(
      header: Row(children: [
        CircleIconButton(icon: backIcon(context), tooltip: S.back.of(context), onTap: () => Navigator.of(context).pop()),
        const SizedBox(width: 10),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text(cat.heading.of(context),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: nz.chromeFg, fontSize: 16, fontWeight: FontWeight.w700)),
            const SampleChip(),
          ]),
        ),
        CircleIconButton(
          icon: LucideIcons.sparkles,
          tooltip: S.askAi.of(context),
          onTap: () => askAi(context, '${S.askAi.of(context)}: ${page.label.of(context)}'),
        ),
      ]),
      body: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        if (multi)
          // `.nzc-tabs`: muted labels, the current one in the foreground with a 2 px accent underline,
          // a divider before each titled group, 1 px rule under the row.
          Container(
            height: 52,
            decoration: BoxDecoration(border: Border(bottom: BorderSide(color: nz.border))),
            child: ListView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 10),
              children: [
                for (final (gi, g) in cat.groups.indexed) ...[
                  if (gi > 0)
                    Container(width: 1, margin: const EdgeInsets.symmetric(horizontal: 8, vertical: 14), color: nz.border),
                  for (final p in g.pages)
                    _Tab(label: p.label.of(context), selected: p.id == _page, onTap: () => setState(() => _page = p.id)),
                ],
              ],
            ),
          ),
        const SizedBox(height: 6),
        Expanded(
          child: AnimatedSwitcher(
            duration: const Duration(milliseconds: 200),
            child: PageBody(key: ValueKey(page.id), page: page),
          ),
        ),
      ]),
    );
  }
}

class _Tab extends StatelessWidget {
  const _Tab({required this.label, required this.selected, required this.onTap});
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    return Semantics(
      selected: selected,
      button: true,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(8),
        child: Stack(children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Center(
              child: Text(label,
                  style: TextStyle(
                    color: selected ? nz.fg : nz.muted,
                    fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
                    fontSize: 14.5,
                  )),
            ),
          ),
          if (selected)
            PositionedDirectional(
              start: 10,
              end: 10,
              bottom: 0,
              child: Container(height: 2, decoration: BoxDecoration(color: nz.accent, borderRadius: BorderRadius.circular(2))),
            ),
        ]),
      ),
    );
  }
}
