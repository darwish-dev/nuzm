import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../api/api_client.dart';
import '../api/config.dart';
import '../app_scope.dart';
import '../l10n/strings.dart';
import '../theme/nuzm_colors.dart';
import '../widgets/common.dart';

/// Maps an API problem to a sentence for the user (the code stays in the logs, not on screen).
String problemText(BuildContext context, Object e) {
  if (e is ApiException) {
    if (e.code == 'invalid_credentials') return S.invalidCredentials.of(context);
    final known = S.problems[e.code];
    if (known != null) return known.of(context);
    if (e.status == 429) return S.tooMany.of(context);
    if (e.offline) return S.offline.of(context);
    if (e.forbidden) return S.forbiddenTitle.of(context);
    if (e.title.isNotEmpty) return e.title;
  }
  return S.genericError.of(context);
}

class _Frame extends StatelessWidget {
  const _Frame({required this.children});
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final nz = context.nz;
    final dark = Theme.of(context).brightness == Brightness.dark;
    return NzScaffold(
      header: Row(children: [
        brandMark(context, size: 28),
        const SizedBox(width: 10),
        Text(S.appName.of(context), style: TextStyle(color: nz.chromeFg, fontSize: 17, fontWeight: FontWeight.w700)),
        const Spacer(),
        CircleIconButton(
          icon: dark ? LucideIcons.sun : LucideIcons.moon,
          tooltip: (dark ? S.lightMode : S.darkMode).of(context),
          onTap: () => app.toggleTheme(Theme.of(context).brightness),
        ),
        const SizedBox(width: 8),
        CircleIconButton(icon: LucideIcons.languages, tooltip: S.language.of(context), onTap: app.toggleLocale),
      ]),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 460),
          child: ListView(padding: const EdgeInsets.fromLTRB(18, 18, 18, 24), shrinkWrap: true, children: [
            const Center(child: NuzmMark(size: 88)),
            const SizedBox(height: 4),
            NzCard(padding: const EdgeInsets.all(20), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children)),
          ]),
        ),
      ),
    );
  }
}

InputDecoration _field(BuildContext context, String label, {Widget? suffix}) => InputDecoration(labelText: label, suffixIcon: suffix);

class SignInScreen extends StatefulWidget {
  const SignInScreen({super.key});

  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends State<SignInScreen> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;
  bool _obscure = true;
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_email.text.trim().isEmpty || _password.text.isEmpty || _busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await AppScope.read(context).signIn(_email.text, _password.text);
    } catch (e) {
      if (mounted) setState(() => _error = problemText(context, e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    final t = Theme.of(context).textTheme;
    final live = liveApiSupported;
    return _Frame(children: [
      Text(S.signInTitle.of(context), textAlign: TextAlign.center, style: t.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
      const SizedBox(height: 6),
      Text(live ? S.signInSub.of(context) : S.webSampleOnly.of(context), textAlign: TextAlign.center, style: TextStyle(color: nz.muted)),
      const SizedBox(height: 24),
      if (live) ...[
        AutofillGroup(
          child: Column(children: [
            TextField(
              controller: _email,
              keyboardType: TextInputType.emailAddress,
              textDirection: TextDirection.ltr,
              autofillHints: const [AutofillHints.email],
              textInputAction: TextInputAction.next,
              decoration: _field(context, S.email.of(context)),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _password,
              obscureText: _obscure,
              textDirection: TextDirection.ltr,
              autofillHints: const [AutofillHints.password],
              onSubmitted: (_) => _submit(),
              decoration: _field(
                context,
                S.password.of(context),
                suffix: IconButton(
                  tooltip: (_obscure ? S.showPassword : S.hidePassword).of(context),
                  icon: Icon(_obscure ? LucideIcons.eye : LucideIcons.eyeOff, size: 20),
                  onPressed: () => setState(() => _obscure = !_obscure),
                ),
              ),
            ),
          ]),
        ),
        if (_error != null) ...[
          const SizedBox(height: 12),
          Semantics(
            liveRegion: true,
            child: Text(_error!, textAlign: TextAlign.center, style: TextStyle(color: nz.danger, fontWeight: FontWeight.w700)),
          ),
        ],
        const SizedBox(height: 18),
        FilledButton(
          onPressed: _busy ? null : _submit,
          style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(50)),
          child: _busy
              ? SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5, color: nz.onPrimaryFill))
              : Text(S.signIn.of(context), style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
        ),
        const SizedBox(height: 10),
        Text(S.noAccount.of(context), textAlign: TextAlign.center, style: TextStyle(color: nz.muted, fontSize: 13)),
        const SizedBox(height: 14),
      ],
      OutlinedButton.icon(
        onPressed: () => AppScope.read(context).useSampleData(),
        style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(50)),
        icon: Icon(LucideIcons.sparkles, size: 18, color: nz.orangeText),
        label: Text(S.exploreSample.of(context), style: const TextStyle(fontWeight: FontWeight.w700)),
      ),
    ]);
  }
}

class CreateOrgScreen extends StatefulWidget {
  const CreateOrgScreen({super.key});

  @override
  State<CreateOrgScreen> createState() => _CreateOrgScreenState();
}

class _CreateOrgScreenState extends State<CreateOrgScreen> {
  final _name = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_name.text.trim().isEmpty || _busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await AppScope.read(context).createOrg(_name.text);
    } catch (e) {
      if (mounted) setState(() => _error = problemText(context, e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    final app = AppScope.of(context);
    return _Frame(children: [
      Text(S.createOrgTitle.of(context), textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
      const SizedBox(height: 6),
      Text(S.createOrgSub.of(context), textAlign: TextAlign.center, style: TextStyle(color: nz.muted)),
      const SizedBox(height: 24),
      TextField(controller: _name, onSubmitted: (_) => _submit(), decoration: _field(context, S.orgName.of(context))),
      if (_error != null) ...[
        const SizedBox(height: 12),
        Text(_error!, textAlign: TextAlign.center, style: TextStyle(color: nz.danger, fontWeight: FontWeight.w700)),
      ],
      const SizedBox(height: 18),
      FilledButton(
        onPressed: _busy ? null : _submit,
        style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(50)),
        child: Text(S.create.of(context), style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
      ),
      const SizedBox(height: 10),
      TextButton(onPressed: app.signOut, child: Text(S.signOut.of(context))),
    ]);
  }
}

class SplashScreen extends StatelessWidget {
  const SplashScreen({super.key});

  @override
  Widget build(BuildContext context) => Scaffold(
        body: NzBackground(
          child: Center(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              const NuzmMark(size: 96),
              const SizedBox(height: 16),
              SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2.5, color: context.nz.accentStrong)),
            ]),
          ),
        ),
      );
}
