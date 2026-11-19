import 'package:flutter/material.dart';

import '../../core/models.dart';
import '../state_views.dart';

/// `list` screens: the items of the spec; an empty list shows the empty state.
class ListScreen extends StatelessWidget {
  const ListScreen({super.key, required this.def});

  final ScreenDef def;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(def.title.of(context))),
      body: def.items.isEmpty
          ? const EmptyView()
          : ListView.separated(
              itemCount: def.items.length,
              separatorBuilder: (_, _) => const Divider(height: 1),
              itemBuilder: (context, i) {
                final item = def.items[i];
                final subtitle = item.subtitle;
                return ListTile(
                  title: Text(item.title.of(context)),
                  subtitle: subtitle == null ? null : Text(subtitle.of(context)),
                );
              },
            ),
    );
  }
}
