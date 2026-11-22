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
  static const ideas = T('أفكار للبدء', 'Ideas to start with');
}
