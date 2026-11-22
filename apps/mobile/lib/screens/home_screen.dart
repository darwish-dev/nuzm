import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../api/api_client.dart';
import '../app_scope.dart';
import '../data/data_source.dart';
import '../data/demo.dart';
import '../l10n/strings.dart';
import '../theme/nuzm_colors.dart';
import '../widgets/common.dart';
import '../widgets/composer.dart';
import 'menu_screen.dart';
import 'section_screen.dart';
import 'sign_in_screen.dart';

class ChatMessage {
  ChatMessage(this.text, {required this.fromUser, this.error = false});
  final String text;
  final bool fromUser;
  final bool error;
}

/// Home: Nuzm AI, the builder assistant. Empty state is the greeting hero; once you send something it becomes the chat.
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final _messages = <ChatMessage>[];
  final _scroll = ScrollController();
  bool _typing = false;
  String? _sessionId;
  int _turn = 0;
  AppController? _app;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final app = AppScope.of(context);
    if (!identical(app, _app)) {
      _app?.pendingPrompt.removeListener(_takePending);
      _app = app..pendingPrompt.addListener(_takePending);
    }
  }

  @override
  void dispose() {
    _app?.pendingPrompt.removeListener(_takePending);
    _scroll.dispose();
    super.dispose();
  }

  void _takePending() {
    final p = _app?.pendingPrompt.value;
    if (p == null) return;
    _app!.pendingPrompt.value = null;
    Navigator.of(context).popUntil((r) => r.isFirst);
    _send(p);
  }

  /// Sends through the data source: live mode creates the AI session on the first message, adds the message,
  /// starts a `chat` run and shows the assistant's reply; sample mode answers with a preview note.
  Future<void> _send(String text) async {
    final t = text.trim();
    if (t.isEmpty || _typing) return;
    final app = AppScope.read(context);
    final turn = ++_turn;
    setState(() {
      _messages.add(ChatMessage(t, fromUser: true));
      _typing = true;
    });
    _toBottom();
    try {
      final r = await app.data.sendChat(sessionId: _sessionId, text: t, locale: app.locale.languageCode);
      if (!mounted || turn != _turn) return;
      setState(() {
        _sessionId = r.sessionId ?? _sessionId;
        _messages.add(ChatMessage(r.reply ?? S.runStillGoing.of(context), fromUser: false));
      });
    } on ApiException catch (e) {
      if (!mounted || turn != _turn) return;
      if (e.unauthenticated) return app.sessionExpired();
      setState(() => _messages.add(ChatMessage('${S.errorPrefix.of(context)}: ${problemText(context, e)}', fromUser: false, error: true)));
    } catch (e) {
      if (!mounted || turn != _turn) return;
      setState(() => _messages.add(ChatMessage('${S.errorPrefix.of(context)}: ${problemText(context, e)}', fromUser: false, error: true)));
    } finally {
      if (mounted && turn == _turn) setState(() => _typing = false);
      _toBottom();
    }
  }

  Future<void> _openChat(ChatSummary c) async {
    final app = AppScope.read(context);
    _newChat();
    if (c.id == null) return _send(c.title.of(context));
    setState(() => _typing = true);
    try {
      final lines = await app.data.chatLines(c.id!);
      if (!mounted) return;
      setState(() {
        _sessionId = c.id;
        _messages.addAll([for (final l in lines) ChatMessage(l.text, fromUser: l.fromUser)]);
      });
    } on ApiException catch (e) {
      if (e.unauthenticated) return app.sessionExpired();
      if (mounted) setState(() => _messages.add(ChatMessage(problemText(context, e), fromUser: false, error: true)));
    } finally {
      if (mounted) setState(() => _typing = false);
      _toBottom();
    }
  }

  void _toBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(_scroll.position.maxScrollExtent, duration: const Duration(milliseconds: 250), curve: Curves.easeOut);
      }
    });
  }

  void _newChat() {
    _turn++;
    setState(() {
      _messages.clear();
      _typing = false;
      _sessionId = null;
    });
  }

  Future<void> _openMenu() async {
    final picked = await Navigator.of(context).push<ChatSummary>(PageRouteBuilder(
      pageBuilder: (_, __, ___) => const MenuScreen(),
      transitionsBuilder: (_, a, __, child) => FadeTransition(
        opacity: a,
        child: SlideTransition(position: Tween(begin: const Offset(0, -0.03), end: Offset.zero).animate(a), child: child),
      ),
    ));
    if (picked != null && mounted) _openChat(picked);
  }

  @override
  Widget build(BuildContext context) {
    final empty = _messages.isEmpty;
    final nz = context.nz;
    return NzScaffold(
      header: Row(children: [
        CircleIconButton(icon: LucideIcons.menu, tooltip: S.menu.of(context), dot: true, onTap: _openMenu),
        const SizedBox(width: 8),
        CircleIconButton(icon: LucideIcons.rotateCw, tooltip: S.refresh.of(context), onTap: _newChat),
        Expanded(
          child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
            brandMark(context, size: 26),
            const SizedBox(width: 8),
            Text(S.nuzmAi.of(context), style: TextStyle(color: nz.chromeFg, fontSize: 16, fontWeight: FontWeight.w700)),
          ]),
        ),
        const SizedBox(width: 54),
        CircleIconButton(icon: LucideIcons.squarePen, tooltip: S.newChat.of(context), onTap: _newChat),
      ]),
      body: Column(children: [
        Expanded(
          child: AnimatedSwitcher(
            duration: const Duration(milliseconds: 250),
            child: empty ? const _Hero(key: ValueKey('hero')) : _chat(),
          ),
        ),
        if (empty) _Suggestions(onPick: _send),
        Padding(
          padding: const EdgeInsets.fromLTRB(10, 8, 10, 10),
          child: Composer(onSend: _send),
        ),
      ]),
    );
  }

  Widget _chat() {
    return ListView.builder(
      key: const ValueKey('chat'),
      controller: _scroll,
      padding: const EdgeInsets.fromLTRB(16, 20, 16, 8),
      itemCount: _messages.length + (_typing ? 1 : 0),
      itemBuilder: (context, i) {
        if (i == _messages.length) return _Bubble(text: S.thinking.of(context), fromUser: false, faint: true);
        final m = _messages[i];
        return _Bubble(text: m.text, fromUser: m.fromUser, error: m.error);
      },
    );
  }
}

class _Hero extends StatelessWidget {
  const _Hero({super.key});

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    final hour = DateTime.now().hour;
    final greet = (hour < 12 ? S.morning : S.evening).of(context);
    final t = Theme.of(context).textTheme;
    final user = AppScope.of(context).data.userName;
    final chips = <(IconData, String)>[
      (LucideIcons.sparkles, 'builder'),
      (LucideIcons.appWindow, 'appbuilder'),
      (LucideIcons.smartphone, 'mobile'),
      (LucideIcons.server, 'instances'),
      (LucideIcons.search, 'domainSearch'),
    ];
    return LayoutBuilder(
      builder: (context, c) => SingleChildScrollView(
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: c.maxHeight),
          child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
            const SizedBox(height: 12),
            const NuzmMark(size: 112),
            const SizedBox(height: 8),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 24),
              child: Column(children: [
                Text.rich(
                  TextSpan(children: [
                    TextSpan(text: isAr(context) ? '$greet يا $user، ' : '$greet, $user. '),
                    TextSpan(text: '${S.iAm.of(context)} '),
                    TextSpan(text: S.nuzmAi.of(context), style: TextStyle(color: nz.accentStrong)),
                  ]),
                  textAlign: TextAlign.center,
                  style: t.headlineSmall?.copyWith(fontWeight: FontWeight.w800, height: 1.35),
                ),
                const SizedBox(height: 2),
                ShaderMask(
                  blendMode: BlendMode.srcIn,
                  shaderCallback: (r) => LinearGradient(colors: [nz.accentStrong, nz.orange]).createShader(r),
                  child: Text(S.heroLine.of(context),
                      textAlign: TextAlign.center, style: t.headlineSmall?.copyWith(fontWeight: FontWeight.w800, height: 1.35)),
                ),
                const SizedBox(height: 10),
                Text(S.heroSub.of(context), textAlign: TextAlign.center, style: t.bodyLarge?.copyWith(color: nz.muted)),
              ]),
            ),
            const SizedBox(height: 22),
            SizedBox(
              height: 60,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: 16),
                itemCount: chips.length,
                separatorBuilder: (_, __) => const SizedBox(width: 10),
                itemBuilder: (context, i) {
                  final (icon, pageId) = chips[i];
                  final label = pageLabel(pageId).of(context);
                  // `.nzc-chip`: card surface, 1 px border, accent icon.
                  return Material(
                    color: nz.card,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12), side: BorderSide(color: nz.border)),
                    clipBehavior: Clip.antiAlias,
                    child: InkWell(
                      onTap: () => openPage(context, pageId),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 22),
                        child: Row(children: [
                          Icon(icon, size: 20, color: nz.accentStrong),
                          const SizedBox(width: 10),
                          Text(label, style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w700)),
                        ]),
                      ),
                    ),
                  );
                },
              ),
            ),
            const SizedBox(height: 12),
          ]),
        ),
      ),
    );
  }
}

class _Suggestions extends StatelessWidget {
  const _Suggestions({required this.onPick});
  final ValueChanged<String> onPick;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    return SizedBox(
      height: 50,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        itemCount: kSuggestions.length,
        separatorBuilder: (_, __) => const SizedBox(width: 10),
        itemBuilder: (context, i) {
          final s = kSuggestions[i].of(context);
          return Material(
            color: nz.accentSoft,
            shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12), side: BorderSide(color: nz.accent.withValues(alpha: 0.22))),
            clipBehavior: Clip.antiAlias,
            child: InkWell(
              onTap: () => onPick(s),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 18),
                child: Row(children: [
                  Icon(LucideIcons.sparkles, size: 17, color: nz.accent),
                  const SizedBox(width: 8),
                  Text(s, style: TextStyle(color: nz.accent, fontWeight: FontWeight.w600)),
                ]),
              ),
            ),
          );
        },
      ),
    );
  }
}

class _Bubble extends StatelessWidget {
  const _Bubble({required this.text, required this.fromUser, this.faint = false, this.error = false});
  final String text;
  final bool fromUser;
  final bool faint;
  final bool error;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    final bubble = Container(
      constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.78),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        color: fromUser ? nz.primaryFill : (error ? nz.danger.withValues(alpha: 0.12) : nz.card),
        border: fromUser ? null : Border.all(color: error ? nz.danger.withValues(alpha: 0.4) : nz.border),
        borderRadius: BorderRadiusDirectional.only(
          topStart: const Radius.circular(18),
          topEnd: const Radius.circular(18),
          bottomStart: Radius.circular(fromUser ? 18 : 6),
          bottomEnd: Radius.circular(fromUser ? 6 : 18),
        ),
      ),
      child: Text(
        text,
        style: TextStyle(
          color: fromUser ? nz.onPrimaryFill : (error ? nz.danger : (faint ? nz.muted : nz.fg)),
          fontSize: 15.5,
          height: 1.5,
          fontStyle: faint ? FontStyle.italic : FontStyle.normal,
        ),
      ),
    );
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Row(
        mainAxisAlignment: fromUser ? MainAxisAlignment.end : MainAxisAlignment.start,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          if (!fromUser) ...[
            Container(
              width: 34,
              height: 34,
              padding: const EdgeInsets.all(6),
              decoration: BoxDecoration(color: nz.card, shape: BoxShape.circle, border: Border.all(color: nz.border)),
              child: brandMark(context),
            ),
            const SizedBox(width: 8),
          ],
          Flexible(child: bubble),
        ],
      ),
    );
  }
}
