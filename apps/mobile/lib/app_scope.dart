import 'package:flutter/material.dart';

import 'api/api_client.dart';
import 'api/api_data_source.dart';
import 'data/data_source.dart';

enum AppPhase { starting, signedOut, needsOrg, ready }

@immutable
class Membership {
  const Membership({required this.orgId, required this.name, required this.role, required this.type});
  final String orgId;
  final String name;
  final String role;
  final String type;
}

/// App-wide state: language (Arabic by default, D-32), appearance, and the session.
/// Live mode signs in against the API; sample mode ([DemoDataSource]) needs no account.
class AppController extends ChangeNotifier {
  /// Sample data, already "signed in" (previews, tests).
  AppController({Locale locale = const Locale('ar'), ThemeMode themeMode = ThemeMode.system, DataSource? data})
      : _locale = locale,
        _themeMode = themeMode,
        api = null,
        _data = data ?? const DemoDataSource(),
        _phase = AppPhase.ready;

  /// Live API: starts signed out until [start] finds a stored session.
  AppController.live(ApiClient this.api, {Locale locale = const Locale('ar'), ThemeMode themeMode = ThemeMode.system})
      : _locale = locale,
        _themeMode = themeMode,
        _data = const DemoDataSource(),
        _phase = AppPhase.starting;

  final ApiClient? api;
  Locale _locale;
  ThemeMode _themeMode;
  DataSource _data;
  AppPhase _phase;
  Map<String, dynamic>? _me;
  List<Membership> _orgs = const [];
  Membership? _org;

  Future<Balances>? _balances;

  /// The wallet and AI credits, fetched once and shared by the menu and the chat screen; [refresh] after a spend.
  Future<Balances> balances({bool refresh = false}) {
    if (refresh || _balances == null) {
      _balances = _data.balances();
      if (refresh) notifyListeners();
    }
    return _balances!;
  }

  /// A prompt another screen hands to Nuzm AI (the home screen picks it up and starts the chat).
  final ValueNotifier<String?> pendingPrompt = ValueNotifier<String?>(null);

  Locale get locale => _locale;
  ThemeMode get themeMode => _themeMode;
  bool get isArabic => _locale.languageCode == 'ar';
  DataSource get data => _data;
  AppPhase get phase => _phase;
  List<Membership> get organizations => _orgs;
  Membership? get organization => _org;
  String? get email => _me?['email']?.toString();
  bool get canUseLive => api != null;

  @override
  void dispose() {
    pendingPrompt.dispose();
    api?.close();
    super.dispose();
  }

  void toggleLocale() {
    _locale = isArabic ? const Locale('en') : const Locale('ar');
    api?.locale = _locale.languageCode;
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

  void _set(AppPhase p) {
    _phase = p;
    _balances = null;
    notifyListeners();
  }

  /// Resumes a stored session (or shows the sign-in screen).
  Future<void> start() async {
    final a = api;
    if (a == null) return _set(AppPhase.ready);
    a.locale = _locale.languageCode;
    if (!await a.hasSession()) return _set(AppPhase.signedOut);
    try {
      await _loadMe();
    } on ApiException catch (e) {
      // Offline at launch: keep the session, let the user retry from the sign-in screen.
      if (e.unauthenticated) await a.clearSession();
      _set(AppPhase.signedOut);
    }
  }

  /// POST /v1/auth/password/login (realm web). Throws [ApiException] (401 invalid_credentials, 429, ...).
  Future<void> signIn(String email, String password) async {
    final a = api!;
    await a.clearSession();
    await a.post('/v1/auth/password/login', {'email': email.trim(), 'password': password, 'realm': 'web'});
    await _loadMe();
  }

  Future<void> _loadMe() async {
    final a = api!;
    final me = await a.get('/v1/me');
    _me = (me as Map).cast<String, dynamic>();
    final ms = _me!['memberships'];
    _orgs = [
      for (final m in (ms is List ? ms : const []))
        if (m is Map && m['status'] != 'suspended')
          Membership(orgId: '${m['orgId']}', name: '${m['name']}', role: '${m['role']}', type: '${m['type']}'),
    ];
    final loc = _me!['locale'];
    if (loc == 'ar' || loc == 'en') {
      _locale = Locale(loc as String);
      a.locale = loc;
    }
    if (_orgs.isEmpty) {
      _org = null;
      await a.setOrg(null);
      return _set(AppPhase.needsOrg);
    }
    final keep = _orgs.where((o) => o.orgId == a.orgId);
    await _useOrg(keep.isNotEmpty ? keep.first : _orgs.first);
  }

  Future<void> _useOrg(Membership o) async {
    final a = api!;
    _org = o;
    await a.setOrg(o.orgId);
    final name = '${_me?['displayName'] ?? ''}'.trim();
    _data = ApiDataSource(a,
        orgId: o.orgId,
        orgDisplayName: o.name,
        user: name.isNotEmpty && name != 'null' ? name : '${_me?['email'] ?? ''}'.split('@').first);
    _set(AppPhase.ready);
  }

  Future<void> switchOrg(String orgId) => _useOrg(_orgs.firstWhere((o) => o.orgId == orgId));

  /// POST /v1/organizations (the caller becomes its owner), then reload the memberships.
  Future<void> createOrg(String name) async {
    await api!.post('/v1/organizations', {'name': name.trim(), 'defaultLocale': _locale.languageCode});
    await _loadMe();
  }

  /// Browse with the sample data, without an account.
  void useSampleData() {
    _data = const DemoDataSource();
    _org = null;
    _set(AppPhase.ready);
  }

  Future<void> signOut() async {
    final a = api;
    if (a != null && _data.isLive) {
      try {
        await a.post('/v1/auth/logout');
      } catch (_) {
        // Signing out locally is enough when the API cannot be reached; the session expires on its own.
      }
      await a.clearSession();
    }
    _me = null;
    _orgs = const [];
    _org = null;
    _data = const DemoDataSource();
    _set(a == null ? AppPhase.ready : AppPhase.signedOut);
  }

  /// Called by screens when the API answers 401 mid-use.
  void sessionExpired() {
    if (_data.isLive) {
      _data = const DemoDataSource();
      _set(AppPhase.signedOut);
    }
  }
}

class AppScope extends InheritedNotifier<AppController> {
  const AppScope({super.key, required AppController controller, required super.child}) : super(notifier: controller);

  static AppController of(BuildContext context) => context.dependOnInheritedWidgetOfExactType<AppScope>()!.notifier!;

  /// Without subscribing to changes (for callbacks).
  static AppController read(BuildContext context) =>
      (context.getElementForInheritedWidgetOfExactType<AppScope>()!.widget as AppScope).notifier!;
}
