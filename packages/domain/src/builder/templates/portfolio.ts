import { L, defineTemplate } from './helpers';

/** Portfolio for a creative professional or studio: work gallery, service packages (sample amounts), process FAQ. */
export const portfolio = defineTemplate({
  id: 'portfolio',
  version: 2,
  category: 'portfolio',
  name: L('معرض أعمال', 'Portfolio'),
  description: L(
    'موقع لمصمم أو مصوّر أو استوديو: معرض أعمال، خدمات وباقات، نبذة شخصية ونموذج تواصل.',
    'A site for a designer, photographer or studio: work gallery, services and packages, an about page and a contact form.',
  ),
  colors: { primary: '#111827', accent: '#B45309', background: '#FAFAFA', text: '#111827' },
  tokens: { radius: 'sm', spacing: 'relaxed', fontFamily: 'sans', width: 'wide' },
  orgType: 'Organization',
  content: (k) => ({
    siteDescription: L(
      'معرض أعمال يعرض مشاريعنا وخدماتنا بوضوح. تصفّح الأعمال وتعرّف على طريقة عملنا وتواصل معنا لبدء مشروعك.',
      'A portfolio that shows our projects and services clearly. Browse the work, see how we work and get in touch to start your project.',
    ),
    assets: [
      k.img(
        'pf-hero',
        L('عمل مختار', 'Featured work'),
        L('عمل مختار من المعرض', 'A featured piece from the portfolio'),
      ),
      k.img('pf-p1', L('مشروع ١', 'Project 1'), L('مشروع هوية بصرية', 'A brand identity project')),
      k.img('pf-p2', L('مشروع ٢', 'Project 2'), L('مشروع تصوير', 'A photography project')),
      k.img(
        'pf-p3',
        L('مشروع ٣', 'Project 3'),
        L('مشروع تصميم واجهات', 'An interface design project'),
      ),
      k.img('pf-p4', L('مشروع ٤', 'Project 4'), L('مشروع مطبوعات', 'A print project')),
      k.img('pf-p5', L('مشروع ٥', 'Project 5'), L('مشروع تغليف', 'A packaging project')),
      k.img(
        'pf-me',
        L('خلف الكواليس', 'Behind the scenes'),
        L('مساحة العمل أثناء تنفيذ مشروع', 'The workspace during a project'),
      ),
    ],
    forms: [k.form('general')],
    pages: [
      k.page(
        'home',
        [
          'أعمال تحكي قصة',
          'Work that tells a story',
          'معرض أعمال يجمع مشاريعنا وخدماتنا. شاهد الأعمال وتواصل معنا لبدء مشروعك.',
          'A portfolio of our projects and services. See the work and get in touch to start your project.',
        ],
        [
          k.hero('home-hero', {
            h: L('أعمال تحكي قصة', 'Work that tells a story'),
            sub: L(
              'نصمّم ونصوّر وننفّذ بعناية، لتصل رسالتك بوضوح وجمال.',
              'We design, shoot and deliver with care, so your message arrives clearly and beautifully.',
            ),
            cta: L('شاهد الأعمال', 'See the work'),
            to: 'projects',
            img: 'pf-hero',
            align: 'start',
          }),
          k.gallery('home-selected', L('أعمال مختارة', 'Selected work'), [
            ['pf-p1', 'هوية بصرية', 'Brand identity'],
            ['pf-p2', 'تصوير', 'Photography'],
            ['pf-p3', 'تصميم واجهات', 'Interface design'],
          ]),
          k.testimonials(
            'home-voices',
            L('ماذا يقول العملاء', 'What clients say'),
            [
              [
                'تعاون سلس ونتيجة تعكس ما كنا نريده.',
                'A smooth collaboration and a result that reflects what we wanted.',
                'عميل',
                'Client',
              ],
              [
                'التزام بالمواعيد واهتمام بالتفاصيل.',
                'Reliable deadlines and attention to detail.',
                'عميل',
                'Client',
              ],
            ],
            { bg: 'muted' },
          ),
          k.cta('home-cta', {
            h: L('لديك مشروع في بالك؟', 'Have a project in mind?'),
            sub: L(
              'شاهد أعمالنا ثم لنتحدث عن مشروعك',
              'See our work, then let us talk about yours',
            ),
            label: L('شاهد المشاريع', 'See the projects'),
            to: 'projects',
          }),
        ],
      ),
      k.page(
        'projects',
        [
          'الأعمال',
          'Work',
          'استعرض مجموعة من أعمالنا في الهوية البصرية والتصوير وتصميم الواجهات والمطبوعات.',
          'Browse a selection of our work in brand identity, photography, interface design and print.',
        ],
        [
          k.text(
            'projects-intro',
            L(
              'هذه مجموعة مختارة من مشاريعنا. لكل مشروع قصة وتحدٍّ وحل، ويسعدنا أن نشاركك التفاصيل عند التواصل.',
              'This is a selection of our projects. Each has a story, a challenge and a solution, and we are happy to share the details when you get in touch.',
            ),
            L('مشاريع مختارة', 'Selected projects'),
          ),
          k.gallery('projects-grid', undefined, [
            ['pf-p1', 'هوية بصرية', 'Brand identity'],
            ['pf-p2', 'تصوير', 'Photography'],
            ['pf-p3', 'تصميم واجهات', 'Interface design'],
            ['pf-p4', 'مطبوعات', 'Print'],
            ['pf-p5', 'تغليف', 'Packaging'],
            ['pf-hero', 'عمل مختار', 'Featured work'],
          ]),
        ],
      ),
      k.page(
        'services',
        [
          'الخدمات والباقات',
          'Services and packages',
          'تعرّف على خدماتنا وباقات العمل، ويمكن تخصيص أي باقة بحسب مشروعك.',
          'Explore our services and work packages. Any package can be tailored to your project.',
        ],
        [
          k.features('services-list', L('ما نقدّمه', 'What we offer'), [
            [
              '🎨',
              'هوية بصرية',
              'Brand identity',
              'شعار وألوان وخطوط تعبّر عن نشاطك.',
              'A logo, colours and typography that express your business.',
            ],
            [
              '📷',
              'تصوير',
              'Photography',
              'صور تُبرز منتجاتك أو مكانك أو فريقك.',
              'Images that showcase your products, space or team.',
            ],
            [
              '🖥️',
              'تصميم واجهات',
              'Interface design',
              'تصميم صفحات وتطبيقات سهلة الاستخدام.',
              'Design of easy-to-use pages and apps.',
            ],
            [
              '📦',
              'تغليف ومطبوعات',
              'Packaging and print',
              'مواد مطبوعة وتغليف جاهز للتنفيذ.',
              'Print materials and packaging ready for production.',
            ],
          ]),
          k.pricing(
            'services-packages',
            L('باقات العمل', 'Work packages'),
            [
              [
                'الأساسية',
                'Starter',
                '300',
                'للمشروع',
                'per project',
                'مناسبة للمشاريع الصغيرة ذات النطاق المحدد.',
                'Suited to small projects with a clear scope.',
              ],
              [
                'المتقدمة',
                'Standard',
                '600',
                'للمشروع',
                'per project',
                'تشمل جولات مراجعة إضافية وتسليمًا بصيغ متعددة.',
                'Includes extra revision rounds and delivery in several formats.',
              ],
              [
                'المخصّصة',
                'Custom',
                '1200',
                'للمشروع',
                'per project',
                'نبنيها معك بحسب حجم المشروع واحتياجاته.',
                'Built with you around the size and needs of the project.',
              ],
            ],
            { bg: 'muted' },
          ),
        ],
      ),
      k.page(
        'about',
        [
          'نبذة عنّا',
          'About us',
          'تعرّف على طريقة عملنا وكيف نحوّل فكرتك إلى نتيجة ملموسة.',
          'Learn how we work and how we turn your idea into a tangible result.',
        ],
        [
          k.text(
            'about-story',
            L(
              'نؤمن أن العمل الجيد يبدأ بالإصغاء. نفهم هدفك وجمهورك أولًا، ثم نقترح حلًّا بصريًا واضحًا ونطوّره معك خطوة بخطوة حتى التسليم.',
              'We believe good work starts with listening. We understand your goal and audience first, then propose a clear visual solution and develop it with you step by step until delivery.',
            ),
            L('كيف نعمل', 'How we work'),
          ),
          k.image('about-studio', 'pf-me', L('مساحة العمل', 'The workspace')),
          k.faq(
            'about-faq',
            L('أسئلة عن طريقة العمل', 'Questions about the process'),
            [
              [
                'كيف يبدأ المشروع؟',
                'How does a project start?',
                'نبدأ بمحادثة قصيرة لفهم هدفك ونطاق العمل، ثم نرسل لك مقترحًا واضحًا.',
                'We begin with a short conversation to understand your goal and the scope, then send you a clear proposal.',
              ],
              [
                'كم جولة مراجعة تشمل الباقة؟',
                'How many revision rounds does a package include?',
                'يُحدَّد عدد الجولات في المقترح قبل البدء حتى يكون كل شيء واضحًا.',
                'The number of rounds is set in the proposal before we begin, so everything is clear.',
              ],
            ],
            { bg: 'muted' },
          ),
        ],
      ),
      k.page(
        'contact',
        [
          'ابدأ مشروعك',
          'Start your project',
          'أخبرنا عن مشروعك وميزانيتك والموعد المطلوب، وسنعود إليك لمناقشة التفاصيل.',
          'Tell us about your project and we will get back to you to discuss the details.',
        ],
        [
          k.text(
            'contact-intro',
            L(
              'احكِ لنا عن فكرتك وموعد التسليم المناسب لك، وسنرد عليك بالخطوة التالية.',
              'Tell us about your idea and your preferred delivery date, and we will reply with the next step.',
            ),
            L('لنتحدث عن مشروعك', 'Let’s talk about your project'),
          ),
          k.contactForm('contact-form', L('أرسل رسالة', 'Send a message')),
        ],
      ),
    ],
  }),
});
