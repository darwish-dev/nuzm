import type { AppSpec, CrudAction, EntitySpec, FieldSpec } from '../spec/app-spec';

/**
 * DEVELOPMENT FIXTURE of the reference CRM as an application spec, hand-written from the scope paragraph of M10 §4. It is NOT the frozen
 * `spec/reference/crm-spec.md` (the owner freezes that; it is a human item) and the tests that use it are NOT the independent suite (AC-M10-01 stays BLOCKED).
 */
const b = (ar: string, en: string) => ({ ar, en });
const f = (
  name: string,
  type: FieldSpec['type'],
  ar: string,
  en: string,
  o: Partial<FieldSpec> = {},
): FieldSpec => ({ name, type, labels: b(ar, en), ...o });
const ent = (e: Omit<EntitySpec, 'audit'> & { audit?: boolean }): EntitySpec => ({
  audit: true,
  ...e,
});
const ALL: CrudAction[] = ['create', 'read', 'update', 'delete', 'import', 'export'];
const entities = ['Account', 'Contact', 'Lead', 'Opportunity', 'Task', 'Note', 'Attachment'];
const grant = (a: CrudAction[]) => Object.fromEntries(entities.map((n) => [n, a]));

export const CRM_SPEC: AppSpec = {
  name: 'Reference CRM',
  slug: 'reference-crm',
  description:
    'Accounts, contacts, leads, opportunities, tasks, notes and attachments with role-based access and a sales pipeline.',
  locales: ['ar', 'en'],
  defaultLocale: 'ar',
  entities: [
    ent({
      name: 'Account',
      plural: 'accounts',
      labels: b('حساب', 'Account'),
      ownership: 'owner',
      searchable: ['name', 'country'],
      sortable: ['name', 'country'],
      fields: [
        f('name', 'string', 'اسم الحساب', 'Account name', { required: true, maxLength: 160 }),
        f('industry', 'enum', 'القطاع', 'Industry', {
          enumValues: ['Technology', 'Retail', 'Health', 'Education', 'Finance', 'Other'],
        }),
        f('website', 'url', 'الموقع', 'Website'),
        f('phone', 'phone', 'الهاتف', 'Phone', { pii: true }),
        f('country', 'string', 'الدولة', 'Country', { maxLength: 80 }),
      ],
    }),
    ent({
      name: 'Contact',
      plural: 'contacts',
      labels: b('جهة اتصال', 'Contact'),
      ownership: 'owner',
      searchable: ['firstName', 'lastName', 'email'],
      sortable: ['lastName', 'firstName'],
      fields: [
        f('firstName', 'string', 'الاسم الأول', 'First name', {
          required: true,
          maxLength: 80,
          pii: true,
        }),
        f('lastName', 'string', 'اسم العائلة', 'Last name', {
          required: true,
          maxLength: 80,
          pii: true,
        }),
        f('email', 'email', 'البريد', 'Email', { pii: true }),
        f('phone', 'phone', 'الهاتف', 'Phone', { pii: true }),
        f('title', 'string', 'المسمى', 'Job title', { maxLength: 120 }),
        f('account', 'reference', 'الحساب', 'Account', { references: 'Account' }),
      ],
    }),
    ent({
      name: 'Lead',
      plural: 'leads',
      labels: b('عميل محتمل', 'Lead'),
      ownership: 'owner',
      searchable: ['name', 'company', 'email'],
      sortable: ['name', 'status'],
      fields: [
        f('name', 'string', 'الاسم', 'Name', { required: true, maxLength: 160, pii: true }),
        f('company', 'string', 'الشركة', 'Company', { maxLength: 160 }),
        f('email', 'email', 'البريد', 'Email', { pii: true }),
        f('phone', 'phone', 'الهاتف', 'Phone', { pii: true }),
        f('source', 'enum', 'المصدر', 'Source', {
          enumValues: ['Web', 'Referral', 'Event', 'Cold'],
        }),
        f('status', 'enum', 'الحالة', 'Status', {
          required: true,
          enumValues: ['New', 'Working', 'Converted', 'Disqualified'],
        }),
      ],
    }),
    ent({
      name: 'Opportunity',
      plural: 'opportunities',
      labels: b('فرصة', 'Opportunity'),
      ownership: 'owner',
      stageField: 'stage',
      searchable: ['name'],
      sortable: ['name', 'amount', 'closeDate', 'stage'],
      fields: [
        f('name', 'string', 'اسم الفرصة', 'Opportunity name', { required: true, maxLength: 160 }),
        f('account', 'reference', 'الحساب', 'Account', { references: 'Account', required: true }),
        f('contact', 'reference', 'جهة الاتصال', 'Contact', { references: 'Contact' }),
        f('stage', 'enum', 'المرحلة', 'Stage', {
          required: true,
          enumValues: ['New', 'Qualified', 'Proposal', 'Won', 'Lost'],
        }),
        f('amount', 'decimal', 'القيمة', 'Amount', { min: 0, max: 1000000000 }),
        f('currency', 'enum', 'العملة', 'Currency', { enumValues: ['SAR', 'USD'] }),
        f('closeDate', 'date', 'تاريخ الإغلاق', 'Close date'),
        f('probability', 'integer', 'الاحتمال', 'Probability %', { min: 0, max: 100 }),
      ],
    }),
    ent({
      name: 'Task',
      plural: 'tasks',
      labels: b('مهمة', 'Task'),
      ownership: 'owner',
      searchable: ['subject'],
      sortable: ['subject', 'dueDate', 'status'],
      fields: [
        f('subject', 'string', 'الموضوع', 'Subject', { required: true, maxLength: 200 }),
        f('status', 'enum', 'الحالة', 'Status', { required: true, enumValues: ['Open', 'Done'] }),
        f('priority', 'enum', 'الأولوية', 'Priority', { enumValues: ['Low', 'Normal', 'High'] }),
        f('dueDate', 'date', 'تاريخ الاستحقاق', 'Due date'),
        f('opportunity', 'reference', 'الفرصة', 'Opportunity', { references: 'Opportunity' }),
      ],
    }),
    ent({
      name: 'Note',
      plural: 'notes',
      labels: b('ملاحظة', 'Note'),
      ownership: 'owner',
      searchable: ['body'],
      sortable: ['createdAt'],
      fields: [
        f('body', 'text', 'النص', 'Text', { required: true, maxLength: 5000 }),
        f('account', 'reference', 'الحساب', 'Account', { references: 'Account' }),
        f('opportunity', 'reference', 'الفرصة', 'Opportunity', { references: 'Opportunity' }),
      ],
    }),
    ent({
      name: 'Attachment',
      plural: 'attachments',
      labels: b('مرفق', 'Attachment'),
      ownership: 'owner',
      searchable: ['title'],
      sortable: ['title'],
      fields: [
        f('title', 'string', 'العنوان', 'Title', { required: true, maxLength: 160 }),
        f('file', 'file', 'الملف', 'File', { required: true }),
        f('account', 'reference', 'الحساب', 'Account', { references: 'Account' }),
        f('opportunity', 'reference', 'الفرصة', 'Opportunity', { references: 'Opportunity' }),
      ],
    }),
  ],
  roles: [
    {
      name: 'admin',
      labels: b('مدير النظام', 'Admin'),
      scope: 'all',
      admin: true,
      permissions: grant(ALL),
    },
    {
      name: 'sales_manager',
      labels: b('مدير المبيعات', 'Sales Manager'),
      scope: 'team',
      permissions: grant(ALL),
    },
    {
      name: 'sales_rep',
      labels: b('مندوب مبيعات', 'Sales Rep'),
      scope: 'own',
      permissions: {
        ...grant(['create', 'read', 'update', 'delete', 'export']),
        Account: ['create', 'read', 'update', 'export'],
      },
    },
    {
      name: 'read_only',
      labels: b('للقراءة فقط', 'Read-only'),
      scope: 'all',
      permissions: grant(['read', 'export']),
    },
  ],
  pages: [
    {
      path: '/',
      kind: 'dashboard',
      title: b('الرئيسية', 'Dashboard'),
      widgets: [
        {
          id: 'pipeline',
          kind: 'by_stage',
          entity: 'Opportunity',
          title: b('خط المبيعات', 'Pipeline by stage'),
        },
        { id: 'open_leads', kind: 'count', entity: 'Lead', title: b('العملاء المحتملون', 'Leads') },
        {
          id: 'pipeline_value',
          kind: 'sum',
          entity: 'Opportunity',
          field: 'amount',
          title: b('قيمة الفرص', 'Opportunity value'),
        },
      ],
    },
    ...entities.map((n) => ({
      path: `/${n.toLowerCase()}s`.replace('opportunitys', 'opportunities'),
      kind: 'list' as const,
      entity: n,
      title: b(n, n),
    })),
    {
      path: '/pipeline',
      kind: 'board',
      entity: 'Opportunity',
      title: b('اللوحة', 'Pipeline board'),
    },
  ],
  api: { basePath: '/api/v1', defaultLimit: 25, maxLimit: 100 },
  nonFunctional: {
    rtl: true,
    accessibility: 'WCAG2.1-AA',
    dataRegion: 'sa-central',
    csvImportExport: true,
    attachmentMaxBytes: 10 * 1024 * 1024,
    notifications: [{ event: 'assignment', channel: 'email', template: 'record_assigned' }],
  },
};
