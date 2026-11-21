import type { IconName } from '@nuzm/ui';
import type { Locale } from '@nuzm/i18n';

/**
 * Content of the public marketing site (service pages). Every text is an Arabic/English pair. Rules (CLAUDE.md §4, docs/10): nothing here states a price, a
 * discount, a guarantee, an uptime figure, a customer count, a region or a compliance claim; what the platform can sell is decided per account, plan and
 * region, so the pages describe what each service is for and send the visitor to sign up, where the real offers are shown.
 */
export type L = { ar: string; en: string };
export const pick = (v: L, locale: Locale): string => v[locale];

export interface ServicePoint {
  icon: IconName;
  title: L;
  text: L;
}
export interface ServiceContent {
  slug: string;
  icon: IconName;
  /** which bento artwork of the console fits this service (the others use an icon panel) */
  art: 'compute' | 'hosting' | 'builder' | null;
  /** the console page this service opens (without the locale) */
  href: string;
  name: L;
  /** short line under the name, in menus and cards */
  tagline: L;
  /** the page headline */
  headline: L;
  intro: L;
  points: ServicePoint[];
  steps: { title: L; text: L }[];
  faq: { q: L; a: L }[];
  /** one honest limitation or status line, when there is one */
  note?: L;
}

export const SERVICES: ServiceContent[] = [
  {
    slug: 'hosting',
    icon: 'hosting',
    art: 'hosting',
    href: '/hosting/sites',
    name: { ar: 'استضافة المواقع', en: 'Website hosting' },
    tagline: {
      ar: 'بيت لموقعك ينمو معه',
      en: 'A home for your website that grows with it',
    },
    headline: {
      ar: 'استضافة مُدارة لموقعك، من أول نشر إلى آخر زائر.',
      en: 'Managed hosting for your website, from first launch to every visitor.',
    },
    intro: {
      ar: 'استضافة على خوادم تشغّلها نظم للمواقع وتطبيقات الويب والوكالات. اختر النوع المناسب، أضف موقعك، اربط نطاقك وانشر.',
      en: 'Hosting on servers that Nuzm operates, for websites, web apps and agencies. Pick the type that fits, add your site, connect your domain and publish.',
    },
    points: [
      {
        icon: 'hosting',
        title: { ar: 'نوع لكل مشروع', en: 'A type for every project' },
        text: {
          ar: 'استضافة مواقع، واستضافة سحابية، وتطبيقات ويب، وباقات للوكالات التي تدير مواقع عملائها.',
          en: 'Web hosting, cloud hosting, web apps, and agency plans for people who run their clients’ sites.',
        },
      },
      {
        icon: 'code',
        title: { ar: 'شغّل ما تبنيه', en: 'Run what you build' },
        text: {
          ar: 'مواقع ثابتة، وPHP، وNode.js، وPython بحسب ما تتيحه الباقة. تعرض كل باقة بيئات التشغيل التي تدعمها.',
          en: 'Static sites, PHP, Node.js and Python, depending on the plan. Each plan lists the runtimes it supports.',
        },
      },
      {
        icon: 'refresh',
        title: { ar: 'نسخ احتياطية تستعيدها', en: 'Backups you can restore' },
        text: {
          ar: 'نسخ احتياطية لموقعك واستعادة منها عند الحاجة، من لوحة التحكم نفسها.',
          en: 'Backups of your site and restores from them when you need one, from the same dashboard.',
        },
      },
      {
        icon: 'lock',
        title: { ar: 'نطاقك مع SSL', en: 'Your domain, with SSL' },
        text: {
          ar: 'اربط نطاقك بموقعك ويُجهَّز SSL له، وتُفحص الحالة قبل أن يُعلَن الربط جاهزًا.',
          en: 'Connect your domain to your site and SSL is set up for it. The state is checked before the connection is called ready.',
        },
      },
    ],
    steps: [
      {
        title: { ar: 'اختر باقة', en: 'Choose a plan' },
        text: {
          ar: 'قارن الباقات بحدودها المكتوبة: المساحة والنطاق الترددي وقواعد البيانات وعدد المواقع.',
          en: 'Compare plans by their stated limits: storage, bandwidth, databases and number of sites.',
        },
      },
      {
        title: { ar: 'أضف موقعك', en: 'Add your website' },
        text: {
          ar: 'أنشئ موقعًا جديدًا أو انشر ما بنيته بالذكاء الاصطناعي.',
          en: 'Create a new site or publish what you built with AI.',
        },
      },
      {
        title: { ar: 'اربط نطاقك', en: 'Connect your domain' },
        text: {
          ar: 'نعرض لك إعدادات DNS المطلوبة ونتحقق منها دون أن نمسّ سجلات البريد أو غيرها.',
          en: 'We show the DNS settings it needs and verify them without touching your mail or other records.',
        },
      },
    ],
    faq: [
      {
        q: { ar: 'أين أرى الأسعار؟', en: 'Where do I see prices?' },
        a: {
          ar: 'تظهر الأسعار في حسابك للباقة والمنطقة التي تختارها، وقبل أي دفع. لا نعرض عرضًا لا يتوفر لحسابك.',
          en: 'Prices appear in your account for the plan and region you choose, before you pay. We never show an offer your account cannot buy.',
        },
      },
      {
        q: {
          ar: 'هل موقعي معزول عن مواقع العملاء الآخرين؟',
          en: 'Is my site isolated from other customers?',
        },
        a: {
          ar: 'نعم، تعمل المواقع معزولة عن بعضها على الخادم، ولكل باقة حدود موارد معلنة.',
          en: 'Yes. Sites run isolated from each other on the server, and every plan has stated resource limits.',
        },
      },
      {
        q: { ar: 'هل أحتاج نطاقًا من نظم؟', en: 'Do I need a domain from Nuzm?' },
        a: {
          ar: 'يمكنك تسجيل نطاق من نظم وربطه بنقرات قليلة، أو ربط نطاق تملكه.',
          en: 'You can register a domain with Nuzm and connect it in a few clicks, or connect one you already own.',
        },
      },
    ],
  },
  {
    slug: 'cloud',
    icon: 'cloud',
    art: 'compute',
    href: '/compute/offers',
    name: { ar: 'الخوادم السحابية', en: 'Cloud servers' },
    tagline: { ar: 'قوة حوسبة بحجم مشروعك', en: 'Compute sized for your project' },
    headline: {
      ar: 'خوادم سحابية تتحكم بها، وتدفع عمّا تختاره فقط.',
      en: 'Cloud servers you control, with an offer shown only when it is real.',
    },
    intro: {
      ar: 'أنشئ خادمًا افتراضيًا وأدره من مكان واحد. تُعرض لك العروض المتحقَّق منها لحسابك وباقتك ومنطقتك فقط.',
      en: 'Create a virtual server and manage it from one place. You only see offers that are verified for your account, plan and region.',
    },
    points: [
      {
        icon: 'check',
        title: { ar: 'عروض متحقَّق منها', en: 'Verified offers only' },
        text: {
          ar: 'لا نفترض وجود منطقة أو باقة. ما يظهر لك هو ما ثبتت إتاحته فعلًا.',
          en: 'We never assume a region or a plan exists. What you see is what has actually been confirmed.',
        },
      },
      {
        icon: 'wallet',
        title: { ar: 'سعر قبل الشراء', en: 'A quote before you buy' },
        text: {
          ar: 'تحصل على عرض سعر واضح، وتوافق عليه، ثم يُنفَّذ الطلب.',
          en: 'You get a clear quote, approve it, and only then is the order placed.',
        },
      },
      {
        icon: 'shield',
        title: { ar: 'حدود إنفاق وموافقات', en: 'Spend limits and approvals' },
        text: {
          ar: 'حدّد سقف الإنفاق واطلب موافقة على ما يتجاوزه.',
          en: 'Set a spending cap and require approval for anything above it.',
        },
      },
      {
        icon: 'pulse',
        title: { ar: 'تتبّع كل عملية', en: 'Every operation tracked' },
        text: {
          ar: 'الإنشاء والتغيير والحذف عمليات تُتابَع حتى تكتمل وتُطابَق مع المزوّد.',
          en: 'Creating, changing and deleting are operations that are followed until they finish and are checked against the provider.',
        },
      },
    ],
    steps: [
      {
        title: { ar: 'تصفّح العروض', en: 'Browse offers' },
        text: {
          ar: 'اختر المنطقة والحجم من العروض المتاحة لحسابك.',
          en: 'Pick a region and size from the offers available to your account.',
        },
      },
      {
        title: { ar: 'راجع العرض ووافق', en: 'Review the quote and approve' },
        text: {
          ar: 'يُعرض السعر والتفاصيل قبل أي التزام.',
          en: 'The price and details are shown before you commit to anything.',
        },
      },
      {
        title: { ar: 'شغّل وأدر', en: 'Run and manage' },
        text: {
          ar: 'ابدأ الخادم وراقب استهلاكه وأدره من لوحة واحدة.',
          en: 'Start the server, watch its usage and manage it from one dashboard.',
        },
      },
    ],
    faq: [
      {
        q: { ar: 'هل تتوفر خوادم في السعودية؟', en: 'Are servers available in Saudi Arabia?' },
        a: {
          ar: 'تظهر مناطق المملكة فقط عندما يثبت توفرها لحسابك. لا نعد بمنطقة قبل التحقق منها.',
          en: 'Saudi regions appear only when they are confirmed for your account. We do not promise a region before it is verified.',
        },
      },
      {
        q: { ar: 'كيف أعرف السعر؟', en: 'How do I know the price?' },
        a: {
          ar: 'يظهر في عرض السعر داخل حسابك قبل أن تؤكد الطلب.',
          en: 'It is shown in the quote inside your account before you confirm the order.',
        },
      },
    ],
  },
  {
    slug: 'domains',
    icon: 'domains',
    art: null,
    href: '/domains/search',
    name: { ar: 'النطاقات و DNS', en: 'Domains & DNS' },
    tagline: { ar: 'اسم موقعك، وربطه بخدماتك', en: 'Your name, connected to your services' },
    headline: {
      ar: 'ابحث عن نطاقك، سجّله، واربطه بموقعك.',
      en: 'Find your domain, register it, and connect it to your site.',
    },
    intro: {
      ar: 'بحث وتسجيل ونقل وتجديد وإدارة DNS في مكان واحد، مع ربط مباشر بالاستضافة.',
      en: 'Search, register, transfer, renew and manage DNS in one place, with a direct link to hosting.',
    },
    points: [
      {
        icon: 'search',
        title: { ar: 'بحث فوري', en: 'Instant search' },
        text: {
          ar: 'اعرف إن كان الاسم متاحًا والسعر الفعلي قبل أن تبدأ.',
          en: 'See whether a name is available, and the real price, before you start.',
        },
      },
      {
        icon: 'transfer',
        title: { ar: 'نقل وتجديد', en: 'Transfer and renew' },
        text: {
          ar: 'انقل نطاقًا تملكه إلى نظم، وجدّد في الوقت المناسب مع تذكيرات قبل الانتهاء.',
          en: 'Move a domain you own to Nuzm, and renew on time with reminders before it expires.',
        },
      },
      {
        icon: 'globe',
        title: { ar: 'إدارة DNS', en: 'DNS management' },
        text: {
          ar: 'أدر السجلات من لوحة واحدة، وتُحمى سجلات الربط من التعديل بالخطأ.',
          en: 'Manage records from one dashboard. Records created by a connection are protected from accidental edits.',
        },
      },
      {
        icon: 'hosting',
        title: { ar: 'ربط بالاستضافة', en: 'Linked to hosting' },
        text: {
          ar: 'اربط نطاقك بموقعك بخطوات واضحة، دون المساس بسجلات البريد وغيرها.',
          en: 'Connect your domain to your site in clear steps, without touching your mail or other records.',
        },
      },
    ],
    steps: [
      {
        title: { ar: 'ابحث', en: 'Search' },
        text: { ar: 'اكتب الاسم الذي تريده.', en: 'Type the name you want.' },
      },
      {
        title: { ar: 'راجع العرض', en: 'Review the quote' },
        text: {
          ar: 'يظهر السعر ومدة التسجيل وما يلزم من بيانات.',
          en: 'The price, the term and any details required are shown.',
        },
      },
      {
        title: { ar: 'سجّل واربط', en: 'Register and connect' },
        text: {
          ar: 'يُنفَّذ الطلب ويُتحقَّق منه، ثم تربطه بموقعك.',
          en: 'The order is placed and checked, then you connect it to your site.',
        },
      },
    ],
    faq: [
      {
        q: { ar: 'هل أستطيع تسجيل نطاق .sa؟', en: 'Can I register a .sa domain?' },
        a: {
          ar: 'نطاقات .sa وامتداداتها السعودية غير متاحة للبيع بعد. نعمل على مسار تسجيلها، وتظهر في البحث فور تأكيده.',
          en: '.sa domains and the other Saudi extensions are not for sale yet. We are working on the registration route, and they will appear in search once it is confirmed.',
        },
      },
      {
        q: { ar: 'هل يُجدَّد نطاقي تلقائيًا؟', en: 'Does my domain renew automatically?' },
        a: {
          ar: 'يمكنك تفعيل التجديد التلقائي. نرسل تذكيرات قبل الانتهاء، وإن تعذّر الدفع تصلك رسالة تنبيه.',
          en: 'You can turn on auto-renewal. We send reminders before expiry, and if a payment fails you are notified.',
        },
      },
    ],
    note: {
      ar: 'النطاقات السعودية (.sa) قيد الإعداد ولا تُباع حاليًا.',
      en: 'Saudi (.sa) domains are being prepared and are not sold yet.',
    },
  },
  {
    slug: 'ai-builder',
    icon: 'sparkle',
    art: 'builder',
    href: '/builder/projects',
    name: { ar: 'منشئ الذكاء الاصطناعي', en: 'AI builder' },
    tagline: { ar: 'من الفكرة إلى موقع أو تطبيق', en: 'From idea to a website or app' },
    headline: {
      ar: 'صِف ما تريد. يبنيه الذكاء الاصطناعي وتحكم أنت.',
      en: 'Describe what you want. AI builds it, and you stay in charge.',
    },
    intro: {
      ar: 'ابنِ موقعًا أو تطبيق ويب أو تطبيق جوال بالوصف النصي، ثم عدّل بصريًا وراجع كل نسخة قبل النشر.',
      en: 'Build a website, a web app or a mobile app from a description, then edit visually and review every version before you publish.',
    },
    points: [
      {
        icon: 'sparkle',
        title: { ar: 'من الوصف إلى موقع', en: 'From a prompt to a site' },
        text: {
          ar: 'اكتب ما تحتاجه بالعربية أو الإنجليزية ويصنع الذكاء الاصطناعي مسودة جاهزة للتعديل.',
          en: 'Write what you need in Arabic or English and AI drafts a version ready for you to edit.',
        },
      },
      {
        icon: 'panel',
        title: { ar: 'محرر بصري', en: 'Visual editor' },
        text: {
          ar: 'عدّل الصفحات والأقسام والنصوص مباشرة، مع التراجع والإعادة.',
          en: 'Edit pages, sections and text directly, with undo and redo.',
        },
      },
      {
        icon: 'code',
        title: { ar: 'تطبيقات ويب وجوال', en: 'Web and mobile apps' },
        text: {
          ar: 'تطبيقات كاملة تُبنى وتُختبر في بيئة معزولة، وتطبيقات Flutter للجوال.',
          en: 'Full apps that are built and tested in an isolated sandbox, and Flutter apps for mobile.',
        },
      },
      {
        icon: 'shield',
        title: { ar: 'ضوابط بشرية', en: 'Human controls' },
        text: {
          ar: 'سقف إنفاق للذكاء الاصطناعي، وموافقة بشرية على أي إجراء مدفوع أو مدمّر.',
          en: 'A spending cap for AI, and human approval for any paid or destructive action.',
        },
      },
    ],
    steps: [
      {
        title: { ar: 'صِف فكرتك', en: 'Describe your idea' },
        text: {
          ar: 'ابدأ بجملة، ونطرح عليك أسئلة إن احتجنا تفاصيل.',
          en: 'Start with a sentence, and we ask questions if we need more detail.',
        },
      },
      {
        title: { ar: 'راجع وعدّل', en: 'Review and refine' },
        text: {
          ar: 'شاهد المعاينة، عدّل بالمحادثة أو بصريًا، وتُحفظ كل نسخة.',
          en: 'Watch the preview, refine by chat or visually, and every version is kept.',
        },
      },
      {
        title: { ar: 'انشر', en: 'Publish' },
        text: {
          ar: 'انشر على استضافة نظم واربط نطاقك.',
          en: 'Publish to Nuzm hosting and connect your domain.',
        },
      },
    ],
    faq: [
      {
        q: { ar: 'هل أملك الكود الذي يُبنى؟', en: 'Do I own the code that is built?' },
        a: {
          ar: 'يمكنك تصدير مشروعك. الكود الذي يولّده الذكاء الاصطناعي يُعامل على أنه غير موثوق ويُشغَّل في بيئة معزولة.',
          en: 'You can export your project. Code that AI generates is treated as untrusted and runs in an isolated sandbox.',
        },
      },
      {
        q: { ar: 'هل يُحاسَب استخدام الذكاء الاصطناعي؟', en: 'Is AI usage billed?' },
        a: {
          ar: 'نعم، باعتماد رصيد ظاهر في حسابك، ويمكنك تحديد سقف له.',
          en: 'Yes, through credits shown in your account, and you can set a cap on them.',
        },
      },
    ],
  },
  {
    slug: 'email',
    icon: 'email',
    art: null,
    href: '/email/mailboxes',
    name: { ar: 'البريد الإلكتروني للأعمال', en: 'Business email' },
    tagline: { ar: 'بريد باسم نطاقك', en: 'Email on your own domain' },
    headline: {
      ar: 'بريد احترافي باسم نطاقك، وإرسال موثوق لرسائل تطبيقك.',
      en: 'Professional email on your domain, and reliable sending for your app’s messages.',
    },
    intro: {
      ar: 'صناديق بريد لفريقك، وإرسال برمجي للرسائل التشغيلية، وإعداد التحقق من المرسل على نطاقك.',
      en: 'Mailboxes for your team, programmatic sending for transactional messages, and sender verification set up on your domain.',
    },
    points: [
      {
        icon: 'mail',
        title: { ar: 'صناديق بريد', en: 'Mailboxes' },
        text: {
          ar: 'أنشئ صناديق لفريقك على نطاقك وأدرها من لوحة واحدة.',
          en: 'Create mailboxes for your team on your domain and manage them from one dashboard.',
        },
      },
      {
        icon: 'send',
        title: { ar: 'إرسال برمجي', en: 'Transactional sending' },
        text: {
          ar: 'أرسل رسائل التفعيل والإشعارات من تطبيقك، مع قوالب وسجل للرسائل.',
          en: 'Send activation and notification emails from your app, with templates and a message log.',
        },
      },
      {
        icon: 'shield',
        title: { ar: 'توثيق المرسل', en: 'Sender verification' },
        text: {
          ar: 'نجهّز لك سجلات SPF وDKIM على نطاقك ونتحقق منها.',
          en: 'We prepare the SPF and DKIM records on your domain and check them.',
        },
      },
      {
        icon: 'check',
        title: { ar: 'قوائم الإيقاف', en: 'Suppression lists' },
        text: {
          ar: 'لا نعيد الإرسال لعناوين ارتدّت أو طلبت الإيقاف.',
          en: 'We do not send again to addresses that bounced or asked to stop.',
        },
      },
    ],
    steps: [
      {
        title: { ar: 'أضف نطاقك', en: 'Add your domain' },
        text: {
          ar: 'اختر النطاق الذي سيُرسل منه البريد.',
          en: 'Choose the domain mail will come from.',
        },
      },
      {
        title: { ar: 'تحقّق من السجلات', en: 'Verify the records' },
        text: {
          ar: 'ننشئ سجلات DNS المطلوبة ونتأكد من صحتها.',
          en: 'We create the DNS records needed and confirm they are correct.',
        },
      },
      {
        title: { ar: 'أنشئ صناديق وأرسل', en: 'Create mailboxes and send' },
        text: {
          ar: 'ابدأ باستخدام البريد أو الإرسال من تطبيقك.',
          en: 'Start using mail, or send from your app.',
        },
      },
    ],
    faq: [
      {
        q: {
          ar: 'هل يعمل مع نطاق سجّلته في مكان آخر؟',
          en: 'Does it work with a domain registered elsewhere?',
        },
        a: {
          ar: 'نعرض عليك السجلات التي تضيفها عند مزوّدك، ثم نتحقق منها.',
          en: 'We show you the records to add at your provider, then we verify them.',
        },
      },
    ],
  },
  {
    slug: 'data',
    icon: 'data',
    art: null,
    href: '/databases',
    name: { ar: 'قواعد البيانات والتخزين', en: 'Databases & storage' },
    tagline: { ar: 'بيانات مُدارة بنسخ احتياطية', en: 'Managed data, with backups' },
    headline: {
      ar: 'قواعد بيانات وتخزين مُدارة، مع نسخ احتياطية تستعيدها.',
      en: 'Managed databases and storage, with backups you can restore.',
    },
    intro: {
      ar: 'قواعد بيانات علائقية وذاكرة مؤقتة وتخزين كائنات لمشاريعك، بنسخ احتياطية واستعادة مجرّبة.',
      en: 'Relational databases, caching and object storage for your projects, with backups and tested restores.',
    },
    points: [
      {
        icon: 'data',
        title: { ar: 'قواعد بيانات مُدارة', en: 'Managed databases' },
        text: {
          ar: 'أنشئ قاعدة بيانات واحصل على بيانات الاتصال، ونحن نتولى النسخ والصيانة.',
          en: 'Create a database and get your connection details. We take care of backups and upkeep.',
        },
      },
      {
        icon: 'refresh',
        title: { ar: 'استعادة آمنة', en: 'Safe restores' },
        text: {
          ar: 'الاستعادة تتم افتراضيًا إلى قاعدة جديدة، ولا يُستبدل الأصل إلا بتأكيدك.',
          en: 'Restores go to a new database by default, and the original is replaced only when you confirm.',
        },
      },
      {
        icon: 'key',
        title: { ar: 'تدوير بيانات الدخول', en: 'Credential rotation' },
        text: {
          ar: 'غيّر كلمات المرور دون انقطاع، مع فترة يعمل فيها القديم والجديد معًا.',
          en: 'Change credentials without downtime, with a window where the old and new both work.',
        },
      },
      {
        icon: 'grid',
        title: { ar: 'تخزين كائنات', en: 'Object storage' },
        text: {
          ar: 'احفظ الملفات والصور في حاويات خاصة بك.',
          en: 'Keep files and images in buckets that are yours.',
        },
      },
    ],
    steps: [
      {
        title: { ar: 'أنشئ', en: 'Create' },
        text: { ar: 'اختر النوع والباقة.', en: 'Choose the type and the plan.' },
      },
      {
        title: { ar: 'اتصل', en: 'Connect' },
        text: {
          ar: 'خذ بيانات الاتصال إلى تطبيقك.',
          en: 'Take the connection details to your app.',
        },
      },
      {
        title: { ar: 'اطمئن', en: 'Rest easy' },
        text: {
          ar: 'نسخ احتياطية دورية واستعادة عند الحاجة.',
          en: 'Regular backups, and a restore when you need one.',
        },
      },
    ],
    faq: [
      {
        q: { ar: 'ما أنواع قواعد البيانات؟', en: 'Which databases are there?' },
        a: {
          ar: 'ما يتاح لحسابك يظهر عند الإنشاء. لا نعرض نوعًا غير متاح.',
          en: 'What your account can create is shown when you create one. We do not list a type that is not available.',
        },
      },
    ],
  },
  {
    slug: 'automation',
    icon: 'workflow',
    art: null,
    href: '/automation/workflows',
    name: { ar: 'الأتمتة والسوق', en: 'Automation & marketplace' },
    tagline: { ar: 'اربط أدواتك ودع العمل يمضي', en: 'Connect your tools and let work flow' },
    headline: {
      ar: 'أتمتة تربط أدواتك، وسوق لما تحتاج إضافته.',
      en: 'Automation that connects your tools, and a marketplace for what you want to add.',
    },
    intro: {
      ar: 'صمّم سير عمل يربط طلباتك وموافقاتك وإشعاراتك، وأضف إضافات من السوق، أو انضم إلى برنامج الوكالات والموزّعين.',
      en: 'Design workflows that connect your requests, approvals and notifications, add extras from the marketplace, or join the agency and reseller programs.',
    },
    points: [
      {
        icon: 'workflow',
        title: { ar: 'سير عمل', en: 'Workflows' },
        text: {
          ar: 'اربط الأحداث بالإجراءات، وراجع كل خطوة قبل أن تُنفَّذ.',
          en: 'Connect events to actions, and review each step before it runs.',
        },
      },
      {
        icon: 'external',
        title: { ar: 'موصّلات', en: 'Connectors' },
        text: {
          ar: 'اربط أدوات عملك بنظم لتتحرك البيانات بينها.',
          en: 'Connect your business tools to Nuzm so data moves between them.',
        },
      },
      {
        icon: 'store',
        title: { ar: 'سوق نظم', en: 'Nuzm marketplace' },
        text: {
          ar: 'تصفّح إضافات جاهزة، أو انشر إضافتك وبعها.',
          en: 'Browse ready-made add-ons, or publish yours and sell it.',
        },
      },
      {
        icon: 'organization',
        title: { ar: 'وكالات وموزّعون', en: 'Agencies and resellers' },
        text: {
          ar: 'أدر عملاءك وخدماتهم من حساب واحد.',
          en: 'Manage your clients and their services from one account.',
        },
      },
    ],
    steps: [
      {
        title: { ar: 'اختر نقطة بداية', en: 'Pick a starting point' },
        text: {
          ar: 'ابدأ بقالب أو بسير عمل فارغ.',
          en: 'Start from a template or a blank workflow.',
        },
      },
      {
        title: { ar: 'اربط أدواتك', en: 'Connect your tools' },
        text: { ar: 'أضف الموصّلات التي تحتاجها.', en: 'Add the connectors you need.' },
      },
      {
        title: { ar: 'راجع وفعّل', en: 'Review and turn on' },
        text: {
          ar: 'راجع الخطوات وفعّل السير، وتابع كل تنفيذ.',
          en: 'Review the steps, turn the workflow on, and follow every run.',
        },
      },
    ],
    faq: [
      {
        q: { ar: 'هل تعمل الأتمتة دون إشرافي؟', en: 'Does automation run without me?' },
        a: {
          ar: 'أنت من يحدد ذلك. يمكن طلب موافقتك قبل أي خطوة مدفوعة أو حساسة.',
          en: 'You decide. You can require your approval before any paid or sensitive step.',
        },
      },
    ],
  },
];

export const serviceBySlug = (slug: string): ServiceContent | undefined =>
  SERVICES.find((s) => s.slug === slug);

/** Texts of the shared parts of the site (header, footer, index, section titles, buttons). */
export const SITE: Record<string, L> = {
  skip: { ar: 'تخطّ إلى المحتوى', en: 'Skip to content' },
  nav: { ar: 'التنقل الرئيسي', en: 'Main navigation' },
  services: { ar: 'الخدمات', en: 'Services' },
  allServices: { ar: 'كل الخدمات', en: 'All services' },
  login: { ar: 'تسجيل الدخول', en: 'Log in' },
  start: { ar: 'ابدأ الآن', en: 'Get started' },
  openConsole: { ar: 'افتح في لوحة التحكم', en: 'Open in your dashboard' },
  language: { ar: 'English', en: 'العربية' },
  menu: { ar: 'القائمة', en: 'Menu' },
  closeMenu: { ar: 'إغلاق القائمة', en: 'Close menu' },
  home: { ar: 'نظم، الصفحة الرئيسية', en: 'Nuzm home' },
  idxEyebrow: { ar: 'خدمات نظم', en: 'NUZM SERVICES' },
  idxTitle: {
    ar: 'كل ما يحتاجه عملك على الإنترنت، في حساب واحد.',
    en: 'Everything your business needs online, in one account.',
  },
  idxIntro: {
    ar: 'استضافة ونطاقات وخوادم وبريد وبيانات وذكاء اصطناعي. تُدار كلها بفاتورة واحدة وعرض واحد للاستهلاك، بالعربية والإنجليزية.',
    en: 'Hosting, domains, servers, email, data and AI. All managed with one bill and one view of usage, in Arabic and English.',
  },
  explore: { ar: 'اكتشف', en: 'Explore' },
  togetherTitle: { ar: 'مبنية لتعمل معًا', en: 'Built to work together' },
  together1: {
    ar: 'حساب واحد وفاتورة واحدة',
    en: 'One account, one bill',
  },
  together1Text: {
    ar: 'تُسجَّل كل خدمة مدفوعة في سجل واحد، وترى استهلاكك كاملًا في مكان واحد.',
    en: 'Every paid service lands in one record, and you see all your usage in one place.',
  },
  together2: { ar: 'عربي أولًا', en: 'Arabic first' },
  together2Text: {
    ar: 'واجهة كاملة بالعربية من اليمين إلى اليسار وبالإنجليزية، والريال السعودي والضريبة المضافة.',
    en: 'A complete right-to-left Arabic interface and English, with Saudi riyals and VAT.',
  },
  together3: { ar: 'أنت المتحكم', en: 'You stay in control' },
  together3Text: {
    ar: 'سقوف إنفاق وموافقات على الإجراءات المدفوعة أو المدمّرة، وسجل لكل تغيير.',
    en: 'Spending caps and approvals for paid or destructive actions, and a record of every change.',
  },
  whatYouGet: { ar: 'ماذا تحصل عليه', en: 'What you get' },
  howItWorks: { ar: 'كيف تبدأ', en: 'How it works' },
  related: { ar: 'خدمات أخرى من نظم', en: 'More from Nuzm' },
  faq: { ar: 'أسئلة شائعة', en: 'Common questions' },
  priceNote: {
    ar: 'تظهر الأسعار داخل حسابك للخدمة والمنطقة التي تختارها، قبل أي دفع.',
    en: 'Prices are shown inside your account for the service and region you choose, before you pay.',
  },
  ctaEyebrow: { ar: 'خطوتك التالية', en: 'YOUR NEXT CHAPTER' },
  ctaTitle: { ar: 'ابدأ بما تحتاجه اليوم.', en: 'Start with what you need today.' },
  ctaText: {
    ar: 'أنشئ حسابك، ثم أضف الخدمات واحدة بعد أخرى.',
    en: 'Create your account, then add services one at a time.',
  },
  footerTagline: {
    ar: 'ذكاء. بنية تحتية. وإمكانات أكثر.',
    en: 'Intelligence. Infrastructure. A little more possibility.',
  },
  footerServices: { ar: 'الخدمات', en: 'Services' },
  footerAccount: { ar: 'حسابك', en: 'Your account' },
  rights: { ar: 'جميع الحقوق محفوظة.', en: 'All rights reserved.' },
  privacy: { ar: 'الخصوصية', en: 'Privacy' },
};
export const site = (key: string, locale: Locale): string => {
  const v = SITE[key];
  if (!v) throw new Error(`unknown site text ${key}`);
  return v[locale];
};
