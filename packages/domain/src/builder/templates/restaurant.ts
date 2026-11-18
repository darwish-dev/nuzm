import { L, defineTemplate } from './helpers';

/** Restaurant / café: warm, serif, photo-led. Menu categories are described without prices. */
export const restaurant = defineTemplate({
  id: 'restaurant',
  version: 1,
  category: 'restaurant',
  name: L('مطعم أو مقهى', 'Restaurant or café'),
  description: L(
    'موقع لمطعم أو مقهى: قائمة الطعام، قصة المكان، معرض صور، وصفحة للحجز والتواصل مع الخريطة.',
    'A site for a restaurant or café: menu, story, photo gallery and a contact page with a map.',
  ),
  colors: { primary: '#9A3412', accent: '#B45309', background: '#FFFBF5', text: '#2B1B12' },
  tokens: { radius: 'md', spacing: 'relaxed', fontFamily: 'serif', width: 'normal' },
  orgType: 'Restaurant',
  content: (k) => ({
    siteDescription: L(
      'أطباق طازجة تُحضَّر بعناية في أجواء دافئة تناسب العائلة والأصدقاء. تعرّف على القائمة واحجز طاولتك.',
      'Fresh dishes prepared with care in a warm setting for family and friends. Explore the menu and book a table.',
    ),
    assets: [
      k.img(
        'rs-hero',
        L('قاعة الطعام', 'Dining room'),
        L('قاعة طعام دافئة بطاولات جاهزة للضيوف', 'A warm dining room with tables set for guests'),
      ),
      k.img(
        'rs-dish1',
        L('طبق رئيسي', 'Main dish'),
        L('طبق رئيسي مقدَّم بعناية', 'A main dish, carefully plated'),
      ),
      k.img(
        'rs-dish2',
        L('مقبّلات', 'Starters'),
        L('تشكيلة من المقبّلات الطازجة', 'A selection of fresh starters'),
      ),
      k.img(
        'rs-dish3',
        L('حلويات', 'Desserts'),
        L('حلوى مع مشروب ساخن', 'A dessert served with a hot drink'),
      ),
      k.img(
        'rs-interior',
        L('أجواء المكان', 'Our space'),
        L('زاوية جلوس هادئة داخل المكان', 'A quiet seating corner inside the venue'),
      ),
      k.img(
        'rs-kitchen',
        L('المطبخ', 'The kitchen'),
        L('فريق المطبخ أثناء التحضير', 'The kitchen team preparing orders'),
      ),
    ],
    forms: [k.form('general')],
    pages: [
      k.page(
        'home',
        [
          'مطعم بأطباق طازجة وأجواء دافئة',
          'Fresh dishes and a warm atmosphere',
          'اكتشف قائمتنا وأجواء المكان، واحجز طاولتك أو تواصل معنا بسهولة.',
          'Discover our menu and atmosphere, then book a table or get in touch with ease.',
        ],
        [
          k.hero('home-hero', {
            h: L('طعم أصيل يُحضَّر بعناية', 'Authentic flavours, made with care'),
            sub: L(
              'أطباق طازجة من مكوّنات مختارة، في أجواء دافئة تجمع العائلة والأصدقاء.',
              'Fresh dishes from carefully chosen ingredients, in a warm setting for family and friends.',
            ),
            cta: L('استعرض القائمة', 'View the menu'),
            to: 'menu',
            img: 'rs-hero',
          }),
          k.features('home-why', L('لماذا يحبّنا ضيوفنا', 'Why guests love us'), [
            [
              '🍽️',
              'مكوّنات طازجة',
              'Fresh ingredients',
              'نختار المكوّنات بعناية ونحضّر أطباقنا عند الطلب.',
              'We choose ingredients with care and prepare our dishes to order.',
            ],
            [
              '👨‍🍳',
              'وصفات مجرَّبة',
              'Trusted recipes',
              'وصفات نعتني بها ونطوّرها لتبقى نكهتها ثابتة في كل زيارة.',
              'Recipes we look after and refine so the taste stays consistent on every visit.',
            ],
            [
              '🤝',
              'ضيافة صادقة',
              'Genuine hospitality',
              'فريق يرحّب بك ويهتم بالتفاصيل الصغيرة من لحظة وصولك.',
              'A team that welcomes you and cares about the small details from the moment you arrive.',
            ],
          ]),
          k.testimonials(
            'home-voices',
            L('كلمات ضيوفنا', 'Words from our guests'),
            [
              [
                'أجواء مريحة وخدمة لطيفة، وسنعود قريبًا.',
                'A relaxed setting and kind service. We will be back soon.',
                'ضيف',
                'Guest',
              ],
              [
                'الأطباق طازجة والتقديم جميل.',
                'The dishes are fresh and beautifully presented.',
                'زائر',
                'Visitor',
              ],
            ],
            { bg: 'muted' },
          ),
        ],
      ),
      k.page(
        'about',
        [
          'قصتنا وفريقنا',
          'Our story and team',
          'تعرّف على قصة المكان والقيم التي نعمل بها كل يوم لنقدّم لك تجربة طعام مميزة.',
          'Learn the story behind the place and the values we work by every day to give you a memorable meal.',
        ],
        [
          k.text(
            'about-story',
            L(
              'بدأت فكرتنا من حب الطعام الجيد والجلسات الدافئة. نؤمن أن الوجبة الجيدة تبدأ من مكوّنات نثق بها، وتكتمل بمكان يشعر فيه الضيف بالراحة. نعمل كل يوم لنحافظ على الجودة ونقدّم لك تجربة تستحق أن تتكرر.',
              'Our idea started from a love of good food and warm gatherings. We believe a good meal starts with ingredients we trust and is completed by a place where guests feel at ease. Every day we work to keep the quality high and give you an experience worth repeating.',
            ),
            L('قصتنا', 'Our story'),
          ),
          k.image('about-space', 'rs-interior', L('أجواء المكان', 'The atmosphere of our space')),
          k.features('about-values', L('ما نؤمن به', 'What we believe in'), [
            [
              '🌿',
              'الجودة أولًا',
              'Quality first',
              'لا نتهاون في اختيار المكوّنات ولا في طريقة التحضير.',
              'We never compromise on ingredients or on how we prepare them.',
            ],
            [
              '⏱️',
              'احترام وقتك',
              'Respect for your time',
              'خدمة منظمة تحافظ على راحتك وتحترم وقتك.',
              'Organised service that keeps you comfortable and respects your time.',
            ],
            [
              '🏡',
              'أجواء عائلية',
              'A family feel',
              'مكان يناسب اللمّات العائلية والجلسات الهادئة مع الأصدقاء.',
              'A place that suits family gatherings and quiet time with friends.',
            ],
          ]),
        ],
      ),
      k.page(
        'menu',
        [
          'قائمة الطعام',
          'Our menu',
          'استعرض أقسام قائمتنا من المقبّلات والأطباق الرئيسية إلى الحلويات والمشروبات.',
          'Browse our menu sections, from starters and main dishes to desserts and drinks.',
        ],
        [
          k.text(
            'menu-intro',
            L(
              'تتغيّر بعض أطباقنا حسب الموسم وتوفّر المكوّنات. اسأل فريقنا عن أطباق اليوم أو عن أي ملاحظة غذائية تهمّك.',
              'Some of our dishes change with the season and the availability of ingredients. Ask our team about today’s dishes or any dietary note that matters to you.',
            ),
            L('قائمة الطعام', 'The menu'),
          ),
          k.features('menu-sections', undefined, [
            [
              '🥗',
              'المقبّلات',
              'Starters',
              'أطباق خفيفة ومنعشة لبداية الوجبة.',
              'Light, fresh plates to begin the meal.',
            ],
            [
              '🍲',
              'الأطباق الرئيسية',
              'Main dishes',
              'أطباق شهية ومشبعة تُقدَّم ساخنة.',
              'Satisfying dishes served hot.',
            ],
            [
              '🍰',
              'الحلويات',
              'Desserts',
              'نهاية حلوة تناسب كل الأذواق.',
              'A sweet ending for every taste.',
            ],
            [
              '☕',
              'المشروبات',
              'Drinks',
              'مشروبات باردة وساخنة بمكوّنات طازجة.',
              'Hot and cold drinks made with fresh ingredients.',
            ],
          ]),
          k.faq(
            'menu-faq',
            L('أسئلة عن القائمة', 'Questions about the menu'),
            [
              [
                'هل تتوفر خيارات لأصحاب الحساسية الغذائية؟',
                'Are there options for people with food allergies?',
                'نرجو إخبار فريقنا بأي حساسية قبل الطلب، وسنساعدك في اختيار الأنسب من القائمة.',
                'Please tell our team about any allergy before ordering and we will help you choose what suits you from the menu.',
              ],
              [
                'هل يمكن طلب الأطباق للمناسبات؟',
                'Can I order dishes for an occasion?',
                'نعم، تواصل معنا بتفاصيل المناسبة وسنرد عليك بالخيارات المتاحة.',
                'Yes. Contact us with the details of your occasion and we will reply with the available options.',
              ],
            ],
            { bg: 'muted' },
          ),
        ],
      ),
      k.page(
        'gallery',
        [
          'معرض الصور',
          'Photo gallery',
          'لمحة مصوّرة عن أطباقنا وأجواء المكان وفريق المطبخ.',
          'A photo glimpse of our dishes, our space and the kitchen team.',
        ],
        [
          k.gallery('gallery-main', L('لمحات من مطعمنا', 'Glimpses of our restaurant'), [
            ['rs-dish1', 'طبق رئيسي', 'Main dish'],
            ['rs-dish2', 'مقبّلات', 'Starters'],
            ['rs-dish3', 'حلويات', 'Desserts'],
            ['rs-interior', 'أجواء المكان', 'Our space'],
            ['rs-kitchen', 'المطبخ', 'The kitchen'],
            ['rs-hero', 'قاعة الطعام', 'Dining room'],
          ]),
        ],
      ),
      k.page(
        'contact',
        [
          'احجز طاولتك وتواصل معنا',
          'Book a table and contact us',
          'أرسل لنا رسالة للحجز أو الاستفسار، وتعرّف على موقعنا على الخريطة.',
          'Send us a message to book or ask a question, and find our location on the map.',
        ],
        [
          k.text(
            'contact-intro',
            L(
              'يسعدنا استقبال حجوزاتكم واستفساراتكم. اكتب لنا وسنرد عليك في أقرب وقت.',
              'We are glad to receive your bookings and questions. Write to us and we will reply as soon as we can.',
            ),
            L('نحب أن نسمع منك', 'We would love to hear from you'),
          ),
          k.contactForm('contact-form', L('أرسل رسالة', 'Send a message')),
          k.map('contact-map', L('موقعنا', 'Find us'), { bg: 'muted' }),
        ],
      ),
    ],
  }),
});
