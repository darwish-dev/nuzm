// Live check against a running dev stack (API + Postgres). Skipped unless NUZM_LIVE_API is set:
//
//   pnpm services:start && pnpm db:migrate && pnpm --filter @nuzm/api dev:stack
//   NUZM_LIVE_API=http://127.0.0.1:4000 flutter test test/live_api_test.dart
//
// Registers a throwaway account (mobile-it-<time>@example.test, random password that is never printed), creates an
// organization, then loads every page of the app through ApiDataSource. Only for local or test environments.
import 'dart:io';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:nuzm_app/api/api_client.dart';
import 'package:nuzm_app/api/session_store.dart';
import 'package:nuzm_app/app_scope.dart';
import 'package:nuzm_app/data/nav.dart';

final base = Platform.environment['NUZM_LIVE_API'];

String outcome(Object e) => e is ApiException
    ? (e.forbidden ? 'FORBIDDEN (${e.code}: ${e.title})' : e.notFound ? 'NOT FOUND (${e.code}: ${e.title})' : 'ERROR ${e.status} ${e.code}')
    : 'CRASH ${e.runtimeType}: $e';

/// The app must never crash on a response, and the API must not answer 500. A 502/503 is an upstream vendor
/// (registrar, model provider) being unavailable: recorded, not failed, because the app shows it as such.
bool failsCheck(Object e) => e is! ApiException || (e.status >= 500 && e.status != 502 && e.status != 503);

void main() {
  test('every screen loads from the live API', () async {
    final host = Uri.parse(base!).host;
    expect(['127.0.0.1', 'localhost', '10.0.2.2'].contains(host) || host.endsWith('.test') || host.endsWith('.localhost'), isTrue,
        reason: 'the live check only runs against a local or test stack');

    final r = Random.secure();
    final stamp = DateTime.now().toUtc().millisecondsSinceEpoch;
    final email = 'mobile-it-$stamp@example.test';
    final password = List.generate(24, (_) => 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[r.nextInt(55)]).join();

    final api = ApiClient(baseUrl: base!, store: MemorySessionStore(), locale: 'ar');
    await api.post('/v1/auth/register', {'email': email, 'password': password, 'displayName': 'Mobile IT', 'locale': 'ar'});
    final app = AppController.live(api);
    await app.start();
    expect(app.phase, AppPhase.needsOrg, reason: 'a new account has no organization');
    await app.createOrg('Mobile IT $stamp');
    expect(app.phase, AppPhase.ready);
    expect(app.data.isLive, isTrue);
    // ignore: avoid_print
    print('signed in as ${app.email} in ${app.organization!.name} (${app.organization!.role})');

    final rows = <String>[];
    final crashes = <String>[];
    for (final c in kCategories) {
      for (final p in c.pages) {
        try {
          if (p.kind == PageKind.dashboard) {
            final d = await app.data.dashboard();
            rows.add('${p.id.padRight(16)} OK  stats=${d.stats.length} attention=${d.attention.length}');
            continue;
          }
          final d = await app.data.load(p.id);
          final n = [
            if (d.items != null) 'items=${d.items!.length}',
            if (d.stats != null) 'stats=${d.stats!.length}',
            if (d.catalog != null) 'catalog=${d.catalog!.length}',
            if (d.fields != null) 'fields=${d.fields!.length}',
            if (d.related != null) 'related=${d.related!.length}',
          ].join(' ');
          rows.add('${p.id.padRight(16)} OK  ${n.isEmpty ? '(no data needed)' : n}');
        } catch (e) {
          final o = outcome(e);
          rows.add('${p.id.padRight(16)} $o');
          if (failsCheck(e)) crashes.add('${p.id}: $o');
        }
      }
    }
    Future<void> extra(String name, Future<String> Function() f) async {
      try {
        rows.add('${name.padRight(16)} OK  ${await f()}');
      } catch (e) {
        final o = outcome(e);
        rows.add('${name.padRight(16)} $o');
        if (failsCheck(e)) crashes.add('$name: $o');
      }
    }

    await extra('notifications', () async => 'n=${(await app.data.notifications()).length}');
    await extra('recentChats', () async => 'n=${(await app.data.recentChats()).length}');
    await extra('domainSearch', () async => 'results=${(await app.data.searchDomains('nuzmmobiletest')).length}');
    await extra('aiChat', () async {
      final t = await app.data.sendChat(text: 'مرحبا، ما الخدمات المتاحة؟', locale: 'ar');
      final lines = await app.data.chatLines(t.sessionId!);
      return 'session=${t.sessionId != null} reply=${t.reply == null ? 'pending' : '${t.reply!.length} chars'} lines=${lines.length}';
    });
    await app.signOut();
    rows.add('signOut          OK  phase=${app.phase.name}');

    // ignore: avoid_print
    print(rows.join('\n'));
    expect(crashes, isEmpty, reason: crashes.join('\n'));
  }, skip: base == null ? 'set NUZM_LIVE_API to run against a dev stack' : false, timeout: const Timeout(Duration(minutes: 4)));
}
