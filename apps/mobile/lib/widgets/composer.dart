import 'dart:convert';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:speech_to_text/speech_recognition_error.dart';
import 'package:speech_to_text/speech_recognition_result.dart';
import 'package:speech_to_text/speech_to_text.dart';

import '../data/data_source.dart';
import '../l10n/strings.dart';
import '../theme/nuzm_colors.dart';
import 'nz_icons.dart';

typedef ComposerSend = void Function(String text, List<ChatAttachment> attachments);

/// The NUZM AI input bar: attach (a text file or a link), the message, and the mic. The mic dictates into the
/// message with the phone's speech recognizer; it turns into send once there is something to send.
class Composer extends StatefulWidget {
  const Composer({super.key, required this.onSend});
  final ComposerSend onSend;

  @override
  State<Composer> createState() => ComposerState();
}

class ComposerState extends State<Composer> with SingleTickerProviderStateMixin {
  final _ctrl = TextEditingController();
  final _focus = FocusNode();
  final _attachments = <ChatAttachment>[];
  final _speech = SpeechToText();
  late final AnimationController _pulse;
  bool _hasText = false;
  bool _speechReady = false;
  bool _listening = false;
  String _before = '';

  bool get _canSend => _hasText || _attachments.isNotEmpty;

  @override
  void initState() {
    super.initState();
    _pulse = AnimationController(vsync: this, duration: const Duration(milliseconds: 1100));
    _ctrl.addListener(() {
      final has = _ctrl.text.trim().isNotEmpty;
      if (has != _hasText) setState(() => _hasText = has);
    });
  }

  @override
  void dispose() {
    if (_listening) _speech.cancel();
    _pulse.dispose();
    _ctrl.dispose();
    _focus.dispose();
    super.dispose();
  }

  /// Puts a starter into the message and focuses it, so the person finishes the sentence.
  void prefill(String text) {
    _ctrl.value = TextEditingValue(text: text, selection: TextSelection.collapsed(offset: text.length));
    _focus.requestFocus();
  }

  void _say(T message) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message.of(context))));
  }

  Future<void> _submit() async {
    if (!_canSend) return;
    if (_listening) await _stopListening();
    final text = _ctrl.text.trim();
    widget.onSend(text, List.of(_attachments));
    _ctrl.clear();
    setState(_attachments.clear);
  }

  // ------------------------------------------------------------------ voice

  Future<void> _toggleMic() async {
    if (_listening) return _stopListening();
    if (!_speechReady) {
      try {
        _speechReady = await _speech.initialize(onStatus: _onStatus, onError: _onError);
      } catch (_) {
        _speechReady = false;
      }
      if (!mounted) return;
      if (!_speechReady) {
        var allowed = false;
        try {
          allowed = await _speech.hasPermission;
        } catch (_) {}
        return _say(allowed ? S.micUnavailable : S.micDenied);
      }
    }
    if (!mounted) return;
    final lang = Localizations.localeOf(context).languageCode;
    String? localeId;
    try {
      final locales = await _speech.locales();
      final match = locales.where((l) => l.localeId.toLowerCase().startsWith(lang));
      localeId = match.isEmpty ? null : match.first.localeId;
    } catch (_) {}
    _before = _ctrl.text.trim();
    setState(() => _listening = true);
    _pulse.repeat();
    try {
      await _speech.listen(
        onResult: _onResult,
        listenOptions: SpeechListenOptions(
          partialResults: true,
          cancelOnError: true,
          listenMode: ListenMode.dictation,
          localeId: localeId,
          pauseFor: const Duration(seconds: 4),
          listenFor: const Duration(minutes: 1),
        ),
      );
    } catch (_) {
      _endListening();
      if (mounted) _say(S.micUnavailable);
    }
  }

  void _onResult(SpeechRecognitionResult r) {
    if (!mounted) return;
    final words = r.recognizedWords.trim();
    final text = [_before, words].where((s) => s.isNotEmpty).join(' ');
    _ctrl.value = TextEditingValue(text: text, selection: TextSelection.collapsed(offset: text.length));
  }

  void _onStatus(String status) {
    if (status == SpeechToText.doneStatus || status == SpeechToText.notListeningStatus) _endListening();
  }

  void _onError(SpeechRecognitionError e) {
    _endListening();
    if (!mounted) return;
    final m = e.errorMsg.toLowerCase();
    // Silence or nothing recognised is not worth a message: the field simply stays as it was.
    if (m.contains('no_match') || m.contains('speech_timeout')) return;
    _say(m.contains('permission') ? S.micDenied : S.micUnavailable);
  }

  Future<void> _stopListening() async {
    try {
      await _speech.stop();
    } catch (_) {}
    _endListening();
  }

  void _endListening() {
    _pulse.stop();
    if (mounted && _listening) setState(() => _listening = false);
  }

  // ------------------------------------------------------------------ attachments

  Future<void> _attach() async {
    if (_attachments.length >= ChatAttachment.maxCount) return _say(S.tooManyAttachments);
    final nz = context.nz;
    final pick = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (sheet) {
        Widget option(String id, IconData icon, T title, T hint) => ListTile(
              leading: Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(color: nz.accentSoft, borderRadius: BorderRadius.circular(12)),
                child: Icon(icon, size: 19, color: nz.accent),
              ),
              title: Text(title.of(sheet), style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
              subtitle: Text(hint.of(sheet), style: TextStyle(color: nz.muted, fontSize: 12.5)),
              onTap: () => Navigator.of(sheet).pop(id),
            );
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(8, 0, 8, 12),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              option('file', NzIcons.fileText, S.attachFile, S.attachFileHint),
              option('link', NzIcons.link, S.attachLink, S.attachLinkHint),
            ]),
          ),
        );
      },
    );
    if (!mounted) return;
    if (pick == 'file') await _pickFile();
    if (pick == 'link') await _addLink();
  }

  Future<void> _pickFile() async {
    FilePickerResult? r;
    try {
      // Any type: the check below decides whether it is text, so code files with unusual extensions work too.
      r = await FilePicker.pickFiles(withData: true);
    } catch (_) {
      if (mounted) _say(S.notText);
      return;
    }
    final f = r?.files.isNotEmpty == true ? r!.files.first : null;
    if (f == null || !mounted) return;
    final bytes = f.bytes;
    String text;
    try {
      if (bytes == null) throw const FormatException();
      text = utf8.decode(bytes);
      if (text.contains('\u0000')) throw const FormatException();
    } on FormatException {
      return _say(S.notText);
    }
    if (text.trim().isEmpty) return _say(S.notText);
    if (text.length > ChatAttachment.maxChars) return _say(S.fileTooLong);
    final name = f.name.length > 100 ? f.name.substring(0, 100) : f.name;
    setState(() => _attachments.add(ChatAttachment.text(name, text)));
  }

  Future<void> _addLink() async {
    final link = await showDialog<String>(context: context, builder: (_) => const _LinkDialog());
    if (link == null || !mounted) return;
    setState(() => _attachments.add(ChatAttachment.link(link)));
  }

  // ------------------------------------------------------------------ layout

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

    final Widget action;
    if (_listening) {
      action = KeyedSubtree(
        key: const ValueKey('stop'),
        child: AnimatedBuilder(
          animation: _pulse,
          builder: (context, child) => Container(
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              boxShadow: [
                BoxShadow(color: nz.orange.withValues(alpha: 0.45 * (1 - _pulse.value)), spreadRadius: 10 * _pulse.value, blurRadius: 0),
              ],
            ),
            child: child,
          ),
          child: round(NzIcons.square, S.stopListening.of(context), null, nz.orangeInk, _stopListening,
              size: 52, gradient: NuzmColors.orangeGradient),
        ),
      );
    } else if (_canSend) {
      action = KeyedSubtree(
        key: const ValueKey('send'),
        child: round(NzIcons.arrowUp, S.send.of(context), null, nz.orangeInk, _submit, size: 52, gradient: NuzmColors.orangeGradient),
      );
    } else {
      action = KeyedSubtree(
        key: const ValueKey('mic'),
        child: round(NzIcons.mic, S.voice.of(context), null, nz.orangeInk, _toggleMic, size: 52, gradient: NuzmColors.orangeGradient),
      );
    }

    // Light: a flat field with no stroke or shadow. Dark: the card with its hairline and a soft lift.
    final light = Theme.of(context).brightness == Brightness.light;
    return Container(
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: light ? nz.elev : nz.card,
        borderRadius: BorderRadius.circular(30),
        border: _listening
            ? Border.all(color: nz.orange.withValues(alpha: 0.6))
            : (light ? null : Border.all(color: nz.border)),
        boxShadow: light ? null : [BoxShadow(color: nz.shadow.withValues(alpha: 0.25), blurRadius: 24, offset: const Offset(0, 8))],
      ),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        if (_attachments.isNotEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 2, 4, 6),
            child: Align(
              alignment: AlignmentDirectional.centerStart,
              child: Wrap(spacing: 6, runSpacing: 6, children: [
                for (var i = 0; i < _attachments.length; i++)
                  AttachmentChip(_attachments[i], onRemove: () => setState(() => _attachments.removeAt(i))),
              ]),
            ),
          ),
        Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
          round(NzIcons.plus, S.attach.of(context), nz.elev, nz.fg, _attach),
          const SizedBox(width: 6),
          Expanded(
            child: TextField(
              controller: _ctrl,
              focusNode: _focus,
              minLines: 1,
              maxLines: 5,
              textInputAction: TextInputAction.send,
              onSubmitted: (_) => _submit(),
              style: const TextStyle(fontSize: 16),
              decoration: InputDecoration(
                hintText: (_listening ? S.listening : S.composerHint).of(context),
                hintStyle: TextStyle(color: _listening ? nz.orangeText : nz.muted),
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
            child: action,
          ),
        ]),
      ]),
    );
  }
}

/// An attachment as a small chip (file name or link), with remove when [onRemove] is given.
class AttachmentChip extends StatelessWidget {
  const AttachmentChip(this.attachment, {super.key, this.onRemove});
  final ChatAttachment attachment;
  final VoidCallback? onRemove;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    return Container(
      constraints: const BoxConstraints(maxWidth: 220),
      padding: EdgeInsetsDirectional.fromSTEB(10, 6, onRemove == null ? 10 : 4, 6),
      decoration: BoxDecoration(color: nz.elev, borderRadius: BorderRadius.circular(12)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(attachment.isLink ? NzIcons.link : NzIcons.fileText, size: 14, color: nz.accent),
        const SizedBox(width: 6),
        Flexible(
          child: Text(attachment.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              textDirection: TextDirection.ltr,
              style: TextStyle(color: nz.fg, fontSize: 12.5, fontWeight: FontWeight.w600)),
        ),
        if (onRemove != null)
          Tooltip(
            message: S.removeAttachment.of(context),
            child: InkWell(
              borderRadius: BorderRadius.circular(8),
              onTap: onRemove,
              child: Padding(padding: const EdgeInsets.all(3), child: Icon(NzIcons.x, size: 14, color: nz.muted)),
            ),
          ),
      ]),
    );
  }
}

class _LinkDialog extends StatefulWidget {
  const _LinkDialog();

  @override
  State<_LinkDialog> createState() => _LinkDialogState();
}

class _LinkDialogState extends State<_LinkDialog> {
  final _ctrl = TextEditingController();
  String? _error;

  // The API's own rule (SessionService.validateAttachments).
  static final _pattern = RegExp(r'''^https?://[^\s<>"']{3,1900}$''');

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  void _add() {
    final v = _ctrl.text.trim();
    if (!_pattern.hasMatch(v)) return setState(() => _error = S.badLink.of(context));
    Navigator.of(context).pop(v);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(S.attachLink.of(context)),
      content: TextField(
        controller: _ctrl,
        autofocus: true,
        keyboardType: TextInputType.url,
        textDirection: TextDirection.ltr,
        onSubmitted: (_) => _add(),
        decoration: InputDecoration(labelText: S.linkLabel.of(context), hintText: 'https://', errorText: _error),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: Text(S.cancel.of(context))),
        FilledButton(onPressed: _add, child: Text(S.add.of(context))),
      ],
    );
  }
}
