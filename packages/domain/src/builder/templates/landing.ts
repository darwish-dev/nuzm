import { L, defineTemplate } from './helpers';

/**
 * Single long landing page for a product, service or campaign. The hero button targets the `contact` section by anchor (`#contact`),
 * so the renderer must emit the section id as the element id. Prices are SAMPLE amounts the owner edits.
 */
export const landing = defineTemplate({
  id: 'landing',
  version: 1,
  category: 'landing',
  name: L('صفحة هبوط', 'Landing page'),
  description: L(
    'صفحة واحدة متكاملة لمنتج أو خدمة أو حملة: عرض القيمة، المزايا، الباقات، الآراء، الأسئلة الشائعة ونموذج التواصل.',
    'One complete page for a product, service or campaign: value proposition, benefits, plans, testimonials, FAQ and a contact form.',
  ),
  colors: { primary: '#4F46E5', accent: '#C2410C', background: '#FFFFFF', text: '#111827' },
  tokens: { radius: 'lg', spacing: 'relaxed', fontFamily: 'sans', width: 'narrow' },
  orgType: 'Organization',
  content: (k) => ({
    siteDescription: L(
      'صفحة واحدة تشرح قيمة منتجنا أو خدمتنا، وتعرض المزايا والباقات، وتتيح لك التواصل معنا بسهولة.',
      'One page that explains the value of our product or service, shows the benefits and plans, and lets you contact us with ease.',
    ),
    assets: [
      k.img(
        'ld-hero',
        L('صورة رئيسية', 'Hero image'),
        L('عرض بصري للمنتج أو الخدمة', 'A visual presentation of the product or service'),
      ),
      k.img(
        'ld-detail',
        L('لقطة تفصيلية', 'Detail shot'),
        L('لقطة قريبة توضّح تفاصيل المنتج', 'A close-up showing the product details'),
      ),
      k.img(
        'ld-g1',
        L('لقطة ١', 'Shot 1'),
        L('استخدام المنتج في الحياة اليومية', 'The product in everyday use'),
      ),
      k.img(
        'ld-g2',
        L('لقطة ٢', 'Shot 2'),
        L('المنتج من زاوية مختلفة', 'The product from a different angle'),
      ),
      k.img('ld-g3', L('لقطة ٣', 'Shot 3'), L('تفصيل من التصميم', 'A detail of the design')),
    ],
    forms: [k.form('general')],
    pages: [
      k.page(
        'home',
        [
          'ابدأ اليوم وتعرّف على الفرق',
          'Get started today and see the difference',
          'صفحة تعرض قيمة منتجنا ومزاياه وباقاته، وتتيح لك التواصل معنا مباشرة.',
          'A page showing the value of our product, its benefits and plans, with a direct way to contact us.',
        ],
        [
          k.hero('home-hero', {
            h: L('حلّ بسيط لمشكلة تتكرر كل يوم', 'A simple answer to a problem you face every day'),
            sub: L(
              'وفّر وقتك وجهدك بتجربة واضحة وسهلة من أول خطوة.',
              'Save time and effort with an experience that is clear and easy from the first step.',
            ),
            cta: L('تواصل معنا', 'Get in touch'),
            to: '#contact',
            img: 'ld-hero',
            align: 'center',
          }),
          k.features('home-benefits', L('لماذا ستحبّه', 'Why you will like it'), [
            [
              '⚡',
              'سهل البدء',
              'Easy to start',
              'تبدأ خلال دقائق دون تعقيد أو خطوات كثيرة.',
              'Start within minutes with no complexity or lengthy steps.',
            ],
            [
              '🎯',
              'مصمَّم لحاجتك',
              'Made for your need',
              'يركّز على ما يهمّك فعلًا دون زوائد.',
              'Focused on what matters to you, with nothing extra.',
            ],
            [
              '🤝',
              'دعم متاح',
              'Support at hand',
              'فريق جاهز للإجابة عن أسئلتك وقت الحاجة.',
              'A team ready to answer your questions when you need it.',
            ],
          ]),
          k.image('home-detail', 'ld-detail', L('لقطة تفصيلية', 'A closer look')),
          k.text(
            'home-story',
            L(
              'بدأنا من ملاحظة بسيطة: كثيرون يضيّعون وقتهم في حلول معقّدة لمشكلات بسيطة. فصمّمنا تجربة مباشرة تحترم وقتك وتعطيك نتيجة واضحة.',
              'We started from a simple observation: many people lose time on complicated answers to simple problems. So we designed a direct experience that respects your time and gives you a clear result.',
            ),
            L('قصتنا باختصار', 'Our story in brief'),
            { align: 'center' },
          ),
          k.gallery('home-gallery', L('لقطات من الاستخدام', 'Seen in use'), [
            ['ld-g1', 'في الحياة اليومية', 'In everyday use'],
            ['ld-g2', 'من زاوية أخرى', 'From another angle'],
            ['ld-g3', 'تفصيل من التصميم', 'A design detail'],
          ]),
          k.pricing(
            'home-plans',
            L('اختر ما يناسبك', 'Choose what suits you'),
            [
              [
                'البداية',
                'Start',
                '100',
                'شهريًا',
                'per month',
                'للتجربة والاحتياجات الأساسية.',
                'For trying it out and basic needs.',
              ],
              [
                'النمو',
                'Grow',
                '250',
                'شهريًا',
                'per month',
                'للاستخدام المنتظم مع مزايا إضافية.',
                'For regular use with extra features.',
              ],
              [
                'الأعمال',
                'Business',
                '500',
                'شهريًا',
                'per month',
                'لفرق ومؤسسات تحتاج دعمًا أوسع.',
                'For teams and organisations that need broader support.',
              ],
            ],
            { bg: 'muted' },
          ),
          k.testimonials('home-voices', L('ماذا يقول المستخدمون', 'What users say'), [
            [
              'بدأت الاستخدام بسرعة ووجدته واضحًا.',
              'I got started quickly and found it clear.',
              'مستخدم',
              'User',
            ],
            [
              'وفّر عليّ وقتًا كنت أضيّعه سابقًا.',
              'It saved me time I used to lose.',
              'مستخدمة',
              'User',
            ],
          ]),
          k.faq(
            'home-faq',
            L('أسئلة شائعة', 'Common questions'),
            [
              [
                'كيف أبدأ؟',
                'How do I get started?',
                'تواصل معنا عبر النموذج أدناه وسنرسل لك الخطوات التالية.',
                'Get in touch through the form below and we will send you the next steps.',
              ],
              [
                'هل يمكنني تغيير الباقة لاحقًا؟',
                'Can I change plans later?',
                'نعم، يمكنك الانتقال بين الباقات بحسب حاجتك.',
                'Yes, you can move between plans as your needs change.',
              ],
              [
                'كيف أصل إلى الدعم؟',
                'How do I reach support?',
                'عبر نموذج التواصل، وسيرد عليك الفريق في أقرب وقت.',
                'Through the contact form, and the team will reply as soon as possible.',
              ],
            ],
            { bg: 'muted' },
          ),
          k.contactForm(
            'contact',
            L('تواصل معنا', 'Contact us'),
            L(
              'اترك رسالتك وسنعود إليك قريبًا.',
              'Leave your message and we will get back to you soon.',
            ),
          ),
          k.map('home-map', L('موقعنا', 'Find us')),
        ],
        L('الصفحة الرئيسية', 'Home'),
      ),
    ],
  }),
});
