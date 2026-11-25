import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:nuzm_app/actions/action_model.dart';
import 'package:nuzm_app/actions/registry.dart';
import 'package:nuzm_app/api/api_client.dart';
import 'package:nuzm_app/api/api_data_source.dart' show localized;
import 'package:nuzm_app/api/session_store.dart';
import 'package:nuzm_app/app_scope.dart';
import 'package:nuzm_app/data/nav.dart';
import 'package:nuzm_app/screens/section_screen.dart';
import 'package:nuzm_app/theme/nuzm_theme.dart';

const org = '0190a3f0-0000-7000-8000-000000000001';

http.Response json(Object body, {int status = 200, Map<String, String> headers = const {}}) =>
    http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json', ...headers});

class FakeApi {
  final requests = <http.Request>[];
  final routes = <String, http.Response Function(http.Request)>{};
  void on(String method, String path, http.Response Function(http.Request) h) => routes['$method $path'] = h;
  MockClient get client => MockClient((req) async {
        requests.add(req);
        final h = routes['${req.method} ${req.url.path}'];
        return h == null ? json({'code': 'not_found', 'title': 'Not found', 'status': 404}, status: 404) : h(req);
      });
  List<http.Request> all(String method, String path) => requests.where((r) => r.method == method && r.url.path == path).toList();
  Map<String, dynamic> body(String method, String path) => jsonDecode(all(method, path).last.body) as Map<String, dynamic>;
}

ActionDef page(String pageId, String id) => kPageActions[pageId]!.firstWhere((a) => a.id == id);
ActionDef item(String pageId, String id) => kItemActions[pageId]!.firstWhere((a) => a.id == id);

ActionContext ctx(FakeApi f, {Map<String, Object?> values = const {}, Map<String, dynamic> item = const {}, Quote? quote, String key = 'k-1'}) =>
    ActionContext(
      api: ApiClient(baseUrl: 'http://api.test', store: MemorySessionStore()..cookies = {'nuzm_session': 's', 'nuzm_csrf': 'c'}, client: f.client),
      orgId: org,
      idempotencyKey: key,
      values: values,
      item: item,
      quote: quote,
    );

void main() {
  test('every action belongs to a page of the app', () {
    // 'domainSearch' is the register tab of the add-domain screen (the domains list's +).
    final ids = {for (final c in kCategories) ...c.pages.map((p) => p.id), 'domainSearch'};
    expect(ids.containsAll(kPageActions.keys), isTrue);
    expect(ids.containsAll(kItemActions.keys), isTrue);
    expect(kPageActions.values.expand((a) => a).length + kItemActions.values.expand((a) => a).length, greaterThanOrEqualTo(45));
  });

  test('a create is a POST with the action\'s idempotency key and CSRF token', () async {
    final f = FakeApi()..on('POST', '/v1/workspaces', (_) => json({'id': 'w1'}, status: 201));
    await page('workspaces', 'create').run(ctx(f, values: {'name': 'Marketing'}, key: 'same-key'));
    await page('workspaces', 'create').run(ctx(f, values: {'name': 'Marketing'}, key: 'same-key'));
    final posts = f.all('POST', '/v1/workspaces');
    expect(posts.map((r) => r.headers['idempotency-key']).toSet(), {'same-key'}, reason: 'a retry of the same submission reuses its key');
    expect(posts.first.headers['x-csrf-token'], 'c');
    expect(f.body('POST', '/v1/workspaces'), {'name': 'Marketing'});
  });

  test('edits and deletes read the ETag first and send If-Match', () async {
    final f = FakeApi()
      ..on('GET', '/v1/projects/p1', (_) => json({'id': 'p1', 'name': 'Old'}, headers: {'etag': 'W/"7"'}))
      ..on('PATCH', '/v1/projects/p1', (_) => json({'id': 'p1', 'name': 'New'}))
      ..on('GET', '/v1/compute/instances/i1', (_) => json({'id': 'i1'}, headers: {'etag': 'W/"3"'}))
      ..on('DELETE', '/v1/compute/instances/i1', (_) => http.Response('', 202));
    await item('projects', 'rename').run(ctx(f, values: {'name': 'New'}, item: {'id': 'p1'}));
    expect(f.all('PATCH', '/v1/projects/p1').single.headers['if-match'], 'W/"7"');
    expect(f.body('PATCH', '/v1/projects/p1'), {'name': 'New'});
    await item('instances', 'delete').run(ctx(f, item: {'id': 'i1'}));
    expect(f.all('DELETE', '/v1/compute/instances/i1').single.headers['if-match'], 'W/"3"');
  });

  test('paid resources: the quote body comes from the form, the create carries the quote id', () async {
    final f = FakeApi()..on('POST', '/v1/hosting/sites', (_) => json({'site': {'id': 's1'}}, status: 202));
    final a = page('sites', 'create');
    final values = {'planId': 'pl1', 'runtime': 'php-8.3', 'projectId': 'pr1', 'name': 'Shop', 'primaryDomain': 'Shop.SA'};
    expect(a.quote!(ctx(f, values: values)), {
      'kind': 'hosting',
      'items': [
        {'planId': 'pl1', 'runtime': 'php-8.3'},
      ],
    });
    final q = Quote.fromJson({'id': 'q1', 'currency': 'SAR', 'subtotalMinor': '10000', 'totalMinor': '11500', 'expiresAt': '2099-01-01T00:00:00Z'});
    await a.run(ctx(f, values: values, quote: q));
    expect(f.body('POST', '/v1/hosting/sites'), {
      'quoteId': 'q1',
      'planId': 'pl1',
      'name': 'Shop',
      'projectId': 'pr1',
      'runtime': 'php-8.3',
      'primaryDomain': 'shop.sa',
    });
  });

  test('bilingual API names show in the reader\'s language', () {
    expect(localized({'ar': 'البداية', 'en': 'Start'}).ar, 'البداية');
    expect(localized({'ar': 'البداية', 'en': 'Start'}).en, 'Start');
    expect(localized('Plain').en, 'Plain');
  });

  test('money fields become integer minor units (no floats)', () async {
    expect(toMinor('1,250.5'), 125050);
    expect(toMinor('0.07'), 7);
    expect(toMinor('12.345'), isNull);
    expect(toMinor('abc'), isNull);
    expect(fromMinor(125050), '1250.50');
    final f = FakeApi()
      ..on('GET', '/v1/billing/spending-limits', (_) => json({'items': []}))
      ..on('PUT', '/v1/billing/spending-limits', (_) => json({'id': 'l1'}));
    await page('limits', 'edit').run(ctx(f, values: {'cap': '1000', 'fourEyes': ''}));
    expect(f.body('PUT', '/v1/billing/spending-limits'),
        {'scope': 'org', 'monthlyCapMinor': '100000', 'currency': 'SAR', 'fourEyesAboveMinor': null});
  });

  test('approvals send the scope hash they were shown; members are addressed by user id', () async {
    final f = FakeApi()
      ..on('POST', '/v1/ai/approvals/a1/decisions', (_) => json({'status': 'approved'}))
      ..on('DELETE', '/v1/organizations/$org/members/u9', (_) => http.Response('', 204));
    await item('buildApprovals', 'approve').run(ctx(f, item: {'id': 'a1', 'scopeHash': 'h-123', 'status': 'pending'}));
    expect(f.body('POST', '/v1/ai/approvals/a1/decisions'), {'decision': 'approve', 'scopeHash': 'h-123'});
    await item('team', 'remove').run(ctx(f, item: {'id': 'm1', 'userId': 'u9'}));
    expect(f.all('DELETE', '/v1/organizations/$org/members/u9'), hasLength(1));
    expect(item('instances', 'start').visible!({'status': 'stopped'}), isTrue);
    expect(item('instances', 'start').visible!({'status': 'running'}), isFalse);
  });

  testWidgets('paid flow in the UI: form → price → confirm → create, then the page reloads', (tester) async {
    tester.view.physicalSize = const Size(390, 844) * 3;
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    var buckets = <Map<String, Object>>[];
    final f = FakeApi()
      ..on('GET', '/v1/storage/buckets', (_) => json({'items': buckets, 'nextCursor': null}))
      ..on('POST', '/v1/quotes', (_) => json({
            'id': 'q-77',
            'currency': 'SAR',
            'subtotalMinor': '2000',
            'taxEstimate': {'taxMinor': '300'},
            'totalMinor': '2300',
            'requiresApproval': false,
            'expiresAt': DateTime.now().toUtc().add(const Duration(minutes: 15)).toIso8601String(),
          }, status: 201))
      ..on('POST', '/v1/storage/buckets', (r) {
        buckets = [
          {'id': 'b1', 'name': 'photos', 'bucketName': 'photos-x', 'status': 'provisioning'},
        ];
        return json({'id': 'b1'}, status: 202);
      })
      ..on('POST', '/v1/auth/password/login', (_) => json({'id': 'u1'}, headers: {'set-cookie': 'nuzm_session=s; Path=/,nuzm_csrf=c; Path=/'}))
      ..on('GET', '/v1/me', (_) => json({
            'id': 'u1',
            'email': 'o@example.test',
            'locale': 'en',
            'memberships': [
              {'orgId': org, 'name': 'Coffee Co', 'slug': 'c', 'type': 'customer', 'status': 'active', 'role': 'owner'},
            ],
          }));
    final app = AppController.live(ApiClient(baseUrl: 'http://api.test', store: MemorySessionStore(), client: f.client));
    await tester.runAsync(() => app.signIn('o@example.test', 'pw'));
    await tester.pumpWidget(AppScope(
      controller: app,
      child: MaterialApp(
        locale: const Locale('en'),
        supportedLocales: const [Locale('ar'), Locale('en')],
        localizationsDelegates: GlobalMaterialLocalizations.delegates,
        theme: NuzmTheme.build(Brightness.light, useGoogleFonts: false),
        home: SectionScreen(category: categoryById('data'), initialPage: 'storage'),
      ),
    ));
    Future<void> settle() async {
      for (var i = 0; i < 4; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
        await tester.pumpAndSettle();
      }
    }

    await settle();
    expect(find.text('Nothing here yet'), findsOneWidget);
    await tester.tap(find.text('New bucket'));
    await settle();

    // Validation runs before anything is sent.
    await tester.tap(find.text('Get the price'));
    await settle();
    expect(find.text('Required'), findsNWidgets(2));
    expect(f.all('POST', '/v1/quotes'), isEmpty);

    await tester.enterText(find.widgetWithText(TextField, 'Name'), 'photos');
    await tester.enterText(find.widgetWithText(TextField, 'Expected size (GB)'), '50');
    await tester.tap(find.text('Get the price'));
    await settle();
    expect(f.body('POST', '/v1/quotes'), {
      'kind': 'storage',
      'items': [
        {'estimatedGb': 50},
      ],
    });
    expect(find.text('Total'), findsOneWidget);
    expect(find.textContaining('23.00 SAR'), findsOneWidget);
    expect(f.all('POST', '/v1/storage/buckets'), isEmpty, reason: 'nothing is created before the user confirms the price');

    await tester.ensureVisible(find.text('Confirm and create'));
    await tester.tap(find.text('Confirm and create'));
    await settle();
    expect(f.body('POST', '/v1/storage/buckets'), {'name': 'photos', 'quoteId': 'q-77', 'versioning': false});
    expect(find.textContaining('photos'), findsWidgets, reason: 'the list reloads after the write');
  });

  testWidgets('sample mode opens forms but never writes', (tester) async {
    tester.view.physicalSize = const Size(390, 844) * 3;
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(AppScope(
      controller: AppController(),
      child: MaterialApp(
        locale: const Locale('ar'),
        supportedLocales: const [Locale('ar'), Locale('en')],
        localizationsDelegates: GlobalMaterialLocalizations.delegates,
        theme: NuzmTheme.build(Brightness.dark, useGoogleFonts: false),
        home: SectionScreen(category: categoryById('projects'), initialPage: 'workspaces'),
      ),
    ));
    await tester.pump(const Duration(milliseconds: 600));
    await tester.pumpAndSettle();
    await tester.tap(find.text('مساحة عمل جديدة'));
    await tester.pumpAndSettle();
    expect(find.textContaining('سجّل الدخول لتنفيذ التغييرات'), findsOneWidget);
    await tester.enterText(find.widgetWithText(TextField, 'الاسم'), 'Marketing');
    await tester.tap(find.widgetWithText(FilledButton, 'مساحة عمل جديدة').last);
    await tester.pumpAndSettle();
    expect(find.textContaining('سجّل الدخول لتنفيذ التغييرات'), findsOneWidget);
  });
}
