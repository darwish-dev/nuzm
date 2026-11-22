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
    return Scaffold(
      body: NzBackground(
        child: SafeArea(
          bottom: false,
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
              child: Row(children: [
                CircleIconButton(icon: backIcon(context), tooltip: S.back.of(context), onTap: () => Navigator.of(context).pop()),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(cat.heading.of(context),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
                    const SizedBox(height: 2),
                    const SampleChip(),
                  ]),
                ),
                CircleIconButton(
                  icon: LucideIcons.sparkles,
                  tooltip: S.askAi.of(context),
                  onTap: () => askAi(context, '${S.askAi.of(context)}: ${page.label.of(context)}'),
                ),
              ]),
            ),
            if (multi)
              SizedBox(
                height: 64,
                child: ListView(
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
                  children: [
                    for (final g in cat.groups) ...[
                      if (g.title != null && cat.groups.length > 1)
                        Padding(
                          padding: const EdgeInsetsDirectional.only(end: 8, start: 4),
                          child: Center(
                            child: Text(g.title!.of(context),
                                style: TextStyle(color: nz.muted, fontSize: 12.5, fontWeight: FontWeight.w700)),
                          ),
                        ),
                      for (final p in g.pages)
                        Padding(
                          padding: const EdgeInsetsDirectional.only(end: 8),
                          child: _Pill(
                            label: p.label.of(context),
                            icon: p.icon,
                            selected: p.id == _page,
                            onTap: () => setState(() => _page = p.id),
                          ),
                        ),
                    ],
                  ],
                ),
              )
            else
              const SizedBox(height: 12),
            Expanded(
              child: AnimatedSwitcher(
                duration: const Duration(milliseconds: 220),
                child: PageBody(key: ValueKey(page.id), page: page),
              ),
            ),
          ]),
        ),
      ),
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill({required this.label, required this.icon, required this.selected, required this.onTap});
  final String label;
  final IconData icon;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    return Semantics(
      selected: selected,
      button: true,
      child: Material(
        color: selected ? nz.primaryFill : nz.card,
        shape: const StadiumBorder(),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Row(children: [
              Icon(icon, size: 17, color: selected ? nz.onPrimaryFill : nz.muted),
              const SizedBox(width: 8),
              Text(label,
                  style: TextStyle(color: selected ? nz.onPrimaryFill : nz.fg, fontWeight: FontWeight.w700, fontSize: 14.5)),
            ]),
          ),
        ),
      ),
    );
  }
}
