import { L, defineTemplate } from './helpers';

/** School / academy / training centre: programs, fees (SAMPLE amounts), registration FAQ and inquiry form. No accreditation or outcome claims. */
export const education = defineTemplate({
  id: 'education',
  version: 1,
  category: 'education',
  name: L('مدرسة أو أكاديمية', 'School or academy'),
  description: L(
    'موقع لمدرسة أو أكاديمية أو مركز تدريب: البرامج والرسوم، أسئلة التسجيل ونموذج استفسار مع الخريطة.',
    'A site for a school, academy or training centre: programs and fees, registration FAQ and an inquiry form with a map.',
  ),
  colors: { primary: '#0E7490', accent: '#B45309', background: '#F7FCFE', text: '#0C2A33' },
  tokens: { radius: 'lg', spacing: 'normal', fontFamily: 'sans', width: 'normal' },
  orgType: 'EducationalOrganization',
  content: (k) => ({
    siteDescription: L(
      'بيئة تعليمية تشجّع الفضول وتبني المهارات. تعرّف على البرامج والرسوم وطريقة التسجيل وتواصل معنا.',
      'A learning environment that encourages curiosity and builds skills. Explore the programs, fees and how to register, and get in touch.',
    ),
    assets: [
      k.img(
        'ed-hero',
        L('الفصل الدراسي', 'Classroom'),
        L(
          'فصل دراسي منظم يتفاعل فيه الطلاب مع المعلم',
          'A tidy classroom where students engage with their teacher',
        ),
      ),
      k.img(
        'ed-class',
        L('نشاط جماعي', 'Group activity'),
        L('طلاب يعملون معًا في نشاط جماعي', 'Students working together on a group activity'),
      ),
      k.img(
        'ed-lab',
        L('قاعة التدريب', 'Training room'),
        L('قاعة تدريب مجهزة بأجهزة وطاولات', 'A training room equipped with computers and desks'),
      ),
    ],
    forms: [k.form('registration')],
    pages: [
      k.page(
        'home',
        [
          'نتعلّم اليوم لنبني الغد',
          'Learning today to build tomorrow',
          'تعرّف على برامجنا التعليمية والرسوم وخطوات التسجيل، وتواصل معنا لأي استفسار.',
          'Explore our learning programs, fees and registration steps, and contact us with any question.',
        ],
        [
          k.hero('home-hero', {
            h: L('نتعلّم اليوم لنبني الغد', 'Learning today to build tomorrow'),
            sub: L(
              'بيئة تعليمية تشجّع الفضول وتبني المهارات خطوة بخطوة.',
              'A learning environment that encourages curiosity and builds skills step by step.',
            ),
            cta: L('تعرّف على البرامج', 'Explore the programs'),
            to: 'programs',
            img: 'ed-hero',
          }),
          k.features('home-why', L('ما يميّز تجربتنا', 'What sets our experience apart'), [
            [
              '📚',
              'مناهج منظمة',
              'Structured curricula',
              'خطط تعلّم واضحة تتدرّج بحسب المستوى.',
              'Clear learning plans that progress with each level.',
            ],
            [
              '🧑‍🏫',
              'معلمون ملتزمون',
              'Dedicated teachers',
              'فريق يتابع تقدّم كل متعلّم ويدعمه.',
              'A team that follows each learner’s progress and supports it.',
            ],
            [
              '🤲',
              'تواصل مع الأسرة',
              'Family communication',
              'نبقي أولياء الأمور على اطلاع بمستوى أبنائهم.',
              'We keep parents informed about their children’s progress.',
            ],
          ]),
          k.testimonials(
            'home-voices',
            L('آراء المجتمع التعليمي', 'What our community says'),
            [
              [
                'بيئة محفّزة ومعلمون يهتمون بالتفاصيل.',
                'A motivating environment and teachers who care about the details.',
                'ولي أمر',
                'Parent',
              ],
              [
                'شرح واضح وتمارين تساعدني على الفهم.',
                'Clear explanations and exercises that help me understand.',
                'طالب',
                'Student',
              ],
            ],
            { bg: 'muted' },
          ),
        ],
      ),
      k.page(
        'programs',
        [
          'البرامج والرسوم',
          'Programs and fees',
          'تعرّف على برامجنا التعليمية والتدريبية والرسوم المتاحة لكل مسار.',
          'Explore our learning and training programs and the fees for each track.',
        ],
        [
          k.text(
            'programs-intro',
            L(
              'نقدّم مسارات متنوعة تناسب أعمارًا ومستويات مختلفة. للمساعدة في اختيار البرنامج المناسب تواصل معنا وسنرشدك.',
              'We offer varied tracks that suit different ages and levels. To help you choose the right program, contact us and we will guide you.',
            ),
            L('مسارات التعلّم', 'Learning tracks'),
          ),
          k.image('programs-room', 'ed-lab', L('قاعة التدريب', 'A training room')),
          k.features('programs-list', undefined, [
            [
              '🌟',
              'البرنامج الأساسي',
              'Core program',
              'مسار تعليمي منتظم على مدار العام الدراسي.',
              'A regular learning track across the school year.',
            ],
            [
              '🛠️',
              'برنامج المهارات',
              'Skills program',
              'تدريب عملي على مهارات يحتاجها المتعلّم.',
              'Hands-on training in skills learners need.',
            ],
            [
              '⚡',
              'الدورات القصيرة',
              'Short courses',
              'دورات مركزة لفترات قصيرة في موضوعات محددة.',
              'Focused short-term courses on specific topics.',
            ],
            [
              '🗓️',
              'ورش نهاية الأسبوع',
              'Weekend workshops',
              'ورش تفاعلية تناسب من لديه وقت محدود.',
              'Interactive workshops for those with limited time.',
            ],
          ]),
          k.pricing(
            'programs-fees',
            L('الرسوم', 'Fees'),
            [
              [
                'ورشة',
                'Workshop',
                '150',
                'للورشة',
                'per workshop',
                'جلسة تدريبية واحدة في موضوع محدد.',
                'A single training session on a specific topic.',
              ],
              [
                'دورة',
                'Course',
                '600',
                'للدورة',
                'per course',
                'سلسلة جلسات ضمن مسار محدد.',
                'A series of sessions within a defined track.',
              ],
              [
                'برنامج',
                'Program',
                '2400',
                'للفصل',
                'per term',
                'مسار كامل لفصل دراسي مع متابعة.',
                'A full track for a term with follow-up.',
              ],
            ],
            { bg: 'muted' },
          ),
        ],
      ),
      k.page(
        'about',
        [
          'عن المؤسسة التعليمية',
          'About our institution',
          'تعرّف على رؤيتنا ورسالتنا وقيمنا التعليمية.',
          'Learn about our vision, mission and educational values.',
        ],
        [
          k.text(
            'about-story',
            L(
              'نؤمن أن لكل متعلّم طريقته في الفهم، لذلك نصمّم تجربة تعليمية مرنة تراعي الفروق وتدعم التقدّم. نعمل مع الأسرة كشريك أساسي في رحلة التعلّم.',
              'We believe every learner has their own way of understanding, so we design a flexible learning experience that respects differences and supports progress. We work with families as key partners in the learning journey.',
            ),
            L('رسالتنا', 'Our mission'),
          ),
          k.image('about-class', 'ed-class', L('نشاط تعليمي جماعي', 'A group learning activity')),
          k.features('about-values', L('قيمنا التعليمية', 'Our educational values'), [
            [
              '🔭',
              'الفضول',
              'Curiosity',
              'نشجّع الأسئلة ونكافئ حب الاستكشاف.',
              'We encourage questions and reward the love of exploring.',
            ],
            [
              '🤝',
              'التعاون',
              'Collaboration',
              'نتعلّم معًا ونحترم آراء بعضنا.',
              'We learn together and respect each other’s views.',
            ],
            [
              '🏅',
              'المثابرة',
              'Perseverance',
              'نتعلّم من المحاولة ونواصل التحسّن.',
              'We learn from trying and keep improving.',
            ],
          ]),
        ],
      ),
      k.page(
        'faq',
        [
          'أسئلة التسجيل',
          'Registration questions',
          'إجابات عن الأسئلة الشائعة حول التسجيل والجداول والمتطلبات.',
          'Answers to common questions about registration, schedules and requirements.',
        ],
        [
          k.faq('faq-main', L('الأسئلة الشائعة', 'Frequently asked questions'), [
            [
              'كيف أسجّل؟',
              'How do I register?',
              'أرسل لنا طلبك من صفحة التواصل مع ذكر البرنامج المطلوب، وسيرد عليك فريق التسجيل بالخطوات.',
              'Send your request from the contact page naming the program you want and the registration team will reply with the steps.',
            ],
            [
              'ما المستندات المطلوبة؟',
              'Which documents are required?',
              'تختلف المستندات بحسب البرنامج، وسنوضحها لك عند التواصل.',
              'Documents vary by program and we will explain them when you get in touch.',
            ],
            [
              'هل تتوفر جداول مرنة؟',
              'Are flexible schedules available?',
              'تتوفر بعض البرامج بأوقات متعددة، اسأل فريق التسجيل عن المتاح.',
              'Some programs run at several times. Ask the registration team what is available.',
            ],
            [
              'هل يمكن زيارة المكان قبل التسجيل؟',
              'Can I visit before registering?',
              'نرحّب بزيارتك بعد تنسيق موعد مسبق عبر صفحة التواصل.',
              'We welcome your visit after arranging a time in advance through the contact page.',
            ],
          ]),
        ],
      ),
      k.page(
        'contact',
        [
          'تواصل للتسجيل والاستفسار',
          'Contact us to register or ask',
          'أرسل استفسارك عن البرامج أو التسجيل، وتعرّف على موقعنا.',
          'Send your question about programs or registration, and find our location.',
        ],
        [
          k.text(
            'contact-intro',
            L(
              'يسعدنا الإجابة عن أسئلتك حول البرامج والتسجيل. اكتب لنا وسنرد عليك قريبًا.',
              'We are glad to answer your questions about programs and registration. Write to us and we will reply soon.',
            ),
            L('نحن بانتظارك', 'We are waiting to hear from you'),
          ),
          k.contactForm(
            'contact-form',
            L('استفسار أو طلب تسجيل', 'Inquiry or registration request'),
          ),
          k.map('contact-map', L('موقعنا', 'Find us'), { bg: 'muted' }),
        ],
      ),
    ],
  }),
});
