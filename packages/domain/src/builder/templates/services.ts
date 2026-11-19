import { L, defineTemplate } from './helpers';

/** Generic professional-services business (also the fallback for 'other'): services, packages with SAMPLE amounts, FAQ, quote request. */
export const services = defineTemplate({
  id: 'services',
  version: 1,
  category: 'services',
  name: L('شركة خدمات', 'Services business'),
  description: L(
    'موقع لشركة أو مؤسسة خدمات: عرض الخدمات، الباقات، أسئلة شائعة ونموذج لطلب عرض سعر مع الخريطة.',
    'A site for a services company: services, packages, FAQ and a quote-request form with a map.',
  ),
  colors: { primary: '#1D4ED8', accent: '#0369A1', background: '#FFFFFF', text: '#0F172A' },
  tokens: { radius: 'md', spacing: 'normal', fontFamily: 'sans', width: 'normal' },
  orgType: 'LocalBusiness',
  content: (k) => ({
    siteDescription: L(
      'خدمات احترافية بتنفيذ دقيق والتزام بالمواعيد. تعرّف على خدماتنا وباقاتنا واطلب عرض سعر.',
      'Professional services with careful delivery and reliable timing. Explore our services and packages and request a quote.',
    ),
    assets: [
      k.img(
        'sv-hero',
        L('فريق العمل', 'Our team at work'),
        L('فريق يعمل على تنفيذ خدمة لعميل', 'A team carrying out a service for a client'),
      ),
      k.img(
        'sv-team',
        L('الفريق', 'The team'),
        L('أعضاء الفريق في اجتماع عمل', 'Team members in a working meeting'),
      ),
      k.img(
        'sv-work',
        L('من أعمالنا', 'Our work'),
        L('مثال على عمل منجز', 'An example of completed work'),
      ),
    ],
    forms: [k.form('general')],
    pages: [
      k.page(
        'home',
        [
          'خدمات موثوقة بتنفيذ متقن',
          'Reliable services, carefully delivered',
          'تعرّف على خدماتنا وباقاتنا، واطلب عرض سعر بسهولة من فريق يلتزم بالمواعيد.',
          'Explore our services and packages and request a quote easily from a team that keeps its deadlines.',
        ],
        [
          k.hero('home-hero', {
            h: L('خدمات موثوقة بتنفيذ متقن', 'Reliable services, carefully delivered'),
            sub: L(
              'نفهم احتياجك أولًا، ثم ننفّذ بخطوات واضحة وتواصل مستمر حتى الانتهاء.',
              'We understand your need first, then deliver in clear steps with steady communication until the job is done.',
            ),
            cta: L('اطلب عرض سعر', 'Request a quote'),
            to: 'contact',
            img: 'sv-hero',
          }),
          k.features('home-why', L('لماذا نحن', 'Why choose us'), [
            [
              '🎯',
              'وضوح في النطاق',
              'A clear scope',
              'نتفق معك على المطلوب والمدة قبل أن نبدأ.',
              'We agree the work and the timeline with you before we start.',
            ],
            [
              '⏱️',
              'التزام بالمواعيد',
              'Reliable timing',
              'نخطّط للعمل ونتابعه لنسلّمه في وقته.',
              'We plan the work and follow it so it is delivered on time.',
            ],
            [
              '💬',
              'تواصل مستمر',
              'Steady communication',
              'نطلعك على سير العمل ونجيب عن أسئلتك.',
              'We keep you informed on progress and answer your questions.',
            ],
            [
              '🛡️',
              'متابعة الجودة',
              'Quality follow-up',
              'نراجع النتيجة معك قبل الإغلاق للتأكد من رضاك.',
              'We review the result with you before closing to make sure you are satisfied.',
            ],
          ]),
          k.testimonials(
            'home-voices',
            L('آراء العملاء', 'What clients say'),
            [
              [
                'تنفيذ منظم وتواصل واضح من البداية للنهاية.',
                'Organised delivery and clear communication from start to finish.',
                'عميل',
                'Client',
              ],
              [
                'فريق محترف ويلتزم بما يتفق عليه.',
                'A professional team that sticks to what it agrees.',
                'عميل',
                'Client',
              ],
            ],
            { bg: 'muted' },
          ),
          // SAMPLE figures: the owner replaces them with the business's own numbers
          k.stats('home-stats', L('بالأرقام', 'In numbers'), [
            ['00+', 'سنة خبرة (عدّلها)', 'Years of experience (edit)'],
            ['000', 'مشروع منجز (عدّلها)', 'Projects completed (edit)'],
            ['000', 'عميل (عدّلها)', 'Clients (edit)'],
          ]),
          k.steps('home-steps', L('كيف نعمل', 'How we work'), [
            [
              'اطلب',
              'Request',
              'أرسل لنا طلبك ببعض التفاصيل',
              'Send us your request with a few details',
            ],
            [
              'نتفق',
              'Agree',
              'نراجع احتياجك ونقدّم عرضًا واضحًا',
              'We review your need and give a clear offer',
            ],
            [
              'ننفّذ',
              'Deliver',
              'ننجز العمل بالمواعيد المتفق عليها',
              'We do the work on the agreed schedule',
            ],
          ]),
          k.cta('home-cta', {
            h: L('جاهزون لخدمتك', 'Ready to help you'),
            sub: L('اطلب عرض سعر وسنرد عليك سريعًا', 'Request a quote and we will reply quickly'),
            label: L('اطلب عرض سعر', 'Request a quote'),
            to: 'contact',
          }),
        ],
      ),
      k.page(
        'about',
        [
          'من نحن',
          'About us',
          'تعرّف على فريقنا وقيمنا وطريقة عملنا في خدمة عملائنا.',
          'Learn about our team, our values and how we serve our clients.',
        ],
        [
          k.text(
            'about-story',
            L(
              'نحن فريق يجمع الخبرة والالتزام. نعمل مع عملائنا كشركاء، ونحرص على أن تكون كل خطوة واضحة ومفهومة، وأن تكون النتيجة النهائية بمستوى توقعاتهم.',
              'We are a team that combines experience and commitment. We work with clients as partners and make sure every step is clear and understood, and that the final result meets their expectations.',
            ),
            L('عن شركتنا', 'About our company'),
          ),
          k.image('about-team', 'sv-team', L('فريق العمل', 'Our team')),
          k.features('about-values', L('قيمنا', 'Our values'), [
            [
              '🤝',
              'الشراكة',
              'Partnership',
              'نعمل بجانبك لا نيابةً عنك فقط.',
              'We work alongside you, not just on your behalf.',
            ],
            [
              '🔎',
              'الشفافية',
              'Transparency',
              'نوضّح لك ما سنفعله ولماذا.',
              'We explain what we will do and why.',
            ],
            [
              '📈',
              'التحسين المستمر',
              'Continuous improvement',
              'نتعلم من كل مشروع لنقدّم الأفضل في القادم.',
              'We learn from every project to deliver better on the next one.',
            ],
          ]),
        ],
      ),
      k.page(
        'services',
        [
          'خدماتنا',
          'Our services',
          'نظرة على خدماتنا وخطوات التنفيذ من الطلب حتى التسليم.',
          'An overview of our services and the delivery steps from request to handover.',
        ],
        [
          k.features('services-list', L('ما نقدّمه', 'What we offer'), [
            [
              '🛠️',
              'التنفيذ',
              'Delivery',
              'تنفيذ الخدمة المطلوبة بحسب النطاق المتفق عليه.',
              'Carrying out the requested service within the agreed scope.',
            ],
            [
              '🧭',
              'الاستشارات',
              'Consulting',
              'نصائح عملية تساعدك على اتخاذ قرار مناسب.',
              'Practical advice that helps you make the right decision.',
            ],
            [
              '🔧',
              'الصيانة والمتابعة',
              'Maintenance and follow-up',
              'متابعة بعد التسليم لضمان استمرار الجودة.',
              'Follow-up after delivery to keep the quality going.',
            ],
            [
              '📞',
              'الدعم',
              'Support',
              'قناة واضحة للإجابة عن أسئلتك بعد التسليم.',
              'A clear channel to answer your questions after delivery.',
            ],
          ]),
          k.text(
            'services-process',
            L(
              'نبدأ بفهم احتياجك، ثم نقدّم عرضًا واضحًا، وبعد الموافقة ننفّذ ونتابع ونسلّم. في كل خطوة ستعرف ما الذي يحدث وما الذي سيأتي بعده.',
              'We begin by understanding your need, then give a clear proposal and, once approved, deliver, follow up and hand over. At every step you will know what is happening and what comes next.',
            ),
            L('خطوات العمل', 'How it works'),
            { bg: 'muted' },
          ),
          k.image(
            'services-work',
            'sv-work',
            L('مثال على عمل منجز', 'An example of completed work'),
          ),
        ],
      ),
      k.page(
        'pricing',
        [
          'الباقات والأسعار',
          'Packages and pricing',
          'اطّلع على باقاتنا وأجوبة الأسئلة الشائعة حول الأسعار والتعاقد.',
          'See our packages and answers to common questions about pricing and engagement.',
        ],
        [
          k.pricing('pricing-plans', L('الباقات', 'Packages'), [
            [
              'الأساسية',
              'Basic',
              '100',
              'شهريًا',
              'per month',
              'للاحتياجات المحدودة والبداية السلسة.',
              'For limited needs and a smooth start.',
            ],
            [
              'المتقدمة',
              'Standard',
              '250',
              'شهريًا',
              'per month',
              'لمن يحتاج متابعة أوسع ودعمًا أسرع.',
              'For those who need broader follow-up and faster support.',
            ],
            [
              'الشاملة',
              'Premium',
              '500',
              'شهريًا',
              'per month',
              'خدمة كاملة مع أولوية في الدعم.',
              'A complete service with priority support.',
            ],
          ]),
          k.faq(
            'pricing-faq',
            L('أسئلة عن الأسعار', 'Pricing questions'),
            [
              [
                'هل يمكن تخصيص الباقة؟',
                'Can a package be tailored?',
                'نعم، يمكن تعديل الباقة بحسب احتياجك. تواصل معنا لنرسل لك عرضًا مناسبًا.',
                'Yes, a package can be adjusted to your needs. Contact us and we will send you a suitable quote.',
              ],
              [
                'هل توجد رسوم إضافية؟',
                'Are there extra fees?',
                'نوضّح كل التكاليف في العرض قبل الموافقة، دون مفاجآت لاحقة.',
                'We set out every cost in the quote before you approve, with no later surprises.',
              ],
              [
                'كيف أبدأ؟',
                'How do I get started?',
                'أرسل لنا طلب عرض سعر من صفحة التواصل وسنعود إليك قريبًا.',
                'Send us a quote request from the contact page and we will get back to you soon.',
              ],
            ],
            { bg: 'muted' },
          ),
        ],
      ),
      k.page(
        'contact',
        [
          'اطلب عرض سعر',
          'Request a quote',
          'أرسل طلبك وسنرد عليك بعرض واضح، وتعرّف على موقعنا على الخريطة.',
          'Send your request and we will reply with a clear quote, and find our location on the map.',
        ],
        [
          k.text(
            'contact-intro',
            L(
              'أخبرنا بما تحتاجه وبالمدة المناسبة لك، وسنعود إليك بعرض واضح.',
              'Tell us what you need and the timing that suits you, and we will come back with a clear quote.',
            ),
            L('نسعد بخدمتك', 'We would be glad to help'),
          ),
          k.contactForm('contact-form', L('طلب عرض سعر', 'Quote request')),
          k.map('contact-map', L('موقعنا', 'Find us'), { bg: 'muted' }),
        ],
      ),
    ],
  }),
});
