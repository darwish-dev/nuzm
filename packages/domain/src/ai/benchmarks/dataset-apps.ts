import { json, task } from './task-builder';
import type { FixtureFile, GoldenTask } from './types';

/** Extended golden tasks, part 2: e-commerce, mobile (React Native), Flutter, full-stack, ERP, CRM and SaaS. Synthetic; every fixture is authored for this suite. */
const L = (...lines: string[]) => `${lines.join('\n')}\n`;
const f = (path: string, content: string): FixtureFile => ({ path, content });

const CART = L(
  'export interface CartItem {',
  '  sku: string;',
  '  priceMinor: number;',
  '  qty: number;',
  '}',
  '',
  'export function totalMinor(items: CartItem[]): number {',
  '  return items.reduce((sum, i) => sum + i.priceMinor * i.qty, 0);',
  '}',
);
const CATALOG = json({ currency: 'SAR', products: [{ sku: 'A1', name: 'Mug', priceMinor: 4500 }] });
const SHOP = [f('src/cart.ts', CART), f('src/catalog.json', CATALOG)];

const RN_APP = L(
  "import { Text, View } from 'react-native';",
  '',
  'export default function App() {',
  '  return (',
  '    <View>',
  '      <Text>Home</Text>',
  '    </View>',
  '  );',
  '}',
);
const APP_JSON = json({ expo: { name: 'Demo', slug: 'demo', version: '1.0.0' } });
const MOBILE = [f('App.tsx', RN_APP), f('app.json', APP_JSON)];

const PUBSPEC = L(
  'name: demo',
  'description: A demo app.',
  'version: 1.0.0+1',
  'environment:',
  '  sdk: ">=3.0.0 <4.0.0"',
  'dependencies:',
  '  flutter:',
  '    sdk: flutter',
);
const MAIN_DART = L(
  "import 'package:flutter/material.dart';",
  '',
  'void main() => runApp(const DemoApp());',
  '',
  'class DemoApp extends StatelessWidget {',
  '  const DemoApp({super.key});',
  '',
  '  @override',
  '  Widget build(BuildContext context) {',
  "    return const MaterialApp(home: Scaffold(body: Text('Home')));",
  '  }',
  '}',
);
const FLUTTER = [f('pubspec.yaml', PUBSPEC), f('lib/main.dart', MAIN_DART)];

const TYPES = L('export interface Todo {', '  id: string;', '  title: string;', '}');
const SERVER = L(
  "import type { Todo } from '../shared/types';",
  '',
  'export const todos: Todo[] = [];',
  '',
  'export function listTodos(): Todo[] {',
  '  return todos;',
  '}',
);
const CLIENT = L(
  "import type { Todo } from '../shared/types';",
  '',
  'export async function fetchTodos(): Promise<Todo[]> {',
  "  const res = await fetch('/api/todos');",
  '  return res.json();',
  '}',
);
const FULLSTACK = [
  f('shared/types.ts', TYPES),
  f('server/todos.ts', SERVER),
  f('web/client.ts', CLIENT),
];

const INVENTORY = L(
  'export interface StockLine {',
  '  sku: string;',
  '  onHand: number;',
  '}',
  '',
  'export function adjust(line: StockLine, delta: number): StockLine {',
  '  return { ...line, onHand: line.onHand + delta };',
  '}',
);
const PO = L(
  "export type PoStatus = 'draft' | 'approved';",
  '',
  'export interface PurchaseOrder {',
  '  id: string;',
  '  status: PoStatus;',
  '}',
);
const ERP = [f('src/inventory.ts', INVENTORY), f('src/orders.ts', PO)];

const CONTACTS = L(
  'export interface Contact {',
  '  id: string;',
  '  name: string;',
  '  email: string;',
  '}',
  '',
  'export function findByEmail(list: Contact[], email: string): Contact | undefined {',
  '  return list.find((c) => c.email === email);',
  '}',
);
const CRM = [f('src/contacts.ts', CONTACTS)];

const PLANS = L(
  'export const PLANS = {',
  '  free: { seats: 1 },',
  '  pro: { seats: 10 },',
  '} as const;',
  '',
  'export type PlanId = keyof typeof PLANS;',
);
const TENANT = L('export interface Tenant {', '  id: string;', '  plan: string;', '}');
const SAAS = [f('src/plans.ts', PLANS), f('src/tenant.ts', TENANT)];

export const APP_TASKS: readonly GoldenTask[] = [
  // ---- e-commerce
  task({
    id: 'ecom-01-discount',
    category: 'e-commerce',
    locale: 'en',
    title: 'Percentage discount in integer money',
    prompt:
      'Add applyDiscount(totalMinor, percent) to src/cart.ts. It returns the total after the percentage is taken off. Money is integer minor units: no floating point, round the discount down.',
    fixture: SHOP,
    checks: [
      { type: 'contains', path: 'src/cart.ts', text: 'export function applyDiscount' },
      { type: 'contains', path: 'src/cart.ts', text: 'Math.floor' },
      {
        type: 'not_matches',
        path: 'src/cart.ts',
        pattern: String.raw`parseFloat|toFixed|\*\s*0\.`,
      },
    ],
    solution: [
      {
        path: 'src/cart.ts',
        content: `${CART}\nexport function applyDiscount(totalMinor: number, percent: number): number {\n  return totalMinor - Math.floor((totalMinor * percent) / 100);\n}\n`,
      },
    ],
  }),
  task({
    id: 'ecom-02-product-ar',
    category: 'e-commerce',
    locale: 'ar',
    title: 'إضافة منتج إلى الكتالوج',
    prompt:
      'أضف منتجًا ثانيًا إلى src/catalog.json: الرمز B2 والاسم "كوب" والسعر 5200 وحدة صغرى، وأبقِ العملة SAR.',
    fixture: SHOP,
    checks: [
      { type: 'json_valid', path: 'src/catalog.json' },
      { type: 'json_field_equals', path: 'src/catalog.json', field: 'products.1.sku', value: 'B2' },
      {
        type: 'json_field_equals',
        path: 'src/catalog.json',
        field: 'products.1.priceMinor',
        value: 5200,
      },
      { type: 'json_field_equals', path: 'src/catalog.json', field: 'currency', value: 'SAR' },
    ],
    solution: [
      {
        path: 'src/catalog.json',
        content: json({
          currency: 'SAR',
          products: [
            { sku: 'A1', name: 'Mug', priceMinor: 4500 },
            { sku: 'B2', name: 'كوب', priceMinor: 5200 },
          ],
        }),
      },
    ],
  }),
  task({
    id: 'ecom-03-vat',
    category: 'e-commerce',
    locale: 'en',
    title: 'VAT in minor units',
    prompt:
      'Add vatMinor(totalMinor) to src/cart.ts returning 15 percent VAT rounded to the nearest minor unit, in integer arithmetic.',
    fixture: SHOP,
    checks: [
      { type: 'contains', path: 'src/cart.ts', text: 'export function vatMinor' },
      { type: 'matches', path: 'src/cart.ts', pattern: String.raw`\b15\b` },
      { type: 'contains', path: 'src/cart.ts', text: 'Math.round' },
    ],
    solution: [
      {
        path: 'src/cart.ts',
        content: `${CART}\nexport function vatMinor(totalMinor: number): number {\n  return Math.round((totalMinor * 15) / 100);\n}\n`,
      },
    ],
  }),

  // ---- mobile application (React Native / Expo)
  task({
    id: 'mob-01-settings-screen',
    category: 'mobile-application',
    locale: 'en',
    title: 'Add a settings screen',
    prompt:
      'Create src/screens/Settings.tsx: a default-exported function component Settings that shows the text "Settings".',
    fixture: MOBILE,
    checks: [
      { type: 'file_exists', path: 'src/screens/Settings.tsx' },
      {
        type: 'contains',
        path: 'src/screens/Settings.tsx',
        text: 'export default function Settings',
      },
      { type: 'contains', path: 'src/screens/Settings.tsx', text: 'Settings</Text>' },
    ],
    solution: [
      {
        path: 'src/screens/Settings.tsx',
        content: L(
          "import { Text, View } from 'react-native';",
          '',
          'export default function Settings() {',
          '  return (',
          '    <View>',
          '      <Text>Settings</Text>',
          '    </View>',
          '  );',
          '}',
        ),
      },
    ],
  }),
  task({
    id: 'mob-02-app-name-ar',
    category: 'mobile-application',
    locale: 'ar',
    title: 'اسم التطبيق بالعربية',
    prompt: 'غيّر اسم التطبيق في app.json إلى "تطبيقي" دون تغيير الـ slug أو الإصدار.',
    fixture: MOBILE,
    checks: [
      { type: 'json_valid', path: 'app.json' },
      { type: 'json_field_equals', path: 'app.json', field: 'expo.name', value: 'تطبيقي' },
      { type: 'json_field_equals', path: 'app.json', field: 'expo.slug', value: 'demo' },
      { type: 'json_field_equals', path: 'app.json', field: 'expo.version', value: '1.0.0' },
    ],
    solution: [
      {
        path: 'app.json',
        content: json({ expo: { name: 'تطبيقي', slug: 'demo', version: '1.0.0' } }),
      },
    ],
  }),
  task({
    id: 'mob-03-accessible-button',
    category: 'mobile-application',
    locale: 'en',
    title: 'An accessible button',
    prompt:
      'In App.tsx add a Pressable that shows "Continue" and has an accessibilityLabel of "Continue".',
    fixture: MOBILE,
    checks: [
      { type: 'contains', path: 'App.tsx', text: 'Pressable' },
      { type: 'contains', path: 'App.tsx', text: 'accessibilityLabel="Continue"' },
      { type: 'contains', path: 'App.tsx', text: 'Continue</Text>' },
    ],
    solution: [
      {
        path: 'App.tsx',
        content: L(
          "import { Pressable, Text, View } from 'react-native';",
          '',
          'export default function App() {',
          '  return (',
          '    <View>',
          '      <Text>Home</Text>',
          '      <Pressable accessibilityLabel="Continue">',
          '        <Text>Continue</Text>',
          '      </Pressable>',
          '    </View>',
          '  );',
          '}',
        ),
      },
    ],
  }),

  // ---- Flutter
  task({
    id: 'fl-01-counter-widget',
    category: 'flutter-application',
    locale: 'en',
    title: 'A stateful counter widget',
    prompt:
      'Create lib/counter.dart with a StatefulWidget named Counter whose state holds an int that a button increments with setState.',
    fixture: FLUTTER,
    checks: [
      { type: 'file_exists', path: 'lib/counter.dart' },
      { type: 'contains', path: 'lib/counter.dart', text: 'class Counter extends StatefulWidget' },
      { type: 'contains', path: 'lib/counter.dart', text: 'setState' },
    ],
    solution: [
      {
        path: 'lib/counter.dart',
        content: L(
          "import 'package:flutter/material.dart';",
          '',
          'class Counter extends StatefulWidget {',
          '  const Counter({super.key});',
          '',
          '  @override',
          '  State<Counter> createState() => _CounterState();',
          '}',
          '',
          'class _CounterState extends State<Counter> {',
          '  int _count = 0;',
          '',
          '  @override',
          '  Widget build(BuildContext context) {',
          "    return TextButton(onPressed: () => setState(() => _count++), child: Text('$_count'));",
          '  }',
          '}',
        ),
      },
    ],
  }),
  task({
    id: 'fl-02-arabic-locale',
    category: 'flutter-application',
    locale: 'ar',
    title: 'عنوان وإعداد لغة عربية',
    prompt: "في lib/main.dart أضف إلى MaterialApp العنوان 'تطبيقي' وlocale: const Locale('ar').",
    fixture: FLUTTER,
    checks: [
      { type: 'contains', path: 'lib/main.dart', text: "title: 'تطبيقي'" },
      { type: 'contains', path: 'lib/main.dart', text: "Locale('ar')" },
    ],
    solution: [
      {
        path: 'lib/main.dart',
        content: MAIN_DART.replace(
          'const MaterialApp(home:',
          "const MaterialApp(title: 'تطبيقي', locale: Locale('ar'), home:",
        ),
      },
    ],
  }),
  task({
    id: 'fl-03-dependency',
    category: 'flutter-application',
    locale: 'en',
    title: 'Add a package dependency',
    prompt:
      'Add the http package (^1.2.0) to the dependencies in pubspec.yaml without removing the flutter sdk dependency.',
    fixture: FLUTTER,
    checks: [
      {
        type: 'matches',
        path: 'pubspec.yaml',
        pattern: String.raw`dependencies:[\s\S]*\n  http: \^1\.2\.0`,
      },
      { type: 'contains', path: 'pubspec.yaml', text: 'sdk: flutter' },
    ],
    solution: [
      {
        path: 'pubspec.yaml',
        content: `${PUBSPEC}  http: ^1.2.0\n`.replace(
          'sdk: flutter\n  http',
          'sdk: flutter\n  http',
        ),
      },
    ],
  }),

  // ---- full-stack (multi-file by nature)
  task({
    id: 'fs-01-done-field',
    category: 'full-stack',
    locale: 'en',
    title: 'Add a done flag across the stack',
    prompt:
      'A todo needs a "done" flag. Add done: boolean to the shared Todo type and add addTodo(title) in server/todos.ts that creates a todo with done: false.',
    fixture: FULLSTACK,
    mustCall: ['read_file'],
    checks: [
      { type: 'contains', path: 'shared/types.ts', text: 'done: boolean' },
      { type: 'contains', path: 'server/todos.ts', text: 'export function addTodo' },
      { type: 'contains', path: 'server/todos.ts', text: 'done: false' },
    ],
    solution: [
      {
        path: 'shared/types.ts',
        content: L(
          'export interface Todo {',
          '  id: string;',
          '  title: string;',
          '  done: boolean;',
          '}',
        ),
      },
      {
        path: 'server/todos.ts',
        content: `${SERVER}\nexport function addTodo(title: string): Todo {\n  const todo: Todo = { id: String(todos.length + 1), title, done: false };\n  todos.push(todo);\n  return todo;\n}\n`,
      },
    ],
  }),
  task({
    id: 'fs-02-create-endpoint',
    category: 'full-stack',
    locale: 'en',
    title: 'Create a todo from the client',
    prompt:
      'Add createTodo(title) to web/client.ts that POSTs {title} as JSON to /api/todos and returns the created Todo.',
    fixture: FULLSTACK,
    checks: [
      { type: 'contains', path: 'web/client.ts', text: 'export async function createTodo' },
      { type: 'contains', path: 'web/client.ts', text: "method: 'POST'" },
      { type: 'contains', path: 'web/client.ts', text: 'JSON.stringify({ title })' },
    ],
    solution: [
      {
        path: 'web/client.ts',
        content: `${CLIENT}\nexport async function createTodo(title: string): Promise<Todo> {\n  const res = await fetch('/api/todos', {\n    method: 'POST',\n    headers: { 'content-type': 'application/json' },\n    body: JSON.stringify({ title }),\n  });\n  return res.json();\n}\n`,
      },
    ],
  }),
  task({
    id: 'fs-03-delete-ar',
    category: 'full-stack',
    locale: 'ar',
    title: 'حذف مهمة من الخادم والعميل',
    prompt:
      'أضف removeTodo(id) في server/todos.ts تحذف المهمة من المصفوفة، وأضف deleteTodo(id) في web/client.ts ترسل طلب DELETE إلى /api/todos/ مع المعرّف.',
    fixture: FULLSTACK,
    checks: [
      { type: 'contains', path: 'server/todos.ts', text: 'export function removeTodo' },
      { type: 'contains', path: 'web/client.ts', text: 'export async function deleteTodo' },
      { type: 'contains', path: 'web/client.ts', text: "method: 'DELETE'" },
    ],
    solution: [
      {
        path: 'server/todos.ts',
        content: `${SERVER}\nexport function removeTodo(id: string): boolean {\n  const i = todos.findIndex((t) => t.id === id);\n  if (i === -1) return false;\n  todos.splice(i, 1);\n  return true;\n}\n`,
      },
      {
        path: 'web/client.ts',
        content: `${CLIENT}\nexport async function deleteTodo(id: string): Promise<void> {\n  await fetch(\`/api/todos/\${id}\`, { method: 'DELETE' });\n}\n`,
      },
    ],
  }),

  // ---- ERP
  task({
    id: 'erp-01-no-negative-stock',
    category: 'erp',
    locale: 'en',
    title: 'Refuse negative stock',
    prompt:
      'adjust() must never produce a negative on-hand quantity: throw a RangeError when the result would be below zero.',
    fixture: ERP,
    checks: [
      { type: 'contains', path: 'src/inventory.ts', text: 'RangeError' },
      { type: 'matches', path: 'src/inventory.ts', pattern: String.raw`<\s*0` },
    ],
    solution: [
      {
        path: 'src/inventory.ts',
        content: L(
          'export interface StockLine {',
          '  sku: string;',
          '  onHand: number;',
          '}',
          '',
          'export function adjust(line: StockLine, delta: number): StockLine {',
          '  const onHand = line.onHand + delta;',
          "  if (onHand < 0) throw new RangeError('stock cannot go below zero');",
          '  return { ...line, onHand };',
          '}',
        ),
      },
    ],
  }),
  task({
    id: 'erp-02-received-status',
    category: 'erp',
    locale: 'en',
    title: 'Receive a purchase order',
    prompt:
      "Add a 'received' status to PoStatus and a receive(po) function in src/orders.ts that returns the order with status 'received', refusing an order that is not 'approved'.",
    fixture: ERP,
    checks: [
      { type: 'matches', path: 'src/orders.ts', pattern: String.raw`PoStatus = [^;]*'received'` },
      { type: 'contains', path: 'src/orders.ts', text: 'export function receive' },
      { type: 'contains', path: 'src/orders.ts', text: "'approved'" },
      { type: 'matches', path: 'src/orders.ts', pattern: 'throw' },
    ],
    solution: [
      {
        path: 'src/orders.ts',
        content: L(
          "export type PoStatus = 'draft' | 'approved' | 'received';",
          '',
          'export interface PurchaseOrder {',
          '  id: string;',
          '  status: PoStatus;',
          '}',
          '',
          'export function receive(po: PurchaseOrder): PurchaseOrder {',
          "  if (po.status !== 'approved') throw new Error('only an approved order can be received');",
          "  return { ...po, status: 'received' };",
          '}',
        ),
      },
    ],
  }),
  task({
    id: 'erp-03-reorder-ar',
    category: 'erp',
    locale: 'ar',
    title: 'تنبيه إعادة الطلب',
    prompt:
      'أضف إلى src/inventory.ts الدالة needsReorder(line, minimum) التي تعيد true عندما تكون الكمية المتوفرة أقل من الحد الأدنى.',
    fixture: ERP,
    checks: [
      { type: 'contains', path: 'src/inventory.ts', text: 'export function needsReorder' },
      { type: 'matches', path: 'src/inventory.ts', pattern: String.raw`onHand\s*<\s*minimum` },
    ],
    solution: [
      {
        path: 'src/inventory.ts',
        content: `${INVENTORY}\nexport function needsReorder(line: StockLine, minimum: number): boolean {\n  return line.onHand < minimum;\n}\n`,
      },
    ],
  }),

  // ---- CRM
  task({
    id: 'crm-01-email-case',
    category: 'crm',
    locale: 'en',
    title: 'Case-insensitive contact lookup',
    prompt: 'findByEmail must match emails regardless of letter case.',
    fixture: CRM,
    checks: [
      { type: 'contains', path: 'src/contacts.ts', text: 'toLowerCase()' },
      { type: 'contains', path: 'src/contacts.ts', text: 'export function findByEmail' },
    ],
    solution: [
      {
        path: 'src/contacts.ts',
        content: L(
          'export interface Contact {',
          '  id: string;',
          '  name: string;',
          '  email: string;',
          '}',
          '',
          'export function findByEmail(list: Contact[], email: string): Contact | undefined {',
          '  const wanted = email.toLowerCase();',
          '  return list.find((c) => c.email.toLowerCase() === wanted);',
          '}',
        ),
      },
    ],
  }),
  task({
    id: 'crm-02-pipeline-stage',
    category: 'crm',
    locale: 'en',
    title: 'Pipeline stages',
    prompt:
      "Create src/pipeline.ts with a Stage type ('lead' | 'qualified' | 'won' | 'lost') and advance(stage) that moves lead to qualified and qualified to won; won and lost stay as they are.",
    fixture: CRM,
    checks: [
      { type: 'file_exists', path: 'src/pipeline.ts' },
      {
        type: 'matches',
        path: 'src/pipeline.ts',
        pattern: String.raw`'lead'[\s\S]*'qualified'[\s\S]*'won'[\s\S]*'lost'`,
      },
      { type: 'contains', path: 'src/pipeline.ts', text: 'export function advance' },
    ],
    solution: [
      {
        path: 'src/pipeline.ts',
        content: L(
          "export type Stage = 'lead' | 'qualified' | 'won' | 'lost';",
          '',
          'export function advance(stage: Stage): Stage {',
          "  if (stage === 'lead') return 'qualified';",
          "  if (stage === 'qualified') return 'won';",
          '  return stage;',
          '}',
        ),
      },
    ],
  }),
  task({
    id: 'crm-03-dedupe-ar',
    category: 'crm',
    locale: 'ar',
    title: 'إزالة جهات الاتصال المكررة',
    prompt:
      'أضف dedupeByEmail(list) إلى src/contacts.ts: تحتفظ بأول جهة اتصال لكل بريد إلكتروني (بغض النظر عن حالة الأحرف).',
    fixture: CRM,
    checks: [
      { type: 'contains', path: 'src/contacts.ts', text: 'export function dedupeByEmail' },
      { type: 'matches', path: 'src/contacts.ts', pattern: String.raw`new Set` },
      { type: 'contains', path: 'src/contacts.ts', text: 'toLowerCase()' },
    ],
    solution: [
      {
        path: 'src/contacts.ts',
        content: `${CONTACTS}\nexport function dedupeByEmail(list: Contact[]): Contact[] {\n  const seen = new Set<string>();\n  return list.filter((c) => {\n    const key = c.email.toLowerCase();\n    if (seen.has(key)) return false;\n    seen.add(key);\n    return true;\n  });\n}\n`,
      },
    ],
  }),

  // ---- SaaS
  task({
    id: 'saas-01-enterprise-plan',
    category: 'saas',
    locale: 'en',
    title: 'Add an enterprise plan',
    prompt:
      'Add an "enterprise" plan with 100 seats to PLANS in src/plans.ts, keeping free and pro.',
    fixture: SAAS,
    checks: [
      {
        type: 'matches',
        path: 'src/plans.ts',
        pattern: String.raw`enterprise:\s*\{\s*seats:\s*100\s*\}`,
      },
      { type: 'contains', path: 'src/plans.ts', text: 'free:' },
      { type: 'contains', path: 'src/plans.ts', text: 'pro:' },
    ],
    solution: [
      {
        path: 'src/plans.ts',
        content: L(
          'export const PLANS = {',
          '  free: { seats: 1 },',
          '  pro: { seats: 10 },',
          '  enterprise: { seats: 100 },',
          '} as const;',
          '',
          'export type PlanId = keyof typeof PLANS;',
        ),
      },
    ],
  }),
  task({
    id: 'saas-02-seat-limit',
    category: 'saas',
    locale: 'en',
    title: 'Seat limit check',
    prompt:
      'Add canAddSeat(plan, used) to src/plans.ts: true when used seats are below the plan seat limit.',
    fixture: SAAS,
    checks: [
      { type: 'contains', path: 'src/plans.ts', text: 'export function canAddSeat' },
      {
        type: 'matches',
        path: 'src/plans.ts',
        pattern: String.raw`used\s*<\s*PLANS\[plan\]\.seats`,
      },
    ],
    solution: [
      {
        path: 'src/plans.ts',
        content: `${PLANS}\nexport function canAddSeat(plan: PlanId, used: number): boolean {\n  return used < PLANS[plan].seats;\n}\n`,
      },
    ],
  }),
  task({
    id: 'saas-03-tenant-key-ar',
    category: 'saas',
    locale: 'ar',
    title: 'مفاتيح معزولة لكل مستأجر',
    prompt:
      'أضف إلى src/tenant.ts الدالة tenantKey(tenantId, key) التي تعيد "tenantId:key" وترمي خطأ إذا كان معرّف المستأجر فارغًا.',
    fixture: SAAS,
    checks: [
      { type: 'contains', path: 'src/tenant.ts', text: 'export function tenantKey' },
      { type: 'contains', path: 'src/tenant.ts', text: '${tenantId}:${key}' },
      { type: 'contains', path: 'src/tenant.ts', text: 'throw' },
    ],
    solution: [
      {
        path: 'src/tenant.ts',
        content: `${TENANT}\nexport function tenantKey(tenantId: string, key: string): string {\n  if (tenantId === '') throw new Error('tenantId is required');\n  return \`\${tenantId}:\${key}\`;\n}\n`,
      },
    ],
  }),
];
