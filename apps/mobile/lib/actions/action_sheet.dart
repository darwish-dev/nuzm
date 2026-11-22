import '../widgets/nz_icons.dart';
import 'dart:async';

import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../app_scope.dart';
import '../data/demo.dart' show Tone;
import '../l10n/strings.dart';
import '../screens/sign_in_screen.dart' show problemText;
import '../theme/nuzm_colors.dart';
import '../widgets/common.dart';
import 'action_model.dart';

/// Starts [action] on [item] (or on the page when [item] is empty). Returns true when the write succeeded.
///
/// Flow: form (if any) → for paid resources a quote with its price → confirm → write. One Idempotency-Key per
/// opened form, so a retry after a timeout never creates twice. Sample mode opens the form but never writes.
Future<bool> runAction(BuildContext context, ActionDef action, {Map<String, dynamic> item = const {}}) async {
  if (action.fields.isEmpty && action.quote == null) {
    final ok = await confirmAction(context, action);
    if (!ok || !context.mounted) return false;
    return _quickRun(context, action, item);
  }
  final done = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    builder: (_) => ActionSheet(action: action, item: item),
  );
  if (done == true && context.mounted) _toast(context, (action.done ?? S.save).of(context));
  return done == true;
}

void _toast(BuildContext context, String text) => ScaffoldMessenger.of(context)
  ..hideCurrentSnackBar()
  ..showSnackBar(SnackBar(content: Text(text)));

Future<bool> confirmAction(BuildContext context, ActionDef action) async {
  if (!action.destructive && action.confirm == null) return true;
  final nz = context.nz;
  final ok = await showDialog<bool>(
    context: context,
    builder: (d) => AlertDialog(
      backgroundColor: nz.elev,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18), side: BorderSide(color: nz.border)),
      title: Text(action.label.of(context), style: const TextStyle(fontWeight: FontWeight.w700)),
      content: Text((action.confirm ?? S.confirmTitle).of(context)),
      actions: [
        TextButton(onPressed: () => Navigator.of(d).pop(false), child: Text(S.cancel.of(context))),
        action.destructive
            ? TextButton(
                style: TextButton.styleFrom(foregroundColor: nz.danger),
                onPressed: () => Navigator.of(d).pop(true),
                child: Text(action.label.of(context), style: const TextStyle(fontWeight: FontWeight.w700)),
              )
            : FilledButton(onPressed: () => Navigator.of(d).pop(true), child: Text(S.continueLabel.of(context))),
      ],
    ),
  );
  return ok == true;
}

Future<bool> _quickRun(BuildContext context, ActionDef action, Map<String, dynamic> item) async {
  final app = AppScope.read(context);
  final api = app.api;
  if (!app.data.isLive || api == null || app.organization == null) {
    _toast(context, S.signInToChange.of(context));
    return false;
  }
  try {
    await action.run(ActionContext(api: api, orgId: app.organization!.orgId, idempotencyKey: newIdempotencyKey(), item: item));
    if (context.mounted) _toast(context, (action.done ?? S.save).of(context));
    return true;
  } on ApiException catch (e) {
    if (e.unauthenticated) app.sessionExpired();
    if (context.mounted) _toast(context, problemText(context, e));
    return false;
  }
}

class ActionSheet extends StatefulWidget {
  const ActionSheet({super.key, required this.action, required this.item});
  final ActionDef action;
  final Map<String, dynamic> item;

  @override
  State<ActionSheet> createState() => _ActionSheetState();
}

class _ActionSheetState extends State<ActionSheet> {
  final _values = <String, Object?>{};
  final _ctrls = <String, TextEditingController>{};
  final _options = <String, List<(String, T)>?>{};
  final _errors = <String, String>{};
  final String _key = newIdempotencyKey();
  String _quoteKey = newIdempotencyKey();
  Quote? _quote;
  String? _quotedFor;
  bool _busy = false;
  String? _error;
  Timer? _tick;

  ActionDef get a => widget.action;

  @override
  void initState() {
    super.initState();
    for (final f in a.fields) {
      final init = f.initial?.call(widget.item);
      if (f.kind == FieldKind.toggle) {
        _values[f.key] = init == true;
      } else if (f.kind == FieldKind.select) {
        _values[f.key] = init?.toString();
      } else {
        _ctrls[f.key] = TextEditingController(text: init == null ? '' : '$init')..addListener(() => _changed(f.key));
      }
    }
    _tick = Timer.periodic(const Duration(seconds: 15), (_) => mounted && _quote != null ? setState(() {}) : null);
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadOptions());
  }

  @override
  void dispose() {
    _tick?.cancel();
    for (final c in _ctrls.values) {
      c.dispose();
    }
    super.dispose();
  }

  ActionContext? _ctx({Quote? quote}) {
    final app = AppScope.read(context);
    final api = app.api;
    if (api == null || !app.data.isLive || app.organization == null) return null;
    return ActionContext(
      api: api,
      orgId: app.organization!.orgId,
      idempotencyKey: _key,
      item: widget.item,
      values: {..._values, for (final e in _ctrls.entries) e.key: e.value.text},
      quote: quote,
    );
  }

  /// Loads the choices of select fields; fields after [changedKey] reload because they may depend on it.
  Future<void> _loadOptions([String? changedKey]) async {
    var after = changedKey == null;
    for (final f in a.fields) {
      if (f.key == changedKey) {
        after = true;
        continue;
      }
      if (!after || f.kind != FieldKind.select) continue;
      if (f.optionsFrom == null) {
        _options[f.key] = f.options;
        continue;
      }
      final c = _ctx();
      if (c == null) {
        setState(() => _options[f.key] = const []);
        continue;
      }
      setState(() => _options[f.key] = null);
      try {
        final o = await f.optionsFrom!(c);
        if (!mounted) return;
        setState(() {
          _options[f.key] = o;
          if (!o.any((x) => x.$1 == _values[f.key])) _values[f.key] = o.length == 1 ? o.first.$1 : null;
        });
      } on ApiException catch (_) {
        if (mounted) setState(() => _options[f.key] = const []);
      }
    }
  }

  void _changed(String key) {
    if (_quote != null || _errors.containsKey(key)) {
      setState(() {
        _errors.remove(key);
      });
    }
  }

  String get _fingerprint => [for (final f in a.fields) '${f.key}=${_values[f.key] ?? _ctrls[f.key]?.text}'].join('&');

  bool get _quoteFresh =>
      _quote != null && _quotedFor == _fingerprint && (_quote!.expiresAt == null || _quote!.expiresAt!.isAfter(DateTime.now()));

  bool _validate() {
    _errors.clear();
    for (final f in a.fields) {
      if (f.kind == FieldKind.toggle) continue;
      final v = (f.kind == FieldKind.select ? (_values[f.key] ?? '') : _ctrls[f.key]!.text).toString().trim();
      if (v.isEmpty) {
        if (f.required) _errors[f.key] = S.requiredField.of(context);
        continue;
      }
      final ok = switch (f.kind) {
        FieldKind.number => RegExp(r'^\d{1,12}$').hasMatch(v) && int.parse(v) > 0,
        FieldKind.money => toMinor(v) != null,
        FieldKind.email => RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(v),
        _ => true,
      };
      if (!ok || (f.pattern != null && !f.pattern!.hasMatch(v))) _errors[f.key] = S.invalidValue.of(context);
    }
    setState(() {});
    return _errors.isEmpty;
  }

  Future<void> _getQuote() async {
    if (!_validate()) return;
    final c = _ctx();
    if (c == null) return _sample();
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final r = await c.api.post('/v1/quotes', a.quote!(c), _quoteKey);
      final q = Quote.fromJson((r as Map).cast<String, dynamic>());
      if (!mounted) return;
      setState(() {
        _quote = q;
        _quotedFor = _fingerprint;
        _quoteKey = newIdempotencyKey();
      });
    } catch (e) {
      _fail(e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _submit() async {
    if (!_validate()) return;
    final c = _ctx(quote: _quote);
    if (c == null) return _sample();
    if (a.quote == null && !await confirmAction(context, a)) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await a.run(c);
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      _fail(e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _fail(Object e) {
    if (!mounted) return;
    if (e is ApiException && e.unauthenticated) {
      Navigator.of(context).pop(false);
      AppScope.read(context).sessionExpired();
      return;
    }
    if (e is ApiException && e.fields.isNotEmpty) {
      for (final f in e.fields) {
        final key = f.split('.').last;
        if (a.fields.any((x) => x.key == key)) _errors[key] = S.invalidValue.of(context);
      }
    }
    setState(() => _error = problemText(context, e) + (e is ApiException && e.traceId != null ? '\n#${e.traceId}' : ''));
  }

  void _sample() {
    Navigator.of(context).pop(false);
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(S.signInToChange.of(context))));
  }

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    final paid = a.quote != null;
    final live = AppScope.of(context).data.isLive;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: ListView(
        shrinkWrap: true,
        padding: const EdgeInsets.fromLTRB(18, 0, 18, 24),
        children: [
          Row(children: [
            IconTile(a.icon, size: 42, tone: a.destructive ? Tone.danger : Tone.accent),
            const SizedBox(width: 12),
            Expanded(child: Text(a.label.of(context), style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700))),
          ]),
          if (!live) ...[const SizedBox(height: 10), Text(S.signInToChange.of(context), style: TextStyle(color: nz.orangeText))],
          if (a.stepUp) ...[
            const SizedBox(height: 10),
            Row(children: [
              Icon(NzIcons.shieldCheck, size: 16, color: nz.muted),
              const SizedBox(width: 6),
              Expanded(child: Text(S.stepUpNote.of(context), style: TextStyle(color: nz.muted, fontSize: 13))),
            ]),
          ],
          const SizedBox(height: 16),
          for (final f in a.fields) Padding(padding: const EdgeInsets.only(bottom: 12), child: _field(f)),
          if (paid && _quote != null) _QuoteCard(quote: _quote!, stale: !_quoteFresh),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 10),
              child: Semantics(
                liveRegion: true,
                child: Text(_error!, style: TextStyle(color: nz.danger, fontWeight: FontWeight.w600)),
              ),
            ),
          const SizedBox(height: 16),
          if (paid && !_quoteFresh)
            FilledButton.icon(
              onPressed: _busy ? null : _getQuote,
              style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(50)),
              icon: _busy ? _spinner(nz) : const Icon(NzIcons.receipt, size: 18),
              label: Text(S.getPrice.of(context)),
            )
          else
            FilledButton(
              onPressed: _busy ? null : _submit,
              style: a.destructive
                  ? FilledButton.styleFrom(minimumSize: const Size.fromHeight(50)).copyWith(
                      backgroundBuilder: (c, s, child) => DecoratedBox(
                        decoration: BoxDecoration(color: nz.danger, borderRadius: BorderRadius.circular(10)),
                        child: child,
                      ),
                      foregroundColor: const WidgetStatePropertyAll(Colors.white),
                    )
                  : FilledButton.styleFrom(minimumSize: const Size.fromHeight(50)),
              child: _busy ? _spinner(nz) : Text(paid ? S.confirmPaid.of(context) : a.label.of(context)),
            ),
          const SizedBox(height: 8),
          OutlinedButton(
            onPressed: _busy ? null : () => Navigator.of(context).pop(false),
            style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
            child: Text(S.cancel.of(context)),
          ),
        ],
      ),
    );
  }

  Widget _spinner(NuzmColors nz) => SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: nz.orangeInk));

  Widget _field(FieldDef f) {
    final nz = context.nz;
    final label = f.label.of(context) + (f.required ? '' : '');
    switch (f.kind) {
      case FieldKind.toggle:
        return SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: Text(label, style: const TextStyle(fontWeight: FontWeight.w600)),
          subtitle: f.hint == null ? null : Text(f.hint!.of(context), style: TextStyle(color: nz.muted)),
          value: _values[f.key] == true,
          onChanged: (v) => setState(() => _values[f.key] = v),
        );
      case FieldKind.select:
        final opts = _options[f.key];
        if (opts == null) {
          return InputDecorator(
            decoration: InputDecoration(labelText: label),
            child: Row(children: [
              const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
              const SizedBox(width: 10),
              Text(S.loadingOptions.of(context), style: TextStyle(color: nz.muted)),
            ]),
          );
        }
        return DropdownButtonFormField<String>(
          key: ValueKey('${f.key}:${opts.length}'),
          initialValue: opts.any((o) => o.$1 == _values[f.key]) ? _values[f.key] as String : null,
          isExpanded: true,
          dropdownColor: nz.elev,
          decoration: InputDecoration(
            labelText: label,
            errorText: _errors[f.key],
            helperText: opts.isEmpty ? S.noOptions.of(context) : f.hint?.of(context),
          ),
          hint: Text(S.choose.of(context)),
          items: [for (final (v, l) in opts) DropdownMenuItem(value: v, child: Text(l.of(context), overflow: TextOverflow.ellipsis))],
          onChanged: (v) {
            setState(() {
              _values[f.key] = v;
              _errors.remove(f.key);
            });
            _loadOptions(f.key);
          },
        );
      default:
        return TextField(
          controller: _ctrls[f.key],
          obscureText: f.kind == FieldKind.password,
          minLines: f.kind == FieldKind.multiline ? 3 : 1,
          maxLines: f.kind == FieldKind.multiline ? 8 : 1,
          textDirection: f.ltr || f.kind == FieldKind.email || f.kind == FieldKind.password ? TextDirection.ltr : null,
          keyboardType: switch (f.kind) {
            FieldKind.number => TextInputType.number,
            FieldKind.money => const TextInputType.numberWithOptions(decimal: true),
            FieldKind.email => TextInputType.emailAddress,
            FieldKind.multiline => TextInputType.multiline,
            _ => TextInputType.text,
          },
          autofillHints: f.kind == FieldKind.password ? const [AutofillHints.password] : null,
          decoration: InputDecoration(labelText: label, errorText: _errors[f.key], helperText: f.hint?.of(context), helperMaxLines: 2),
        );
    }
  }
}

/// The price of a paid action, from the quote. Integer minor units; the tax is the API's estimate.
class _QuoteCard extends StatelessWidget {
  const _QuoteCard({required this.quote, required this.stale});
  final Quote quote;
  final bool stale;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    final left = quote.expiresAt?.difference(DateTime.now());
    Widget row(T label, int minor, {bool strong = false}) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Row(children: [
            Expanded(child: Text(label.of(context), style: TextStyle(color: strong ? nz.fg : nz.muted, fontWeight: strong ? FontWeight.w700 : null))),
            LtrText(displayValue('money:$minor:${quote.currency}', context),
                style: TextStyle(fontWeight: strong ? FontWeight.w800 : FontWeight.w600, fontSize: strong ? 17 : 14)),
          ]),
        );
    return Opacity(
      opacity: stale ? 0.5 : 1,
      child: NzCard(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(S.priceTitle.of(context), style: const TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 6),
          row(S.subtotal, quote.subtotalMinor),
          row(S.taxEst, quote.taxMinor),
          Divider(color: nz.border),
          row(S.total, quote.totalMinor, strong: true),
          if (left != null && !left.isNegative)
            Text('${S.validFor.of(context)} ${left.inMinutes + 1} ${S.minutes.of(context)}', style: TextStyle(color: nz.muted, fontSize: 12.5)),
          if (quote.requiresApproval)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(S.needsApprovalNote.of(context), style: TextStyle(color: nz.orangeText, fontWeight: FontWeight.w600)),
            ),
          const SizedBox(height: 6),
          Text(S.paidNote.of(context), style: TextStyle(color: nz.muted, fontSize: 12.5)),
        ]),
      ),
    );
  }
}
