import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/config.dart';
import '../app_scope.dart';
import '../l10n/strings.dart';
import '../theme/nuzm_colors.dart';
import '../widgets/common.dart';
import '../widgets/nz_icons.dart';

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

// ---------------------------------------------------------------- the shell

const _panelFg = Color(0xFFF4F0E8);
const _panelMuted = Color(0xFFB9C2C0);
const _ink = Color(0xFF15302A);

/// The website's sign-in / sign-up layout (`AuthShell`) on a phone: the brand panel (the console's dark chrome
/// gradient with its glows, the same in both themes) with the headline and what the account is for, and the form
/// card below it, which follows the theme. Sign-up shows its two steps (account, then organization) instead.
class AuthShell extends StatelessWidget {
  const AuthShell({
    super.key,
    required this.headline,
    required this.sub,
    required this.title,
    required this.body,
    required this.children,
    this.step,
    this.footer = const [],
  });
  final T headline;
  final T sub;
  final T title;
  final T body;

  /// Sign-up: 1 (account) or 2 (organization). Null shows the three features.
  final int? step;
  final List<Widget> children;
  final List<Widget> footer;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    final app = AppScope.of(context);
    final dark = Theme.of(context).brightness == Brightness.dark;
    final panel = NuzmColors.dark;
    return Scaffold(
      backgroundColor: panel.bg,
      body: Stack(children: [
        Positioned.fill(child: DecoratedBox(decoration: BoxDecoration(gradient: panel.chrome))),
        for (final g in panel.chromeGlows) Positioned.fill(child: DecoratedBox(decoration: BoxDecoration(gradient: g))),
        SafeArea(
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 520),
              child: ListView(padding: const EdgeInsets.fromLTRB(14, 6, 14, 20), children: [
                Row(children: [
                  brandMark(context, size: 26),
                  const SizedBox(width: 8),
                  const Expanded(
                    child: Text('NUZM AI',
                        maxLines: 1,
                        overflow: TextOverflow.fade,
                        softWrap: false,
                        style: TextStyle(color: _panelFg, fontSize: 15, fontWeight: FontWeight.w800, letterSpacing: 0.6)),
                  ),
                  _LanguagePill(arabic: app.isArabic, onTap: app.toggleLocale),
                  const SizedBox(width: 8),
                  _PanelDisc(
                    icon: dark ? NzIcons.sun : NzIcons.moon,
                    tooltip: (dark ? S.lightMode : S.darkMode).of(context),
                    onTap: () => app.toggleTheme(Theme.of(context).brightness),
                  ),
                ]),
                Padding(
                  padding: const EdgeInsets.fromLTRB(8, 28, 8, 22),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(headline.of(context), style: const TextStyle(color: _panelFg, fontSize: 28, fontWeight: FontWeight.w800, height: 1.25)),
                    const SizedBox(height: 8),
                    Text(sub.of(context), style: const TextStyle(color: _panelMuted, fontSize: 14.5, height: 1.55)),
                    const SizedBox(height: 18),
                    if (step == null)
                      Wrap(spacing: 8, runSpacing: 8, children: [
                        for (final (i, f) in S.panelFeatures.indexed) _PanelItem(mark: '${i + 1}', label: f.of(context)),
                      ])
                    else
                      Row(children: [
                        for (final (i, label) in [S.stepAccount, S.stepOrg].indexed) ...[
                          if (i > 0) Expanded(child: Container(height: 2, margin: const EdgeInsets.symmetric(horizontal: 8), color: _panelFg.withValues(alpha: 0.18))),
                          _PanelItem(
                            mark: i + 1 < step! ? '✓' : '${i + 1}',
                            label: label.of(context),
                            state: i + 1 < step! ? _StepState.done : (i + 1 == step ? _StepState.current : _StepState.todo),
                          ),
                        ],
                      ]),
                  ]),
                ),
                Container(
                  padding: const EdgeInsets.fromLTRB(20, 24, 20, 20),
                  decoration: BoxDecoration(
                    color: nz.bg,
                    borderRadius: BorderRadius.circular(28),
                    boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.28), blurRadius: 40, offset: const Offset(0, 18), spreadRadius: -12)],
                  ),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    Text(title.of(context), style: TextStyle(color: nz.fg, fontSize: 22, fontWeight: FontWeight.w800)),
                    const SizedBox(height: 4),
                    Text(body.of(context), style: TextStyle(color: nz.muted, fontSize: 13.5, height: 1.5)),
                    const SizedBox(height: 20),
                    ...children,
                    // The other way in (sign-up / sign-in, sample data): inside the card, readable in both themes.
                    if (footer.isNotEmpty) ...[
                      const SizedBox(height: 14),
                      Divider(height: 1, color: nz.fg.withValues(alpha: 0.08)),
                      const SizedBox(height: 6),
                      ...footer,
                    ],
                  ]),
                ),
              ]),
            ),
          ),
        ),
      ]),
    );
  }
}

enum _StepState { done, current, todo }

class _PanelItem extends StatelessWidget {
  const _PanelItem({required this.mark, required this.label, this.state = _StepState.current});
  final String mark;
  final String label;
  final _StepState state;

  @override
  Widget build(BuildContext context) {
    final on = state != _StepState.todo;
    return Container(
      padding: const EdgeInsetsDirectional.fromSTEB(5, 5, 12, 5),
      decoration: BoxDecoration(color: _panelFg.withValues(alpha: on ? 0.10 : 0.05), borderRadius: BorderRadius.circular(20)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Container(
          width: 24,
          height: 24,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            gradient: on ? NuzmColors.brandGradient : null,
            color: on ? null : _panelFg.withValues(alpha: 0.12),
          ),
          child: Text(mark, style: TextStyle(color: on ? _ink : _panelMuted, fontSize: 12, fontWeight: FontWeight.w800)),
        ),
        const SizedBox(width: 8),
        Flexible(child: Text(label, style: TextStyle(color: on ? _panelFg : _panelMuted, fontSize: 13, fontWeight: FontWeight.w700))),
      ]),
    );
  }
}

class _LanguagePill extends StatelessWidget {
  const _LanguagePill({required this.arabic, required this.onTap});
  final bool arabic;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Tooltip(
        message: S.language.of(context),
        child: Material(
          color: const Color(0xD90D0E10),
          shape: const StadiumBorder(),
          child: InkWell(
            customBorder: const StadiumBorder(),
            onTap: onTap,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(NzIcons.languages, size: 16, color: _panelFg),
                const SizedBox(width: 6),
                // The language you switch to, written in that language (as the website's switch).
                Text(arabic ? 'English' : 'العربية', style: const TextStyle(color: _panelFg, fontSize: 13, fontWeight: FontWeight.w700)),
              ]),
            ),
          ),
        ),
      );
}

class _PanelDisc extends StatelessWidget {
  const _PanelDisc({required this.icon, required this.tooltip, required this.onTap});
  final IconData icon;
  final String tooltip;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Tooltip(
        message: tooltip,
        child: Material(
          color: const Color(0xD90D0E10),
          shape: const CircleBorder(),
          child: InkWell(
            customBorder: const CircleBorder(),
            onTap: onTap,
            child: SizedBox(width: 38, height: 38, child: Icon(icon, size: 18, color: _panelFg)),
          ),
        ),
      );
}

/// A footer line on the panel: "No account? Create one".
class _SwitchLine extends StatelessWidget {
  const _SwitchLine({required this.question, required this.action, required this.onTap});
  final T question;
  final T action;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Wrap(alignment: WrapAlignment.center, crossAxisAlignment: WrapCrossAlignment.center, children: [
        Text(question.of(context), style: TextStyle(color: context.nz.muted, fontSize: 14)),
        TextButton(
          onPressed: onTap,
          child: Text(action.of(context), style: TextStyle(color: context.nz.accent, fontWeight: FontWeight.w800, fontSize: 14)),
        ),
      ]);
}

final _emailPattern = RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$');

Widget _errorLine(BuildContext context, String? error) => error == null
    ? const SizedBox.shrink()
    : Padding(
        padding: const EdgeInsets.only(top: 12),
        child: Semantics(
          liveRegion: true,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(color: context.nz.danger.withValues(alpha: 0.10), borderRadius: BorderRadius.circular(12)),
            child: Row(children: [
              Icon(NzIcons.triangleAlert, size: 17, color: context.nz.danger),
              const SizedBox(width: 8),
              Expanded(child: Text(error, style: TextStyle(color: context.nz.danger, fontWeight: FontWeight.w700, fontSize: 13.5))),
            ]),
          ),
        ),
      );

Widget _primary(BuildContext context, {required bool busy, required T label, required VoidCallback onPressed}) => FilledButton(
      onPressed: busy ? null : onPressed,
      style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
      child: busy
          ? SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5, color: context.nz.orangeInk))
          : Text(label.of(context), style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
    );

class _PasswordField extends StatefulWidget {
  const _PasswordField({required this.controller, this.error, this.onSubmitted, this.newPassword = false});
  final TextEditingController controller;
  final String? error;
  final ValueChanged<String>? onSubmitted;
  final bool newPassword;

  @override
  State<_PasswordField> createState() => _PasswordFieldState();
}

class _PasswordFieldState extends State<_PasswordField> {
  bool _obscure = true;

  @override
  Widget build(BuildContext context) => TextField(
        controller: widget.controller,
        obscureText: _obscure,
        textDirection: TextDirection.ltr,
        autofillHints: [widget.newPassword ? AutofillHints.newPassword : AutofillHints.password],
        onSubmitted: widget.onSubmitted,
        decoration: InputDecoration(
          labelText: S.password.of(context),
          errorText: widget.error,
          prefixIcon: const Icon(NzIcons.lock, size: 19),
          suffixIcon: IconButton(
            tooltip: (_obscure ? S.showPassword : S.hidePassword).of(context),
            icon: Icon(_obscure ? NzIcons.eye : NzIcons.eyeOff, size: 20),
            onPressed: () => setState(() => _obscure = !_obscure),
          ),
        ),
      );
}

/// 0..3 from length and variety: the API's real rule is 12..128 characters and not a common password.
int passwordScore(String p) {
  if (p.length < 12) return 0;
  final classes = [RegExp('[a-z]'), RegExp('[A-Z]'), RegExp(r'\d'), RegExp(r'[^A-Za-z0-9]')].where((r) => r.hasMatch(p)).length;
  if (p.length >= 20 || (p.length >= 16 && classes >= 3)) return 3;
  if (p.length >= 16 || classes >= 3) return 2;
  return 1;
}

class _StrengthMeter extends StatelessWidget {
  const _StrengthMeter(this.password);
  final String password;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    final score = passwordScore(password);
    final colors = [nz.danger, nz.orange, nz.accent, nz.accent];
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          for (var i = 0; i < 4; i++) ...[
            if (i > 0) const SizedBox(width: 4),
            Expanded(
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 200),
                height: 4,
                decoration: BoxDecoration(
                  color: password.isNotEmpty && i <= score ? colors[score] : nz.elev,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
          ],
        ]),
        const SizedBox(height: 6),
        Text(
          password.isEmpty ? S.passwordHelp.of(context) : (password.length < 12 ? S.passwordShort : S.passwordStrength[score]).of(context),
          style: TextStyle(color: password.isNotEmpty && password.length < 12 ? nz.danger : nz.muted, fontSize: 12),
        ),
      ]),
    );
  }
}

// ---------------------------------------------------------------- signed out: sign-in ⇄ sign-up

/// The signed-out screen: sign-in, or sign-up when the onboarding's "Create an account" was chosen.
class AuthScreen extends StatefulWidget {
  const AuthScreen({super.key});

  @override
  State<AuthScreen> createState() => _AuthScreenState();
}

class _AuthScreenState extends State<AuthScreen> {
  late bool _register = AppScope.read(context).startOnRegister;

  @override
  Widget build(BuildContext context) => AnimatedSwitcher(
        duration: const Duration(milliseconds: 260),
        child: _register
            ? RegisterScreen(key: const ValueKey('register'), onSignIn: () => setState(() => _register = false))
            : SignInScreen(key: const ValueKey('signin'), onRegister: () => setState(() => _register = true)),
      );
}

class SignInScreen extends StatefulWidget {
  const SignInScreen({super.key, this.onRegister});
  final VoidCallback? onRegister;

  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends State<SignInScreen> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy) return;
    if (!_emailPattern.hasMatch(_email.text.trim()) || _password.text.isEmpty) {
      return setState(() => _error = S.invalidCredentials.of(context));
    }
    if (!liveApiSupported) return setState(() => _error = S.webSampleOnly.of(context));
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
    final app = AppScope.of(context);
    return AuthShell(
      headline: S.panelLoginTitle,
      sub: S.panelLoginSub,
      title: S.loginTitle,
      body: S.loginBody,
      footer: [
        if (widget.onRegister != null) _SwitchLine(question: S.loginNoAccount, action: S.loginRegister, onTap: widget.onRegister!),
        Center(
          child: TextButton.icon(
            onPressed: app.useSampleData,
            icon: Icon(NzIcons.sparkles, size: 16, color: nz.orangeText),
            label: Text(S.exploreSample.of(context), style: TextStyle(color: nz.muted, fontWeight: FontWeight.w600, fontSize: 13)),
          ),
        ),
      ],
      children: [
        AutofillGroup(
          child: Column(children: [
            TextField(
              controller: _email,
              keyboardType: TextInputType.emailAddress,
              textDirection: TextDirection.ltr,
              autofillHints: const [AutofillHints.email],
              textInputAction: TextInputAction.next,
              decoration: InputDecoration(labelText: S.email.of(context), prefixIcon: const Icon(NzIcons.mail, size: 19)),
            ),
            const SizedBox(height: 12),
            _PasswordField(controller: _password, onSubmitted: (_) => _submit()),
          ]),
        ),
        Align(
          alignment: AlignmentDirectional.centerEnd,
          child: TextButton(
            onPressed: () => showForgotPassword(context, _email.text),
            child: Text(S.forgot.of(context), style: TextStyle(color: nz.accent, fontWeight: FontWeight.w700, fontSize: 13)),
          ),
        ),
        _errorLine(context, _error),
        const SizedBox(height: 12),
        _primary(context, busy: _busy, label: S.signIn, onPressed: _submit),
      ],
    );
  }
}

class RegisterScreen extends StatefulWidget {
  const RegisterScreen({super.key, this.onSignIn});
  final VoidCallback? onSignIn;

  @override
  State<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends State<RegisterScreen> {
  final _name = TextEditingController();
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;
  String? _error;
  String? _emailError;
  String? _passwordError;

  @override
  void initState() {
    super.initState();
    _password.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _name.dispose();
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy) return;
    final email = _email.text.trim();
    final p = _password.text;
    setState(() {
      _error = null;
      _emailError = _emailPattern.hasMatch(email) ? null : S.badEmail.of(context);
      _passwordError = p.length < 12 || p.length > 128 ? S.passwordHelp.of(context) : null;
    });
    if (_emailError != null || _passwordError != null) return;
    if (!liveApiSupported) return setState(() => _error = S.webSampleOnly.of(context));
    setState(() => _busy = true);
    try {
      await AppScope.read(context).register(email: email, password: p, displayName: _name.text);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        if (e.code == 'email_in_use') {
          _emailError = problemText(context, e);
        } else if (e.code == 'weak_password') {
          _passwordError = problemText(context, e);
        } else {
          _error = problemText(context, e);
        }
      });
    } catch (e) {
      if (mounted) setState(() => _error = problemText(context, e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AuthShell(
      headline: S.panelRegisterTitle,
      sub: S.panelRegisterSub,
      title: S.registerTitle,
      body: S.registerBody,
      step: 1,
      footer: [
        if (widget.onSignIn != null) _SwitchLine(question: S.haveAccount, action: S.signIn, onTap: widget.onSignIn!),
      ],
      children: [
        AutofillGroup(
          child: Column(children: [
            TextField(
              controller: _name,
              autofillHints: const [AutofillHints.name],
              textInputAction: TextInputAction.next,
              maxLength: 120,
              decoration: InputDecoration(labelText: S.displayName.of(context), prefixIcon: const Icon(NzIcons.user, size: 19), counterText: ''),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _email,
              keyboardType: TextInputType.emailAddress,
              textDirection: TextDirection.ltr,
              autofillHints: const [AutofillHints.email],
              textInputAction: TextInputAction.next,
              decoration: InputDecoration(labelText: S.email.of(context), errorText: _emailError, prefixIcon: const Icon(NzIcons.mail, size: 19)),
            ),
            const SizedBox(height: 12),
            _PasswordField(controller: _password, error: _passwordError, newPassword: true, onSubmitted: (_) => _submit()),
            _StrengthMeter(_password.text),
          ]),
        ),
        _errorLine(context, _error),
        const SizedBox(height: 18),
        _primary(context, busy: _busy, label: S.registerSubmit, onPressed: _submit),
      ],
    );
  }
}

/// "Forgot your password?": the API always answers 202, so the message never says whether the account exists.
Future<void> showForgotPassword(BuildContext context, String email) => showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _ForgotSheet(email: email),
    );

class _ForgotSheet extends StatefulWidget {
  const _ForgotSheet({required this.email});
  final String email;

  @override
  State<_ForgotSheet> createState() => _ForgotSheetState();
}

class _ForgotSheetState extends State<_ForgotSheet> {
  late final _email = TextEditingController(text: widget.email.trim());
  bool _busy = false;
  bool _sent = false;
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    if (_busy) return;
    if (!_emailPattern.hasMatch(_email.text.trim())) return setState(() => _error = S.badEmail.of(context));
    if (!liveApiSupported) return setState(() => _error = S.webSampleOnly.of(context));
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await AppScope.read(context).forgotPassword(_email.text);
      if (mounted) setState(() => _sent = true);
    } catch (e) {
      if (mounted) setState(() => _error = problemText(context, e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.viewInsetsOf(context).bottom),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text(S.forgotTitle.of(context), style: TextStyle(color: nz.fg, fontSize: 19, fontWeight: FontWeight.w800)),
        const SizedBox(height: 4),
        Text(S.forgotBody.of(context), style: TextStyle(color: nz.muted, fontSize: 13.5, height: 1.5)),
        const SizedBox(height: 16),
        if (_sent)
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(color: nz.accentSoft, borderRadius: BorderRadius.circular(14)),
            child: Row(children: [
              Icon(NzIcons.circleCheck, color: nz.accent),
              const SizedBox(width: 10),
              Expanded(child: Text(S.forgotSent.of(context), style: TextStyle(color: nz.fg, fontWeight: FontWeight.w600))),
            ]),
          )
        else ...[
          TextField(
            controller: _email,
            autofocus: widget.email.isEmpty,
            keyboardType: TextInputType.emailAddress,
            textDirection: TextDirection.ltr,
            onSubmitted: (_) => _send(),
            decoration: InputDecoration(labelText: S.email.of(context), errorText: _error, prefixIcon: const Icon(NzIcons.mail, size: 19)),
          ),
          const SizedBox(height: 16),
          _primary(context, busy: _busy, label: S.forgotSubmit, onPressed: _send),
        ],
      ]),
    );
  }
}

// ---------------------------------------------------------------- step 2: the organization

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
    final app = AppScope.of(context);
    return AuthShell(
      headline: S.panelRegisterTitle,
      sub: S.orgStepSub,
      title: S.createOrgTitle,
      body: S.createOrgSub,
      step: 2,
      footer: [
        Center(
          child: TextButton(
            onPressed: app.signOut,
            child: Text(S.signOut.of(context), style: TextStyle(color: context.nz.muted, fontWeight: FontWeight.w600)),
          ),
        ),
      ],
      children: [
        TextField(
          controller: _name,
          onSubmitted: (_) => _submit(),
          decoration: InputDecoration(labelText: S.orgName.of(context), prefixIcon: const Icon(NzIcons.building2, size: 19)),
        ),
        _errorLine(context, _error),
        const SizedBox(height: 18),
        _primary(context, busy: _busy, label: S.create, onPressed: _submit),
      ],
    );
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
