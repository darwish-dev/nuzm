import type { Locale } from '@nuzm/i18n';

/** Every sentence of the landing page, in both languages. The two objects have the same shape (the compiler checks it) and a test checks the Arabic is Arabic. */
export interface LandingText {
  skip: string;
  announceTag: string;
  announce: string;
  heroTitle1: string;
  heroTitle2: string;
  heroSub1: string;
  heroSub2: string;
  promptLabel: string;
  promptPlaceholder: string;
  promptHelper: string;
  promptSend: string;
  promptsLabel: string;
  prompts: [string, string, string];
  resultEyebrow: string;
  openBuilder: string;
  openWorkflows: string;
  workflows: { title: string; text: string; steps: [string, string, string] }[];
  choices: [string, string, string];
  platformTitle1: string;
  platformTitle2: string;
  platformText: string;
  platformLabel: string;
  bridgeEyebrow: string;
  bridgeTitle1: string;
  bridgeTitle2: string;
  bridgeText: string;
  bridgeLabel: string;
  claudeSub: string;
  hubSub: string;
  destinations: [string, string, string, string, string, string];
  explore: string;
  footEyebrow: string;
  footTitle1: string;
  footTitle2: string;
  footBrand1: string;
  footBrand2: string;
  footExploreTitle: string;
  footExplore: [string, string, string, string];
  footBuildTitle: string;
  footBuild: [string, string, string, string, string];
  footWorkspaceTitle: string;
  footDesigns: string;
  footLogin: string;
  footStart: string;
  themeLight: string;
  themeDark: string;
  rights: string;
  built: string;
  top: string;
  dialogLabel: string;
  dialogClose: string;
  dialogEyebrow: string;
  dialogTitle1: string;
  dialogTitle2: string;
  dialogText: string;
  chatEyebrow: string;
  chatTitle1: string;
  chatTitle2: string;
  chatText: string;
  chatTry: string;
  chatDashboard: string;
  chatVideoLabel: string;
  chatCaption: string;
  showEyebrow: string;
  showTitle1: string;
  showTitle2: string;
  showText: string;
  showOptions: [string, string, string];
  showCreate: [string, string, string];
  showBadge: string;
  showStage: string;
  showPicker: string;
  techLabel: string;
}

const en: LandingText = {
  skip: 'Skip to content',
  announceTag: 'MEET NUZM AI',
  announce: 'A little intelligence. Endless possibility.',
  heroTitle1: 'Your ambition,',
  heroTitle2: 'powered by AI.',
  heroSub1: 'AI agents, cloud, and business tools.',
  heroSub2: 'Everything connected. Everything moving you forward.',
  promptLabel: 'What would you like to create or automate?',
  promptPlaceholder: 'What would you like to make possible?',
  promptHelper: 'Your next chapter starts here',
  promptSend: 'Explore a workflow for your idea',
  promptsLabel: 'Try an idea',
  prompts: ['Automate my operations', 'Build my next website', 'Connect my business tools'],
  resultEyebrow: 'SUGGESTED STARTING POINT',
  openBuilder: 'Open builder',
  openWorkflows: 'Open workflows',
  workflows: [
    {
      title: 'Operations, without the busywork.',
      text: 'Connect requests, approvals, and notifications in a workflow you control.',
      steps: ['Receive a request', 'Review the next action', 'Notify your team'],
    },
    {
      title: 'Your idea. A working starting point.',
      text: 'Describe what you want to build, then bring it into the Nuzm builder to develop and refine.',
      steps: ['Describe your idea', 'Build your first version', 'Review and publish'],
    },
    {
      title: 'Make your tools work together.',
      text: 'Design a connected workflow with AI assistance and keep your team in control.',
      steps: ['Choose your tools', 'Define your workflow', 'Review each action'],
    },
  ],
  choices: ['Operations', 'Build with AI', 'Integrations'],
  platformTitle1: 'One platform.',
  platformTitle2: 'Everything you need.',
  platformText:
    'Hosting, domains, servers, AI and the tools around them, designed to work together.',
  platformLabel: 'The Nuzm platform',
  bridgeEyebrow: 'INTELLIGENCE MEETS EVERYDAY WORK',
  bridgeTitle1: 'Your AI.',
  bridgeTitle2: 'Your business. Connected.',
  bridgeText: 'AI assistance, connected to the tools your business runs on.',
  bridgeLabel:
    'Claude connects through Nuzm to domains, hosting, email, ERP, CRM, and business apps',
  claudeSub: 'Intelligence for your everyday work',
  hubSub: 'One connected platform',
  destinations: ['Domains', 'Web hosting', 'Business email', 'ERP', 'CRM', 'Business apps'],
  explore: 'Explore the platform',
  footEyebrow: 'YOUR NEXT CHAPTER',
  footTitle1: 'Make room for',
  footTitle2: 'what’s possible.',
  footBrand1: 'Intelligence. Infrastructure.',
  footBrand2: 'A little more possibility.',
  footExploreTitle: 'Explore',
  footExplore: ['AI agents', 'Automation', 'Vibe coding', 'Integrations'],
  footBuildTitle: 'Build on Nuzm',
  footBuild: ['Cloud servers', 'Domains', 'Website cloud', 'AI builder', 'All services'],
  footWorkspaceTitle: 'Your workspace',
  footDesigns: 'Design library',
  footLogin: 'Log in',
  footStart: 'Get started',
  themeLight: 'Light appearance',
  themeDark: 'Dark appearance',
  rights: 'All rights reserved.',
  built: 'Built around your possibilities.',
  top: 'Back to top',
  dialogLabel: 'AI workflow preview',
  dialogClose: 'Close workflow preview',
  dialogEyebrow: 'EXPLORE THE EXPERIENCE',
  dialogTitle1: 'A workflow with',
  dialogTitle2: 'you at the center.',
  dialogText:
    'Choose a starting point to see how your work could connect. This is an illustrative preview.',
  chatEyebrow: 'CHAT WITH NUZM AI',
  chatTitle1: 'Just say what you need.',
  chatTitle2: 'Nuzm AI builds it with you.',
  chatText:
    'From a first idea to a live website, one conversation. Nuzm AI plans it, builds a first version and applies your changes as you ask.',
  chatTry: 'Try Nuzm AI',
  chatDashboard: 'Open dashboard',
  chatVideoLabel:
    'An animation of chatting with Nuzm AI: describe a website, approve the plan, edit by chat, publish',
  chatCaption: 'An illustrative animation of the Nuzm AI builder flow.',
  showEyebrow: 'IMAGINE IT. BUILD IT.',
  showTitle1: 'One idea.',
  showTitle2: 'Any possibility.',
  showText: 'Apps, websites, and web apps. Created with AI.',
  showOptions: ['Mobile app', 'Website', 'Dashboard'],
  showCreate: ['Create a mobile app', 'Create a website', 'Create a web app'],
  showBadge: 'Powered by Nuzm AI',
  showStage: 'Choose what to create',
  showPicker: 'Build type',
  techLabel: 'Technologies you can build and run on Nuzm',
};

const ar: LandingText = {
  skip: 'تخطَّ إلى المحتوى',
  announceTag: 'تعرّف على نظم AI',
  announce: 'قليل من الذكاء. وإمكانات لا تنتهي.',
  heroTitle1: 'طموحك،',
  heroTitle2: 'بقوة الذكاء الاصطناعي.',
  heroSub1: 'وكلاء ذكاء اصطناعي، وسحابة، وأدوات أعمال.',
  heroSub2: 'كل شيء متصل، وكل شيء يدفعك إلى الأمام.',
  promptLabel: 'ماذا تريد أن تنشئ أو تؤتمت؟',
  promptPlaceholder: 'ماذا تحب أن تحقّق؟',
  promptHelper: 'فصلك التالي يبدأ هنا',
  promptSend: 'استكشف مسار عمل لفكرتك',
  promptsLabel: 'جرّب فكرة',
  prompts: ['أتمتة عملياتي', 'ابنِ موقعي القادم', 'اربط أدوات عملي'],
  resultEyebrow: 'نقطة بداية مقترحة',
  openBuilder: 'افتح المنشئ',
  openWorkflows: 'افتح مسارات العمل',
  workflows: [
    {
      title: 'عمليات بلا أعمال روتينية.',
      text: 'اربط الطلبات والموافقات والإشعارات في مسار عمل تتحكم به.',
      steps: ['استلام طلب', 'مراجعة الإجراء التالي', 'إشعار فريقك'],
    },
    {
      title: 'فكرتك. نقطة انطلاق تعمل.',
      text: 'صِف ما تريد بناءه، ثم انقله إلى منشئ نظم لتطويره وتحسينه.',
      steps: ['صِف فكرتك', 'ابنِ نسختك الأولى', 'راجع وانشر'],
    },
    {
      title: 'اجعل أدواتك تعمل معًا.',
      text: 'صمّم مسار عمل متصلًا بمساعدة الذكاء الاصطناعي، وأبقِ فريقك في موضع التحكم.',
      steps: ['اختر أدواتك', 'حدّد مسار عملك', 'راجع كل إجراء'],
    },
  ],
  choices: ['العمليات', 'ابنِ بالذكاء الاصطناعي', 'التكاملات'],
  platformTitle1: 'منصة واحدة.',
  platformTitle2: 'كل ما تحتاجه.',
  platformText: 'استضافة ونطاقات وخوادم وذكاء اصطناعي والأدوات المحيطة بها، مصمَّمة لتعمل معًا.',
  platformLabel: 'منصة نظم',
  bridgeEyebrow: 'حيث يلتقي الذكاء بالعمل اليومي',
  bridgeTitle1: 'ذكاؤك.',
  bridgeTitle2: 'عملك. متصلان.',
  bridgeText: 'مساعدة بالذكاء الاصطناعي، متصلة بالأدوات التي يقوم عليها عملك.',
  bridgeLabel: 'يتصل Claude عبر نظم بالنطاقات والاستضافة والبريد وERP وCRM وتطبيقات الأعمال',
  claudeSub: 'ذكاء لعملك اليومي',
  hubSub: 'منصة واحدة متصلة',
  destinations: ['النطاقات', 'استضافة المواقع', 'البريد للأعمال', 'ERP', 'CRM', 'تطبيقات الأعمال'],
  explore: 'استكشف المنصة',
  footEyebrow: 'فصلك التالي',
  footTitle1: 'افسح المجال',
  footTitle2: 'لما هو ممكن.',
  footBrand1: 'ذكاء. وبنية تحتية.',
  footBrand2: 'وقليل من الإمكانات الإضافية.',
  footExploreTitle: 'استكشف',
  footExplore: ['وكلاء الذكاء الاصطناعي', 'الأتمتة', 'البرمجة بالذكاء', 'التكاملات'],
  footBuildTitle: 'ابنِ على نظم',
  footBuild: [
    'الخوادم السحابية',
    'النطاقات',
    'استضافة المواقع',
    'منشئ الذكاء الاصطناعي',
    'كل الخدمات',
  ],
  footWorkspaceTitle: 'مساحة عملك',
  footDesigns: 'مكتبة التصاميم',
  footLogin: 'تسجيل الدخول',
  footStart: 'ابدأ الآن',
  themeLight: 'مظهر فاتح',
  themeDark: 'مظهر داكن',
  rights: 'جميع الحقوق محفوظة.',
  built: 'مبنية حول إمكاناتك.',
  top: 'العودة للأعلى',
  dialogLabel: 'معاينة مسار عمل بالذكاء الاصطناعي',
  dialogClose: 'إغلاق المعاينة',
  dialogEyebrow: 'استكشف التجربة',
  dialogTitle1: 'مسار عمل',
  dialogTitle2: 'وأنت في مركزه.',
  dialogText: 'اختر نقطة بداية لترى كيف يمكن أن يتصل عملك. هذه معاينة توضيحية.',
  chatEyebrow: 'تحدّث مع نظم AI',
  chatTitle1: 'قل ما تحتاجه.',
  chatTitle2: 'ونظم AI يبنيه معك.',
  chatText:
    'من فكرة أولى إلى موقع حي، في محادثة واحدة. يخطّط نظم AI، ويبني نسخة أولى، ويطبّق تعديلاتك كما تطلب.',
  chatTry: 'جرّب نظم AI',
  chatDashboard: 'افتح لوحة التحكم',
  chatVideoLabel: 'رسم متحرك للمحادثة مع نظم AI: صِف موقعًا، واعتمد الخطة، وعدّل بالمحادثة، ثم انشر',
  chatCaption: 'رسم متحرك توضيحي لمسار منشئ نظم AI.',
  showEyebrow: 'تخيّلها. ابنِها.',
  showTitle1: 'فكرة واحدة.',
  showTitle2: 'إمكانات بلا حدود.',
  showText: 'تطبيقات ومواقع وتطبيقات ويب. تُنشأ بالذكاء الاصطناعي.',
  showOptions: ['تطبيق جوال', 'موقع', 'لوحة تحكم'],
  showCreate: ['أنشئ تطبيق جوال', 'أنشئ موقعًا', 'أنشئ تطبيق ويب'],
  showBadge: 'بقوة نظم AI',
  showStage: 'اختر ما تريد إنشاءه',
  showPicker: 'نوع المشروع',
  techLabel: 'التقنيات التي يمكنك البناء والتشغيل بها على نظم',
};

export const landingText = (l: Locale): LandingText => (l === 'ar' ? ar : en);
