import 'package:flutter/material.dart';

import '../../core/models.dart';

/// `home` and `detail` screens: a coloured header card with the title and the body text.
class InfoScreen extends StatelessWidget {
  const InfoScreen({super.key, required this.def});

  final ScreenDef def;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final body = def.body;
    final isHome = def.kind == ScreenKind.home;
    return Scaffold(
      appBar: AppBar(title: Text(def.title.of(context))),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Container(
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(20),
              gradient: isHome
                  ? LinearGradient(
                      begin: AlignmentDirectional.topStart,
                      end: AlignmentDirectional.bottomEnd,
                      colors: [scheme.primary, scheme.tertiary],
                    )
                  : null,
              color: isHome ? null : scheme.surfaceContainerLow,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Semantics(
                  header: true,
                  child: Text(
                    def.title.of(context),
                    style: theme.textTheme.headlineSmall?.copyWith(
                      fontWeight: FontWeight.w700,
                      color: isHome ? scheme.onPrimary : scheme.onSurface,
                    ),
                  ),
                ),
                if (body != null) ...[
                  const SizedBox(height: 10),
                  Text(
                    body.of(context),
                    style: theme.textTheme.bodyLarge?.copyWith(
                      color: isHome ? scheme.onPrimary : scheme.onSurfaceVariant,
                      height: 1.5,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}
