import { L, defineTemplate } from './helpers';

/** Retail / shop showcase: product gallery, shipping and return FAQ. No prices, no stock or delivery-time promises. */
export const retail = defineTemplate({
  id: 'retail',
  version: 1,
  category: 'retail',
  name: L('متجر', 'Shop or store'),
  description: L(
    'موقع لمتجر أو محل: عرض المنتجات، أسئلة التوصيل والاستبدال، ونموذج للاستفسار مع موقع المتجر.',
    'A site for a shop or store: product showcase, shipping and returns FAQ, and an inquiry form with the store location.',
  ),
  colors: { primary: '#6D28D9', accent: '#BE185D', background: '#FFFFFF', text: '#1F1B2E' },
  tokens: { radius: 'lg', spacing: 'normal', fontFamily: 'sans', width: 'wide' },
  orgType: 'Store',
  content: (k) => ({
    siteDescription: L(
      'منتجات مختارة بعناية مع خدمة واضحة للتوصيل والاستبدال. تصفّح المنتجات وتواصل معنا لأي استفسار.',
      'Carefully chosen products with clear delivery and returns. Browse the products and contact us with any question.',
    ),
    assets: [
      k.img(
        'rt-hero',
        L('واجهة المتجر', 'Storefront'),
        L('عرض أنيق لمنتجات المتجر', 'A tidy display of the store’s products'),
      ),
      k.img(
        'rt-p1',
        L('منتج ١', 'Product 1'),
        L('منتج من مجموعة الوصول الحديث', 'A product from the new arrivals'),
      ),
      k.img(
        'rt-p2',
        L('منتج ٢', 'Product 2'),
        L('منتج من المجموعة الأكثر طلبًا', 'A product from the best sellers'),
      ),
      k.img(
        'rt-p3',
        L('منتج ٣', 'Product 3'),
        L('منتج مناسب للهدايا', 'A product suited for gifts'),
      ),
      k.img(
        'rt-p4',
        L('منتج ٤', 'Product 4'),
        L('منتج من مجموعة العروض الموسمية', 'A product from the seasonal selection'),
      ),
      k.img(
        'rt-store',
        L('داخل المتجر', 'Inside the store'),
        L('داخل المتجر بأرفف منظمة', 'Inside the store with neatly arranged shelves'),
      ),
    ],
    forms: [k.form('order')],
    pages: [
      k.page(
        'home',
        [
          'متجر بمنتجات مختارة',
          'A store of carefully chosen products',
          'تصفّح منتجاتنا المختارة بعناية، واطّلع على التوصيل والاستبدال، وتواصل معنا بسهولة.',
          'Browse our carefully chosen products, read about delivery and returns, and get in touch with ease.',
        ],
        [
          k.hero('home-hero', {
            h: L('منتجات مختارة لك بعناية', 'Products picked for you with care'),
            sub: L(
              'تشكيلة متجددة وخدمة واضحة، من الاختيار حتى وصول الطلب.',
              'A refreshed selection and clear service, from choosing to receiving your order.',
            ),
            cta: L('تصفّح المنتجات', 'Browse products'),
            to: 'products',
            img: 'rt-hero',
          }),
          k.features('home-promises', L('وعودنا لك', 'Our promises to you'), [
            [
              '🚚',
              'توصيل واضح',
              'Clear delivery',
              'تعرف تكلفة التوصيل ومدته قبل إتمام طلبك.',
              'You know the delivery cost and time before you complete your order.',
            ],
            [
              '🔁',
              'استبدال بسيط',
              'Simple exchanges',
              'سياسة استبدال واضحة ومكتوبة تحميك كعميل.',
              'A clear, written exchange policy that protects you as a customer.',
            ],
            [
              '💬',
              'دعم سريع',
              'Quick support',
              'فريق جاهز للإجابة عن أسئلتك عن المنتجات والطلبات.',
              'A team ready to answer your questions about products and orders.',
            ],
          ]),
          k.testimonials(
            'home-voices',
            L('آراء عملائنا', 'What customers say'),
            [
              [
                'منتجات مرتبة وتعامل محترم.',
                'Well-presented products and respectful service.',
                'عميل',
                'Customer',
              ],
              [
                'كان الطلب سهلًا والتواصل واضحًا.',
                'Ordering was easy and communication was clear.',
                'عميلة',
                'Customer',
              ],
            ],
            { bg: 'muted' },
          ),
          k.cta('home-cta', {
            h: L('تسوّق ما يعجبك اليوم', 'Shop what you love today'),
            sub: L(
              'تصفّح منتجاتنا واختر الأنسب لك',
              'Browse our products and choose what suits you',
            ),
            label: L('تصفّح المنتجات', 'Browse products'),
            to: 'products',
          }),
        ],
      ),
      k.page(
        'products',
        [
          'منتجاتنا',
          'Our products',
          'استعرض أقسام المتجر ومنتجاته المميزة، وتواصل معنا للاستفسار عن أي منتج.',
          'Browse the store’s categories and featured products, and contact us about any product.',
        ],
        [
          k.text(
            'products-intro',
            L(
              'نحدّث تشكيلتنا باستمرار. للاستفسار عن توفّر منتج أو تفاصيله، أرسل لنا رسالة وسنرد عليك.',
              'We refresh our selection regularly. To ask about a product’s availability or details, send us a message and we will reply.',
            ),
            L('تشكيلة المتجر', 'The store selection'),
          ),
          k.gallery('products-grid', L('منتجات مميزة', 'Featured products'), [
            ['rt-p1', 'وصل حديثًا', 'New arrival'],
            ['rt-p2', 'الأكثر طلبًا', 'Best seller'],
            ['rt-p3', 'مناسب للهدايا', 'A good gift'],
            ['rt-p4', 'اختيار الموسم', 'Seasonal pick'],
          ]),
          k.features('products-categories', L('تسوّق حسب الفئة', 'Shop by category'), [
            [
              '🆕',
              'وصل حديثًا',
              'New arrivals',
              'أحدث ما أضفناه إلى المتجر.',
              'The latest additions to the store.',
            ],
            [
              '⭐',
              'الأكثر طلبًا',
              'Best sellers',
              'المنتجات التي يعود إليها عملاؤنا.',
              'The products our customers come back to.',
            ],
            [
              '🎁',
              'الهدايا',
              'Gifts',
              'أفكار مناسبة للمناسبات والإهداء.',
              'Ideas for occasions and gifting.',
            ],
          ]),
        ],
      ),
      k.page(
        'about',
        [
          'عن المتجر',
          'About the store',
          'تعرّف على قصة المتجر وكيف نختار منتجاتنا ونخدم عملاءنا.',
          'Learn the store’s story and how we choose our products and serve our customers.',
        ],
        [
          k.text(
            'about-story',
            L(
              'بدأنا بفكرة بسيطة: أن يجد العميل منتجات يثق بها بدون عناء. نختار ما نعرضه بعناية، ونحرص على وصف واضح للمنتج وخدمة تحترم وقتك.',
              'We started with a simple idea: customers should find products they trust without hassle. We choose what we show with care and focus on clear product descriptions and service that respects your time.',
            ),
            L('من نحن', 'Who we are'),
          ),
          k.image('about-store', 'rt-store', L('داخل المتجر', 'Inside the store')),
          k.features('about-values', undefined, [
            [
              '✅',
              'اختيار دقيق',
              'Careful selection',
              'نراجع كل منتج قبل عرضه.',
              'We review every product before listing it.',
            ],
            [
              '📝',
              'وصف صادق',
              'Honest descriptions',
              'نكتب وصفًا واضحًا يطابق ما ستستلمه.',
              'We write clear descriptions that match what you will receive.',
            ],
            [
              '🤗',
              'خدمة محترمة',
              'Respectful service',
              'نتعامل مع كل استفسار باهتمام.',
              'We treat every inquiry with attention.',
            ],
          ]),
        ],
      ),
      k.page(
        'faq',
        [
          'الأسئلة الشائعة',
          'Frequently asked questions',
          'إجابات عن أسئلة الطلب والتوصيل والدفع والاستبدال.',
          'Answers about ordering, delivery, payment and exchanges.',
        ],
        [
          k.faq('faq-main', L('أسئلة الطلب والتوصيل', 'Ordering and delivery questions'), [
            [
              'كيف أتابع طلبي؟',
              'How do I follow my order?',
              'نرسل لك تحديثًا عند شحن الطلب. وللاستفسار يمكنك مراسلتنا من صفحة التواصل.',
              'We send you an update when your order ships. For questions you can message us from the contact page.',
            ],
            [
              'ما طرق الدفع المتاحة؟',
              'Which payment methods are available?',
              'تظهر طرق الدفع المتاحة عند إتمام الطلب. وللاستفسار تواصل معنا.',
              'The available payment methods are shown when you complete your order. Contact us if you have questions.',
            ],
            [
              'كم تستغرق مدة التوصيل؟',
              'How long does delivery take?',
              'تختلف المدة بحسب مدينتك، وتظهر لك قبل تأكيد الطلب.',
              'The time varies by your city and is shown to you before you confirm the order.',
            ],
            [
              'هل يمكنني استبدال المنتج؟',
              'Can I exchange a product?',
              'نعم، وفق سياسة الاستبدال المنشورة. تواصل معنا وسنوضح لك الخطوات.',
              'Yes, under the published exchange policy. Contact us and we will explain the steps.',
            ],
          ]),
        ],
      ),
      k.page(
        'contact',
        [
          'تواصل مع المتجر',
          'Contact the store',
          'أرسل استفسارك عن منتج أو طلب، وتعرّف على موقع المتجر.',
          'Send your question about a product or an order, and find the store’s location.',
        ],
        [
          k.text(
            'contact-intro',
            L(
              'أخبرنا بما تحتاجه وسنساعدك. اذكر اسم المنتج أو رقم الطلب إن وُجد.',
              'Tell us what you need and we will help. Mention the product name or order number if you have one.',
            ),
            L('نحن هنا لمساعدتك', 'We are here to help'),
          ),
          k.contactForm('contact-form', L('أرسل استفسارك', 'Send your inquiry')),
          k.map('contact-map', L('موقع المتجر', 'Store location'), { bg: 'muted' }),
        ],
      ),
    ],
  }),
});
