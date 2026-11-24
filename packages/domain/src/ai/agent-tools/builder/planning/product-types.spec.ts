import { describe, expect, it } from 'vitest';
import { PRODUCT_TYPES, PROFILES, analyzeRequirements, buildPlan, planFromText, validatePlan, type ProductType } from './index';

/** One realistic request per product type, in English and Arabic. */
const CASES: Record<ProductType, { en: string; ar: string; must: string[]; stack: string; files?: RegExp }> = {
  website: { en: 'A company website with about, services and a contact form', ar: 'موقع شركة تعريفي مع صفحة من نحن والخدمات ونموذج تواصل', must: ['layout', 'pages', 'contact'], stack: 'next-static' },
  landing: { en: 'A landing page for our new product launch campaign', ar: 'صفحة هبوط لحملة إطلاق منتجنا الجديد', must: ['sections', 'lead-form'], stack: 'next-static' },
  ecommerce: { en: 'An online store to sell products with cart, checkout and orders', ar: 'متجر الكتروني لبيع المنتجات مع سلة وطلبات', must: ['catalog', 'cart', 'orders', 'schema'], stack: 'next-nest-pg' },
  webapp: { en: 'A web application for managing employee requests with a dashboard', ar: 'تطبيق ويب لإدارة طلبات الموظفين مع لوحة مؤشرات', must: ['core', 'ui', 'dashboard'], stack: 'next-nest-pg' },
  mobile: { en: 'A mobile app for iOS and Android to book appointments', ar: 'تطبيق جوال للايفون والاندرويد لحجز المواعيد', must: ['navigation', 'api-client', 'auth'], stack: 'flutter', files: /^test\/.+_test\.dart$/ },
  flutter: { en: 'A Flutter app with offline mode and push notifications', ar: 'تطبيق فلاتر يعمل دون اتصال مع اشعارات التطبيق', must: ['state', 'offline', 'push'], stack: 'flutter', files: /^test\/.+_test\.dart$/ },
  erp: { en: 'An ERP with sales, purchasing, inventory and accounting', ar: 'نظام erp للمبيعات والمشتريات والمخزون والمحاسبة', must: ['sales', 'purchasing', 'inventory', 'accounting'], stack: 'next-nest-pg' },
  crm: { en: 'A CRM to track customers, leads and the sales pipeline', ar: 'نظام ادارة علاقات العملاء لمتابعة العملاء والفرص', must: ['customers', 'pipeline', 'activities'], stack: 'next-nest-pg' },
  saas: { en: 'A SaaS product with subscription plans and multiple organizations', ar: 'منتج ساس بباقات اشتراك وعدة مؤسسات', must: ['tenants', 'billing'], stack: 'next-nest-pg' },
  fullstack: { en: 'A full-stack application to manage tasks', ar: 'تطبيق فل ستاك لادارة المهام', must: ['schema', 'core', 'ui'], stack: 'next-nest-pg' },
  api: { en: 'A REST API service with endpoints for products and orders', ar: 'خدمة واجهه برمجيه لنقاط نهايه المنتجات والطلبات', must: ['resources', 'openapi'], stack: 'nest-pg' },
  database: { en: 'A database schema and data model for a clinic with migrations', ar: 'تصميم قاعده بيانات ونموذج البيانات لعياده مع ترحيلات', must: ['model', 'migrations', 'indexes'], stack: 'postgres-sql', files: /^db\/tests\/.+\.test\.sql$/ },
  auth: { en: 'An authentication service with login system and password reset', ar: 'خدمه مصادقه ونظام تسجيل دخول واستعادة كلمة المرور', must: ['signin', 'reset', 'rate-limit'], stack: 'nest-pg' },
  docs: { en: 'Generate technical documentation and a readme for the project', ar: 'توليد توثيق تقني وملف readme للمشروع', must: ['readme', 'architecture', 'runbook'], stack: 'html-css' },
};

describe('every product type', () => {
  it('has a profile, and a case here', () => {
    expect(Object.keys(PROFILES).sort()).toEqual([...PRODUCT_TYPES].sort());
    expect(Object.keys(CASES).sort()).toEqual([...PRODUCT_TYPES].sort());
  });
  for (const t of PRODUCT_TYPES) {
    for (const lang of ['en', 'ar'] as const) {
      it(`${t} (${lang}): recognised, planned, validated`, () => {
        const c = CASES[t];
        const text = c[lang];
        const a = analyzeRequirements(text, { hint: t });
        expect(a.productType).toBe(t);
        // without the hint the text alone must already point at the type, or at least not be unclear
        const plain = analyzeRequirements(text);
        expect(plain.ambiguities.map((x) => x.id)).not.toContain('product_type_unclear');
        const plan = planFromText(text, { hint: t });
        expect(validatePlan(plan), JSON.stringify(plan.risks)).toEqual({ ok: true });
        const mods = plan.tasks.map((x) => x.moduleId);
        for (const m of c.must) expect(mods, `${t}: ${m}`).toContain(m);
        expect(plan.stack.id).toBe(c.stack);
        if (c.files) expect(plan.tasks.find((x) => x.moduleId === 'tests')!.files.every((f) => c.files!.test(f))).toBe(true);
        expect(plan.tasks.at(-1)!.kind).toBe('review');
        expect(plan.locale).toBe(lang);
      });
    }
  }
  it('unaided text (no hint) picks the intended type for the clear cases', () => {
    for (const t of ['ecommerce', 'crm', 'erp', 'flutter', 'saas', 'landing'] as const) {
      expect(analyzeRequirements(CASES[t].en).productType, t).toBe(t);
      expect(analyzeRequirements(CASES[t].ar).productType, `${t} ar`).toBe(t);
    }
  });
  it('a documentation product has no second generic documentation task and static sites no generated tests', () => {
    const docs = planFromText(CASES.docs.en, { hint: 'docs' });
    expect(docs.tasks.filter((x) => x.moduleId === 'docs')).toEqual([]);
    expect(docs.tasks.find((x) => x.moduleId === 'tests')).toBeUndefined();
    const site = planFromText(CASES.website.en, { hint: 'website' });
    expect(site.tasks.find((x) => x.moduleId === 'tests')).toBeUndefined();
    expect(validatePlan(site)).toEqual({ ok: true });
  });
  it('regulated and external-service areas always carry an approval or a note, never a compliance claim', () => {
    const erp = planFromText(CASES.erp.en, { hint: 'erp' });
    expect(erp.approvals.some((a) => /tax/i.test(a.reason))).toBe(true);
    const mobile = planFromText(CASES.mobile.en, { hint: 'mobile' });
    expect(mobile.approvals.some((a) => /store submission/.test(a.reason))).toBe(true);
    for (const t of PRODUCT_TYPES) {
      const plan = buildPlan(analyzeRequirements(CASES[t].en, { hint: t }));
      const text = JSON.stringify(plan);
      expect(text, t).not.toMatch(/ZATCA[- ]compliant|certified|guarantee/i);
    }
  });
  it('mobile and API products keep their money and idempotency rules in the acceptance criteria', () => {
    const api = planFromText(CASES.api.en, { hint: 'api' });
    expect(JSON.stringify(api.tasks.find((x) => x.moduleId === 'resources')!.acceptance)).toContain('Idempotency-Key');
    const shop = planFromText(CASES.ecommerce.en, { hint: 'ecommerce' });
    expect(JSON.stringify(shop.tasks.find((x) => x.moduleId === 'schema')!.acceptance)).toContain('minor units');
  });
});
