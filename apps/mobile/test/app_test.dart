import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nuzm_app/app_scope.dart';
import 'package:nuzm_app/data/nav.dart';
import 'package:nuzm_app/main.dart';
import 'package:nuzm_app/screens/menu_screen.dart';
import 'package:nuzm_app/screens/page_views.dart';
import 'package:nuzm_app/screens/section_screen.dart';
import 'package:nuzm_app/theme/nuzm_colors.dart';
import 'package:nuzm_app/theme/nuzm_theme.dart';

const phone = Size(390, 844);

Future<void> setPhone(WidgetTester tester) async {
  tester.view.physicalSize = phone * 3;
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
}

Widget host(Widget child, {Locale locale = const Locale('ar'), Brightness b = Brightness.light}) {
  final c = AppController(locale: locale);
  return AppScope(
    controller: c,
    child: MaterialApp(
      locale: locale,
      supportedLocales: const [Locale('ar'), Locale('en')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      theme: NuzmTheme.build(b, useGoogleFonts: false),
      home: child,
    ),
  );
}

void main() {
  test('identity tokens match the console palette', () {
    expect(NuzmColors.dark.bg, const Color(0xFF0B0B0C));
    expect(NuzmColors.dark.accent, const Color(0xFFBCDCCB));
    expect(NuzmColors.light.accent, const Color(0xFF2C6A5F));
    expect(NuzmColors.light.orange, const Color(0xFFE9A16D));
  });

  test('navigation mirrors the console: 13 categories, unique page ids', () {
    expect(kCategories.length, 13);
    final ids = [for (final c in kCategories) ...c.pages.map((p) => p.id)];
    expect(ids.toSet().length, ids.length);
    expect(ids.length, 44);
  });

  for (final b in Brightness.values) {
    testWidgets('home is Nuzm AI (Arabic, RTL, ${b.name})', (tester) async {
      await setPhone(tester);
      final c = AppController(themeMode: b == Brightness.dark ? ThemeMode.dark : ThemeMode.light);
      await tester.pumpWidget(NuzmApp(controller: c, useGoogleFonts: false));
      await tester.pumpAndSettle();
      expect(find.textContaining('نظم AI'), findsWidgets);
      expect(Directionality.of(tester.element(find.byType(Scaffold).first)), TextDirection.rtl);

      await tester.enterText(find.byType(TextField), 'ابنِ لي متجرًا');
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('إرسال'));
      await tester.pump();
      expect(find.text('ابنِ لي متجرًا'), findsOneWidget); // the bubble (the field is cleared)
      await tester.pump(const Duration(seconds: 1));
      await tester.pumpAndSettle();
      expect(find.textContaining('في هذه المعاينة'), findsOneWidget);
    });
  }

  testWidgets('menu lists every section, searches, and switches language and theme', (tester) async {
    await setPhone(tester);
    final c = AppController(themeMode: ThemeMode.light);
    await tester.pumpWidget(NuzmApp(controller: c, useGoogleFonts: false));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('القائمة'));
    await tester.pumpAndSettle();
    final menuScroll = find.descendant(of: find.byType(CustomScrollView), matching: find.byType(Scrollable)).first;
    await tester.scrollUntilVisible(find.text('المحادثات الأخيرة'), 300, scrollable: menuScroll);
    expect(find.text('المحادثات الأخيرة'), findsOneWidget);
    await tester.drag(menuScroll, const Offset(0, 3000));
    await tester.pumpAndSettle();

    final search = find.descendant(of: find.byType(MenuScreen), matching: find.byType(TextField));
    await tester.enterText(search, 'فوات');
    await tester.pumpAndSettle();
    expect(find.text('الفواتير'), findsOneWidget);
    await tester.enterText(search, '');
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('English'));
    await tester.pumpAndSettle();
    expect(c.locale.languageCode, 'en');
    await tester.tap(find.byTooltip('Dark mode'));
    await tester.pumpAndSettle();
    expect(c.themeMode, ThemeMode.dark);
  });

  // Every page of every section, in both languages and both themes, renders with no layout error.
  for (final locale in const [Locale('ar'), Locale('en')]) {
    for (final b in Brightness.values) {
      testWidgets('all pages render (${locale.languageCode}, ${b.name})', (tester) async {
        await setPhone(tester);
        for (final cat in kCategories) {
          for (final p in cat.pages) {
            await tester.pumpWidget(host(SectionScreen(key: ValueKey(p.id), category: cat, initialPage: p.id), locale: locale, b: b));
            await tester.pump(const Duration(milliseconds: 600));
            await tester.pumpAndSettle();
            expect(find.byType(PageBody), findsOneWidget, reason: p.id);
            expect(tester.takeException(), isNull, reason: p.id);
          }
        }
      });
    }
  }

  testWidgets('list item opens its detail screen', (tester) async {
    await setPhone(tester);
    final cat = categoryById('cloud');
    await tester.pumpWidget(host(SectionScreen(category: cat, initialPage: 'instances')));
    await tester.pump(const Duration(milliseconds: 600));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('web-01'));
    await tester.pumpAndSettle();
    expect(find.text('التفاصيل'), findsOneWidget);
    expect(find.textContaining('/compute/instances'), findsOneWidget);
  });

  testWidgets('empty and error states', (tester) async {
    await setPhone(tester);
    await tester.pumpWidget(host(SectionScreen(category: categoryById('email'), initialPage: 'suppressions')));
    await tester.pump(const Duration(milliseconds: 600));
    await tester.pumpAndSettle();
    expect(find.text('لا يوجد شيء هنا بعد'), findsOneWidget);

    await tester.pumpWidget(host(Scaffold(body: PageBody(page: findPage('invoices').$2, forceError: true))));
    await tester.pump(const Duration(milliseconds: 600));
    await tester.pumpAndSettle();
    expect(find.text('تعذّر التحميل'), findsOneWidget);
    expect(find.text('إعادة المحاولة'), findsOneWidget);
  });
}
