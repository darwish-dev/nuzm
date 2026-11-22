import 'package:flutter/widgets.dart';

/// A bilingual text. Data (navigation, sample rows) carries both languages; screens pick one with [of].
@immutable
class T {
  const T(this.ar, this.en);
  final String ar;
  final String en;

  String of(BuildContext context) => Localizations.localeOf(context).languageCode == 'ar' ? ar : en;
}

bool isAr(BuildContext context) => Localizations.localeOf(context).languageCode == 'ar';

/// Interface strings.
class S {
  static const appName = T('نظم', 'Nuzm');
  static const nuzmAi = T('نظم AI', 'Nuzm AI');
  static const morning = T('صباح الخير', 'Good morning');
  static const evening = T('مساء الخير', 'Good evening');
  static const iAm = T('أنا', "I'm");
  static const heroLine = T('ماذا نبني اليوم؟', 'What shall we build today?');
  static const heroSub = T(
    'صف فكرتك وأحوّلها إلى موقع أو تطبيق أو خادم جاهز — وأتابع معك النطاق والبريد والفوترة.',
    'Describe your idea and I will turn it into a site, an app or a server — then help with the domain, email and billing.',
  );
  static const composerHint = T('صف ما تريد أن تبنيه…', 'Describe what you want to build…');
  static const menu = T('القائمة', 'Menu');
  static const newChat = T('محادثة جديدة', 'New chat');
  static const refresh = T('تحديث', 'Refresh');
  static const attach = T('إرفاق', 'Attach');
  static const voice = T('إدخال صوتي', 'Voice input');
  static const send = T('إرسال', 'Send');
  static const styles = T('الأسلوب والهوية', 'Style and identity');
  static const close = T('إغلاق', 'Close');
  static const back = T('رجوع', 'Back');
  static const notifications = T('الإشعارات', 'Notifications');
  static const search = T('ابحث في الخدمات والمشاريع والصفحات…', 'Search services, projects and pages…');
  static const recentChats = T('المحادثات الأخيرة', 'Recent chats');
  static const allServices = T('كل الخدمات', 'All services');
  static const noResults = T('لا توجد نتائج مطابقة', 'No matching results');
  static const noResultsHint = T('جرّب كلمة أخرى.', 'Try another word.');
  static const darkMode = T('الوضع الداكن', 'Dark mode');
  static const lightMode = T('الوضع الفاتح', 'Light mode');
  static const language = T('English', 'العربية');
  static const sampleData = T('بيانات تجريبية', 'Sample data');
  static const sampleNote = T(
    'هذه المعاينة تعرض بيانات تجريبية؛ الربط بالواجهة البرمجية لم يُفعَّل بعد.',
    'This preview shows sample data; the API connection is not switched on yet.',
  );
  static const loading = T('جارٍ التحميل…', 'Loading…');
  static const emptyTitle = T('لا يوجد شيء هنا بعد', 'Nothing here yet');
  static const emptyHint = T('عندما تضيف عناصر ستظهر هنا.', 'Items you add will show up here.');
  static const errorTitle = T('تعذّر التحميل', 'Could not load');
  static const errorHint = T('تحقق من الاتصال ثم أعد المحاولة.', 'Check your connection and try again.');
  static const retry = T('إعادة المحاولة', 'Try again');
  static const comingSoon = T('هذا الإجراء متاح من لوحة التحكم على الويب حاليًا.',
      'This action is available in the web console for now.');
  static const create = T('إنشاء', 'Create');
  static const save = T('حفظ', 'Save');
  static const details = T('التفاصيل', 'Details');
  static const actions = T('الإجراءات', 'Actions');
  static const askAi = T('اسأل نظم AI', 'Ask Nuzm AI');
  static const thinking = T('نظم AI يكتب…', 'Nuzm AI is typing…');
  static const aiPreviewReply = T(
    'استلمت طلبك. في هذه المعاينة لا أنفّذ شيئًا فعليًا بعد — عند ربط التطبيق بالمنصة سأجهّز لك خطة البناء والتكلفة وأطلب موافقتك قبل أي إجراء مدفوع.',
    'Got it. In this preview I do not run anything yet — once the app is connected to the platform I will prepare the build plan and cost and ask for your approval before any paid action.',
  );
  static const searchDomain = T('ابحث عن اسم نطاق…', 'Search for a domain name…');
  static const check = T('تحقّق', 'Check');
  static const available = T('متاح', 'Available');
  static const taken = T('محجوز', 'Taken');
  static const viewAll = T('عرض الكل', 'View all');
  static const needsAttention = T('يحتاج انتباهك', 'Needs your attention');
  static const services = T('الخدمات', 'Services');
  static const markAllRead = T('تعليم الكل كمقروء', 'Mark all as read');
  static const startBuilding = T('ابدأ البناء', 'Start building');
  static const builderPrompt = T('صف المشروع الذي تريد بناءه', 'Describe the project you want to build');
  static const builderHint = T('مثال: متجر لبيع القهوة المختصة مع دفع إلكتروني…',
      'Example: a specialty-coffee shop with online payments…');
  static const used = T('مستخدم', 'used');
  static const of_ = T('من', 'of');
  static const signOut = T('تسجيل الخروج', 'Sign out');
  static const appearance = T('المظهر', 'Appearance');
  static const system = T('حسب النظام', 'System');

  static const signIn = T('تسجيل الدخول', 'Sign in');
  static const signInTitle = T('مرحبًا بك في نظم', 'Welcome to Nuzm');
  static const signInSub = T('سجّل الدخول بحسابك في نظم لإدارة خدماتك والبناء مع نظم AI.',
      'Sign in with your Nuzm account to manage your services and build with Nuzm AI.');
  static const email = T('البريد الإلكتروني', 'Email');
  static const password = T('كلمة المرور', 'Password');
  static const showPassword = T('إظهار كلمة المرور', 'Show password');
  static const hidePassword = T('إخفاء كلمة المرور', 'Hide password');
  static const exploreSample = T('تصفّح ببيانات تجريبية', 'Explore with sample data');
  static const noAccount = T('ليس لديك حساب؟ أنشئه من موقع نظم ثم عد هنا.', "No account? Create one on the Nuzm website, then come back.");
  static const invalidCredentials = T('البريد أو كلمة المرور غير صحيحة.', 'The email or password is not correct.');
  static const tooMany = T('محاولات كثيرة. انتظر قليلًا ثم أعد المحاولة.', 'Too many attempts. Wait a little and try again.');
  static const offline = T('تعذّر الوصول إلى الخادم. تحقق من الاتصال.', 'Could not reach the server. Check your connection.');
  static const genericError = T('حدث خطأ غير متوقع.', 'Something went wrong.');
  static const webSampleOnly = T('نسخة الويب تعمل ببيانات تجريبية؛ استخدم تطبيق الجوال للربط بحسابك.',
      'The web build runs on sample data; use the mobile app to connect your account.');
  static const createOrgTitle = T('أنشئ مؤسستك', 'Create your organization');
  static const createOrgSub = T('كل الخدمات والفواتير تتبع مؤسسة. أنشئ واحدة للبدء.',
      'Every service and invoice belongs to an organization. Create one to start.');
  static const orgName = T('اسم المؤسسة', 'Organization name');
  static const forbiddenTitle = T('لا تملك صلاحية هذه الصفحة', "You don't have access to this page");
  static const forbiddenHint = T('اطلب من مالك المؤسسة منحك الصلاحية.', 'Ask an owner of the organization for access.');
  static const notEnabledTitle = T('غير مفعّلة لمؤسستك', 'Not switched on for your organization');
  static const notEnabledHint = T('هذه الخدمة غير متاحة لمؤسستك حاليًا.', 'This service is not available to your organization yet.');
  static const organization = T('المؤسسة', 'Organization');
  static const switchOrg = T('تبديل المؤسسة', 'Switch organization');
  static const signedInAs = T('مسجّل باسم', 'Signed in as');
  static const runStillGoing = T('ما زال نظم AI يعمل على طلبك؛ ستجد الرد في المحادثة عند اكتماله.',
      'Nuzm AI is still working on it; the answer will appear in this chat when it is done.');
  static const errorPrefix = T('تعذّر الإرسال', 'Could not send');
  static const noChats = T('لا توجد محادثات بعد.', 'No chats yet.');
  static const noNotifications = T('لا توجد إشعارات.', 'No notifications.');
  static const allClear = T('لا شيء يحتاج انتباهك الآن.', 'Nothing needs your attention right now.');
  /// Problem codes (spec/openapi/errors.yaml) the app explains in the reader's language.
  static const problems = <String, T>{
    'residency_denied': T('سياسة إقامة البيانات لمؤسستك لا تسمح بهذه الخدمة في المنطقة المتاحة حاليًا.',
        "Your organization's data residency policy does not allow this service in the region available now."),
    'insufficient_credits': T('رصيد نظم AI غير كافٍ. أضف رصيدًا ثم أعد المحاولة.', 'Not enough Nuzm AI credits. Add credits and try again.'),
    'ai_unavailable': T('نظم AI متوقف مؤقتًا. حاول لاحقًا.', 'Nuzm AI is paused for now. Try again later.'),
    'unsupported_capability': T('لا يوجد مزوّد ذكاء اصطناعي مفعّل لمؤسستك بعد.', 'No AI provider is switched on for your organization yet.'),
    'run_active': T('هناك طلب قيد التنفيذ في هذه المحادثة. انتظر حتى يكتمل.', 'A request is already running in this chat. Wait for it to finish.'),
    'content_blocked': T('لا يمكن إرسال هذا المحتوى.', 'This content cannot be sent.'),
    'secret_detected': T('يبدو أن رسالتك تحتوي على سر (مفتاح أو كلمة مرور). احذفه ثم أعد الإرسال.',
        'Your message seems to contain a secret (a key or password). Remove it and send again.'),
    'email_not_verified': T('أكّد بريدك الإلكتروني أولًا.', 'Verify your email address first.'),
    'service_unavailable': T('الخدمة غير متاحة مؤقتًا من المزوّد. حاول بعد قليل.', 'The service is temporarily unavailable from the provider. Try again shortly.'),
    'mfa_required': T('هذا الإجراء يحتاج التحقق بخطوتين.', 'This action needs two-step verification.'),
  };
  static const ideas = T('أفكار للبدء', 'Ideas to start with');
}
