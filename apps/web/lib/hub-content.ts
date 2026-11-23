import type { IconName } from '@nuzm/ui';
import type { L } from './site-content';

/**
 * Content of the public Blog, Academy and Community pages. Every statement describes what the Nuzm services already do (the same facts as site-content.ts);
 * nothing here invents a price, a region, a date, a member count or an event. Channels that do not exist yet are marked "coming soon".
 */
const l = (en: string, ar: string): L => ({ en, ar });

/* ---------------- blog ---------------- */

export type PostCategory = 'guides' | 'builder' | 'security';
export const POST_CATEGORIES: { id: PostCategory; name: L }[] = [
  { id: 'guides', name: l('Guides', 'أدلة') },
  { id: 'builder', name: l('AI builder', 'منشئ الذكاء الاصطناعي') },
  { id: 'security', name: l('Security and trust', 'الأمان والثقة') },
];

export interface Post {
  slug: string;
  category: PostCategory;
  icon: IconName;
  minutes: number;
  title: L;
  excerpt: L;
  sections: { h: L; p: L }[];
  /** the service page this article leads to */
  service: string;
}

export const POSTS: Post[] = [
  {
    slug: 'launch-your-first-website',
    category: 'guides',
    icon: 'hosting',
    minutes: 5,
    title: l('Launch your first website on Nuzm', 'أطلق موقعك الأول على نظم'),
    excerpt: l(
      'From choosing a hosting type to connecting your domain and turning on SSL: the whole path in one place.',
      'من اختيار نوع الاستضافة إلى ربط نطاقك وتفعيل SSL: المسار كاملًا في مكان واحد.',
    ),
    sections: [
      {
        h: l('Pick the hosting type', 'اختر نوع الاستضافة'),
        p: l(
          'Website hosting, cloud hosting, web apps and agency plans each fit a different project. Each plan lists the runtimes it supports, such as static sites, PHP, Node.js or Python, so you can match it to what you are building.',
          'تناسب استضافة المواقع والاستضافة السحابية وتطبيقات الويب وباقات الوكالات مشاريع مختلفة. تعرض كل باقة بيئات التشغيل التي تدعمها، مثل المواقع الثابتة وPHP وNode.js وPython، لتختار ما يناسب ما تبنيه.',
        ),
      },
      {
        h: l('Add your site', 'أضف موقعك'),
        p: l(
          'Create the site from your dashboard and upload what you built, or start from the AI builder and publish from there.',
          'أنشئ الموقع من لوحة التحكم وارفع ما بنيته، أو ابدأ من منشئ الذكاء الاصطناعي وانشر منه.',
        ),
      },
      {
        h: l('Connect your domain', 'اربط نطاقك'),
        p: l(
          'Register a domain with Nuzm or connect one you already own. The connection is checked before it is reported as ready, and SSL is prepared for it.',
          'سجّل نطاقًا من نظم أو اربط نطاقًا تملكه. يُفحص الربط قبل أن يُعلن جاهزًا، ويُجهَّز SSL له.',
        ),
      },
      {
        h: l('Keep a backup you can restore', 'احتفظ بنسخة تستطيع استعادتها'),
        p: l(
          'Backups of your site are available from the same dashboard, and you can restore from them when you need to.',
          'تتوفر النسخ الاحتياطية لموقعك من لوحة التحكم نفسها، ويمكنك الاستعادة منها عند الحاجة.',
        ),
      },
    ],
    service: 'hosting',
  },
  {
    slug: 'describe-it-build-it',
    category: 'builder',
    icon: 'sparkle',
    minutes: 4,
    title: l('Describe it, build it: writing a good first prompt', 'صِفه يُبنَ: كيف تكتب طلبك الأول'),
    excerpt: l(
      'The AI builder starts from your words. A few details about audience, screens and style make the first version much closer to what you want.',
      'يبدأ منشئ الذكاء الاصطناعي من كلماتك. تفاصيل قليلة عن الجمهور والشاشات والأسلوب تجعل النسخة الأولى أقرب لما تريد.',
    ),
    sections: [
      {
        h: l('Say who it is for', 'قل لمن تبنيه'),
        p: l(
          'A clinic booking page and a portfolio need different things. Name your audience and what they should do on the first screen.',
          'صفحة حجز لعيادة تختلف عن معرض أعمال. اذكر جمهورك وما يجب أن يفعله في الشاشة الأولى.',
        ),
      },
      {
        h: l('List the key screens', 'اذكر الشاشات الأساسية'),
        p: l(
          'Home, services, booking, contact: a short list of screens gives the first version a clear structure you can refine.',
          'الرئيسية، الخدمات، الحجز، التواصل: قائمة قصيرة بالشاشات تمنح النسخة الأولى بنية واضحة تحسّنها لاحقًا.',
        ),
      },
      {
        h: l('Write in Arabic or English', 'اكتب بالعربية أو الإنجليزية'),
        p: l(
          'Both work. Choose the languages of your site in the options, and keep refining with follow-up requests.',
          'كلاهما يعمل. اختر لغات موقعك من الخيارات، واستمر في التحسين بطلبات متابعة.',
        ),
      },
      {
        h: l('Review before you publish', 'راجع قبل النشر'),
        p: l(
          'Every change appears in the preview first. You decide what gets published, and a spending cap keeps AI usage within your limit.',
          'يظهر كل تعديل في المعاينة أولًا. أنت من يقرر ما يُنشر، ويحافظ سقف الإنفاق على استخدام الذكاء الاصطناعي ضمن حدّك.',
        ),
      },
    ],
    service: 'ai-builder',
  },
  {
    slug: 'domain-dns-basics',
    category: 'guides',
    icon: 'domains',
    minutes: 6,
    title: l('Domains and DNS, explained simply', 'النطاقات وDNS بشرح مبسّط'),
    excerpt: l(
      'What a DNS record does, which ones your site and email need, and how Nuzm protects the records that keep them connected.',
      'ما وظيفة سجل DNS، وما السجلات التي يحتاجها موقعك وبريدك، وكيف تحمي نظم سجلات الربط.',
    ),
    sections: [
      {
        h: l('A domain is an address book entry', 'النطاق عنوان في دليل'),
        p: l(
          'DNS records tell the internet where your website and your email live. Changing a record changes where visitors and messages go.',
          'تخبر سجلات DNS الإنترنت أين يوجد موقعك وبريدك. تغيير سجل يغيّر وجهة الزوار والرسائل.',
        ),
      },
      {
        h: l('Search before you decide', 'ابحث قبل أن تقرر'),
        p: l(
          'Domain search shows whether a name is available and its actual price before you start.',
          'يعرض البحث عن النطاقات إن كان الاسم متاحًا وسعره الفعلي قبل أن تبدأ.',
        ),
      },
      {
        h: l('Connect without breaking email', 'اربط دون أن تتعطل رسائلك'),
        p: l(
          'Connecting a domain to your site follows clear steps and does not touch your email records. The connection records are protected from accidental edits.',
          'يتم ربط النطاق بموقعك بخطوات واضحة دون المساس بسجلات البريد، وتُحمى سجلات الربط من التعديل بالخطأ.',
        ),
      },
      {
        h: l('Renew on time', 'جدّد في الوقت المناسب'),
        p: l(
          'Turn on automatic renewal, and you will receive reminders before the domain expires.',
          'فعّل التجديد التلقائي، وتصلك تذكيرات قبل انتهاء النطاق.',
        ),
      },
    ],
    service: 'domains',
  },
  {
    slug: 'verified-offers-only',
    category: 'security',
    icon: 'shield',
    minutes: 3,
    title: l('Why we only show offers that are real', 'لماذا لا نعرض إلا العروض المتحقَّق منها'),
    excerpt: l(
      'A region or a plan appears in your account only once it is confirmed for you. Here is why, and what it means for your orders.',
      'لا تظهر منطقة أو باقة في حسابك إلا بعد التحقق منها لك. إليك السبب وما يعنيه ذلك لطلباتك.',
    ),
    sections: [
      {
        h: l('No assumed regions', 'لا مناطق مفترضة'),
        p: l(
          'We do not assume a region or plan exists. What you see in the cloud servers page has actually been confirmed for your account, plan and region.',
          'لا نفترض وجود منطقة أو باقة. ما تراه في صفحة الخوادم السحابية ثبتت إتاحته فعلًا لحسابك وباقتك ومنطقتك.',
        ),
      },
      {
        h: l('A quote before you buy', 'عرض سعر قبل الشراء'),
        p: l(
          'You receive a clear quote, approve it, and only then is the order placed.',
          'تحصل على عرض سعر واضح، وتوافق عليه، ثم يُنفَّذ الطلب.',
        ),
      },
      {
        h: l('Every operation is followed to the end', 'كل عملية تُتابَع حتى تكتمل'),
        p: l(
          'Creating, changing and deleting are operations that are tracked until they finish and are checked against the provider.',
          'الإنشاء والتغيير والحذف عمليات تُتابَع حتى تكتمل وتُطابَق مع المزوّد.',
        ),
      },
    ],
    service: 'cloud',
  },
  {
    slug: 'professional-email-setup',
    category: 'guides',
    icon: 'email',
    minutes: 4,
    title: l('Professional email on your own domain', 'بريد احترافي باسم نطاقك'),
    excerpt: l(
      'Mailboxes for your team, sending from your app, and the sender records that help your messages arrive.',
      'صناديق بريد لفريقك، وإرسال من تطبيقك، وسجلات المرسل التي تساعد رسائلك على الوصول.',
    ),
    sections: [
      {
        h: l('Mailboxes for the team', 'صناديق بريد للفريق'),
        p: l(
          'Create mailboxes on your domain and manage them from one dashboard.',
          'أنشئ صناديق بريد على نطاقك وأدرها من لوحة واحدة.',
        ),
      },
      {
        h: l('Sender verification', 'توثيق المرسل'),
        p: l(
          'Nuzm prepares the SPF and DKIM records on your domain and verifies them. If your domain is registered elsewhere, you get the records to add there.',
          'تجهّز نظم سجلات SPF وDKIM على نطاقك وتتحقق منها. وإن كان نطاقك مسجّلًا في مكان آخر تحصل على السجلات لتضيفها هناك.',
        ),
      },
      {
        h: l('Respect stop requests', 'احترم طلبات الإيقاف'),
        p: l(
          'Addresses that bounced or asked to stop are not sent to again.',
          'لا يُعاد الإرسال لعناوين ارتدّت أو طلبت الإيقاف.',
        ),
      },
    ],
    service: 'email',
  },
  {
    slug: 'safe-restores',
    category: 'security',
    icon: 'data',
    minutes: 3,
    title: l('Restores that never overwrite by surprise', 'استعادة لا تستبدل بياناتك فجأة'),
    excerpt: l(
      'How managed databases restore to a new copy by default, and how credentials rotate without downtime.',
      'كيف تستعيد قواعد البيانات المُدارة إلى نسخة جديدة افتراضيًا، وكيف تُدوَّر بيانات الدخول دون انقطاع.',
    ),
    sections: [
      {
        h: l('Restore to a new database', 'الاستعادة إلى قاعدة جديدة'),
        p: l(
          'A restore goes to a new database by default. The original is replaced only when you confirm it.',
          'تتم الاستعادة افتراضيًا إلى قاعدة جديدة، ولا يُستبدل الأصل إلا بتأكيدك.',
        ),
      },
      {
        h: l('Rotate credentials calmly', 'دوّر بيانات الدخول بهدوء'),
        p: l(
          'Change passwords without downtime: for a period, the old and the new credentials both work.',
          'غيّر كلمات المرور دون انقطاع: لفترةٍ يعمل القديم والجديد معًا.',
        ),
      },
    ],
    service: 'data',
  },
];

export const postBySlug = (slug: string) => POSTS.find((p) => p.slug === slug);

/* ---------------- academy ---------------- */

export type Level = 'beginner' | 'intermediate';
export const LEVELS: Record<Level, L> = {
  beginner: l('Beginner', 'مبتدئ'),
  intermediate: l('Intermediate', 'متوسط'),
};

export interface Course {
  slug: string;
  icon: IconName;
  level: Level;
  title: L;
  summary: L;
  /** what you can do after the course */
  outcome: L;
  lessons: { title: L; text: L }[];
  service: string;
}

export const COURSES: Course[] = [
  {
    slug: 'hosting-foundations',
    icon: 'hosting',
    level: 'beginner',
    title: l('Hosting foundations', 'أساسيات الاستضافة'),
    summary: l(
      'Choose a hosting type, publish a site, connect a domain and keep backups.',
      'اختر نوع الاستضافة، وانشر موقعًا، واربط نطاقًا، واحتفظ بنسخ احتياطية.',
    ),
    outcome: l('A live website on your own domain.', 'موقع يعمل على نطاقك الخاص.'),
    lessons: [
      {
        title: l('Hosting types and runtimes', 'أنواع الاستضافة وبيئات التشغيل'),
        text: l(
          'Compare website hosting, cloud hosting, web apps and agency plans, and read which runtimes each plan supports.',
          'قارن استضافة المواقع والاستضافة السحابية وتطبيقات الويب وباقات الوكالات، واقرأ بيئات التشغيل التي تدعمها كل باقة.',
        ),
      },
      {
        title: l('Add and publish a site', 'أضف موقعًا وانشره'),
        text: l(
          'Create a site in the dashboard and publish your files or a project from the AI builder.',
          'أنشئ موقعًا من لوحة التحكم وانشر ملفاتك أو مشروعًا من منشئ الذكاء الاصطناعي.',
        ),
      },
      {
        title: l('Domain and SSL', 'النطاق وSSL'),
        text: l(
          'Connect a domain, wait for the connection check, and confirm SSL is ready.',
          'اربط نطاقًا، وانتظر فحص الربط، وتأكد من جاهزية SSL.',
        ),
      },
      {
        title: l('Backups and restore', 'النسخ الاحتياطية والاستعادة'),
        text: l(
          'Find your backups and practise a restore before you ever need one.',
          'اعثر على نسخك الاحتياطية وجرّب الاستعادة قبل أن تحتاجها.',
        ),
      },
    ],
    service: 'hosting',
  },
  {
    slug: 'build-with-ai',
    icon: 'sparkle',
    level: 'beginner',
    title: l('Build with the AI builder', 'ابنِ مع منشئ الذكاء الاصطناعي'),
    summary: l(
      'Go from a written idea to a reviewed, published website or app.',
      'انتقل من فكرة مكتوبة إلى موقع أو تطبيق تمت مراجعته ونشره.',
    ),
    outcome: l('A first version you have reviewed and published.', 'نسخة أولى راجعتها ونشرتها.'),
    lessons: [
      {
        title: l('Write the brief', 'اكتب الوصف'),
        text: l(
          'Describe the audience, the key screens and the style, in Arabic or English.',
          'صِف الجمهور والشاشات الأساسية والأسلوب، بالعربية أو الإنجليزية.',
        ),
      },
      {
        title: l('Refine in the editor', 'حسّن في المحرر'),
        text: l(
          'Edit pages, sections and text directly, with undo and redo, or ask for changes in the conversation.',
          'عدّل الصفحات والأقسام والنصوص مباشرة مع التراجع والإعادة، أو اطلب التعديلات في المحادثة.',
        ),
      },
      {
        title: l('Web apps and Flutter apps', 'تطبيقات الويب وتطبيقات Flutter'),
        text: l(
          'Web apps are built and tested in an isolated environment; mobile apps use Flutter.',
          'تُبنى تطبيقات الويب وتُختبر في بيئة معزولة، وتستخدم تطبيقات الجوال Flutter.',
        ),
      },
      {
        title: l('Spending caps and approvals', 'سقف الإنفاق والموافقات'),
        text: l(
          'Set an AI spending cap; paid or destructive actions need a human approval.',
          'حدّد سقفًا لإنفاق الذكاء الاصطناعي؛ الإجراءات المدفوعة أو المدمّرة تحتاج موافقة بشرية.',
        ),
      },
    ],
    service: 'ai-builder',
  },
  {
    slug: 'domains-and-email',
    icon: 'domains',
    level: 'beginner',
    title: l('Domains and business email', 'النطاقات والبريد المهني'),
    summary: l(
      'Register or transfer a domain, manage DNS and set up email that arrives.',
      'سجّل نطاقًا أو انقله، وأدر DNS، وجهّز بريدًا يصل.',
    ),
    outcome: l(
      'A domain with working email and verified sender records.',
      'نطاق ببريد يعمل وسجلات مرسل موثّقة.',
    ),
    lessons: [
      {
        title: l('Search, register, transfer', 'ابحث وسجّل وانقل'),
        text: l(
          'Check availability and the real price, register a name, or transfer one you own.',
          'تحقق من التوفر والسعر الفعلي، وسجّل اسمًا أو انقل نطاقًا تملكه.',
        ),
      },
      {
        title: l('DNS records', 'سجلات DNS'),
        text: l(
          'Manage records from one place; connection records are protected from accidental edits.',
          'أدر السجلات من مكان واحد؛ سجلات الربط محمية من التعديل بالخطأ.',
        ),
      },
      {
        title: l('Mailboxes', 'صناديق البريد'),
        text: l(
          'Create mailboxes for your team on your domain.',
          'أنشئ صناديق بريد لفريقك على نطاقك.',
        ),
      },
      {
        title: l('SPF and DKIM', 'SPF وDKIM'),
        text: l(
          'Let Nuzm prepare and verify the sender records on your domain.',
          'دع نظم تجهّز سجلات المرسل على نطاقك وتتحقق منها.',
        ),
      },
    ],
    service: 'domains',
  },
  {
    slug: 'cloud-servers-safely',
    icon: 'cloud',
    level: 'intermediate',
    title: l('Cloud servers, safely', 'الخوادم السحابية بأمان'),
    summary: l(
      'Create a virtual server with a quote, a spending cap and tracked operations.',
      'أنشئ خادمًا افتراضيًا بعرض سعر وسقف إنفاق وعمليات متتبَّعة.',
    ),
    outcome: l(
      'A server you can account for, from quote to operation log.',
      'خادم تعرف كل شيء عنه، من عرض السعر إلى سجل العمليات.',
    ),
    lessons: [
      {
        title: l('Read verified offers', 'اقرأ العروض المتحقَّق منها'),
        text: l(
          'Only offers confirmed for your account, plan and region are shown.',
          'لا تُعرض إلا العروض التي ثبتت إتاحتها لحسابك وباقتك ومنطقتك.',
        ),
      },
      {
        title: l('Quote and approve', 'عرض السعر والموافقة'),
        text: l(
          'Review the quote and approve it before the order is placed.',
          'راجع عرض السعر ووافق عليه قبل تنفيذ الطلب.',
        ),
      },
      {
        title: l('Spending limits', 'حدود الإنفاق'),
        text: l(
          'Set a spending cap and require approval above it.',
          'حدّد سقف الإنفاق واطلب الموافقة على ما يتجاوزه.',
        ),
      },
      {
        title: l('Follow operations', 'تابع العمليات'),
        text: l(
          'Watch create, change and delete operations until they complete.',
          'تابع عمليات الإنشاء والتغيير والحذف حتى تكتمل.',
        ),
      },
    ],
    service: 'cloud',
  },
];

export const courseBySlug = (slug: string) => COURSES.find((c) => c.slug === slug);

/* ---------------- community ---------------- */

export interface Channel {
  id: string;
  icon: IconName;
  title: L;
  text: L;
  /** a real destination; absent while the channel is not open yet */
  href?: string;
  action?: L;
}

export const CHANNELS: Channel[] = [
  {
    id: 'docs',
    icon: 'list',
    title: l('Documentation', 'التوثيق'),
    text: l(
      'Step-by-step guides and the API reference. Each page has a feedback button that reaches the team.',
      'أدلة خطوة بخطوة ومرجع الواجهة البرمجية. في كل صفحة زر للملاحظات يصل إلى الفريق.',
    ),
    href: '/docs',
    action: l('Open the docs', 'افتح التوثيق'),
  },
  {
    id: 'support',
    icon: 'support',
    title: l('Support from your dashboard', 'الدعم من لوحة التحكم'),
    text: l(
      'Signed-in customers reach support from inside the dashboard, with their account context.',
      'يصل العملاء المسجّلون إلى الدعم من داخل لوحة التحكم مع سياق حساباتهم.',
    ),
    href: '/login',
    action: l('Sign in', 'سجّل الدخول'),
  },
  {
    id: 'forum',
    icon: 'organization',
    title: l('Community forum', 'منتدى المجتمع'),
    text: l(
      'A place to ask questions, share what you built and help others. We are preparing it.',
      'مكان لطرح الأسئلة ومشاركة ما بنيته ومساعدة الآخرين. نعمل على تجهيزه.',
    ),
  },
  {
    id: 'events',
    icon: 'calendar',
    title: l('Workshops and meetups', 'ورش ولقاءات'),
    text: l(
      'Live sessions in Arabic and English about building and running projects on Nuzm. The schedule will be announced here.',
      'جلسات مباشرة بالعربية والإنجليزية عن بناء المشاريع وتشغيلها على نظم. يُعلن الجدول هنا.',
    ),
  },
];

export const COMMUNITY_VALUES: { icon: IconName; title: L; text: L }[] = [
  {
    icon: 'globe',
    title: l('Arabic first, English too', 'العربية أولًا، والإنجليزية أيضًا'),
    text: l('Ask and answer in the language you think in.', 'اسأل وأجب باللغة التي تفكر بها.'),
  },
  {
    icon: 'shield',
    title: l('Respect and safety', 'الاحترام والأمان'),
    text: l(
      'No personal data, passwords or keys in public posts. Be kind; help the next person.',
      'لا بيانات شخصية ولا كلمات مرور ولا مفاتيح في المنشورات العامة. كن لطيفًا وساعد من بعدك.',
    ),
  },
  {
    icon: 'sparkle',
    title: l('Show what you built', 'شارك ما بنيته'),
    text: l(
      'Real projects teach the most: share the idea, the steps and what you learned.',
      'المشاريع الحقيقية تعلّم أكثر: شارك الفكرة والخطوات وما تعلّمته.',
    ),
  },
];

/* ---------------- shared labels ---------------- */

export const HUB = {
  blog: l('Blog', 'المدونة'),
  academy: l('Academy', 'الأكاديمية'),
  community: l('Community', 'المجتمع'),
  blogTitle: l('Ideas and guides for building online', 'أفكار وأدلة للبناء على الإنترنت'),
  blogIntro: l(
    'Practical articles about hosting, domains, email and the AI builder, written by the Nuzm team.',
    'مقالات عملية عن الاستضافة والنطاقات والبريد ومنشئ الذكاء الاصطناعي، يكتبها فريق نظم.',
  ),
  all: l('All', 'الكل'),
  featured: l('Featured', 'مختار'),
  minutes: l('min read', 'دقائق قراءة'),
  read: l('Read the article', 'اقرأ المقال'),
  byTeam: l('Nuzm team', 'فريق نظم'),
  backBlog: l('All articles', 'كل المقالات'),
  moreArticles: l('More articles', 'مقالات أخرى'),
  tryService: l('Try it in your account', 'جرّبه في حسابك'),
  academyTitle: l('Learn to build and run on Nuzm', 'تعلّم البناء والتشغيل على نظم'),
  academyIntro: l(
    'Short, free courses in Arabic and English. Each one ends with something working in your account.',
    'دورات قصيرة ومجانية بالعربية والإنجليزية. تنتهي كل دورة بشيء يعمل في حسابك.',
  ),
  free: l('Free', 'مجانية'),
  lessons: l('lessons', 'دروس'),
  startCourse: l('Start the course', 'ابدأ الدورة'),
  outcome: l('You will finish with', 'ستنتهي بـ'),
  backAcademy: l('All courses', 'كل الدورات'),
  lessonPlan: l('Lesson plan', 'خطة الدروس'),
  practise: l('Practise in your account', 'طبّق في حسابك'),
  paths: l('Learning paths', 'مسارات التعلّم'),
  communityTitle: l('Build together', 'نبني معًا'),
  communityIntro: l(
    'A place for people who build on Nuzm to learn from each other, in Arabic and English.',
    'مساحة لمن يبني على نظم ليتعلّم بعضهم من بعض، بالعربية والإنجليزية.',
  ),
  channels: l('Where to find us', 'أين تجدنا'),
  soon: l('Coming soon', 'قريبًا'),
  values: l('How we talk to each other', 'كيف نتحدث مع بعضنا'),
  learnMore: l('Keep learning', 'تابع التعلّم'),
};
