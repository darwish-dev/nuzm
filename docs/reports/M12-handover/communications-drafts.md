# Communications drafts (M12 S58)

Status: DRAFT 2026-11-18, NOT VERIFIED, not approved. Templates only: placeholders are in square brackets. Rules for every notice: approved by the communications lead before sending; facts only, no cause or blame until confirmed; no personal data, secrets, tokens or internal system names beyond what customers need; times in UTC; state the next update time; no claim of certification or legal compliance. Notices that touch legal obligations (breach, regulator, tax) are reviewed by counsel or the tax advisor first (HG-04-01, HG-03-04). The platform sends nothing automatically on these topics; people send them. Channels (email, in-console notice, status page) are to be confirmed: no public status page exists yet.

## 1. Incident: investigating
EN: "Subject: [Service] issue under investigation. We are investigating an issue affecting [service/feature] since [time] UTC. [Impact in one sentence: who and what.] [Workaround if any.] We will post the next update by [time] UTC. Reference: [incident id]."
AR: "الموضوع: مشكلة قيد التحقيق في [الخدمة]. نحقّق في مشكلة تؤثر على [الخدمة/الميزة] منذ [الوقت] بالتوقيت العالمي المنسّق. [وصف الأثر في جملة واحدة: من وما المتأثر.] [حل بديل إن وُجد.] سننشر التحديث التالي قبل [الوقت] بالتوقيت العالمي المنسّق. المرجع: [رقم الحادثة]."

## 2. Incident: update
EN: "Update on [incident id] at [time] UTC: [what changed, what we know, what we are doing]. Impact now: [impact]. Next update by [time] UTC."
AR: "تحديث بشأن [رقم الحادثة] في [الوقت] بالتوقيت العالمي المنسّق: [ما تغيّر وما نعرفه وما نقوم به]. الأثر الحالي: [الأثر]. التحديث التالي قبل [الوقت] بالتوقيت العالمي المنسّق."

## 3. Incident: resolved
EN: "Subject: Resolved: [service] issue. The issue affecting [service] from [start] to [end] UTC is resolved. [What customers should check or repeat, if anything.] [Data impact: none known / describe.] We will publish a summary of what happened and what we are changing by [date]. Reference: [incident id]."
AR: "الموضوع: تم حل المشكلة في [الخدمة]. تم حل المشكلة التي أثّرت على [الخدمة] من [البداية] إلى [النهاية] بالتوقيت العالمي المنسّق. [ما ينبغي للعملاء التحقق منه أو إعادته إن وُجد.] [الأثر على البيانات: لا يوجد أثر معروف / وصفه.] وسننشر ملخصًا لما حدث وما سنغيّره قبل [التاريخ]. المرجع: [رقم الحادثة]."

## 4. Planned maintenance
EN: "Subject: Planned maintenance on [date]. We will perform maintenance on [service] from [start] to [end] UTC. Expected impact: [none / brief interruption / read-only]. You do not need to take action[, except: ...]. Reference: [change id]."
AR: "الموضوع: صيانة مجدولة بتاريخ [التاريخ]. سنجري صيانة على [الخدمة] من [البداية] إلى [النهاية] بالتوقيت العالمي المنسّق. الأثر المتوقع: [لا أثر / انقطاع قصير / وضع القراءة فقط]. لا يلزمكم أي إجراء [باستثناء: ...]. المرجع: [رقم التغيير]."

## 5. Maintenance: completed or extended
EN: "Maintenance on [service] is [complete at [time] UTC / extended until [time] UTC because [short reason]]."
AR: "الصيانة على [الخدمة] [اكتملت في [الوقت] بالتوقيت العالمي المنسّق / مُدِّدت حتى [الوقت] بالتوقيت العالمي المنسّق بسبب [سبب موجز]]."

## 6. Provider-caused degradation
EN: "A cloud provider we use is experiencing problems. Creating new [service] in [region] is temporarily unavailable. Existing resources and data are not deleted. We will update you by [time] UTC. Reference: [incident id]." (Runbook: `provider-outage.md`.)
AR: "يواجه أحد مزوّدي الحوسبة السحابية الذين نعتمد عليهم مشكلات حاليًا. إنشاء [الخدمة] الجديدة في [المنطقة] غير متاح مؤقتًا. موارد حسابكم وبياناتكم الحالية لم تُحذف. سنوافيكم بالمستجدات قبل [الوقت] بالتوقيت العالمي المنسّق. المرجع: [رقم الحادثة]."

## 7. Payments degraded
EN: "Card payments are temporarily unavailable or delayed. Your invoices will not be treated as overdue because of this and your services continue. Please do not retry repeatedly; we will confirm when payments work. Reference: [incident id]." (Runbook: `psp-outage.md`.)
AR: "المدفوعات بالبطاقة متوقفة أو متأخرة مؤقتًا. لن تُعامَل فواتيركم كمتأخرة بسبب ذلك وستستمر خدماتكم. نرجو عدم تكرار المحاولات، وسنؤكد لكم عند عودة المدفوعات للعمل. المرجع: [رقم الحادثة]."

## 8. Security event notice (precaution; before facts are known)
EN: "We are investigating a security event affecting [area]. As a precaution we have [action]. We will contact affected customers directly if their data is involved and will update you by [time] UTC. Reference: [incident id]."
AR: "نحقّق في حدث أمني يتعلق بـ[المجال]. وكإجراء احترازي قمنا بـ[الإجراء]. سنتواصل مباشرةً مع العملاء المتأثرين إذا تبيّن أن بياناتهم معنية، وسنوافيكم بالمستجدات قبل [الوقت] بالتوقيت العالمي المنسّق. المرجع: [رقم الحادثة]."

## 9. Personal-data breach notice to affected customers (COUNSEL REVIEW REQUIRED)
Whether and when to send, and to whom, is decided with counsel; legal deadlines come from counsel (per published PDPL / regulator rules, verify against current official text with counsel; HG-04-01). Recorded in the breach case (`data-breach-workflow.md`).
EN: "Subject: Notice about your data. On [date] UTC we detected [factual description]. Information involved: [categories]. Not involved: [categories, only if confirmed]. What we have done: [actions]. What you can do: [steps]. Contact: [channel]. Reference: [case id]."
AR: "الموضوع: إشعار بشأن بياناتكم. بتاريخ [التاريخ] بالتوقيت العالمي المنسّق اكتشفنا [وصفًا واقعيًا]. المعلومات المعنية: [الفئات]. المعلومات غير المعنية: [الفئات، فقط عند التأكد]. ما قمنا به: [الإجراءات]. ما يمكنكم فعله: [الخطوات]. للتواصل: [القناة]. المرجع: [رقم القضية]."
Regulator notification: `<text and channel prepared by counsel: to be filled>`. No regulator template is held in this repository.

## 10. E-invoice delivery delay (TAX ADVISOR REVIEW REQUIRED)
EN: "Delivery of some invoices is delayed because an external tax-authority service is unavailable. Invoices will be sent as soon as they are cleared. No action is needed. Reference: [incident id]."
AR: "تأخّر إرسال بعض الفواتير بسبب عدم توفّر خدمة خارجية تابعة للجهة الضريبية. ستُرسَل الفواتير فور اعتمادها ولا يلزمكم أي إجراء. المرجع: [رقم الحادثة]."

## 11. Account or site action under the acceptable use policy
EN: "We received a report that [site/service] may breach our acceptable use policy ([reason code]). We have taken this step: [notify/throttle/suspend]. You can appeal by [method] by [date] UTC. Reference: [case id]." (Runbook: `abuse-takedown.md`.)
AR: "وردنا بلاغ يفيد بأن [الموقع/الخدمة] قد يخالف سياسة الاستخدام المقبول ([رمز السبب]). واتخذنا الإجراء التالي: [إشعار/تقييد/إيقاف]. يمكنكم تقديم اعتراض عبر [الطريقة] قبل [التاريخ] بالتوقيت العالمي المنسّق. المرجع: [رقم الحالة]."

## 12. Recovery after data loss window
EN: "We have recovered from an infrastructure failure. Changes made between [time] and [time] UTC may not be present and may need to be repeated. We will contact organizations with confirmed impact. Reference: [incident id]." (Runbook: `dr-restore.md`.)
AR: "تعافينا من عطل في البنية التحتية. قد لا تكون التغييرات التي أُجريت بين [الوقت] و[الوقت] بالتوقيت العالمي المنسّق موجودة، وقد تحتاج إلى إعادة تنفيذها. وسنتواصل مع المؤسسات التي تأكد تأثرها. المرجع: [رقم الحادثة]."

## 13. Internal: incident opened (for the staff channel)
EN: "[SEV] [incident id] opened at [time] UTC by [role]. Components: [list]. IC: [role]. Runbook: [link]. Next internal update: [time] UTC."
AR: "فُتحت الحادثة [رقم الحادثة] بمستوى [الخطورة] في [الوقت] بالتوقيت العالمي المنسّق بواسطة [الدور]. المكوّنات: [القائمة]. قائد الحادثة: [الدور]. دليل الإجراء: [الرابط]. التحديث الداخلي التالي: [الوقت] بالتوقيت العالمي المنسّق."
