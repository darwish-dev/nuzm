import 'package:flutter/material.dart';

import '../../core/models.dart';

/// `home` and `detail` screens: a title and a text body.
class InfoScreen extends StatelessWidget {
  const InfoScreen({super.key, required this.def});

  final ScreenDef def;

  @override
  Widget build(BuildContext context) {
    final body = def.body;
    return Scaffold(
      appBar: AppBar(title: Text(def.title.of(context))),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Semantics(
            header: true,
            child: Text(
              def.title.of(context),
              style: Theme.of(context).textTheme.headlineSmall,
            ),
          ),
          const SizedBox(height: 12),
          if (body != null)
            Text(body.of(context), style: Theme.of(context).textTheme.bodyLarge),
        ],
      ),
    );
  }
}
