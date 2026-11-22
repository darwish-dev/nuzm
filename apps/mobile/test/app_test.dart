import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nuzm_app/app_scope.dart';
import 'package:nuzm_app/data/nav.dart';
import 'package:nuzm_app/main.dart';
import 'package:nuzm_app/screens/menu_screen.dart';
import 'package:nuzm_app/screens/page_views.dart';
import 'package:nuzm_app/screens/plans_screen.dart';
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
      expect(find.text('NUZM AI'), findsNothing, reason: 'no title in the chat top bar');
      expect(find.text('اكتب رسالتك إلى NUZM AI…'), findsOneWidget);
      expect(find.text('كيف أساعدك اليوم؟'), findsOneWidget, reason: 'one simple greeting, Claude-style');
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

  test('dark is the default appearance', () {
    expect(AppController().themeMode, ThemeMode.dark);
  });

  testWidgets('menu: wallet and credits, organization picker, every section, no search or shortcut circles', (tester) async {
    await setPhone(tester);
    final c = AppController(themeMode: ThemeMode.light);
    await tester.pumpWidget(NuzmApp(controller: c, useGoogleFonts: false));
    await tester.pumpAndSettle();
    expect(find.textContaining('7,420'), findsOneWidget, reason: 'the chat bar shows the AI credits');

    await tester.tap(find.byTooltip('القائمة'));
    await tester.pumpAndSettle();
    final menu = find.byType(MenuScreen);
    expect(find.descendant(of: menu, matching: find.byType(TextField)), findsNothing, reason: 'no search bar');
    expect(find.text('المحفظة'), findsOneWidget);
    expect(find.textContaining('1,250.00'), findsOneWidget);
    expect(find.descendant(of: menu, matching: find.textContaining('7,420')), findsOneWidget);
    expect(find.text('المؤسسة'), findsWidgets, reason: 'organization picker');
    for (final cat in kCategories.where((c) => c.id != 'account')) {
      expect(find.descendant(of: menu, matching: find.text(cat.label.ar)), findsWidgets, reason: cat.id);
    }
    final scroll = find.descendant(of: menu, matching: find.byType(Scrollable)).first;
    await tester.scrollUntilVisible(find.text('المحادثات الأخيرة'), 300, scrollable: scroll);
    expect(find.text('المحادثات الأخيرة'), findsOneWidget);

    // Appearance and language live in the settings footer, next to sign-out.
    await tester.scrollUntilVisible(find.text('تسجيل الخروج'), 300, scrollable: scroll);
    await tester.pumpAndSettle();
    expect(find.text('الإعدادات'), findsOneWidget);
    expect(find.descendant(of: menu, matching: find.text('الملف الشخصي')), findsOneWidget, reason: 'profile is a settings row, not a tile');
    expect(find.text('تسجيل الخروج'), findsOneWidget);
    await tester.tap(find.descendant(of: menu, matching: find.text('English')));
    await tester.pumpAndSettle();
    expect(c.locale.languageCode, 'en');
    await tester.tap(find.descendant(of: menu, matching: find.text('Dark')));
    await tester.pumpAndSettle();
    expect(c.themeMode, ThemeMode.dark);

    // Close shrinks the menu back into the button.
    await tester.tap(find.byTooltip('Close'));
    await tester.pump(const Duration(milliseconds: 120));
    expect(find.byType(MenuScreen), findsOneWidget, reason: 'still closing');
    await tester.pumpAndSettle();
    expect(find.byType(MenuScreen), findsNothing);
  });

  testWidgets('chat: no refresh button, three start cards fill the message, a link attaches and is sent', (tester) async {
    await setPhone(tester);
    final c = AppController(themeMode: ThemeMode.dark);
    await tester.pumpWidget(NuzmApp(controller: c, useGoogleFonts: false));
    await tester.pumpAndSettle();
    expect(find.byTooltip('تحديث'), findsNothing);
    for (final label in ['تطبيق جوال', 'تطبيق ويب', 'موقع ويب']) {
      expect(find.text(label), findsOneWidget);
    }
    await tester.tap(find.text('تطبيق ويب'));
    await tester.pumpAndSettle();
    expect(find.text('أريد إنشاء تطبيق ويب: '), findsOneWidget);
    expect(find.byTooltip('إرسال'), findsOneWidget, reason: 'mic turns into send');

    await tester.tap(find.byTooltip('إرفاق'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('رابط'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).last, 'not a link');
    await tester.tap(find.text('إضافة'));
    await tester.pumpAndSettle();
    expect(find.textContaining('http://'), findsOneWidget, reason: 'the API rule is checked first');
    await tester.enterText(find.byType(TextField).last, 'https://example.com/brief');
    await tester.tap(find.text('إضافة'));
    await tester.pumpAndSettle();
    expect(find.text('https://example.com/brief'), findsOneWidget);

    await tester.tap(find.byTooltip('إرسال'));
    await tester.pump();
    expect(find.text('تطبيق جوال'), findsNothing, reason: 'the cards leave once the chat starts');
    expect(find.text('https://example.com/brief'), findsOneWidget, reason: 'the sent message shows its attachment');
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
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

  testWidgets('hosting: my sites with a floating + that opens the plans; the plans slide like the website', (tester) async {
    await setPhone(tester);
    await tester.pumpWidget(host(SectionScreen(category: categoryById('hosting'), initialPage: 'sites'), b: Brightness.dark));
    await tester.pump(const Duration(milliseconds: 600));
    await tester.pumpAndSettle();
    expect(find.text('موقع استضافة جديد'), findsNothing, reason: 'create moved to the floating button');
    await tester.tap(find.byTooltip('باقات الاستضافة'));
    await tester.pump(const Duration(milliseconds: 600));
    await tester.pumpAndSettle();
    expect(find.text('اختر ما يناسب مشروعك.'), findsOneWidget);
    for (final tab in ['استضافة المواقع', 'تطبيقات الويب']) {
      expect(find.text(tab), findsOneWidget);
    }
    // Website hosting has three plans: the cheapest is shown first, sliding reveals the next.
    expect(find.text('البداية'), findsOneWidget);
    expect(find.textContaining('29'), findsWidgets);
    await tester.drag(find.byType(PageView), const Offset(300, 0)); // RTL: the next card comes from the left
    await tester.pumpAndSettle();
    expect(find.text('الأعمال'), findsOneWidget);
    expect(find.text('ما تتضمنه:'), findsWidgets);
    expect(find.text('يعمل مع:'), findsWidgets);
    await tester.tap(find.text('تطبيقات الويب'));
    await tester.pumpAndSettle();
    expect(find.text('تطبيقات الويب - البداية'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('cloud plans include the virtual servers', (tester) async {
    await setPhone(tester);
    await tester.pumpWidget(host(const PlansScreen(service: 'cloud')));
    await tester.pump(const Duration(milliseconds: 600));
    await tester.pumpAndSettle();
    expect(find.text('الاستضافة السحابية'), findsOneWidget);
    await tester.tap(find.text('الخوادم الافتراضية'));
    await tester.pumpAndSettle();
    expect(find.text('2 vCPU'), findsWidgets, reason: 'three plans: it opens on the highlighted middle one');
    expect(find.text('اختر الخادم'), findsWidgets);
  });

  testWidgets('domains: the + opens the search; the search shows a top match with its yearly price', (tester) async {
    await setPhone(tester);
    await tester.pumpWidget(host(SectionScreen(category: categoryById('domains'), initialPage: 'domainList')));
    await tester.pump(const Duration(milliseconds: 600));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('البحث عن نطاق'));
    await tester.pump(const Duration(milliseconds: 600));
    await tester.pumpAndSettle();
    expect(find.text('ابحث عن اسم نطاق'), findsOneWidget);
    for (final t in ['.com', '.net', '.org']) {
      expect(find.text(t), findsOneWidget);
    }
    await tester.enterText(find.byType(TextField), 'nuzmcafe');
    await tester.tap(find.text('بحث').last);
    await tester.pump(const Duration(milliseconds: 600));
    await tester.pumpAndSettle();
    expect(find.text('أفضل نتيجة'), findsOneWidget);
    expect(find.text('سجّل النطاق'), findsOneWidget);
    expect(find.textContaining('نطاقات السعودية غير متاحة'), findsOneWidget, reason: 'blocked extensions say why');
    expect(tester.takeException(), isNull);
  });

  testWidgets('email pages create from the floating +', (tester) async {
    await setPhone(tester);
    await tester.pumpWidget(host(SectionScreen(category: categoryById('email'), initialPage: 'mailboxes')));
    await tester.pump(const Duration(milliseconds: 600));
    await tester.pumpAndSettle();
    expect(find.byType(FloatingAdd), findsOneWidget);
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
