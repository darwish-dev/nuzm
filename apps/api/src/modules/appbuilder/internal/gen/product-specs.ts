import { CRM_SPEC } from '../fixtures/crm-appspec';
import type {
  AppSpec,
  Bilingual,
  CrudAction,
  EntitySpec,
  FieldSpec,
  RoleSpec,
} from '../spec/app-spec';
import { validateAppSpec } from '../spec/app-spec';
import type { FullStackOptions } from './options';

/**
 * P3-S05 generators for the product types of the planner that map to full-stack web apps: CRM, ERP, SaaS and e-commerce (back office). Each returns a STRUCTURED `AppSpec` (validated here with the builder's own
 * `validateAppSpec`) plus the generator options the product needs; the deterministic scaffolder renders everything else. Deterministic and offline: no model, no clock, no network.
 *
 * Rules the specs follow (CLAUDE.md §4): money is an INTEGER in minor units next to a currency code (never a float); personal fields are marked `pii` (classified, redacted in the audit trail); SaaS is multi-tenant
 * (tenant column + row-level security); roles follow least privilege and only `admin` administers.
 *
 * NOT covered, stated plainly: payment capture, tax (ZATCA/VAT) calculation and invoice issuing, shipping rates, and a public storefront. An e-commerce app here is the back office (catalogue, customers, orders, stock) with
 * the order total stored as the sum of its lines by the application; connecting a PSP, calculating tax and publishing a storefront are separate, gated pieces of work (docs/phase3, B-DOMAIN, PSP decisions).
 */
export type WebProduct = 'crm' | 'erp' | 'saas' | 'ecommerce';
export const WEB_PRODUCTS: readonly WebProduct[] = ['crm', 'erp', 'saas', 'ecommerce'];

export interface ProductBrief {
  /** display name; the slug is derived unless given */
  name: string;
  slug?: string;
  description?: string;
  defaultLocale?: 'ar' | 'en';
  /** ISO 4217 codes the app accepts for money fields (default SAR and USD) */
  currencies?: string[];
  dataRegion?: string;
  /** Let people register themselves with the least-privileged role (CRM, ERP, e-commerce). Default off: an administrator creates users. SaaS always registers organisations. */
  selfRegistration?: boolean;
}
export interface ProductApp {
  product: WebProduct;
  spec: AppSpec;
  options: FullStackOptions;
  /** what the generated app deliberately does not do (shown to the customer; never silently dropped) */
  notIncluded: Bilingual[];
}

const b = (ar: string, en: string): Bilingual => ({ ar, en });
const f = (
  name: string,
  type: FieldSpec['type'],
  ar: string,
  en: string,
  o: Partial<FieldSpec> = {},
): FieldSpec => ({ name, type, labels: b(ar, en), ...o });
const money = (name: string, ar: string, en: string, o: Partial<FieldSpec> = {}): FieldSpec =>
  f(name, 'integer', ar, en, { min: 0, max: 100_000_000_00, ...o });
const currency = (cs: string[]): FieldSpec =>
  f('currency', 'enum', 'العملة', 'Currency', { required: true, enumValues: cs });
const ent = (e: Omit<EntitySpec, 'audit'> & { audit?: boolean }): EntitySpec => ({
  audit: true,
  ...e,
});
const RW: CrudAction[] = ['create', 'read', 'update', 'delete'];
const ALL: CrudAction[] = [...RW, 'import', 'export'];
const grant = (names: string[], a: CrudAction[]): Record<string, CrudAction[]> =>
  Object.fromEntries(names.map((n) => [n, a]));
const slugOf = (s: string): string => {
  const x = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return /^[a-z]/.test(x) && x.length >= 2 ? x : 'app-' + (x || 'x');
};
const base = (brief: ProductBrief, product: WebProduct, description: string) => ({
  name: brief.name.slice(0, 80),
  slug: brief.slug ?? slugOf(brief.name),
  description: (brief.description ?? description).slice(0, 2000),
  locales: ['ar', 'en'] as ('ar' | 'en')[],
  defaultLocale: brief.defaultLocale ?? 'ar',
  api: { basePath: '/api/v1', defaultLimit: 25, maxLimit: 100 },
  nonFunctional: {
    rtl: true,
    accessibility: 'WCAG2.1-AA' as const,
    dataRegion: brief.dataRegion ?? 'sa-central',
    csvImportExport: product !== 'saas',
    attachmentMaxBytes: 5 * 1024 * 1024,
    notifications: [],
  },
});
const adminRole = (names: string[]): RoleSpec => ({
  name: 'admin',
  labels: b('مدير النظام', 'Admin'),
  scope: 'all',
  admin: true,
  permissions: grant(names, ALL),
});
const viewerRole = (names: string[]): RoleSpec => ({
  name: 'read_only',
  labels: b('للقراءة فقط', 'Read-only'),
  scope: 'all',
  permissions: grant(names, ['read', 'export']),
});

// ------------------------------------------------------------------------------------------------ CRM
function crm(brief: ProductBrief): ProductApp {
  const spec: AppSpec = {
    ...JSON.parse(JSON.stringify(CRM_SPEC)),
    name: brief.name.slice(0, 80),
    slug: brief.slug ?? slugOf(brief.name),
  };
  // the reference CRM stores the opportunity amount as a decimal; platform rule: money is an integer in minor units. The amount becomes `amountMinor` (and everything that named it follows).
  for (const e of spec.entities)
    for (const fld of e.fields)
      if (fld.type === 'decimal' && fld.name === 'amount') {
        fld.name = 'amountMinor';
        fld.type = 'integer';
        fld.labels = b('القيمة (وحدة صغرى)', 'Amount (minor units)');
        fld.min = 0;
        fld.max = 100_000_000_00;
        e.sortable = e.sortable.map((n) => (n === 'amount' ? 'amountMinor' : n));
        e.searchable = e.searchable.map((n) => (n === 'amount' ? 'amountMinor' : n));
      }
  for (const pg of spec.pages)
    for (const w of pg.widgets ?? []) if (w.field === 'amount') w.field = 'amountMinor';
  const cur = spec.entities.flatMap((e) => e.fields).find((x) => x.name === 'currency');
  if (cur && brief.currencies) cur.enumValues = brief.currencies;
  if (brief.description) spec.description = brief.description.slice(0, 2000);
  if (brief.defaultLocale) spec.defaultLocale = brief.defaultLocale;
  if (brief.dataRegion) spec.nonFunctional.dataRegion = brief.dataRegion;
  return {
    product: 'crm',
    spec,
    options: brief.selfRegistration ? { signupRole: 'auto' } : {},
    notIncluded: [
      b('الفوترة والدفع وإرسال البريد التسويقي', 'Billing, payments and marketing e-mail'),
    ],
  };
}

// ------------------------------------------------------------------------------------------------ ERP
function erp(brief: ProductBrief): ProductApp {
  const cs = brief.currencies ?? ['SAR', 'USD'];
  const names = [
    'Supplier',
    'Item',
    'PurchaseOrder',
    'PurchaseLine',
    'StockMovement',
    'Customer',
    'SalesOrder',
    'SalesLine',
  ];
  const entities: EntitySpec[] = [
    ent({
      name: 'Supplier',
      plural: 'suppliers',
      labels: b('مورّد', 'Supplier'),
      ownership: 'org',
      searchable: ['name', 'email'],
      sortable: ['name'],
      fields: [
        f('name', 'string', 'الاسم', 'Name', { required: true, maxLength: 160 }),
        f('email', 'email', 'البريد', 'Email', { pii: true }),
        f('phone', 'phone', 'الهاتف', 'Phone', { pii: true }),
        f('taxNumber', 'string', 'الرقم الضريبي', 'Tax number', { maxLength: 30 }),
      ],
    }),
    ent({
      name: 'Item',
      plural: 'items',
      labels: b('صنف', 'Item'),
      ownership: 'org',
      searchable: ['sku', 'name'],
      sortable: ['sku', 'name'],
      fields: [
        f('sku', 'string', 'رمز الصنف', 'SKU', { required: true, unique: true, maxLength: 40 }),
        f('name', 'string', 'الاسم', 'Name', { required: true, maxLength: 160 }),
        f('unit', 'enum', 'الوحدة', 'Unit', {
          required: true,
          enumValues: ['piece', 'kg', 'litre', 'metre', 'box'],
        }),
        money('unitCostMinor', 'التكلفة (وحدة صغرى)', 'Unit cost (minor units)', {
          required: true,
        }),
        currency(cs),
        f('onHand', 'integer', 'الكمية المتاحة', 'On hand', { required: true, min: 0 }),
        f('reorderLevel', 'integer', 'حد إعادة الطلب', 'Reorder level', { min: 0 }),
      ],
    }),
    ent({
      name: 'PurchaseOrder',
      plural: 'purchase_orders',
      labels: b('أمر شراء', 'Purchase order'),
      ownership: 'owner',
      searchable: ['number'],
      sortable: ['number', 'orderDate'],
      stageField: 'status',
      fields: [
        f('number', 'string', 'الرقم', 'Number', { required: true, unique: true, maxLength: 30 }),
        f('supplier', 'reference', 'المورّد', 'Supplier', {
          required: true,
          references: 'Supplier',
        }),
        f('status', 'enum', 'الحالة', 'Status', {
          required: true,
          enumValues: ['Draft', 'Approved', 'Received', 'Cancelled'],
        }),
        f('orderDate', 'date', 'التاريخ', 'Order date', { required: true }),
        money('totalMinor', 'الإجمالي (وحدة صغرى)', 'Total (minor units)', { required: true }),
        currency(cs),
      ],
    }),
    ent({
      name: 'PurchaseLine',
      plural: 'purchase_lines',
      labels: b('بند شراء', 'Purchase line'),
      ownership: 'owner',
      audit: false,
      searchable: [],
      sortable: ['quantity'],
      fields: [
        f('purchaseOrder', 'reference', 'أمر الشراء', 'Purchase order', {
          required: true,
          references: 'PurchaseOrder',
        }),
        f('item', 'reference', 'الصنف', 'Item', { required: true, references: 'Item' }),
        f('quantity', 'integer', 'الكمية', 'Quantity', { required: true, min: 1, max: 1_000_000 }),
        money('unitCostMinor', 'سعر الوحدة (وحدة صغرى)', 'Unit cost (minor units)', {
          required: true,
        }),
      ],
    }),
    ent({
      name: 'StockMovement',
      plural: 'stock_movements',
      labels: b('حركة مخزون', 'Stock movement'),
      ownership: 'org',
      searchable: ['note'],
      sortable: ['movedAt'],
      fields: [
        f('item', 'reference', 'الصنف', 'Item', { required: true, references: 'Item' }),
        f('kind', 'enum', 'النوع', 'Kind', {
          required: true,
          enumValues: ['Receipt', 'Issue', 'Adjustment'],
        }),
        f('quantity', 'integer', 'الكمية', 'Quantity', {
          required: true,
          min: -1_000_000,
          max: 1_000_000,
        }),
        f('movedAt', 'datetime', 'وقت الحركة', 'Moved at', { required: true }),
        f('note', 'string', 'ملاحظة', 'Note', { maxLength: 200 }),
      ],
    }),
    ent({
      name: 'Customer',
      plural: 'customers',
      labels: b('عميل', 'Customer'),
      ownership: 'owner',
      searchable: ['name', 'email'],
      sortable: ['name'],
      fields: [
        f('name', 'string', 'الاسم', 'Name', { required: true, maxLength: 160, pii: true }),
        f('email', 'email', 'البريد', 'Email', { pii: true }),
        f('phone', 'phone', 'الهاتف', 'Phone', { pii: true }),
      ],
    }),
    ent({
      name: 'SalesOrder',
      plural: 'sales_orders',
      labels: b('أمر بيع', 'Sales order'),
      ownership: 'owner',
      searchable: ['number'],
      sortable: ['number', 'orderDate'],
      stageField: 'status',
      fields: [
        f('number', 'string', 'الرقم', 'Number', { required: true, unique: true, maxLength: 30 }),
        f('customer', 'reference', 'العميل', 'Customer', {
          required: true,
          references: 'Customer',
        }),
        f('status', 'enum', 'الحالة', 'Status', {
          required: true,
          enumValues: ['Draft', 'Confirmed', 'Shipped', 'Invoiced', 'Cancelled'],
        }),
        f('orderDate', 'date', 'التاريخ', 'Order date', { required: true }),
        money('totalMinor', 'الإجمالي (وحدة صغرى)', 'Total (minor units)', { required: true }),
        currency(cs),
      ],
    }),
    ent({
      name: 'SalesLine',
      plural: 'sales_lines',
      labels: b('بند بيع', 'Sales line'),
      ownership: 'owner',
      audit: false,
      searchable: [],
      sortable: ['quantity'],
      fields: [
        f('salesOrder', 'reference', 'أمر البيع', 'Sales order', {
          required: true,
          references: 'SalesOrder',
        }),
        f('item', 'reference', 'الصنف', 'Item', { required: true, references: 'Item' }),
        f('quantity', 'integer', 'الكمية', 'Quantity', { required: true, min: 1, max: 1_000_000 }),
        money('unitPriceMinor', 'سعر الوحدة (وحدة صغرى)', 'Unit price (minor units)', {
          required: true,
        }),
      ],
    }),
  ];
  const roles: RoleSpec[] = [
    adminRole(names),
    {
      name: 'warehouse',
      labels: b('أمين المستودع', 'Warehouse'),
      scope: 'all',
      permissions: {
        Item: ['read', 'update', 'export'],
        StockMovement: [...RW, 'export'],
        Supplier: ['read'],
        PurchaseOrder: ['read', 'update'],
        PurchaseLine: ['read'],
      },
    },
    {
      name: 'purchaser',
      labels: b('مسؤول المشتريات', 'Purchaser'),
      scope: 'own',
      permissions: {
        Supplier: [...RW, 'export'],
        Item: ['read'],
        PurchaseOrder: [...RW, 'export'],
        PurchaseLine: [...RW],
      },
    },
    {
      name: 'salesperson',
      labels: b('مندوب مبيعات', 'Salesperson'),
      scope: 'own',
      permissions: {
        Customer: [...RW, 'export'],
        Item: ['read'],
        SalesOrder: [...RW, 'export'],
        SalesLine: [...RW],
      },
    },
    viewerRole(names),
  ];
  const spec: AppSpec = {
    ...base(
      brief,
      'erp',
      'Suppliers, items and stock, purchase orders, customers and sales orders with role-based access.',
    ),
    entities,
    roles,
    pages: [
      {
        path: '/',
        kind: 'dashboard',
        title: b('الرئيسية', 'Dashboard'),
        widgets: [
          {
            id: 'po_status',
            kind: 'by_stage',
            entity: 'PurchaseOrder',
            title: b('أوامر الشراء', 'Purchase orders by status'),
          },
          {
            id: 'so_status',
            kind: 'by_stage',
            entity: 'SalesOrder',
            title: b('أوامر البيع', 'Sales orders by status'),
          },
          { id: 'items', kind: 'count', entity: 'Item', title: b('الأصناف', 'Items') },
          {
            id: 'recent_moves',
            kind: 'recent',
            entity: 'StockMovement',
            title: b('آخر الحركات', 'Recent stock movements'),
          },
        ],
      },
      {
        path: '/purchase-orders',
        kind: 'board',
        title: b('أوامر الشراء', 'Purchase orders'),
        entity: 'PurchaseOrder',
      },
      {
        path: '/sales-orders',
        kind: 'board',
        title: b('أوامر البيع', 'Sales orders'),
        entity: 'SalesOrder',
      },
      { path: '/items', kind: 'list', title: b('الأصناف', 'Items'), entity: 'Item' },
    ],
  };
  return {
    product: 'erp',
    spec,
    options: brief.selfRegistration ? { signupRole: 'auto' } : {},
    notIncluded: [
      b(
        'الحسابات العامة والضرائب والفواتير الإلكترونية',
        'General ledger, tax and e-invoicing (ZATCA)',
      ),
      b(
        'تحديث المخزون تلقائياً من الأوامر',
        'Automatic stock postings from orders (movements are recorded explicitly)',
      ),
    ],
  };
}

// ------------------------------------------------------------------------------------------------ SaaS (multi-tenant)
function saas(brief: ProductBrief): ProductApp {
  const cs = brief.currencies ?? ['SAR', 'USD'];
  const names = ['Project', 'Task', 'Member', 'Plan', 'Subscription'];
  const entities: EntitySpec[] = [
    ent({
      name: 'Project',
      plural: 'projects',
      labels: b('مشروع', 'Project'),
      ownership: 'org',
      searchable: ['name'],
      sortable: ['name'],
      fields: [
        f('name', 'string', 'الاسم', 'Name', { required: true, maxLength: 120 }),
        f('status', 'enum', 'الحالة', 'Status', {
          required: true,
          enumValues: ['Active', 'Archived'],
        }),
        f('description', 'text', 'الوصف', 'Description', { maxLength: 4000 }),
      ],
    }),
    ent({
      name: 'Task',
      plural: 'tasks',
      labels: b('مهمة', 'Task'),
      ownership: 'owner',
      searchable: ['title'],
      sortable: ['title', 'dueDate'],
      stageField: 'stage',
      fields: [
        f('title', 'string', 'العنوان', 'Title', { required: true, maxLength: 200 }),
        f('stage', 'enum', 'المرحلة', 'Stage', {
          required: true,
          enumValues: ['Todo', 'Doing', 'Done'],
        }),
        f('dueDate', 'date', 'الاستحقاق', 'Due date'),
        f('project', 'reference', 'المشروع', 'Project', { references: 'Project' }),
      ],
    }),
    ent({
      name: 'Member',
      plural: 'members',
      labels: b('عضو', 'Member'),
      ownership: 'org',
      searchable: ['name', 'email'],
      sortable: ['name'],
      fields: [
        f('name', 'string', 'الاسم', 'Name', { required: true, maxLength: 120, pii: true }),
        f('email', 'email', 'البريد', 'Email', { required: true, unique: true, pii: true }),
        f('title', 'string', 'المسمى', 'Job title', { maxLength: 80 }),
      ],
    }),
    ent({
      name: 'Plan',
      plural: 'plans',
      labels: b('باقة', 'Plan'),
      ownership: 'org',
      searchable: ['name'],
      sortable: ['name'],
      fields: [
        f('name', 'string', 'الاسم', 'Name', { required: true, unique: true, maxLength: 80 }),
        money('priceMinor', 'السعر الشهري (وحدة صغرى)', 'Monthly price (minor units)', {
          required: true,
        }),
        currency(cs),
        f('seats', 'integer', 'المقاعد', 'Seats', { required: true, min: 1, max: 100_000 }),
      ],
    }),
    ent({
      name: 'Subscription',
      plural: 'subscriptions',
      labels: b('اشتراك', 'Subscription'),
      ownership: 'org',
      searchable: [],
      sortable: ['startsOn'],
      stageField: 'status',
      fields: [
        f('plan', 'reference', 'الباقة', 'Plan', { required: true, references: 'Plan' }),
        f('status', 'enum', 'الحالة', 'Status', {
          required: true,
          enumValues: ['Trial', 'Active', 'PastDue', 'Cancelled'],
        }),
        f('startsOn', 'date', 'يبدأ في', 'Starts on', { required: true }),
      ],
    }),
  ];
  const roles: RoleSpec[] = [
    adminRole(names),
    {
      name: 'member',
      labels: b('عضو', 'Member'),
      scope: 'own',
      permissions: { Project: ['read'], Task: [...RW], Member: ['read'], Plan: ['read'] },
    },
    viewerRole(names),
  ];
  const spec: AppSpec = {
    ...base(
      brief,
      'saas',
      'A multi-tenant workspace: each organisation registers, invites its members and manages projects, tasks, plans and a subscription.',
    ),
    entities,
    roles,
    pages: [
      {
        path: '/',
        kind: 'dashboard',
        title: b('الرئيسية', 'Dashboard'),
        widgets: [
          { id: 'tasks', kind: 'by_stage', entity: 'Task', title: b('المهام', 'Tasks by stage') },
          { id: 'projects', kind: 'count', entity: 'Project', title: b('المشاريع', 'Projects') },
          { id: 'members', kind: 'count', entity: 'Member', title: b('الأعضاء', 'Members') },
        ],
      },
      { path: '/tasks', kind: 'board', title: b('المهام', 'Tasks'), entity: 'Task' },
    ],
  };
  return {
    product: 'saas',
    spec,
    options: { tenancy: 'multi', signupRole: 'auto' },
    notIncluded: [
      b(
        'تحصيل الاشتراكات (بوابة الدفع) والفوترة والضريبة',
        'Collecting subscription payments (PSP), invoicing and tax',
      ),
      b('دعوات البريد وتسجيل الدخول الموحد (SSO)', 'E-mail invitations and single sign-on'),
    ],
  };
}

// ------------------------------------------------------------------------------------------------ e-commerce (back office)
function ecommerce(brief: ProductBrief): ProductApp {
  const cs = brief.currencies ?? ['SAR', 'USD'];
  const names = ['Category', 'Product', 'ShopCustomer', 'ShopOrder', 'OrderLine'];
  const entities: EntitySpec[] = [
    ent({
      name: 'Category',
      plural: 'categories',
      labels: b('تصنيف', 'Category'),
      ownership: 'org',
      searchable: ['name'],
      sortable: ['name'],
      fields: [
        f('name', 'string', 'الاسم', 'Name', { required: true, unique: true, maxLength: 80 }),
        f('active', 'boolean', 'مفعّل', 'Active', { required: true }),
      ],
    }),
    ent({
      name: 'Product',
      plural: 'products',
      labels: b('منتج', 'Product'),
      ownership: 'org',
      searchable: ['sku', 'name'],
      sortable: ['name', 'priceMinor'],
      fields: [
        f('sku', 'string', 'رمز المنتج', 'SKU', { required: true, unique: true, maxLength: 40 }),
        f('name', 'string', 'الاسم', 'Name', { required: true, maxLength: 160 }),
        f('description', 'text', 'الوصف', 'Description', { maxLength: 4000 }),
        f('category', 'reference', 'التصنيف', 'Category', { references: 'Category' }),
        money('priceMinor', 'السعر (وحدة صغرى)', 'Price (minor units)', { required: true }),
        currency(cs),
        f('stock', 'integer', 'المخزون', 'Stock', { required: true, min: 0 }),
        f('active', 'boolean', 'مفعّل', 'Active', { required: true }),
        f('image', 'file', 'الصورة', 'Image'),
      ],
    }),
    ent({
      name: 'ShopCustomer',
      plural: 'shop_customers',
      labels: b('عميل', 'Customer'),
      ownership: 'org',
      searchable: ['name', 'email'],
      sortable: ['name'],
      fields: [
        f('name', 'string', 'الاسم', 'Name', { required: true, maxLength: 160, pii: true }),
        f('email', 'email', 'البريد', 'Email', { required: true, pii: true }),
        f('phone', 'phone', 'الهاتف', 'Phone', { pii: true }),
        f('city', 'string', 'المدينة', 'City', { maxLength: 80 }),
      ],
    }),
    ent({
      name: 'ShopOrder',
      plural: 'shop_orders',
      labels: b('طلب', 'Order'),
      ownership: 'org',
      searchable: ['number'],
      sortable: ['number', 'placedOn'],
      stageField: 'status',
      fields: [
        f('number', 'string', 'الرقم', 'Number', { required: true, unique: true, maxLength: 30 }),
        f('customer', 'reference', 'العميل', 'Customer', {
          required: true,
          references: 'ShopCustomer',
        }),
        f('status', 'enum', 'الحالة', 'Status', {
          required: true,
          enumValues: [
            'Pending',
            'Paid',
            'Packed',
            'Shipped',
            'Delivered',
            'Cancelled',
            'Refunded',
          ],
        }),
        f('placedOn', 'date', 'تاريخ الطلب', 'Placed on', { required: true }),
        money('totalMinor', 'الإجمالي (وحدة صغرى)', 'Total (minor units)', { required: true }),
        currency(cs),
      ],
    }),
    ent({
      name: 'OrderLine',
      plural: 'order_lines',
      labels: b('بند طلب', 'Order line'),
      ownership: 'org',
      audit: false,
      searchable: [],
      sortable: ['quantity'],
      fields: [
        f('shopOrder', 'reference', 'الطلب', 'Order', { required: true, references: 'ShopOrder' }),
        f('product', 'reference', 'المنتج', 'Product', { required: true, references: 'Product' }),
        f('quantity', 'integer', 'الكمية', 'Quantity', { required: true, min: 1, max: 10_000 }),
        money('unitPriceMinor', 'سعر الوحدة (وحدة صغرى)', 'Unit price (minor units)', {
          required: true,
        }),
      ],
    }),
  ];
  const roles: RoleSpec[] = [
    adminRole(names),
    {
      name: 'merchandiser',
      labels: b('مسؤول الكتالوج', 'Merchandiser'),
      scope: 'all',
      permissions: {
        Category: [...RW, 'export'],
        Product: [...RW, 'import', 'export'],
        ShopOrder: ['read'],
        OrderLine: ['read'],
      },
    },
    {
      name: 'fulfilment',
      labels: b('مسؤول التجهيز', 'Fulfilment'),
      scope: 'all',
      permissions: {
        ShopOrder: ['read', 'update', 'export'],
        OrderLine: ['read'],
        ShopCustomer: ['read'],
        Product: ['read', 'update'],
      },
    },
    {
      name: 'support',
      labels: b('خدمة العملاء', 'Support'),
      scope: 'all',
      permissions: { ShopCustomer: ['read', 'update'], ShopOrder: ['read'], OrderLine: ['read'] },
    },
    viewerRole(names),
  ];
  const spec: AppSpec = {
    ...base(
      brief,
      'ecommerce',
      'Back office of an online shop: categories, products and stock, customers, orders and order lines with role-based access.',
    ),
    entities,
    roles,
    pages: [
      {
        path: '/',
        kind: 'dashboard',
        title: b('الرئيسية', 'Dashboard'),
        widgets: [
          {
            id: 'orders',
            kind: 'by_stage',
            entity: 'ShopOrder',
            title: b('الطلبات', 'Orders by status'),
          },
          { id: 'products', kind: 'count', entity: 'Product', title: b('المنتجات', 'Products') },
          {
            id: 'revenue',
            kind: 'sum',
            entity: 'ShopOrder',
            field: 'totalMinor',
            title: b('إجمالي الطلبات (وحدة صغرى)', 'Order total (minor units)'),
          },
          {
            id: 'recent',
            kind: 'recent',
            entity: 'ShopOrder',
            title: b('آخر الطلبات', 'Recent orders'),
          },
        ],
      },
      { path: '/orders', kind: 'board', title: b('الطلبات', 'Orders'), entity: 'ShopOrder' },
      { path: '/products', kind: 'list', title: b('المنتجات', 'Products'), entity: 'Product' },
    ],
  };
  return {
    product: 'ecommerce',
    spec,
    options: brief.selfRegistration ? { signupRole: 'auto' } : {},
    notIncluded: [
      b(
        'الدفع الإلكتروني وحساب الضريبة وإصدار الفواتير',
        'Payment capture, tax calculation and invoicing',
      ),
      b('واجهة المتجر العامة والسلة', 'A public storefront and cart'),
      b('الشحن وأسعاره', 'Shipping and shipping rates'),
    ],
  };
}

/** The app of a product type. Throws if the produced spec does not pass the builder's own validation (a bug of this generator, caught by its tests). */
export function productApp(product: WebProduct, brief: ProductBrief): ProductApp {
  const app = { crm, erp, saas, ecommerce }[product](brief);
  const check = validateAppSpec(app.spec);
  if (!check.ok)
    throw new Error(
      `product spec ${product} is invalid: ${check.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`,
    );
  return app;
}
