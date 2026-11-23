import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:nuzm_app/api/api_client.dart';
import 'package:nuzm_app/api/api_data_source.dart';
import 'package:nuzm_app/api/session_store.dart';
import 'package:nuzm_app/app_scope.dart';
import 'package:nuzm_app/data/demo.dart';
import 'package:nuzm_app/data/nav.dart';
import 'package:nuzm_app/main.dart';
import 'package:nuzm_app/screens/section_screen.dart';

const org = '0190a3f0-0000-7000-8000-000000000001';

http.Response json(Object body, {int status = 200, Map<String, String> headers = const {}}) =>
    http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json', ...headers});

/// A tiny fake of the API: records requests and answers by method + path.
class FakeApi {
  final requests = <http.Request>[];
  final routes = <String, http.Response Function(http.Request)>{};

  void on(String method, String path, http.Response Function(http.Request) h) => routes['$method $path'] = h;

  MockClient get client => MockClient((req) async {
        requests.add(req);
        final h = routes['${req.method} ${req.url.path}'];
        if (h == null) return json({'code': 'not_found', 'title': 'Not found', 'status': 404}, status: 404);
        return h(req);
      });

  http.Request last(String method, String path) => requests.lastWhere((r) => r.method == method && r.url.path == path);
}

void main() {
  group('ApiClient', () {
    test('keeps the session cookies, echoes CSRF on unsafe methods, sends org, realm, locale and an idempotency key', () async {
      final f = FakeApi()
        ..on('POST', '/v1/auth/password/login', (_) => json({'id': 'u1'}, headers: {
              'set-cookie': 'nuzm_session=s3cr3t; Path=/; HttpOnly; SameSite=Lax; Expires=Wed, 21 Oct 2026 07:28:00 GMT,'
                  'nuzm_csrf=c5rf; Path=/; SameSite=Lax',
            }))
        ..on('GET', '/v1/me', (_) => json({'id': 'u1'}))
        ..on('POST', '/v1/ai/sessions', (_) => json({'id': 's1'}));
      final store = MemorySessionStore();
      final api = ApiClient(baseUrl: 'http://api.test', store: store, client: f.client, locale: 'en');

      await api.post('/v1/auth/password/login', {'email': 'a@b.test', 'password': 'x'});
      expect(store.cookies, {'nuzm_session': 's3cr3t', 'nuzm_csrf': 'c5rf'});
      await api.setOrg(org);

      await api.get('/v1/me');
      final get = f.last('GET', '/v1/me');
      expect(get.headers['cookie'], contains('nuzm_session=s3cr3t'));
      expect(get.headers['x-nuzm-org'], org);
      expect(get.headers['x-nuzm-realm'], 'web');
      expect(get.headers['accept-language'], 'en');
      expect(get.headers.containsKey('x-csrf-token'), isFalse, reason: 'safe methods carry no CSRF token');
      expect(get.headers.containsKey('idempotency-key'), isFalse);

      await api.post('/v1/ai/sessions', {'title': 't'});
      final post = f.last('POST', '/v1/ai/sessions');
      expect(post.headers['x-csrf-token'], 'c5rf');
      expect(post.headers['idempotency-key'], matches(RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')));
      expect(jsonDecode(post.body), {'title': 't'});
    });

    test('turns a problem response into ApiException and forgets the session on 401', () async {
      final f = FakeApi()
        ..on('GET', '/v1/me', (_) => json(
              {'code': 'unauthenticated', 'title': 'Authentication required', 'status': 401, 'traceId': 't-1'},
              status: 401,
            ));
      final store = MemorySessionStore()..cookies = {'nuzm_session': 'old', 'nuzm_csrf': 'c'};
      final api = ApiClient(baseUrl: 'http://api.test', store: store, client: f.client);
      await expectLater(
        api.get('/v1/me'),
        throwsA(isA<ApiException>().having((e) => e.unauthenticated, 'unauthenticated', true).having((e) => e.traceId, 'traceId', 't-1')),
      );
      expect(store.cookies.containsKey('nuzm_session'), isFalse);
      expect(await api.hasSession(), isFalse);
    });

    test('a network failure is an offline ApiException, not a crash', () async {
      final api = ApiClient(
        baseUrl: 'http://api.test',
        store: MemorySessionStore(),
        client: MockClient((_) async => throw http.ClientException('connection refused')),
      );
      await expectLater(api.get('/v1/me'), throwsA(isA<ApiException>().having((e) => e.offline, 'offline', true)));
    });

    test('splits joined Set-Cookie headers without breaking Expires dates', () {
      expect(
        splitSetCookie('a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/, b=2; Path=/'),
        ['a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/', 'b=2; Path=/'],
      );
    });
  });

  group('AppController (live)', () {
    FakeApi signedInApi({List<Map<String, Object>> memberships = const []}) => FakeApi()
      ..on('POST', '/v1/auth/password/login', (_) => json({'id': 'u1'}, headers: {'set-cookie': 'nuzm_session=s; Path=/,nuzm_csrf=c; Path=/'}))
      ..on('GET', '/v1/me', (_) => json({
            'id': 'u1',
            'email': 'owner@example.test',
            'displayName': 'Owner',
            'locale': 'en',
            'memberships': memberships,
          }))
      ..on('POST', '/v1/auth/logout', (_) => http.Response('', 204, headers: {'set-cookie': 'nuzm_session=; Max-Age=0; Path=/'}));

    test('first launch opens the onboarding; once seen, it starts signed out', () async {
      final store = MemorySessionStore();
      final c = AppController.live(ApiClient(baseUrl: 'http://api.test', store: store, client: FakeApi().client));
      await c.start();
      expect(c.phase, AppPhase.onboarding);
      await c.finishOnboarding(register: true);
      expect(c.phase, AppPhase.signedOut);
      expect(c.startOnRegister, isTrue);
      expect(store.onboarded, isTrue);
      final again = AppController.live(ApiClient(baseUrl: 'http://api.test', store: store, client: FakeApi().client));
      await again.start();
      expect(again.phase, AppPhase.signedOut);
    });

    test('sign-in loads the memberships, picks the organization and switches to live data', () async {
      final f = signedInApi(memberships: [
        {'orgId': org, 'name': 'Coffee Co', 'slug': 'coffee', 'type': 'customer', 'status': 'active', 'role': 'owner'},
      ]);
      final store = MemorySessionStore();
      final c = AppController.live(ApiClient(baseUrl: 'http://api.test', store: store, client: f.client));
      await c.signIn('owner@example.test', 'pw');
      expect(c.phase, AppPhase.ready);
      expect(c.data.isLive, isTrue);
      expect(c.data.orgName.en, 'Coffee Co');
      expect(c.data.userName, 'Owner');
      expect(c.locale.languageCode, 'en', reason: 'the account language wins');
      expect(store.org, org);
      expect(jsonDecode(f.last('POST', '/v1/auth/password/login').body), {'email': 'owner@example.test', 'password': 'pw', 'realm': 'web'});

      await c.signOut();
      expect(c.phase, AppPhase.signedOut);
      expect(store.cookies, isEmpty);
    });

    test('an account without an organization is asked to create one', () async {
      final c = AppController.live(ApiClient(baseUrl: 'http://api.test', store: MemorySessionStore(), client: signedInApi().client));
      await c.signIn('owner@example.test', 'pw');
      expect(c.phase, AppPhase.needsOrg);
    });

    test('wrong credentials surface as invalid_credentials', () async {
      final f = FakeApi()
        ..on('POST', '/v1/auth/password/login',
            (_) => json({'code': 'invalid_credentials', 'title': 'Invalid credentials', 'status': 401}, status: 401));
      final c = AppController.live(ApiClient(baseUrl: 'http://api.test', store: MemorySessionStore(), client: f.client));
      await expectLater(c.signIn('x@example.test', 'bad'), throwsA(isA<ApiException>().having((e) => e.code, 'code', 'invalid_credentials')));
      expect(c.phase, AppPhase.starting);
    });
  });

  group('ApiDataSource mapping', () {
    ApiDataSource source(FakeApi f) => ApiDataSource(
          ApiClient(baseUrl: 'http://api.test', store: MemorySessionStore(), client: f.client),
          orgId: org,
          orgDisplayName: 'Coffee Co',
          user: 'owner',
        );

    test('servers: name, plan, region, status and first public IP', () async {
      final f = FakeApi()
        ..on('GET', '/v1/compute/instances', (_) => json({
              'items': [
                {'id': 'i1', 'name': 'web-01', 'status': 'running', 'dataRegion': 'sa-riyadh', 'plan': {'name': 'Small'}, 'publicIps': ['203.0.113.7']},
              ],
              'nextCursor': null,
            }));
      final d = await source(f).load('instances');
      final it = d.items!.single;
      expect(it.title.en, 'web-01');
      expect(it.subtitle.en, 'Small · sa-riyadh');
      expect(it.status!.tone, Tone.success);
      expect(it.meta, '203.0.113.7');
      expect(f.last('GET', '/v1/compute/instances').url.queryParameters['limit'], '50');
    });

    test('invoices keep integer minor units', () async {
      final f = FakeApi()
        ..on('GET', '/v1/billing/invoices', (_) => json({
              'items': [
                {'id': 'v1', 'number': 'INV-1', 'status': 'open', 'currency': 'SAR', 'totalMinor': 48300, 'taxMinor': 6300, 'paidMinor': 0},
              ],
              'nextCursor': null,
            }));
      final it = (await source(f).load('invoices')).items!.single;
      expect(it.meta, 'money:48300:SAR');
      expect(it.status!.tone, Tone.orange);
    });

    test('team reads the members of the active organization', () async {
      final f = FakeApi()
        ..on('GET', '/v1/organizations/$org/members', (_) => json({
              'items': [
                {'id': 'm1', 'email': 'sara@example.test', 'displayName': 'Sara', 'role': 'admin'},
              ],
              'nextCursor': null,
            }));
      final it = (await source(f).load('team')).items!.single;
      expect(it.title.en, 'Sara');
      expect(it.status!.label.en, 'Admin');
    });

    test('notifications use the console wording with their params', () async {
      final f = FakeApi()
        ..on('GET', '/v1/notifications', (_) => json({
              'items': [
                {'id': 'n1', 'kind': 'billing.invoice_issued', 'params': {'number': 'INV-9'}, 'readAt': null, 'createdAt': '2026-11-20T10:00:00Z'},
              ],
              'nextCursor': null,
              'unreadCount': 1,
            }));
      final n = (await source(f).notifications()).single;
      expect(n.title.en, contains('INV-9'));
      expect(n.title.ar, contains('INV-9'));
      expect(n.pageId, 'invoices');
      expect(n.read, isFalse);
    });

    test('a 403 page surfaces as forbidden, a disabled module (404) as not found', () async {
      final f = FakeApi()
        ..on('GET', '/v1/databases', (_) => json({'code': 'forbidden', 'title': 'Forbidden', 'status': 403}, status: 403));
      await expectLater(source(f).load('databases'), throwsA(isA<ApiException>().having((e) => e.forbidden, 'forbidden', true)));
      await expectLater(source(f).load('workflows'), throwsA(isA<ApiException>().having((e) => e.notFound, 'notFound', true)));
    });

    test('chat: creates the session, adds the message, starts a chat run and returns the reply', () async {
      var messages = <Map<String, Object>>[];
      final f = FakeApi()
        ..on('POST', '/v1/ai/sessions', (_) => json({'id': 's1'}, status: 201))
        ..on('GET', '/v1/ai/sessions/s1/messages', (_) => json({'items': messages, 'nextCursor': null}))
        ..on('POST', '/v1/ai/sessions/s1/messages', (r) {
          messages = [...messages, {'id': 'm1', 'role': 'user', 'content': jsonDecode(r.body)['content'] as String}];
          return json({'id': 'm1'}, status: 201);
        })
        ..on('POST', '/v1/ai/runs', (_) {
          messages = [...messages, {'id': 'm2', 'role': 'assistant', 'content': 'Hello from Nuzm AI'}];
          return json({'run': {'id': 'r1', 'state': 'queued'}}, status: 202);
        })
        ..on('GET', '/v1/ai/runs/r1', (_) => json({'id': 'r1', 'state': 'succeeded'}));
      final turn = await source(f).sendChat(text: 'Build me a store', locale: 'en');
      expect(turn.sessionId, 's1');
      expect(turn.reply, 'Hello from Nuzm AI');
      final run = jsonDecode(f.last('POST', '/v1/ai/runs').body) as Map;
      expect(run['kind'], 'chat');
      expect(run['sessionId'], 's1');
      expect((run['input'] as Map)['locale'], 'en');
    });
  });

  test('money formatting from minor units', () {
    expect(moneyValue(-1840, 'SAR'), 'money:-1840:SAR');
    expect(statusFor('renewal_at_risk')!.tone, Tone.orange);
    expect(statusFor('brand_new_state')!.label.en, 'Brand new state');
    expect(notificationText('something.new', const {}).en, contains('something.new'));
  });

  testWidgets('money renders in the reading language', (tester) async {
    late String ar, en;
    await tester.pumpWidget(Localizations(
      locale: const Locale('ar'),
      delegates: const [DefaultWidgetsLocalizations.delegate],
      child: Builder(builder: (c) {
        ar = money(-1840, c);
        return const SizedBox();
      }),
    ));
    await tester.pumpWidget(Localizations(
      locale: const Locale('en'),
      delegates: const [DefaultWidgetsLocalizations.delegate],
      child: Builder(builder: (c) {
        en = money(123456, c, currency: 'USD');
        return const SizedBox();
      }),
    ));
    expect(ar, '-18.40 ر.س');
    expect(en, '1,234.56 USD');
  });

  testWidgets('sign-in screen → home with the account name; a 403 page shows the forbidden state', (tester) async {
    tester.view.physicalSize = const Size(390, 844) * 3;
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final f = FakeApi()
      ..on('POST', '/v1/auth/password/login', (_) => json({'id': 'u1'}, headers: {'set-cookie': 'nuzm_session=s; Path=/,nuzm_csrf=c; Path=/'}))
      ..on('GET', '/v1/me', (_) => json({
            'id': 'u1',
            'email': 'owner@example.test',
            'displayName': 'Noor',
            'locale': 'ar',
            'memberships': [
              {'orgId': org, 'name': 'Coffee Co', 'slug': 'c', 'type': 'customer', 'status': 'active', 'role': 'owner'},
            ],
          }))
      ..on('GET', '/v1/databases', (_) => json({'code': 'forbidden', 'title': 'Forbidden', 'status': 403}, status: 403));
    final c = AppController.live(ApiClient(baseUrl: 'http://api.test', store: MemorySessionStore()..onboarded = true, client: f.client),
        themeMode: ThemeMode.dark);
    await tester.pumpWidget(NuzmApp(controller: c, useGoogleFonts: false));
    await tester.runAsync(c.start);
    await tester.pumpAndSettle();
    expect(find.text('تسجيل الدخول'), findsOneWidget);

    await tester.enterText(find.byType(TextField).at(0), 'owner@example.test');
    await tester.enterText(find.byType(TextField).at(1), 'pw-for-test');
    await tester.tap(find.text('تسجيل الدخول'));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    await tester.pumpAndSettle();
    expect(c.phase, AppPhase.ready);
    expect(find.textContaining('Noor'), findsOneWidget);

    final nav = tester.state<NavigatorState>(find.byType(Navigator).first);
    nav.push(MaterialPageRoute<void>(builder: (_) => SectionScreen(category: categoryById('data'), initialPage: 'databases')));
    await tester.pumpAndSettle();
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    await tester.pumpAndSettle();
    expect(find.text('لا تملك صلاحية هذه الصفحة'), findsOneWidget);
    expect(find.text('بيانات تجريبية'), findsNothing, reason: 'live data carries no sample chip');
  });

  testWidgets('first launch: onboarding → create account (field errors from the API) → organization → home', (tester) async {
    tester.view.physicalSize = const Size(390, 844) * 3;
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    var registered = false;
    var hasOrg = false;
    final f = FakeApi()
      ..on('POST', '/v1/auth/register', (r) {
        final b = jsonDecode(r.body) as Map;
        if (b['email'] == 'taken@example.test') {
          return json({'code': 'email_in_use', 'title': 'exists', 'status': 409}, status: 409);
        }
        registered = true;
        return json({'id': 'u2'}, status: 201, headers: {'set-cookie': 'nuzm_session=s; Path=/,nuzm_csrf=c; Path=/'});
      })
      ..on('GET', '/v1/me', (_) => json({
            'id': 'u2',
            'email': 'new@example.test',
            'displayName': 'Sara',
            'locale': 'ar',
            'memberships': [
              if (hasOrg) {'orgId': org, 'name': 'Sara Studio', 'slug': 's', 'type': 'customer', 'status': 'active', 'role': 'owner'},
            ],
          }))
      ..on('POST', '/v1/organizations', (_) {
        hasOrg = true;
        return json({'id': org}, status: 201);
      });
    final store = MemorySessionStore();
    final c = AppController.live(ApiClient(baseUrl: 'http://api.test', store: store, client: f.client), themeMode: ThemeMode.dark);
    await tester.pumpWidget(NuzmApp(controller: c, useGoogleFonts: false));
    await tester.runAsync(c.start);
    // The onboarding animates forever (floating orb): pump frames instead of settling.
    await tester.pump(const Duration(milliseconds: 500));
    expect(c.phase, AppPhase.onboarding);
    expect(find.text('ابنِ بالمحادثة'), findsOneWidget);
    await tester.tap(find.text('تخطّي'));
    for (var i = 0; i < 8; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.text('تحكّم كامل في الإنفاق'), findsOneWidget);
    await tester.tap(find.text('إنشاء حساب'));
    await tester.pumpAndSettle();
    expect(store.onboarded, isTrue);
    expect(find.text('إنشاء حساب في نظم'), findsOneWidget);

    // Client-side checks first: nothing is sent for a bad email or a short password.
    await tester.enterText(find.byType(TextField).at(1), 'not-an-email');
    await tester.enterText(find.byType(TextField).at(2), 'short');
    await tester.tap(find.text('إنشاء الحساب'));
    await tester.pumpAndSettle();
    expect(find.text('أدخل بريدًا إلكترونيًا صالحًا.'), findsOneWidget);
    expect(f.requests.where((r) => r.url.path == '/v1/auth/register'), isEmpty);

    await tester.enterText(find.byType(TextField).at(0), 'Sara');
    await tester.enterText(find.byType(TextField).at(1), 'taken@example.test');
    await tester.enterText(find.byType(TextField).at(2), 'a long pass phrase here');
    await tester.pumpAndSettle();
    expect(find.text('قوية'), findsOneWidget, reason: 'strength meter');
    await tester.tap(find.text('إنشاء الحساب'));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    await tester.pumpAndSettle();
    expect(find.textContaining('يوجد حساب بهذا البريد'), findsOneWidget, reason: '409 email_in_use on the email field');

    await tester.enterText(find.byType(TextField).at(1), 'new@example.test');
    await tester.tap(find.text('إنشاء الحساب'));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    await tester.pumpAndSettle();
    expect(registered, isTrue);
    final body = jsonDecode(f.last('POST', '/v1/auth/register').body) as Map;
    expect(body, {'email': 'new@example.test', 'password': 'a long pass phrase here', 'displayName': 'Sara', 'locale': 'ar'});
    expect(c.phase, AppPhase.needsOrg);
    expect(find.text('أنشئ مؤسستك'), findsOneWidget);

    await tester.enterText(find.byType(TextField), 'Sara Studio');
    await tester.tap(find.text('إنشاء'));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    await tester.pumpAndSettle();
    expect(c.phase, AppPhase.ready);
    expect(c.organization?.name, 'Sara Studio');
  });

  testWidgets('forgot password: sends the email and never says whether the account exists', (tester) async {
    tester.view.physicalSize = const Size(390, 844) * 3;
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final f = FakeApi()..on('POST', '/v1/auth/password/forgot', (_) => http.Response('', 202));
    final c = AppController.live(ApiClient(baseUrl: 'http://api.test', store: MemorySessionStore()..onboarded = true, client: f.client));
    await tester.pumpWidget(NuzmApp(controller: c, useGoogleFonts: false));
    await tester.runAsync(c.start);
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).at(0), 'someone@example.test');
    await tester.tap(find.text('نسيت كلمة المرور؟'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('إرسال الرابط'));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    await tester.pumpAndSettle();
    expect(jsonDecode(f.last('POST', '/v1/auth/password/forgot').body), {'email': 'someone@example.test'});
    expect(find.textContaining('إن كان هناك حساب'), findsOneWidget);
  });
}
