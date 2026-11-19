import 'package:flutter/material.dart';

import '../core/models.dart';

/// The four screen states every generated screen handles: loading, empty, error, content.
class LoadingView extends StatelessWidget {
  const LoadingView({super.key});

  @override
  Widget build(BuildContext context) => Center(
        child: Semantics(
          label: const L('جارٍ التحميل', 'Loading').of(context),
          child: const CircularProgressIndicator(),
        ),
      );
}

class EmptyView extends StatelessWidget {
  const EmptyView({super.key, this.message});

  final L? message;

  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            (message ?? const L('لا توجد عناصر بعد', 'Nothing here yet')).of(context),
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodyLarge,
          ),
        ),
      );
}

class ErrorView extends StatelessWidget {
  const ErrorView({super.key, required this.message, this.onRetry});

  final L message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.error_outline, color: Theme.of(context).colorScheme.error),
              const SizedBox(height: 12),
              Text(message.of(context), textAlign: TextAlign.center),
              if (onRetry != null) ...[
                const SizedBox(height: 12),
                FilledButton(
                  onPressed: onRetry,
                  child: Text(const L('إعادة المحاولة', 'Try again').of(context)),
                ),
              ],
            ],
          ),
        ),
      );
}
