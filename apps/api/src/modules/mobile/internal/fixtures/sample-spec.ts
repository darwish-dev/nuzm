import type { MobileSpec } from '../flutter/spec';

/**
 * The scripted "model answer" of the design agent used by dev and tests (S48: a scripted model adapter returns recorded fixtures; model QUALITY is NOT VERIFIED, HG-09-01/D-18).
 * A small field-service app: home, job list, a form (every field type), a detail screen and settings. Arabic copy is original text, not machine-translated product copy.
 */
export const SAMPLE_MOBILE_SPEC: MobileSpec = {
  schemaVersion: 1,
  app: {
    name: { ar: 'مهام الميدان', en: 'Field Tasks' },
    packageId: 'sa.nuzm.field_tasks',
    description: { ar: 'تطبيق لمتابعة مهام الفرق الميدانية', en: 'Track the tasks of field teams' },
  },
  theme: { primary: '#0B6E4F', secondary: '#C77700', dark: true },
  defaultLocale: 'ar',
  auth: { enabled: true },
  screens: [
    {
      id: 'home',
      title: { ar: 'الرئيسية', en: 'Home' },
      kind: 'home',
      body: { ar: 'مرحبًا بك. هنا ملخص مهامك لهذا اليوم.', en: "Welcome. Here is a summary of today's tasks." },
    },
    {
      id: 'tasks',
      title: { ar: 'المهام', en: 'Tasks' },
      kind: 'list',
      items: [
        { title: { ar: 'زيارة موقع العميل', en: 'Visit the customer site' }, subtitle: { ar: 'اليوم ٢:٠٠ م', en: 'Today 2:00 PM' } },
        { title: { ar: 'تسليم التقرير', en: 'Hand in the report' }, subtitle: { ar: 'غدًا', en: 'Tomorrow' } },
      ],
    },
    {
      id: 'new_task',
      title: { ar: 'مهمة جديدة', en: 'New task' },
      kind: 'form',
      fields: [
        { id: 'title', label: { ar: 'العنوان', en: 'Title' }, type: 'text', required: true },
        { id: 'contact_email', label: { ar: 'بريد جهة الاتصال', en: 'Contact email' }, type: 'email' },
        { id: 'contact_phone', label: { ar: 'هاتف جهة الاتصال', en: 'Contact phone' }, type: 'phone' },
        { id: 'budget', label: { ar: 'الميزانية', en: 'Budget' }, type: 'number' },
        {
          id: 'priority',
          label: { ar: 'الأولوية', en: 'Priority' },
          type: 'choice',
          required: true,
          options: [
            { value: 'low', label: { ar: 'منخفضة', en: 'Low' } },
            { value: 'high', label: { ar: 'عالية', en: 'High' } },
          ],
        },
        { id: 'notes', label: { ar: 'ملاحظات', en: 'Notes' }, type: 'multiline' },
        { id: 'urgent', label: { ar: 'عاجلة', en: 'Urgent' }, type: 'switch' },
      ],
    },
    {
      id: 'about',
      title: { ar: 'عن التطبيق', en: 'About' },
      kind: 'detail',
      body: { ar: "نسخة تجريبية مولّدة. لا تعتمد على المعاينة وحدها؛ اختبر على جهاز حقيقي.", en: 'A generated demo build. Do not rely on the preview alone; test on a real device.' },
    },
    { id: 'settings', title: { ar: 'الإعدادات', en: 'Settings' }, kind: 'settings' },
  ],
  navigation: { initial: 'home', tabs: ['home', 'tasks', 'new_task', 'settings'] },
  permissions: [],
};
