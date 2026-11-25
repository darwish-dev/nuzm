import { L, defineTemplate } from './helpers';

/** Non-profit / charity: mission, programs, impact gallery, volunteer form. No donation account details, no impact figures. */
export const ngo = defineTemplate({
  id: 'ngo',
  version: 2,
  category: 'ngo',
  name: L('جمعية أو مبادرة خيرية', 'Non-profit or charity'),
  description: L(
    'موقع لجمعية أو مبادرة: الرسالة والمشاريع ومعرض الصور ونموذج للتطوع أو الشراكة مع الخريطة.',
    'A site for a non-profit or initiative: mission, projects, photo gallery and a volunteer or partnership form with a map.',
  ),
  colors: { primary: '#166534', accent: '#A16207', background: '#F7FBF7', text: '#14231A' },
  tokens: { radius: 'md', spacing: 'relaxed', fontFamily: 'serif', width: 'normal' },
  orgType: 'NGO',
  content: (k) => ({
    siteDescription: L(
      'مبادرة تعمل مع المجتمع لصناعة أثر إيجابي مستدام. تعرّف على مشاريعنا وكيف يمكنك المشاركة بالتطوع أو الشراكة.',
      'An initiative working with the community to create lasting positive impact. Explore our projects and how you can take part as a volunteer or partner.',
    ),
    assets: [
      k.img(
        'ng-hero',
        L('عمل مجتمعي', 'Community work'),
        L('متطوعون يشاركون في نشاط مجتمعي', 'Volunteers taking part in a community activity'),
      ),
      k.img(
        'ng-p1',
        L('نشاط ١', 'Activity 1'),
        L('نشاط توعوي لأفراد المجتمع', 'An awareness activity for community members'),
      ),
      k.img(
        'ng-p2',
        L('نشاط ٢', 'Activity 2'),
        L('يوم تطوعي لتنظيم حملة مجتمعية', 'A volunteer day organising a community campaign'),
      ),
      k.img('ng-p3', L('نشاط ٣', 'Activity 3'), L('ورشة عمل للأسر', 'A workshop for families')),
      k.img(
        'ng-p4',
        L('نشاط ٤', 'Activity 4'),
        L('لقاء فريق المتطوعين', 'A meeting of the volunteer team'),
      ),
    ],
    forms: [k.form('volunteer')],
    pages: [
      k.page(
        'home',
        [
          'معًا نصنع أثرًا يدوم',
          'Together we make lasting impact',
          'تعرّف على رسالة المبادرة ومشاريعها، وشاركنا بالتطوع أو الشراكة.',
          'Discover the initiative’s mission and projects, and join us as a volunteer or partner.',
        ],
        [
          k.hero('home-hero', {
            h: L('معًا نصنع أثرًا يدوم', 'Together we make lasting impact'),
            sub: L(
              'نعمل مع المجتمع بروح التعاون لنصنع فرقًا حقيقيًا في حياة الأسر والأفراد.',
              'We work with the community in a spirit of cooperation to make a real difference in the lives of families and individuals.',
            ),
            cta: L('شارك معنا', 'Take part'),
            to: 'contact',
            img: 'ng-hero',
          }),
          k.features('home-focus', L('مجالات عملنا', 'Our areas of work'), [
            [
              '🤲',
              'العمل التطوعي',
              'Volunteering',
              'نفتح الباب لمن يرغب بالمشاركة بوقته ومهاراته.',
              'We open the door to those who want to give their time and skills.',
            ],
            [
              '📚',
              'التوعية والتعليم',
              'Awareness and learning',
              'برامج توعوية وورش تفيد الأسر والأفراد.',
              'Awareness programs and workshops that benefit families and individuals.',
            ],
            [
              '🌱',
              'المبادرات المجتمعية',
              'Community initiatives',
              'مبادرات يقودها المجتمع وتخدمه.',
              'Initiatives led by the community and serving it.',
            ],
          ]),
          k.text(
            'home-mission',
            L(
              'نؤمن أن التغيير الإيجابي يبدأ من خطوة صغيرة، وأن المجتمع حين يتكاتف يصل أبعد. ندعوك لتكون جزءًا من هذه الرحلة.',
              'We believe positive change begins with one small step, and that a community that comes together goes further. We invite you to be part of this journey.',
            ),
            L('رسالتنا', 'Our mission'),
            { bg: 'muted', align: 'center' },
          ),
          // SAMPLE figures: the owner replaces them with the business's own numbers
          k.stats('home-stats', L('أثرنا بالأرقام', 'Our impact in numbers'), [
            ['000', 'مستفيد (عدّلها)', 'Beneficiaries (edit)'],
            ['00', 'مبادرة (عدّلها)', 'Initiatives (edit)'],
            ['000', 'متطوع (عدّلها)', 'Volunteers (edit)'],
          ]),
          k.cta('home-cta', {
            h: L('كن جزءًا من الأثر', 'Be part of the impact'),
            sub: L('انضم إلينا وساهم في مبادراتنا', 'Join us and support our initiatives'),
            label: L('تواصل معنا', 'Get in touch'),
            to: 'contact',
          }),
        ],
      ),
      k.page(
        'about',
        [
          'من نحن',
          'Who we are',
          'تعرّف على رسالتنا وقيمنا وطريقة عملنا، وأجوبة عن أسئلة المشاركة.',
          'Learn about our mission, values and way of working, with answers to questions about taking part.',
        ],
        [
          k.text(
            'about-story',
            L(
              'بدأت مبادرتنا من مجموعة أشخاص جمعهم الرغبة في خدمة مجتمعهم. نعمل بشفافية، ونحرص على أن يكون لكل نشاط هدف واضح وأثر يمكن متابعته.',
              'Our initiative began with a group of people brought together by the wish to serve their community. We work transparently and make sure every activity has a clear goal and an impact that can be followed.',
            ),
            L('قصتنا', 'Our story'),
          ),
          k.image('about-photo', 'ng-p4', L('فريق المتطوعين', 'The volunteer team')),
          k.features('about-values', L('قيمنا', 'Our values'), [
            [
              '🔍',
              'الشفافية',
              'Transparency',
              'نعرض ما نفعله بوضوح أمام المجتمع.',
              'We show what we do clearly to the community.',
            ],
            [
              '🕊️',
              'الاحترام',
              'Respect',
              'نخدم الجميع بكرامة ودون تمييز.',
              'We serve everyone with dignity and without discrimination.',
            ],
            [
              '🔗',
              'الشراكة',
              'Partnership',
              'نبني علاقات تعاون مع الأفراد والجهات.',
              'We build cooperative relationships with individuals and organisations.',
            ],
          ]),
          k.faq(
            'about-faq',
            L('أسئلة عن المشاركة', 'Questions about taking part'),
            [
              [
                'كيف أتطوّع؟',
                'How can I volunteer?',
                'أرسل لنا نموذج المشاركة من صفحة التواصل وسنعود إليك بالفرص المتاحة.',
                'Send us the form on the contact page and we will come back with the opportunities available.',
              ],
              [
                'هل يمكن لجهة أن تشاركنا كشريك؟',
                'Can an organisation partner with us?',
                'نرحّب بالشراكات. اكتب لنا نبذة عن جهتك وفكرة التعاون.',
                'We welcome partnerships. Write to us about your organisation and your idea for cooperation.',
              ],
            ],
            { bg: 'muted' },
          ),
        ],
      ),
      k.page(
        'projects',
        [
          'مشاريعنا',
          'Our projects',
          'تعرّف على مشاريع المبادرة وبرامجها وآراء المتطوعين.',
          'Discover the initiative’s projects and programs and hear from volunteers.',
        ],
        [
          k.features('projects-list', L('برامج ومشاريع', 'Programs and projects'), [
            [
              '🧺',
              'مبادرات الأسر',
              'Family initiatives',
              'أنشطة تدعم الأسر وتعزّز التكافل في الحي.',
              'Activities that support families and strengthen solidarity in the neighbourhood.',
            ],
            [
              '🎓',
              'ورش وتوعية',
              'Workshops and awareness',
              'ورش قصيرة تنقل المعرفة والمهارات للمجتمع.',
              'Short workshops that share knowledge and skills with the community.',
            ],
            [
              '🌳',
              'أيام تطوعية',
              'Volunteer days',
              'أيام تطوع منظمة للمشاركة في خدمة البيئة والحي.',
              'Organised volunteer days to help the environment and neighbourhood.',
            ],
            [
              '🤝',
              'شراكات مجتمعية',
              'Community partnerships',
              'تعاون مع جهات تشاركنا الهدف نفسه.',
              'Cooperation with organisations that share our goal.',
            ],
          ]),
          k.testimonials(
            'projects-voices',
            L('أصوات المتطوعين', 'Voices of volunteers'),
            [
              [
                'تجربة جميلة جمعتني بأشخاص يحملون الهدف نفسه.',
                'A lovely experience that connected me with people who share the same goal.',
                'متطوع',
                'Volunteer',
              ],
              [
                'التنظيم واضح والأنشطة ذات معنى.',
                'The organisation is clear and the activities are meaningful.',
                'متطوعة',
                'Volunteer',
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
          'لقطات من أنشطتنا ومبادراتنا المجتمعية وفعالياتنا مع المتطوعين والشركاء.',
          'Snapshots of our activities and community initiatives.',
        ],
        [
          k.text(
            'gallery-intro',
            L(
              'لحظات من أنشطتنا مع المتطوعين والمجتمع.',
              'Moments from our activities with volunteers and the community.',
            ),
            L('لحظات من أنشطتنا', 'Moments from our activities'),
          ),
          k.gallery('gallery-main', undefined, [
            ['ng-p1', 'نشاط توعوي', 'An awareness activity'],
            ['ng-p2', 'يوم تطوعي', 'A volunteer day'],
            ['ng-p3', 'ورشة للأسر', 'A family workshop'],
            ['ng-p4', 'لقاء المتطوعين', 'A volunteer meeting'],
          ]),
        ],
      ),
      k.page(
        'contact',
        [
          'شاركنا أو تواصل معنا',
          'Take part or contact us',
          'سجّل رغبتك في التطوع أو الشراكة أو أرسل استفسارك، وتعرّف على موقعنا.',
          'Register your wish to volunteer or partner, or send a question, and find our location.',
        ],
        [
          k.text(
            'contact-intro',
            L(
              'للتطوع أو الشراكة أو التبرع أو أي استفسار، اكتب لنا وسنرد عليك بالتفاصيل.',
              'To volunteer, partner, donate or ask anything, write to us and we will reply with the details.',
            ),
            L('يسعدنا تواصلك', 'We are glad you got in touch'),
          ),
          k.contactForm('contact-form', L('نموذج المشاركة', 'Get involved')),
          k.map('contact-map', L('موقعنا', 'Find us'), { bg: 'muted' }),
        ],
      ),
    ],
  }),
});
