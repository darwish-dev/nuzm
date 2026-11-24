// GENERATED from packages/i18n/src/messages.ts (notif.kind.*). Do not edit by hand.
// ignore_for_file: lines_longer_than_80_chars
import '../l10n/strings.dart';

const Map<String, T> kNotificationKinds = {
  'security.impersonation_started': T('بدأ فريق الدعم جلسة دعم بصلاحية أحد مستخدميكم لمدة {ttlMinutes} دقيقة.', 'Support started a {ttlMinutes}-minute support session acting as one of your users.'),
  'security.org_suspended': T('تم إيقاف مؤسستكم من قِبل إدارة المنصة.', 'Your organization was suspended by platform administration.'),
  'security.org_reinstated': T('أُعيد تفعيل مؤسستكم.', 'Your organization was reinstated.'),
  'billing.payment_failed': T('تعذّر تحصيل دفعة الاشتراك. يرجى سداد الفاتورة أو تحديث وسيلة الدفع.', 'We could not collect the subscription payment. Please pay the invoice or update your payment method.'),
  'billing.dunning_reminder': T('تذكير: لديكم فاتورة متأخرة السداد. يرجى سدادها لتجنب تقييد المشتريات الجديدة.', 'Reminder: you have an overdue invoice. Please pay it to avoid new purchases being restricted.'),
  'billing.dunning_restricted': T('تم تقييد المشتريات الجديدة بسبب فاتورة متأخرة. الخدمات الحالية تعمل ولم يُحذف أي شيء.', 'New purchases are restricted because of an overdue invoice. Existing services keep running and nothing is deleted.'),
  'billing.dunning_suspended': T('طُلب إيقاف الخدمات بسبب فاتورة متأخرة. لن تُحذف بياناتكم.', 'Suspension of services was requested because of an overdue invoice. Your data is not deleted.'),
  'billing.dunning_review': T('الفاتورة المتأخرة قيد مراجعة المالك. لن يُحذف أي شيء دون قرار بشري.', 'The overdue invoice is under owner review. Nothing is deleted without a human decision.'),
  'billing.payment_recovered': T('تم سداد الفاتورة المتأخرة وعاد الاشتراك إلى وضعه الطبيعي.', 'The overdue invoice was paid and your subscription is back to normal.'),
  'billing.invoice_issued': T('صدرت فاتورة جديدة برقم {number}.', 'A new invoice {number} was issued.'),
  'billing.card_expiring': T('تنتهي صلاحية البطاقة المنتهية بالأرقام {last4} في {month}/{year}. يرجى تحديث وسيلة الدفع.', 'The card ending in {last4} expires {month}/{year}. Please update your payment method.'),
  'unknown': T('إشعار جديد ({kind})', 'New notification ({kind})'),
  'hosting.quota_soft': T('اقترب موقع {site} من حدّ الحصة ({dim}): المستخدم {used} من {limit}.', 'Site {site} is close to its {dim} quota: {used} of {limit} used.'),
  'hosting.quota_hard': T('وصل موقع {site} إلى حدّ الحصة ({dim}): {used} من {limit}. قد تُقيَّد بعض العمليات حتى يُخفَّض الاستخدام أو تُرفَع الخطة.', 'Site {site} reached its {dim} quota: {used} of {limit}. Some operations may be restricted until usage drops or the plan is upgraded.'),
  'hosting.site_suspended': T('تم إيقاف موقع {site} مؤقتًا. السبب: {reason}.', 'Site {site} was suspended. Reason: {reason}.'),
  'hosting.site_resumed': T('أُعيد تشغيل موقع {site}.', 'Site {site} was resumed.'),
  'hosting.abuse_notice': T('تلقّينا إشعار إساءة استخدام بخصوص موقع {site} (السبب: {reason}). يمكنكم الاعتراض من صفحة الموقع.', 'We received an abuse notice about site {site} (reason: {reason}). You can appeal from the site page.'),
  'domain.order_succeeded': T('اكتمل طلب النطاق.', 'Your domain order completed.'),
  'domain.order_failed': T('تعذّر إتمام طلب النطاق وأُعيد المبلغ المحجوز.', 'A domain order could not be completed; the reserved amount was released.'),
  'domain.renewal_reminder': T('يقترب موعد تجديد أحد نطاقاتكم.', 'One of your domains is due for renewal.'),
  'domain.renewal_approval_needed': T('يحتاج تجديد نطاق إلى موافقة إنفاق.', 'A domain renewal needs a spend approval.'),
  'domain.renewal_payment_failed': T('تعذّر دفع تجديد نطاق؛ سدّد المبلغ لتجنّب فقدانه.', 'A domain renewal payment failed; pay to avoid losing it.'),
};
