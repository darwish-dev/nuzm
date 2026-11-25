import { L, defineTemplate } from './helpers';

/** Clinic: calm teal palette, appointment-request form. No medical claims: service names and wording are generic. */
export const clinic = defineTemplate({
  id: 'clinic',
  version: 2,
  category: 'clinic',
  name: L('عيادة أو مركز طبي', 'Clinic or medical centre'),
  description: L(
    'موقع لعيادة أو مركز طبي: خدمات، فريق، أسئلة شائعة ونموذج لطلب موعد مع خريطة الموقع.',
    'A site for a clinic or medical centre: services, team, FAQ and an appointment-request form with a map.',
  ),
  colors: { primary: '#0F766E', accent: '#0369A1', background: '#F7FDFC', text: '#0F2A2A' },
  tokens: { radius: 'md', spacing: 'normal', fontFamily: 'sans', width: 'normal' },
  orgType: 'MedicalClinic',
  content: (k) => ({
    siteDescription: L(
      'عيادة تضع راحتك أولًا: مواعيد منظمة، وفريق يستمع إليك، وبيئة نظيفة ومريحة. تعرّف على خدماتنا واطلب موعدك.',
      'A clinic that puts your comfort first: organised appointments, a team that listens and a clean, calm setting. Explore our services and request an appointment.',
    ),
    assets: [
      k.img(
        'cl-hero',
        L('الاستقبال', 'Reception'),
        L('منطقة استقبال مريحة ومرتبة', 'A comfortable, tidy reception area'),
      ),
      k.img(
        'cl-room',
        L('غرفة الكشف', 'Consultation room'),
        L('غرفة استشارة نظيفة ومجهزة', 'A clean, equipped consultation room'),
      ),
      k.img(
        'cl-team',
        L('الفريق', 'The team'),
        L('فريق العيادة في لقطة جماعية', 'The clinic team in a group photo'),
      ),
    ],
    forms: [k.form('appointment')],
    pages: [
      k.page(
        'home',
        [
          'عيادة برعاية واهتمام',
          'A clinic with care and attention',
          'مواعيد منظمة وفريق متعاون وبيئة نظيفة. تعرّف على خدمات العيادة واطلب موعدك بسهولة.',
          'Organised appointments, a supportive team and a clean setting. Explore the clinic’s services and request your appointment with ease.',
        ],
        [
          k.hero('home-hero', {
            h: L('رعاية بعناية واهتمام', 'Care with attention and respect'),
            sub: L(
              'عيادة تضع راحتك أولًا: مواعيد منظمة، وفريق يستمع إليك، وبيئة نظيفة ومريحة.',
              'A clinic that puts your comfort first: organised appointments, a team that listens and a clean, calm setting.',
            ),
            cta: L('اطلب موعدًا', 'Request an appointment'),
            to: 'contact',
            img: 'cl-hero',
          }),
          k.features('home-points', L('ما يميّز تجربتك معنا', 'What to expect with us'), [
            [
              '🗓️',
              'مواعيد منظمة',
              'Organised appointments',
              'نحترم وقتك ونحرص على تنظيم المواعيد لتقليل الانتظار.',
              'We respect your time and organise appointments to keep waiting short.',
            ],
            [
              '🤝',
              'فريق متعاون',
              'A supportive team',
              'فريق يشرح لك الخطوات بوضوح ويجيب عن أسئلتك.',
              'A team that explains each step clearly and answers your questions.',
            ],
            [
              '🧼',
              'بيئة نظيفة',
              'A clean setting',
              'نعتني بنظافة المكان وترتيبه ليكون زيارتك مريحة.',
              'We look after the cleanliness and order of the place so your visit is comfortable.',
            ],
          ]),
          k.testimonials(
            'home-voices',
            L('آراء المراجعين', 'What patients say'),
            [
              [
                'تعامل لطيف وتنظيم جيد للمواعيد.',
                'Kind treatment and well-organised appointments.',
                'مراجع',
                'Patient',
              ],
              [
                'شرح واضح وخدمة محترمة.',
                'Clear explanations and respectful service.',
                'مراجعة',
                'Patient',
              ],
            ],
            { bg: 'muted' },
          ),
          k.steps('home-steps', L('كيف تتم الزيارة', 'How your visit works'), [
            ['احجز', 'Book', 'اختر الموعد المناسب لك', 'Choose a time that suits you'],
            [
              'زرنا',
              'Visit',
              'يستقبلك فريقنا ويفحص حالتك',
              'Our team welcomes you and assesses your case',
            ],
            ['تابع', 'Follow up', 'نتابع معك بعد الزيارة', 'We follow up with you after the visit'],
          ]),
          k.cta('home-cta', {
            h: L('احجز موعدك بسهولة', 'Book your visit with ease'),
            sub: L('فريقنا جاهز لاستقبالك', 'Our team is ready to welcome you'),
            label: L('احجز موعدًا', 'Book an appointment'),
            to: 'contact',
          }),
        ],
      ),
      k.page(
        'about',
        [
          'عن العيادة',
          'About the clinic',
          'تعرّف على رسالة العيادة وقيمها وطريقة عملها في خدمة المراجعين.',
          'Learn about the clinic’s mission, its values and how it serves patients.',
        ],
        [
          k.text(
            'about-story',
            L(
              'نسعى إلى تقديم تجربة زيارة هادئة ومنظمة، يشعر فيها المراجع بالاحترام والاهتمام. نعمل بروح الفريق الواحد، ونحرص على وضوح التواصل وخصوصية المراجعين في كل خطوة.',
              'We aim to offer a calm, well-organised visit in which every patient feels respected and cared for. We work as one team and care about clear communication and patient privacy at every step.',
            ),
            L('رسالتنا', 'Our mission'),
          ),
          k.image('about-room', 'cl-room', L('غرفة الاستشارة', 'Our consultation room')),
          k.features('about-values', L('قيمنا', 'Our values'), [
            [
              '🔒',
              'الخصوصية',
              'Privacy',
              'نتعامل مع معلوماتك بسرّية واحترام.',
              'We treat your information with confidentiality and respect.',
            ],
            [
              '💬',
              'وضوح التواصل',
              'Clear communication',
              'نشرح لك كل خطوة بلغة بسيطة.',
              'We explain each step in simple language.',
            ],
            [
              '🌱',
              'التطوّر المستمر',
              'Continuous improvement',
              'نراجع تجربة المراجعين ونطوّر خدماتنا باستمرار.',
              'We review patient experience and keep improving our services.',
            ],
          ]),
        ],
      ),
      k.page(
        'services',
        [
          'خدمات العيادة',
          'Clinic services',
          'تعرّف على خدمات العيادة، واطّلع على أسئلة المواعيد الشائعة.',
          'Explore the clinic’s services and read the common questions about appointments.',
        ],
        [
          k.text(
            'services-intro',
            L(
              'نقدّم مجموعة من الخدمات العامة. للاستفسار عن خدمة محددة أو مدى ملاءمتها لحالتك، تواصل معنا وسيوجّهك الفريق.',
              'We offer a range of general services. To ask about a specific service or whether it suits your case, contact us and the team will guide you.',
            ),
            L('خدماتنا', 'Our services'),
          ),
          k.features('services-list', undefined, [
            [
              '🩺',
              'استشارات عامة',
              'General consultations',
              'جلسة استماع وتقييم أولي مع الطبيب المختص.',
              'A listening session and initial assessment with the specialist.',
            ],
            [
              '📋',
              'المتابعة الدورية',
              'Follow-up visits',
              'زيارات متابعة منظمة بحسب توصية الطبيب.',
              'Organised follow-up visits as recommended by the doctor.',
            ],
            [
              '🧪',
              'فحوصات أساسية',
              'Basic checks',
              'فحوصات بسيطة تُطلب عند الحاجة وبحسب التقييم.',
              'Simple checks requested when needed, based on the assessment.',
            ],
            [
              '📘',
              'إرشادات صحية',
              'Health guidance',
              'إرشادات عامة تساعدك على العناية بنفسك بين الزيارات.',
              'General guidance to help you look after yourself between visits.',
            ],
          ]),
          k.faq(
            'services-faq',
            L('أسئلة المواعيد', 'Appointment questions'),
            [
              [
                'كيف أحجز موعدًا؟',
                'How do I book an appointment?',
                'املأ نموذج طلب الموعد في صفحة التواصل وسيتواصل معك فريق الاستقبال لتأكيد الوقت المناسب.',
                'Fill in the appointment form on the contact page and the reception team will contact you to confirm a suitable time.',
              ],
              [
                'ماذا أحضر معي في الزيارة؟',
                'What should I bring to my visit?',
                'يُفضّل إحضار هويتك وأي تقارير أو نتائج سابقة متعلقة بزيارتك.',
                'We recommend bringing your ID and any previous reports or results related to your visit.',
              ],
              [
                'هل يمكنني تغيير موعدي؟',
                'Can I change my appointment?',
                'نعم، تواصل معنا قبل الموعد بوقت كافٍ لنرتّب لك وقتًا بديلًا.',
                'Yes. Contact us well before the appointment and we will arrange another time for you.',
              ],
            ],
            { bg: 'muted' },
          ),
        ],
      ),
      k.page(
        'team',
        [
          'فريق العيادة',
          'The clinic team',
          'تعرّف على الفريق الذي يخدمك: الأطباء والتمريض وفريق الاستقبال.',
          'Meet the team who serve you: doctors, nursing staff and the reception team.',
        ],
        [
          k.text(
            'team-intro',
            L(
              'خلف كل زيارة ناجحة فريق يعمل بتناغم. هذه لمحة عن الأدوار التي ستقابلها في العيادة.',
              'Behind every smooth visit is a team that works in harmony. Here is a glimpse of the roles you will meet at the clinic.',
            ),
            L('فريق يهتم بك', 'A team that cares'),
          ),
          k.image('team-photo', 'cl-team', L('فريق العيادة', 'The clinic team')),
          k.features('team-roles', undefined, [
            [
              '👩‍⚕️',
              'الأطباء',
              'Doctors',
              'يقيّمون حالتك ويشرحون لك الخطوات المناسبة.',
              'They assess your case and explain the suitable next steps.',
            ],
            [
              '💉',
              'التمريض',
              'Nursing staff',
              'يساندون الأطباء ويرافقونك أثناء الزيارة.',
              'They support the doctors and accompany you during your visit.',
            ],
            [
              '📞',
              'الاستقبال',
              'Reception',
              'ينظّمون المواعيد ويجيبون عن استفساراتك.',
              'They organise appointments and answer your questions.',
            ],
          ]),
        ],
      ),
      k.page(
        'contact',
        [
          'اطلب موعدًا',
          'Request an appointment',
          'املأ نموذج طلب الموعد وسيتواصل معك فريق الاستقبال، وتعرّف على موقع العيادة.',
          'Fill in the appointment form and the reception team will contact you, and find the clinic’s location.',
        ],
        [
          k.text(
            'contact-intro',
            L(
              'اترك بياناتك وسبب الزيارة وسنتواصل معك لتأكيد الموعد. في الحالات الطارئة يُرجى التوجّه إلى أقرب مرفق طوارئ.',
              'Leave your details and the reason for your visit and we will contact you to confirm. In an emergency, please go to the nearest emergency facility.',
            ),
            L('نرتّب لك موعدًا', 'We will arrange your visit'),
          ),
          k.contactForm('contact-form', L('طلب موعد', 'Appointment request')),
          k.map('contact-map', L('موقع العيادة', 'Clinic location'), { bg: 'muted' }),
        ],
      ),
    ],
  }),
});
