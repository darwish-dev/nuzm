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
import 'package:nuzm_app/actions/action_model.dart';
import 'package:nuzm_app/actions/registry.dart';
import 'package:nuzm_app/api/api_client.dart';
import 'package:nuzm_app/api/session_store.dart';
import 'package:nuzm_app/app_scope.dart';
import 'package:nuzm_app/data/data_source.dart';
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

    await extra('balances', () async {
      final b = await app.data.balances();
      return 'wallet=${b.walletMinor} ${b.currency} credits=${b.credits} low=${b.lowCredit}';
    });
    await extra('notifications', () async => 'n=${(await app.data.notifications()).length}');
    await extra('recentChats', () async => 'n=${(await app.data.recentChats()).length}');
    await extra('domainSearch', () async => 'results=${(await app.data.searchDomains('nuzmmobiletest')).length}');
    await extra('domainSearchTlds', () async {
      final r = await app.data.searchDomains('nuzmmobiletest', tlds: const ['com', 'net']);
      return [for (final d in r) '${d.name}:${d.available}${d.blocked ? ' blocked' : ''}${d.price == null ? '' : ' priced'}'].join(' ');
    });
    await extra('orgHostingPlanKeys', () async {
      final r = await api.get('/v1/hosting/plans');
      final items = r is Map ? r['items'] as List : r as List;
      return [for (final p in items) p['key']].join(',');
    });
    for (final service in const ['hosting', 'cloud']) {
      await extra('plans:$service', () async {
        final g = await app.data.plans(service);
        expect(g, isNotEmpty);
        return [for (final x in g) '${x.id}=${x.cards.length}'].join(' ');
      });
    }
    await extra('aiChat', () async {
      final t = await app.data.sendChat(text: 'مرحبا، ما الخدمات المتاحة؟', locale: 'ar');
      final lines = await app.data.chatLines(t.sessionId!);
      return 'session=${t.sessionId != null} reply=${t.reply == null ? 'pending' : '${t.reply!.length} chars'} lines=${lines.length}';
    });
    // Attachments go with the message (text file + link), stored before the run starts.
    await extra('aiChatAttachments', () async {
      String? sid;
      try {
        final t = await app.data.sendChat(text: 'Use the brief', locale: 'en', attachments: const [
          ChatAttachment.text('brief.md', '# Brief\nA cafe booking app.'),
          ChatAttachment.link('https://example.com/brief'),
        ]);
        sid = t.sessionId;
      } on ApiException catch (e) {
        if (e.code == 'validation_failed') rethrow;
      }
      sid ??= (await app.data.recentChats()).first.id;
      final msgs = await api.get('/v1/ai/sessions/$sid/messages', query: {'limit': '100'});
      final mine = [for (final m in (msgs as Map)['items'] as List) if (m['role'] == 'user' && m['content'] == 'Use the brief') m];
      final kinds = [for (final a in (mine.last['attachments'] as List)) a['kind']];
      expect(kinds, ['text', 'url']);
      return 'stored attachments=$kinds';
    });
    // ---- writes, through the same action definitions the screens use
    final orgId = app.organization!.orgId;
    ActionContext ctx(Map<String, Object?> values, [Map<String, dynamic> item = const {}, Quote? quote]) =>
        ActionContext(api: api, orgId: orgId, idempotencyKey: newIdempotencyKey(), values: values, item: item, quote: quote);
    Future<Map<String, dynamic>?> newest(String path, bool Function(Map<String, dynamic>) where) async =>
        (await ctx({}).list(path)).where(where).firstOrNull;
    ActionDef pa(String page, String id) => kPageActions[page]!.firstWhere((a) => a.id == id);
    ActionDef ia(String page, String id) => kItemActions[page]!.firstWhere((a) => a.id == id);
    // A 4xx that means our request was wrong fails the check; refusals by policy, plan or vendor are recorded.
    bool wrongRequest(Object e) =>
        e is ApiException && const {'validation_failed', 'precondition_required', 'precondition_failed', 'etag_mismatch', 'idempotency_key_required', 'csrf_failed'}.contains(e.code);
    Future<void> w(String name, Future<String> Function() f) async {
      try {
        rows.add('${name.padRight(22)} OK  ${await f()}');
      } catch (e) {
        final o = outcome(e);
        rows.add('${name.padRight(22)} $o');
        if (failsCheck(e) || wrongRequest(e)) crashes.add('$name: $o');
      }
    }

    final tag = '$stamp'.substring(7);
    await w('workspace.create', () async {
      await pa('workspaces', 'create').run(ctx({'name': 'WS $tag'}));
      return 'ok';
    });
    final ws = await newest('/v1/workspaces', (x) => x['name'] == 'WS $tag');
    await w('workspace.rename', () async {
      await ia('workspaces', 'rename').run(ctx({'name': 'WS $tag b'}, ws!));
      return '${(await newest('/v1/workspaces', (x) => x['id'] == ws['id']))?['name']}';
    });
    await w('project.create', () async {
      await pa('projects', 'create').run(ctx({'workspaceId': ws!['id'], 'name': 'Proj $tag'}));
      return 'ok';
    });
    final proj = await newest('/v1/projects', (x) => x['name'] == 'Proj $tag');
    await w('project.rename', () async {
      await ia('projects', 'rename').run(ctx({'name': 'Proj $tag b'}, proj!));
      return '${(await newest('/v1/projects', (x) => x['id'] == proj['id']))?['name']}';
    });
    await w('builder.create', () async {
      await pa('appbuilder', 'create').run(ctx({'type': 'website', 'name': 'Site $tag'}));
      return 'ok';
    });
    final bp = await newest('/v1/builder/projects', (x) => x['name'] == 'Site $tag');
    await w('builder.rename', () async {
      await ia('appbuilder', 'rename').run(ctx({'name': 'Site $tag b'}, bp!));
      return 'ok';
    });
    await w('builder.delete', () async {
      await ia('appbuilder', 'delete').run(ctx({'confirmName': 'Site $tag b'}, {...bp!, 'name': 'Site $tag b'}));
      return 'ok';
    });
    await w('org.edit', () async {
      await pa('orgSettings', 'edit').run(ctx({'name': 'Mobile IT $tag edited', 'defaultLocale': 'ar'}));
      return '${(await api.get('/v1/organizations/$orgId'))['name']}';
    });
    await w('taxProfile.edit', () async {
      await pa('taxProfile', 'edit').run(ctx({
        'buyerType': 'b2b',
        'legalAr': 'شركة اختبار',
        'legalEn': 'Test Co',
        'vat': '300000000000003',
        'cr': '',
        'street': 'King Fahd Rd',
        'buildingNumber': '1234',
        'district': 'Olaya',
        'city': 'Riyadh',
        'postalCode': '12211',
      }));
      return '${(await api.get('/v1/billing/tax-profile'))['legalName']}';
    });
    await w('limits.edit', () async {
      await pa('limits', 'edit').run(ctx({'cap': '1500', 'fourEyes': '500'}));
      return 'cap=${(await app.data.load('limits')).stats!.first.value}';
    });
    await w('aiBudgets.edit', () async {
      final raw = (await app.data.load('aiBudgets')).raw;
      await pa('aiBudgets', 'edit').run(ctx({'dailyCredits': '100', 'runMaxCredits': '20', 'totalCredits': ''}, raw));
      return 'daily=${((await api.get('/v1/ai/budgets'))['org'] as Map)['dailyCredits']}';
    });
    await w('emailDomain.create', () async {
      await pa('emailDomains', 'create').run(ctx({'domain': 'mail-$tag.example.test', 'purposes': 'both'}));
      return 'ok';
    });
    await w('template.create', () async {
      await pa('templates', 'create').run(ctx({'key': 'welcome-$tag', 'name': 'Welcome', 'locale': 'ar', 'subject': 'مرحبا', 'html': '<p>مرحبا</p>'}));
      return 'ok';
    });
    await w('suppression.add', () async {
      await pa('suppressions', 'create').run(ctx({'address': 'blocked-$tag@example.test'}));
      return 'ok';
    });
    final sup = await newest('/v1/email/suppressions', (x) => x['address'] == 'blocked-$tag@example.test');
    await w('suppression.remove', () async {
      await ia('suppressions', 'remove').run(ctx({}, sup!));
      return 'ok';
    });
    await w('team.invite', () async {
      await pa('team', 'create').run(ctx({'email': 'invitee-$tag@example.test', 'role': 'viewer'}));
      return 'ok';
    });
    // Paid: quote only (nothing is created on the dev stack without a human confirming a price).
    for (final (name, page, values) in [
      ('quote.storage', 'storage', <String, Object?>{'name': 'b-$tag', 'estimatedGb': '10'}),
      ('quote.mailbox', 'mailboxes', <String, Object?>{'domainId': 'x', 'localPart': 'info', 'quotaMb': '1024'}),
      ('quote.database', 'databases', <String, Object?>{'engine': 'postgresql', 'version': '16', 'planRef': 'small', 'storageGb': '10', 'name': 'db'}),
    ]) {
      await w(name, () async {
        final q = Quote.fromJson(((await api.post('/v1/quotes', pa(page, 'create').quote!(ctx(values)))) as Map).cast<String, dynamic>());
        return 'total=${q.totalMinor} ${q.currency} approval=${q.requiresApproval}';
      });
    }
    await w('quote.hosting', () async {
      final plan = (await ctx({}).list('/v1/hosting/plans')).first;
      final rts = plan['runtimes'] as List? ?? const [];
      final rt = rts.isEmpty ? '' : (rts.first is Map ? '${(rts.first as Map)['id'] ?? (rts.first as Map)['key']}' : '${rts.first}');
      final body = pa('sites', 'create').quote!(ctx({'planId': plan['id'], 'runtime': rt}));
      final q = Quote.fromJson(((await api.post('/v1/quotes', body)) as Map).cast<String, dynamic>());
      return '${plan['name']}/$rt total=${q.totalMinor} ${q.currency} tax=${q.taxMinor} approval=${q.requiresApproval}';
    });
    await w('project.delete', () async {
      await ia('projects', 'delete').run(ctx({}, proj!));
      return 'ok';
    });
    await w('workspace.delete', () async {
      await ia('workspaces', 'delete').run(ctx({}, ws!));
      return 'ok';
    });
    await w('password.change', () async {
      await pa('profile', 'password').run(ctx({'currentPassword': password, 'newPassword': '${password}X9'}));
      return 'ok';
    });

    await app.signOut();
    rows.add('signOut          OK  phase=${app.phase.name}');

    // ignore: avoid_print
    print(rows.join('\n'));
    expect(crashes, isEmpty, reason: crashes.join('\n'));
  }, skip: base == null ? 'set NUZM_LIVE_API to run against a dev stack' : false, timeout: const Timeout(Duration(minutes: 4)));
}
