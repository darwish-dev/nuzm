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
  static const appName = T('NUZM AI', 'NUZM AI');
  static const nuzmAi = T('NUZM AI', 'NUZM AI');
  static const morning = T('صباح الخير', 'Good morning');
  static const evening = T('مساء الخير', 'Good evening');
  static const iAm = T('أنا', "I'm");
  static const heroLine = T('كيف أساعدك اليوم؟', 'How can I help you today?');
  static const heroSub = T(
    'صف فكرتك وأحوّلها إلى موقع أو تطبيق أو خادم جاهز — وأتابع معك النطاق والبريد والفوترة.',
    'Describe your idea and I will turn it into a site, an app or a server — then help with the domain, email and billing.',
  );
  static const composerHint = T('اكتب رسالتك إلى NUZM AI…', 'Message NUZM AI…');
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
    'step_up_required': T('هذا الإجراء يحتاج تأكيد التحقق بخطوتين حديثًا. أكمله من لوحة التحكم على الويب ثم أعد المحاولة.',
        'This action needs a recent two-step verification. Complete it in the web console, then try again.'),
    'quote_expired': T('انتهت صلاحية السعر. اطلب سعرًا جديدًا.', 'The price expired. Get a new price.'),
    'quote_consumed': T('استُخدم هذا السعر من قبل. اطلب سعرًا جديدًا.', 'This price was already used. Get a new price.'),
    'price_changed': T('تغيّر السعر. اطلب سعرًا جديدًا.', 'The price changed. Get a new price.'),
    'spend_approval_required': T('هذا المبلغ يتجاوز حد الإنفاق ويحتاج موافقة. اطلبها من صفحة موافقات الإنفاق.',
        'This amount is over the spending limit and needs approval. Request it on the Spend approvals page.'),
    'approval_required': T('يحتاج هذا الإجراء موافقة قبل التنفيذ.', 'This action needs approval before it runs.'),
    'payment_required': T('يلزم الدفع أولًا.', 'Payment is required first.'),
    'insufficient_funds': T('الرصيد غير كافٍ.', 'Not enough balance.'),
    'etag_mismatch': T('تغيّر العنصر منذ فتحه. حدّث الصفحة ثم أعد المحاولة.', 'It changed since you opened it. Refresh and try again.'),
    'precondition_failed': T('تغيّر العنصر منذ فتحه. حدّث الصفحة ثم أعد المحاولة.', 'It changed since you opened it. Refresh and try again.'),
    'conflict': T('تعارض مع حالة حالية. حدّث الصفحة ثم أعد المحاولة.', 'It conflicts with the current state. Refresh and try again.'),
    'name_taken': T('هذا الاسم مستخدم. اختر اسمًا آخر.', 'This name is taken. Choose another.'),
    'quota_exceeded': T('تجاوز الحصة المسموحة لخطتك.', 'Over the quota of your plan.'),
    'kind_not_available': T('هذه الخدمة غير متاحة للشراء بعد.', 'This service cannot be bought yet.'),
    'no_capacity': T('لا توجد سعة متاحة حاليًا. جرّب خيارًا آخر.', 'No capacity right now. Try another option.'),
    'no_eligible_offer': T('لا يوجد عرض مؤهل لهذا الاختيار.', 'No eligible offer for this choice.'),
    'domain_unavailable': T('النطاق غير متاح للتسجيل.', 'The domain is not available to register.'),
    'eligibility_blocked': T('النطاق غير مؤهل للتسجيل وفق السياسة.', 'The domain is not eligible under the policy.'),
    'invalid_state': T('لا يمكن تنفيذ ذلك في الحالة الحالية.', 'This cannot be done in the current state.'),
    'deletion_protected': T('العنصر محمي من الحذف.', 'It is protected from deletion.'),
    'in_use': T('العنصر مستخدم حاليًا.', 'It is in use.'),
    'weak_password': T('كلمة المرور ضعيفة أو شائعة. اختر أطول وأقوى.', 'The password is weak or common. Choose a longer, stronger one.'),
    'validation_failed': T('بعض القيم غير صحيحة. راجعها ثم أعد المحاولة.', 'Some values are not valid. Check them and try again.'),
    'sender_not_verified': T('هوية المرسل غير موثّقة بعد.', 'The sender identity is not verified yet.'),
    'suppressed': T('العنوان في قائمة الحظر.', 'The address is on the suppression list.'),
    'ownership_unverified': T('لم يتم التحقق من ملكية النطاق بعد.', 'Domain ownership is not verified yet.'),
    'mfa_required': T('هذا الإجراء يحتاج التحقق بخطوتين.', 'This action needs two-step verification.'),
  };
  static const signInToChange = T('أنت تتصفح بيانات تجريبية. سجّل الدخول لتنفيذ التغييرات.',
      'You are browsing sample data. Sign in to make changes.');
  static const getPrice = T('اعرض السعر', 'Get the price');
  static const confirmPaid = T('تأكيد وإنشاء', 'Confirm and create');
  static const priceTitle = T('السعر', 'Price');
  static const subtotal = T('المجموع قبل الضريبة', 'Subtotal');
  static const taxEst = T('الضريبة (تقديرية)', 'Tax (estimate)');
  static const total = T('الإجمالي', 'Total');
  static const validFor = T('صالح لمدة', 'Valid for');
  static const minutes = T('دقيقة', 'min');
  static const needsApprovalNote = T('هذا المبلغ يتجاوز حد الإنفاق الشهري وقد يحتاج موافقة.',
      'This amount goes over the monthly spending cap and may need approval.');
  static const paidNote = T('سيُحتسب هذا المبلغ على مؤسستك عند التأكيد.', 'This amount is charged to your organization when you confirm.');
  static const requiredField = T('مطلوب', 'Required');
  static const invalidValue = T('قيمة غير صحيحة', 'Not a valid value');
  static const cancel = T('إلغاء', 'Cancel');
  static const confirmTitle = T('هل أنت متأكد؟', 'Are you sure?');
  static const continueLabel = T('متابعة', 'Continue');
  static const stepUpNote = T('يحتاج تحققًا بخطوتين حديثًا.', 'Needs a recent two-step verification.');
  static const webOnlyWrites = T('الإنشاء والتعديل لهذه الصفحة متاحان من لوحة التحكم على الويب حاليًا.',
      'Creating and editing on this page is in the web console for now.');
  static const noOptions = T('لا توجد خيارات متاحة', 'No options available');
  static const choose = T('اختر', 'Choose');
  static const loadingOptions = T('جارٍ تحميل الخيارات…', 'Loading options…');
  static const aiCredits = T('رصيد نظم AI', 'Nuzm AI credits');
  static const wallet = T('المحفظة', 'Wallet');
  static const credits = T('رصيد الذكاء', 'AI credits');
  static const project = T('المشروع', 'Project');
  static const allProjects = T('كل المشاريع', 'All projects');
  static const ideas = T('أفكار للبدء', 'Ideas to start with');
  static const settings = T('الإعدادات', 'Settings');
  static const dark = T('داكن', 'Dark');
  static const light = T('فاتح', 'Light');
  static const languageLabel = T('اللغة', 'Language');
  static const arabicName = T('العربية', 'العربية');
  static const englishName = T('English', 'English');
  static const topUp = T('التفاصيل', 'Details');
  static const lowCredit = T('رصيد منخفض', 'Low');
  // The three starters above the composer.
  static const startMobile = T('تطبيق جوال', 'Mobile app');
  static const startWebApp = T('تطبيق ويب', 'Web app');
  static const startWebsite = T('موقع ويب', 'Website');
  static const promptMobile = T('أريد إنشاء تطبيق جوال: ', 'Create a mobile app: ');
  static const promptWebApp = T('أريد إنشاء تطبيق ويب: ', 'Create a web app: ');
  static const promptWebsite = T('أريد إنشاء موقع ويب: ', 'Create a website: ');
  // Attachments and voice.
  static const attachFile = T('ملف نصي', 'Text file');
  static const attachFileHint = T('txt و md و csv و json وملفات الشيفرة، حتى 20٬000 حرف', 'txt, md, csv, json and code files, up to 20,000 characters');
  static const attachLink = T('رابط', 'Link');
  static const attachLinkHint = T('صفحة يقرؤها NUZM AI أثناء العمل', 'A page NUZM AI reads while it works');
  static const linkLabel = T('الرابط', 'Link');
  static const add = T('إضافة', 'Add');
  static const removeAttachment = T('إزالة المرفق', 'Remove attachment');
  static const badLink = T('أدخل رابطًا يبدأ بـ http:// أو https://', 'Enter a link that starts with http:// or https://');
  static const notText = T('هذا الملف ليس نصًا. يمكن إرفاق الملفات النصية والروابط فقط.', 'This file is not text. Only text files and links can be attached.');
  static const fileTooLong = T('الملف أطول من 20٬000 حرف.', 'The file is longer than 20,000 characters.');
  static const tooManyAttachments = T('يمكن إرفاق 10 عناصر كحد أقصى.', 'You can attach up to 10 items.');
  static const seeAttachments = T('اطّلع على المرفقات.', 'See the attachments.');
  static const listening = T('أستمع إليك…', 'Listening…');
  static const stopListening = T('إيقاف التسجيل', 'Stop recording');
  static const micDenied = T('اسمح للتطبيق باستخدام الميكروفون من إعدادات الهاتف.', 'Allow the microphone for this app in the phone settings.');
  static const micUnavailable = T('التعرّف على الكلام غير متاح على هذا الجهاز.', 'Speech recognition is not available on this device.');
  // Plans (the website's plan section).
  static const plansEyebrow = T('الباقات والأسعار', 'Plans & pricing');
  static const plansHeadline = T('اختر ما يناسب مشروعك.', 'Pick what fits your project.');
  static const hostingPlans = T('باقات الاستضافة', 'Hosting plans');
  static const cloudPlans = T('باقات السحابة', 'Cloud plans');
  static const perMonth = T('/شهر', '/mo');
  static const included = T('ما تتضمنه:', 'Included:');
  static const runsOn = T('يعمل مع:', 'Runs:');
  static const choosePlan = T('اختر الباقة', 'Choose plan');
  static const chooseServer = T('اختر الخادم', 'Choose server');
  static const fineHosting = T('تُحاسَب شهريًا لكل موقع. يُؤكَّد توفّر الباقة لحسابك ومنطقتك قبل الشراء.',
      'Billed monthly, per site. Availability for your account and region is confirmed before you buy.');
  static const fineServer = T('تُحاسَب شهريًا. تُفحص إقامة البيانات والحصة والتوفّر لحسابك عند الطلب.',
      'Billed monthly. Data residency, quota and availability are checked for your account when you order.');
  static const noPlans = T('لا توجد باقات منشورة الآن.', 'No plans are published right now.');
  static const planNotOffered = T('هذه الباقة غير متاحة لمؤسستك الآن؛ اختر باقة من النموذج.',
      'This plan is not offered to your organization right now; pick one in the form.');
  static const addNew = T('إضافة', 'Add');
  // Domain search (the website's domain tool, `dom.search.*`).
  static const domEyebrow = T('البحث عن نطاق', 'Domain search');
  static const domHero = T('ابحث عن اسم نطاق', 'Search for a domain name');
  static const domBody = T('ابحث عن اسم، وقارن الامتدادات، وسجّله خلال دقائق.', 'Search a name, compare extensions and register it in minutes.');
  static const domPlaceholder = T('اكتب اسمًا، مثل mybrand', 'Type a name, e.g. mybrand');
  static const domExtensions = T('الامتدادات التي نبيعها', 'Extensions we sell');
  static const domHelp = T('تُعرض الأسعار بالريال وتشمل هامش المنصة؛ الضريبة تُحتسب عند عرض السعر.',
      'Prices are in SAR and include the platform margin; tax is estimated when you get a quote.');
  static const domResults = T('نتائج البحث', 'Search results');
  static const domBest = T('أفضل نتيجة', 'Top match');
  static const domPerYear = T('سنويًا', 'per year');
  static const domAvailable = T('متاح', 'Available');
  static const domTaken = T('غير متاح', 'Taken');
  static const domUnknown = T('غير معروف الآن', 'Unknown right now');
  static const domBlocked = T('غير مدعوم', 'Not supported');
  static const domPremium = T('نطاق مميز (غير مباع بعد)', 'Premium (not sold yet)');
  static const domNoPrice = T('السعر غير متوفر بعد', 'Price not available yet');
  static const domNotForSale = T('غير معروض للبيع بعد', 'Not on sale yet');
  static const domRegister = T('سجّل النطاق', 'Register');
  static const domSearchGo = T('بحث', 'Search');
  static const domReasons = {
    'policy.saudi_absent': T('نطاقات السعودية غير متاحة حاليًا (بانتظار مسار الأهلية).', 'Saudi domains are not available yet (eligibility route pending).'),
    'policy.not_in_portfolio': T('هذا الامتداد غير ضمن الامتدادات المعروضة.', 'This extension is not in the sales portfolio.'),
    'registrar.not_listed': T('لا يوجد مسجّل معتمد يدعم هذا الامتداد.', 'No verified registrar supports this extension.'),
  };
  static const domReasonOther = T('هذا الامتداد غير مدعوم حاليًا.', 'This extension is not supported at the moment.');
}
