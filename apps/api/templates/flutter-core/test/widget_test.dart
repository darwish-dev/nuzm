import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:APP_PACKAGE/app.dart';
import 'package:APP_PACKAGE/core/auth.dart';
import 'package:APP_PACKAGE/core/models.dart';
import 'package:APP_PACKAGE/core/settings.dart';
import 'package:APP_PACKAGE/generated/app_spec.dart';
import 'package:APP_PACKAGE/ui/screens/form_screen.dart';

class _FakeAuth implements AuthRepository {
  @override
  Future<String> login(String email, String password) async {
    if (password == 'wrong') {
      throw const AuthException('invalid_credentials');
    }
    return 'test-token';
  }
}

Widget _app() {
  final store = SettingsStore.memory();
  return ProviderScope(
    overrides: [
      settingsStoreProvider.overrideWithValue(store),
      tokenStoreProvider.overrideWithValue(MemoryTokenStore()),
      authRepositoryProvider.overrideWithValue(_FakeAuth()),
    ],
    child: const App(),
  );
}

Future<void> _signIn(WidgetTester tester) async {
  if (!kAuthEnabled) {
    return;
  }
  await tester.enterText(find.byKey(const ValueKey('login_email')), 'a@example.com');
  await tester.enterText(find.byKey(const ValueKey('login_password')), 'secret');
  await tester.tap(find.byKey(const ValueKey('login_submit')));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('boots in the default locale and direction', (tester) async {
    await tester.pumpWidget(_app());
    await tester.pumpAndSettle();
    await _signIn(tester);
    final ctx = tester.element(find.byType(Scaffold).first);
    expect(Localizations.localeOf(ctx).languageCode, kDefaultLocale);
    expect(
      Directionality.of(ctx),
      kDefaultLocale == 'ar' ? TextDirection.rtl : TextDirection.ltr,
    );
  });

  if (kAuthEnabled) {
    testWidgets('login shows an error for wrong credentials and stays signed out',
        (tester) async {
      await tester.pumpWidget(_app());
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const ValueKey('login_email')), 'a@example.com');
      await tester.enterText(find.byKey(const ValueKey('login_password')), 'wrong');
      await tester.tap(find.byKey(const ValueKey('login_submit')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('login_submit')), findsOneWidget);
      expect(find.byType(NavigationBar), findsNothing);
    });
  }

  testWidgets('every tab is reachable', (tester) async {
    await tester.pumpWidget(_app());
    await tester.pumpAndSettle();
    await _signIn(tester);
    final tabs = [for (final s in kScreens) if (kTabs.contains(s.id)) s];
    if (tabs.length < 2) {
      return;
    }
    for (final s in tabs) {
      final ctx = tester.element(find.byType(NavigationBar));
      await tester.tap(find.text(s.title.of(ctx)).last);
      await tester.pumpAndSettle();
      expect(find.byType(NavigationBar), findsOneWidget);
    }
  });

  testWidgets('required fields are validated', (tester) async {
    const field = FieldDef(id: 'name', label: L('الاسم', 'Name'), type: FieldType.text, required: true);
    late BuildContext captured;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(builder: (context) {
          captured = context;
          return const SizedBox();
        }),
      ),
    );
    expect(validateField(captured, field, ''), isNotNull);
    expect(validateField(captured, field, 'x'), isNull);
    const email = FieldDef(id: 'e', label: L('بريد', 'Email'), type: FieldType.email);
    expect(validateField(captured, email, 'not-an-email'), isNotNull);
    expect(validateField(captured, email, 'a@b.co'), isNull);
    expect(validateField(captured, email, ''), isNull);
  });
}
