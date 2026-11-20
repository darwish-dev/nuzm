import 'package:flutter/material.dart';

import '../../core/models.dart';
import '../state_views.dart';

/// `list` screens: the items of the spec as cards with an initial avatar; an empty list shows the empty state.
class ListScreen extends StatelessWidget {
  const ListScreen({super.key, required this.def});

  final ScreenDef def;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(title: Text(def.title.of(context))),
      body: def.items.isEmpty
          ? const EmptyView()
          : ListView.separated(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
              itemCount: def.items.length,
              separatorBuilder: (_, _) => const SizedBox(height: 10),
              itemBuilder: (context, i) {
                final item = def.items[i];
                final title = item.title.of(context);
                final subtitle = item.subtitle;
                return Card(
                  child: ListTile(
                    leading: CircleAvatar(
                      backgroundColor: scheme.primaryContainer,
                      foregroundColor: scheme.onPrimaryContainer,
                      child: ExcludeSemantics(
                        child: Text(title.isEmpty ? '•' : title.characters.first),
                      ),
                    ),
                    title: Text(title, style: const TextStyle(fontWeight: FontWeight.w600)),
                    subtitle: subtitle == null ? null : Text(subtitle.of(context)),
                  ),
                );
              },
            ),
    );
  }
}
