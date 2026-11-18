# Customer FAQ, Arabic and English (M12 S58 draft)

Status: DRAFT 2026-11-18. NOT VERIFIED and not approved for publication: wording needs review by the communications lead, counsel where noted (HG-04-01) and the tax advisor where noted (HG-03-04). It claims only what exists in this repository on 2026-11-18. **Enterprise single sign-on (SAML/OIDC) and SCIM are in progress and switched off by default (feature flags); they are described below as not yet available.** Nothing here states or implies a certification or a legal compliance status.
Entries marked `[AVAILABLE]` describe behaviour present in the code or spec; `[IN PROGRESS]` and `[NOT AVAILABLE]` must not be presented as live.

---

### 1. Can we sign in with our company's identity provider (single sign-on)? `[IN PROGRESS]`
**EN:** Enterprise single sign-on using SAML or OpenID Connect is being built and is not yet available to customers. When it becomes available it will be enabled per organization, and we will publish setup instructions. Until then, members sign in with email and password, and can add multi-factor authentication.
**AR:** يجري حاليًا تطوير تسجيل الدخول الموحّد للمؤسسات عبر SAML أو OpenID Connect، وهو غير متاح للعملاء بعد. عند توفّره سيُفعَّل لكل مؤسسة على حدة وسننشر خطوات الإعداد. وإلى ذلك الحين يسجّل الأعضاء الدخول بالبريد الإلكتروني وكلمة المرور، ويمكنهم إضافة المصادقة متعددة العوامل.

### 2. Is multi-factor authentication available? `[AVAILABLE]`
**EN:** Yes. Members can enrol a second factor, verify it and generate recovery codes from their account security settings. Sensitive actions may ask for a recent verification. Staff accounts of the platform always require it.
**AR:** نعم. يمكن للأعضاء تسجيل عامل تحقق ثانٍ والتحقق منه وإنشاء رموز استرداد من إعدادات أمان الحساب. وقد تطلب الإجراءات الحساسة تحققًا حديثًا. أما حسابات موظفي المنصة فالمصادقة متعددة العوامل إلزامية لها دائمًا.

### 3. What happens if we enable single sign-on enforcement and are locked out? `[IN PROGRESS]`
**EN:** Enforcement is not available yet. When it is, we will recommend keeping at least two owner accounts able to recover access, and our support team will verify your identity before any change, with two staff members involved. Please do not share passwords or certificates with support.
**AR:** إلزام تسجيل الدخول الموحّد غير متاح بعد. وعند توفّره سننصح بإبقاء حسابين على الأقل من حسابات المالكين قادرين على استعادة الوصول، وسيتحقق فريق الدعم من هويتكم قبل أي تغيير بمشاركة موظفين اثنين. نرجو عدم مشاركة كلمات المرور أو الشهادات مع الدعم.

### 4. Can users be created and removed automatically from our identity provider (SCIM)? `[IN PROGRESS]`
**EN:** SCIM 2.0 user and group provisioning is being built and is not yet available. Today, organization owners and administrators add and remove members manually in the console.
**AR:** يجري تطوير تزويد المستخدمين والمجموعات تلقائيًا عبر SCIM 2.0، وهو غير متاح بعد. حاليًا يضيف مالكو المؤسسة ومديروها الأعضاء ويزيلونهم يدويًا من لوحة التحكم.

### 5. Who can see the audit log of my organization, and what does it show? `[AVAILABLE]`
**EN:** Members with the audit-read permission can see the organization's audit events, newest first, and filter them by actor, action, resource, outcome and time. Members with the billing administrator role see billing-related events only. Events record who did what and when; they are designed not to contain passwords or card numbers.
**AR:** يستطيع الأعضاء الذين يملكون صلاحية قراءة سجل التدقيق الاطلاع على أحداث التدقيق الخاصة بمؤسستهم من الأحدث إلى الأقدم، وتصفيتها بحسب الفاعل والإجراء والمورد والنتيجة والوقت. ويرى أعضاء دور مدير الفوترة الأحداث المتعلقة بالفوترة فقط. تسجّل الأحداث من فعل ماذا ومتى، وهي مصمَّمة بحيث لا تتضمن كلمات مرور أو أرقام بطاقات.

### 6. Can I export my audit log? `[IN PROGRESS]`
**EN:** An audit export with a signed manifest is planned and not yet available. For now you can read and filter events through the console or the API. If you need an export urgently, contact support; we will tell you what is possible.
**AR:** التصدير مع بيان موقَّع لسجل التدقيق مخطَّط له وغير متاح بعد. يمكنكم حاليًا قراءة الأحداث وتصفيتها عبر لوحة التحكم أو واجهة البرمجة. وإذا احتجتم إلى تصدير عاجل فتواصلوا مع الدعم وسنبيّن لكم الممكن.

### 7. Can audit records be altered? `[AVAILABLE, with limits]`
**EN:** Audit records are append-only and linked by a hash chain, and a background job checks the chains and signs checkpoints. A customer-facing integrity indicator is not exposed yet. This describes the design of our controls; it is not an independent certification.
**AR:** سجلات التدقيق للإضافة فقط ومترابطة بسلسلة تجزئة، وتتحقق مهمة في الخلفية من السلاسل وتوقّع نقاط تحقق. ومؤشر سلامة السجل الموجَّه للعملاء غير معروض بعد. وهذا وصف لتصميم ضوابطنا وليس شهادة مستقلة.

### 8. How long do you keep audit logs? `[NOT AVAILABLE: pending decision]`
**EN:** Retention periods for audit and other records are being set with legal counsel and have not been finalised. We will publish them when they are approved. Nothing is deleted automatically by the application today.
**AR:** يجري تحديد مدد الاحتفاظ بسجلات التدقيق وغيرها مع المستشار القانوني ولم تُعتمد بعد، وسننشرها عند اعتمادها. ولا يحذف التطبيق شيئًا تلقائيًا حاليًا.

### 9. Is there a status page, and how will you tell us about incidents? `[NOT AVAILABLE: to be confirmed]`
**EN:** A public status page is not available yet; its launch is to be confirmed. Our process is to tell affected organizations promptly with what we know, what it affects and when the next update will come (see our incident procedure). Final channels (email, in-console notices) will be listed here once confirmed.
**AR:** صفحة الحالة العامة غير متاحة بعد، وموعد إطلاقها سيُؤكَّد لاحقًا. وإجراؤنا هو إبلاغ المؤسسات المتأثرة سريعًا بما نعرفه وما يتأثر وموعد التحديث التالي. وسنذكر هنا القنوات النهائية (البريد الإلكتروني وإشعارات لوحة التحكم) بعد تأكيدها.

### 10. What availability and recovery targets do you work to? `[INTERNAL TARGETS, not yet measured]`
**EN:** Our internal targets are 99.9 % monthly availability for the control-plane API, and for the control-plane database a recovery point of 15 minutes and a recovery time of 4 hours. They are targets, not guarantees: they have not yet been evidenced by recovery exercises, and no service-level agreement is in place yet (support model under review).
**AR:** أهدافنا الداخلية هي توفّر شهري بنسبة 99.9% لواجهة التحكم البرمجية، ولقاعدة بيانات التحكم نقطة استرداد مدتها 15 دقيقة ووقت تعافٍ مدته 4 ساعات. هذه أهداف وليست ضمانات؛ فلم تُثبَت بعد بتمارين استرداد، ولا توجد اتفاقية مستوى خدمة بعد (نموذج الدعم قيد المراجعة).

### 11. Where is my data stored? `[AVAILABLE, with limits]`
**EN:** Resources that depend on a region carry a data region, and the platform checks residency rules before placing data or calling vendors. Availability of a Saudi region depends on each provider account and is verified per account; we never show an offer that is not verified for your account and region. This is not legal advice about your own obligations.
**AR:** تحمل الموارد المرتبطة بمنطقة جغرافية وسمًا لمنطقة البيانات، وتتحقق المنصة من قواعد الإقامة قبل وضع البيانات أو استدعاء الموردين. ويعتمد توفّر منطقة سعودية على كل حساب مزوّد ويُتحقَّق منه لكل حساب، ولا نعرض عرضًا لم يُتحقَّق منه لحسابكم ومنطقتكم. وهذا ليس استشارة قانونية بشأن التزاماتكم.

### 12. Do you store our card details? `[AVAILABLE, sandbox only today]`
**EN:** No. Card details are entered in the payment provider's hosted fields; the platform stores only a token, card brand, last four digits and expiry. Live card payments are not yet enabled; a production payment provider is pending approval.
**AR:** لا. تُدخَل بيانات البطاقة في حقول مستضافة لدى مزوّد الدفع، ولا تحفظ المنصة سوى رمز مميّز ونوع البطاقة وآخر أربعة أرقام وتاريخ الانتهاء. المدفوعات الفعلية بالبطاقة غير مفعّلة بعد، فاعتماد مزوّد دفع للإنتاج ما زال معلّقًا.

### 13. How do I ask for a copy, correction or deletion of my personal data? `[AVAILABLE, deadlines pending counsel]`
**EN:** Members can open a data-subject request about themselves from the console (privacy requests; exact screen to be confirmed), and owners and administrators can request organization data exports. Response periods and refusal grounds are being confirmed with counsel; support will tell you the current process.
**AR:** يستطيع الأعضاء تقديم طلب يخص بياناتهم الشخصية من لوحة التحكم (طلبات الخصوصية؛ الشاشة المحددة ستؤكَّد لاحقًا)، ويستطيع المالكون والمديرون طلب تصدير بيانات المؤسسة. وتُؤكَّد مدد الاستجابة وأسباب الرفض مع المستشار القانوني، وسيعرّفكم الدعم بالإجراء المعمول به حاليًا.

### 14. A corrected invoice: will the original change? `[AVAILABLE]`
**EN:** No. An issued invoice never changes. A mistake is corrected with a credit note and, if needed, a new invoice. Invoice formats and tax wording are subject to review by our tax advisor.
**AR:** لا. الفاتورة الصادرة لا تتغير أبدًا، وتُصحَّح الأخطاء بإشعار دائن، ثم بفاتورة جديدة عند الحاجة. وصيغ الفواتير والعبارات الضريبية قيد مراجعة المستشار الضريبي لدينا.

### 15. How do I report abuse or a security problem? `[contact to be confirmed]`
**EN:** Send the report to `<abuse and security contact: to be filled>`. Include what you saw, where and when (UTC), without sending passwords or personal data of others. We acknowledge reports, act under our policy and give a way to appeal.
**AR:** أرسلوا البلاغ إلى `<جهة الاتصال الخاصة بالإساءة والأمن: تُحدَّد لاحقًا>` مع بيان ما رأيتموه ومكانه ووقته (بالتوقيت العالمي المنسّق)، من دون إرسال كلمات مرور أو بيانات شخصية لآخرين. نؤكد استلام البلاغات ونتصرف وفق سياستنا ونتيح طريقة للاعتراض.
