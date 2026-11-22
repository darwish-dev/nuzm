import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../l10n/strings.dart';
import '../theme/nuzm_colors.dart';
import 'common.dart';

/// The Nuzm AI input bar: attach, style, text, and mic (turns into send once there is text).
class Composer extends StatefulWidget {
  const Composer({super.key, required this.onSend});
  final ValueChanged<String> onSend;

  @override
  State<Composer> createState() => _ComposerState();
}

class _ComposerState extends State<Composer> {
  final _ctrl = TextEditingController();
  bool _hasText = false;

  @override
  void initState() {
    super.initState();
    _ctrl.addListener(() {
      final has = _ctrl.text.trim().isNotEmpty;
      if (has != _hasText) setState(() => _hasText = has);
    });
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  void _submit() {
    if (!_hasText) return;
    widget.onSend(_ctrl.text);
    _ctrl.clear();
  }

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    Widget round(IconData icon, String tip, Color? bg, Color fg, VoidCallback onTap, {double size = 46, Gradient? gradient}) => Tooltip(
          message: tip,
          child: Material(
            color: Colors.transparent,
            shape: const CircleBorder(),
            clipBehavior: Clip.antiAlias,
            child: Ink(
              decoration: BoxDecoration(color: bg, gradient: gradient, shape: BoxShape.circle),
              child: InkWell(onTap: onTap, child: SizedBox(width: size, height: size, child: Icon(icon, size: 21, color: fg))),
            ),
          ),
        );
    return Container(
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: nz.card,
        borderRadius: BorderRadius.circular(30),
        border: Border.all(color: nz.border),
        boxShadow: [BoxShadow(color: nz.shadow.withValues(alpha: 0.25), blurRadius: 24, offset: const Offset(0, 8))],
      ),
      child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
        round(LucideIcons.plus, S.attach.of(context), nz.elev, nz.fg, () => showSoon(context)),
        const SizedBox(width: 6),
        round(LucideIcons.palette, S.styles.of(context), nz.accentSoft, nz.accent, () => showSoon(context)),
        const SizedBox(width: 6),
        Expanded(
          child: TextField(
            controller: _ctrl,
            minLines: 1,
            maxLines: 5,
            textInputAction: TextInputAction.send,
            onSubmitted: (_) => _submit(),
            style: const TextStyle(fontSize: 16),
            decoration: InputDecoration(
              hintText: S.composerHint.of(context),
              hintStyle: TextStyle(color: nz.muted),
              filled: false,
              border: InputBorder.none,
              enabledBorder: InputBorder.none,
              focusedBorder: InputBorder.none,
              contentPadding: const EdgeInsets.symmetric(horizontal: 6, vertical: 13),
            ),
          ),
        ),
        const SizedBox(width: 6),
        AnimatedSwitcher(
          duration: const Duration(milliseconds: 180),
          transitionBuilder: (c, a) => ScaleTransition(scale: a, child: c),
          child: _hasText
              ? KeyedSubtree(
                  key: const ValueKey('send'),
                  child: round(LucideIcons.arrowUp, S.send.of(context), null, nz.orangeInk, _submit, size: 52, gradient: NuzmColors.orangeGradient))
              : KeyedSubtree(
                  key: const ValueKey('mic'),
                  child: round(LucideIcons.mic, S.voice.of(context), null, nz.orangeInk, () => showSoon(context), size: 52, gradient: NuzmColors.orangeGradient)),
        ),
      ]),
    );
  }
}
