import 'package:flutter/material.dart';

/// App-wide preferences: language (Arabic by default, D-32) and appearance (follows the system until the user picks).
class AppController extends ChangeNotifier {
  AppController({Locale locale = const Locale('ar'), ThemeMode themeMode = ThemeMode.system})
      : _locale = locale,
        _themeMode = themeMode;

  Locale _locale;
  ThemeMode _themeMode;

  /// A prompt another screen hands to Nuzm AI (the home screen picks it up and starts the chat).
  final ValueNotifier<String?> pendingPrompt = ValueNotifier<String?>(null);

  @override
  void dispose() {
    pendingPrompt.dispose();
    super.dispose();
  }

  Locale get locale => _locale;
  ThemeMode get themeMode => _themeMode;
  bool get isArabic => _locale.languageCode == 'ar';

  void toggleLocale() {
    _locale = isArabic ? const Locale('en') : const Locale('ar');
    notifyListeners();
  }

  /// Flips between light and dark, starting from what is on screen now.
  void toggleTheme(Brightness current) {
    _themeMode = current == Brightness.dark ? ThemeMode.light : ThemeMode.dark;
    notifyListeners();
  }

  void setThemeMode(ThemeMode mode) {
    _themeMode = mode;
    notifyListeners();
  }
}

class AppScope extends InheritedNotifier<AppController> {
  const AppScope({super.key, required AppController controller, required super.child})
      : super(notifier: controller);

  static AppController of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<AppScope>()!.notifier!;
}
