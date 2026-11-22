import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../api/api_client.dart';
import '../app_scope.dart';
import '../data/data_source.dart';
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
      if (app.data.isLive) app.balances(refresh: true);
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
        const SizedBox(width: 6),
        CircleIconButton(icon: LucideIcons.rotateCw, tooltip: S.refresh.of(context), onTap: _newChat),
        Expanded(
          child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
            brandMark(context, size: 20),
            const SizedBox(width: 6),
            Flexible(
              child: Text(S.nuzmAi.of(context),
                  maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: nz.chromeFg, fontSize: 14, fontWeight: FontWeight.w700)),
            ),
          ]),
        ),
        // The AI credits the chat spends (the console's top-bar balance chip).
        CreditChip(onTap: () => openPage(context, 'aiUsage')),
        const SizedBox(width: 6),
        CircleIconButton(icon: LucideIcons.squarePen, tooltip: S.newChat.of(context), onTap: _newChat),
      ]),
      body: Column(children: [
        Expanded(
          child: AnimatedSwitcher(
            duration: const Duration(milliseconds: 250),
            child: empty ? const _Hero(key: ValueKey('hero')) : _chat(),
          ),
        ),
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
      padding: const EdgeInsets.fromLTRB(18, 20, 18, 8),
      itemCount: _messages.length + (_typing ? 1 : 0),
      itemBuilder: (context, i) {
        if (i == _messages.length) return _Bubble(text: S.thinking.of(context), fromUser: false, faint: true);
        final m = _messages[i];
        return _Bubble(text: m.text, fromUser: m.fromUser, error: m.error);
      },
    );
  }
}

/// The empty chat, Claude-style: the mark and one greeting line, nothing else.
class _Hero extends StatelessWidget {
  const _Hero({super.key});

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    final greet = (DateTime.now().hour < 12 ? S.morning : S.evening).of(context);
    final user = AppScope.of(context).data.userName;
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.symmetric(horizontal: 28),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          brandMark(context, size: 44),
          const SizedBox(height: 14),
          Text(
            isAr(context) ? '$greet، $user' : '$greet, $user',
            textAlign: TextAlign.center,
            style: TextStyle(color: nz.fg, fontSize: 24, fontWeight: FontWeight.w600, height: 1.3),
          ),
          const SizedBox(height: 4),
          Text(S.heroLine.of(context), textAlign: TextAlign.center, style: TextStyle(color: nz.muted, fontSize: 15)),
        ]),
      ),
    );
  }
}

/// Claude-style messages: yours in a soft bubble at the end, the assistant's as plain text across the width.
class _Bubble extends StatelessWidget {
  const _Bubble({required this.text, required this.fromUser, this.faint = false, this.error = false});
  final String text;
  final bool fromUser;
  final bool faint;
  final bool error;

  @override
  Widget build(BuildContext context) {
    final nz = context.nz;
    if (fromUser) {
      return Padding(
        padding: const EdgeInsets.only(bottom: 18),
        child: Align(
          alignment: AlignmentDirectional.centerEnd,
          child: Container(
            constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.8),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: BoxDecoration(color: nz.elev, borderRadius: BorderRadius.circular(18)),
            child: Text(text, style: TextStyle(color: nz.fg, fontSize: 15.5, height: 1.5)),
          ),
        ),
      );
    }
    return Padding(
      padding: const EdgeInsets.only(bottom: 22),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Padding(padding: const EdgeInsets.only(top: 3), child: brandMark(context, size: 18)),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            text,
            style: TextStyle(
              color: error ? nz.danger : (faint ? nz.muted : nz.fg),
              fontSize: 15.5,
              height: 1.65,
              fontStyle: faint ? FontStyle.italic : FontStyle.normal,
            ),
          ),
        ),
      ]),
    );
  }
}
