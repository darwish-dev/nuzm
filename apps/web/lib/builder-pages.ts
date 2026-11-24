import type { ServiceContent, L } from './site-content';
const l = (en: string, ar: string): L => ({ en, ar });
const builds = [
  {
    slug: 'flutter-ai-builder',
    name: l('Flutter AI Builder', 'منشئ تطبيقات Flutter بالذكاء الاصطناعي'),
    headline: l('Your app idea. A Flutter experience.', 'فكرة تطبيقك. بتجربة Flutter.'),
    intro: l(
      'Shape a mobile app with AI assistance: screens, navigation, and the details that make it yours.',
      'صمّم تطبيق جوال بمساعدة الذكاء الاصطناعي: شاشات وتنقّل وتفاصيل تعبّر عن فكرتك.',
    ),
    href: '/mobile/new',
    tech: 'Flutter · Dart',
    outcome: l('Mobile-first screens', 'شاشات مصممة للجوال'),
    detail: l(
      'Plan your app around touch, simple navigation, and clear journeys between screens.',
      'خطّط لتطبيقك حول اللمس والتنقّل البسيط ورحلات واضحة بين الشاشات.',
    ),
  },
  {
    slug: 'nextjs-ai-builder',
    name: l('Next.js Website AI Builder', 'منشئ مواقع Next.js بالذكاء الاصطناعي'),
    headline: l('A website that starts with your idea.', 'موقع يبدأ من فكرتك.'),
    intro: l(
      'Create a website with AI assistance, from the first page to responsive layouts and your own visual identity.',
      'أنشئ موقعًا بمساعدة الذكاء الاصطناعي، من الصفحة الأولى إلى تصميم متجاوب وهوية بصرية خاصة بك.',
    ),
    href: '/builder/projects',
    tech: 'Next.js · React',
    outcome: l('Pages that flow together', 'صفحات تنسجم معًا'),
    detail: l(
      'Shape your homepage, content sections, and navigation into a consistent website experience.',
      'نسّق الصفحة الرئيسية وأقسام المحتوى والتنقّل لتجربة موقع متكاملة.',
    ),
  },
  {
    slug: 'fullstack-ai-builder',
    name: l('Full-stack Web App AI Builder', 'منشئ تطبيقات الويب المتكاملة بالذكاء الاصطناعي'),
    headline: l('Turn a business idea into a web app.', 'حوّل فكرة عملك إلى تطبيق ويب.'),
    intro: l(
      'Plan a full-stack application with AI assistance: dashboards, connected workflows, and the screens your team needs.',
      'خطّط لتطبيق متكامل بمساعدة الذكاء الاصطناعي: لوحات تحكم وسير عمل متصل وشاشات يحتاجها فريقك.',
    ),
    href: '/builder/apps',
    tech: 'React · APIs · Data',
    outcome: l('A workspace for real work', 'مساحة عمل لإنجاز أعمالك'),
    detail: l(
      'Design dashboards, forms, and customer journeys around the way your business operates.',
      'صمّم لوحات التحكم والنماذج ورحلات العملاء وفق طريقة عمل منشأتك.',
    ),
  },
];
export const BUILDER_PAGES: ServiceContent[] = builds.map((b) => ({
  slug: b.slug,
  name: b.name,
  icon: 'code',
  image: '/images/illustrations/builder.webp',
  href: b.href,
  headline: b.headline,
  tagline: b.outcome,
  intro: b.intro,
  note: l(
    'AI-assisted development. Review generated work and test it before publishing. Framework availability depends on the project configuration.',
    'تطوير بمساعدة الذكاء الاصطناعي. راجع العمل الناتج واختبره قبل النشر. يتوقف توفر أطر العمل على إعداد المشروع.',
  ),
  points: [
    {
      icon: 'sparkle',
      title: l('Start with a conversation', 'ابدأ بمحادثة'),
      text: l(
        'Describe what you want to build, who it is for, and the experience you have in mind.',
        'صِف ما تريد بناءه ولمن تبنيه والتجربة التي تتخيلها.',
      ),
    },
    {
      icon: 'code',
      title: l(b.tech, `التقنيات: ${b.tech}`),
      text: l(
        'Choose the project setup that fits your idea and refine the generated implementation.',
        'اختر إعداد المشروع المناسب لفكرتك وحسّن التنفيذ الناتج.',
      ),
    },
    { icon: 'grid', title: b.outcome, text: b.detail },
    {
      icon: 'check',
      title: l('Review. Refine. Make it yours.', 'راجع. حسّن. اجعله خاصًا بك.'),
      text: l(
        'Preview your project, request changes, and check the result before taking the next step.',
        'عاين مشروعك واطلب التعديلات وتحقق من النتيجة قبل الخطوة التالية.',
      ),
    },
  ],
  steps: [
    {
      title: l('Describe the idea', 'صِف الفكرة'),
      text: l(
        'Tell AI about your audience, key screens, and visual direction.',
        'أخبر الذكاء الاصطناعي عن جمهورك والشاشات الأساسية والتوجه البصري.',
      ),
    },
    {
      title: l('Build and refine', 'ابنِ وحسّن'),
      text: l(
        'Work through the first version, then adjust the layout and behavior with follow-up requests.',
        'راجع النسخة الأولى ثم عدّل التصميم والسلوك بطلبات متابعة.',
      ),
    },
    {
      title: l('Test your experience', 'اختبر التجربة'),
      text: l(
        'Check the screens and flows, then use the deployment options available for your project.',
        'تحقق من الشاشات ومسارات الاستخدام ثم استخدم خيارات النشر المتاحة لمشروعك.',
      ),
    },
  ],
  faq: [
    {
      q: l('Can I change the generated design?', 'هل يمكنني تعديل التصميم الناتج؟'),
      a: l(
        'Yes. Use follow-up instructions to refine your project, and review each change in its preview.',
        'نعم. استخدم تعليمات المتابعة لتحسين مشروعك وراجع كل تعديل في المعاينة.',
      ),
    },
    {
      q: l('Is publishing automatic?', 'هل النشر تلقائي؟'),
      a: l(
        'Review and test your project first. Deployment, connected services, and any charges depend on the options available in your workspace.',
        'راجع مشروعك واختبره أولًا. يعتمد النشر والخدمات المتصلة وأي رسوم على الخيارات المتاحة في مساحة عملك.',
      ),
    },
    {
      q: l('Where can I see pricing?', 'أين أجد الأسعار؟'),
      a: l(
        'Your workspace shows the available plans, AI usage, and deployment options before you commit to a purchase.',
        'تعرض مساحة العمل الباقات المتاحة واستخدام الذكاء الاصطناعي وخيارات النشر قبل إتمام الشراء.',
      ),
    },
  ],
}));
