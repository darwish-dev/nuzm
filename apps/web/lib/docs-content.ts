import type { L } from './site-content';

/**
 * Developer-guide content (Arabic and English). Everything here restates the platform contract (spec/openapi/openapi.yaml, docs/04): conventions that are not
 * implemented are not documented as if they were (for example, rate-limit headers are not part of the contract yet, so the guide only says to back off).
 * Code samples are language-neutral and use placeholders (`$NUZM_API`, `$NUZM_API_KEY`), never a real host or key.
 */
export type Block =
  | { t: 'p'; v: L }
  | { t: 'h'; v: L }
  | { t: 'ul'; v: L[] }
  | { t: 'note'; v: L }
  | { t: 'code'; lang: 'bash' | 'js' | 'json' | 'http'; v: string; caption?: L }
  | { t: 'table'; head: L[]; rows: L[][] }
  | { t: 'errors' };

export interface Guide {
  slug: string;
  title: L;
  summary: L;
  blocks: Block[];
}

const l = (en: string, ar: string): L => ({ en, ar });

export const GUIDES: Guide[] = [
  {
    slug: 'quickstart',
    title: l('Quickstart', 'البدء السريع'),
    summary: l(
      'Create an API key and make your first call in a few minutes.',
      'أنشئ مفتاح واجهة واجرِ أول طلب خلال دقائق.',
    ),
    blocks: [
      {
        t: 'p',
        v: l(
          'Every integration starts the same way: an organization administrator creates an API key, and your code sends it with each request. The API is JSON over HTTPS under `/v1`.',
          'تبدأ كل عملية تكامل بالطريقة نفسها: يُنشئ مدير المنظمة مفتاح واجهة، ويرسله كودك مع كل طلب. الواجهة JSON عبر HTTPS تحت `/v1`.',
        ),
      },
      { t: 'h', v: l('1. Create an API key', '١. أنشئ مفتاح واجهة') },
      {
        t: 'ul',
        v: [
          l(
            'Open your dashboard, then Settings, then API keys, and create a key.',
            'افتح لوحة التحكم، ثم الإعدادات، ثم مفاتيح الواجهة، وأنشئ مفتاحًا.',
          ),
          l(
            'Choose only the permissions the integration needs. A key can never do more than the person who created it.',
            'اختر الصلاحيات التي يحتاجها التكامل فقط. لا يستطيع المفتاح فعل أكثر مما يستطيعه من أنشأه.',
          ),
          l(
            'Copy the key now. It starts with `nzk_` and is shown once; we keep only a hash.',
            'انسخ المفتاح الآن. يبدأ بـ `nzk_` ويظهر مرة واحدة، ولا نحتفظ إلا بقيمة مُجزَّأة منه.',
          ),
        ],
      },
      { t: 'h', v: l('2. Make your first call', '٢. أجرِ أول طلب') },
      {
        t: 'code',
        lang: 'bash',
        caption: l('List your projects', 'اعرض مشاريعك'),
        v: 'curl "$NUZM_API/v1/projects?limit=10" \\\n  -H "Authorization: Bearer $NUZM_API_KEY"',
      },
      {
        t: 'p',
        v: l(
          'A successful list answers with `items` and a `nextCursor`. An error answers with `application/problem+json`; see Errors.',
          'يرد الطلب الناجح بـ `items` و`nextCursor`. وفي الخطأ يرد بـ `application/problem+json`؛ راجع الأخطاء.',
        ),
      },
      { t: 'h', v: l('3. Create something', '٣. أنشئ شيئًا') },
      {
        t: 'p',
        v: l(
          'Requests that create or charge need an `Idempotency-Key` so a retry never does the work twice.',
          'الطلبات التي تُنشئ أو تُحاسِب تحتاج `Idempotency-Key` حتى لا يتكرر العمل عند إعادة المحاولة.',
        ),
      },
      {
        t: 'code',
        lang: 'bash',
        v: 'curl -X POST "$NUZM_API/v1/webhook-endpoints" \\\n  -H "Authorization: Bearer $NUZM_API_KEY" \\\n  -H "Idempotency-Key: $(uuidgen)" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"url":"https://example.com/hooks/nuzm","events":["site.deployed","domain.registered"]}\'',
      },
      {
        t: 'note',
        v: l(
          'Your API host is the address of your Nuzm deployment. The examples use `$NUZM_API` for it.',
          'مضيف الواجهة هو عنوان نشر نظم الخاص بك. تستخدم الأمثلة `$NUZM_API` للدلالة عليه.',
        ),
      },
    ],
  },
  {
    slug: 'authentication',
    title: l('Authentication', 'المصادقة'),
    summary: l(
      'API keys, scopes, organizations and acting for a client.',
      'مفاتيح الواجهة والنطاقات والمنظمات والعمل نيابة عن عميل.',
    ),
    blocks: [
      {
        t: 'p',
        v: l(
          'Send your key as a bearer token on every request. Never put a key in a URL, in client-side code or in a repository.',
          'أرسل مفتاحك كرمز حامل في كل طلب. لا تضعه في عنوان URL ولا في كود يعمل عند المستخدم ولا في مستودع.',
        ),
      },
      { t: 'code', lang: 'http', v: 'Authorization: Bearer nzk_…' },
      { t: 'h', v: l('What a key can do', 'ماذا يستطيع المفتاح') },
      {
        t: 'ul',
        v: [
          l(
            'A key belongs to one organization. The organization comes from the key; a body or query parameter never selects it.',
            'المفتاح تابع لمنظمة واحدة. تُؤخذ المنظمة من المفتاح، ولا يحددها أي حقل في الطلب.',
          ),
          l(
            'A key carries a subset of its creator’s permissions (its scopes). A call outside them answers `403`.',
            'يحمل المفتاح جزءًا من صلاحيات من أنشأه (نطاقاته). الطلب خارجها يردّ بـ `403`.',
          ),
          l(
            'A key can expire and can be limited to a list of IP addresses. Set both for production integrations.',
            'يمكن أن ينتهي المفتاح، ويمكن حصره بقائمة عناوين IP. اضبط الاثنين في تكاملات الإنتاج.',
          ),
          l(
            'Creating a key needs a recent multi-factor check by a person in the dashboard.',
            'إنشاء المفتاح يتطلب تحققًا حديثًا متعدد العوامل من شخص في لوحة التحكم.',
          ),
        ],
      },
      {
        t: 'h',
        v: l(
          'Acting for a client (agencies and resellers)',
          'العمل نيابة عن عميل (الوكالات والموزّعون)',
        ),
      },
      {
        t: 'p',
        v: l(
          'An agency or reseller can act inside a client organization by sending `X-Nuzm-Acting-Org`. The header is checked against the access the client has delegated.',
          'تستطيع الوكالة أو الموزّع العمل داخل منظمة عميل بإرسال `X-Nuzm-Acting-Org`. يُتحقَّق من الترويسة مقابل الصلاحيات التي فوّضها العميل.',
        ),
      },
      {
        t: 'code',
        lang: 'http',
        v: 'Authorization: Bearer nzk_…\nX-Nuzm-Acting-Org: 0190b1e0-0000-7000-8000-000000000000',
      },
      { t: 'h', v: l('Rotating a key', 'تدوير المفتاح') },
      {
        t: 'p',
        v: l(
          'Create the new key, deploy it, then revoke the old one (`DELETE /v1/api-keys/{id}`).',
          'أنشئ المفتاح الجديد، وانشره، ثم ألغِ القديم (`DELETE /v1/api-keys/{id}`).',
        ),
      },
    ],
  },
  {
    slug: 'requests',
    title: l('Requests and data', 'الطلبات والبيانات'),
    summary: l(
      'Formats for ids, timestamps and money, and how to update safely.',
      'صيغ المعرّفات والأوقات والمبالغ، وكيف تُعدّل بأمان.',
    ),
    blocks: [
      {
        t: 'table',
        head: [l('Topic', 'الموضوع'), l('Rule', 'القاعدة')],
        rows: [
          [
            l('Base', 'الأساس'),
            l(
              '`/v1`, JSON, UTF-8. A breaking change would be `/v2`.',
              '`/v1` وJSON وUTF-8. التغيير الكاسر يكون `/v2`.',
            ),
          ],
          [l('Fields', 'الحقول'), l('camelCase.', 'بصيغة camelCase.')],
          [l('Ids', 'المعرّفات'), l('UUIDv7 strings.', 'نصوص UUIDv7.')],
          [l('Time', 'الوقت'), l('RFC 3339 in UTC.', 'RFC 3339 بالتوقيت العالمي.')],
          [
            l('Money', 'المال'),
            l(
              '`{ "amount": "12345", "currency": "SAR" }`: `amount` is an integer string in minor units (halalas), never a decimal.',
              '`{ "amount": "12345", "currency": "SAR" }`: قيمة `amount` نص صحيح بأصغر وحدة (هللة)، ولا تكون كسرًا عشريًا.',
            ),
          ],
          [
            l('Region', 'المنطقة'),
            l(
              'Resources that live in a region return `dataRegion` and `providerRegionId`.',
              'الموارد التي تقع في منطقة تُرجع `dataRegion` و`providerRegionId`.',
            ),
          ],
        ],
      },
      { t: 'h', v: l('Updating safely', 'التعديل بأمان') },
      {
        t: 'p',
        v: l(
          'Resources that can be edited return an `ETag`. Send it back as `If-Match` on `PATCH` and `PUT`. If someone else changed the resource, you get `412` instead of overwriting their work; a missing header answers `428`.',
          'الموارد القابلة للتعديل تُرجع `ETag`. أعده في `If-Match` عند `PATCH` و`PUT`. إن غيّر غيرك المورد تحصل على `412` بدل أن تكتب فوق عمله، والترويسة الناقصة تردّ بـ `428`.',
        ),
      },
      {
        t: 'code',
        lang: 'bash',
        v: 'curl -X PATCH "$NUZM_API/v1/projects/$ID" \\\n  -H "Authorization: Bearer $NUZM_API_KEY" \\\n  -H "If-Match: $ETAG" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"name":"New name"}\'',
      },
    ],
  },
  {
    slug: 'idempotency',
    title: l('Idempotency', 'عدم تكرار التنفيذ'),
    summary: l(
      'Retry any create or charge without doing it twice.',
      'أعد أي طلب إنشاء أو محاسبة دون أن يُنفَّذ مرتين.',
    ),
    blocks: [
      {
        t: 'p',
        v: l(
          'Send an `Idempotency-Key` on every `POST` that creates or charges. Use a new random value (a UUID) for each logical operation and reuse it only when you retry that same operation.',
          'أرسل `Idempotency-Key` مع كل `POST` يُنشئ أو يُحاسِب. استخدم قيمة عشوائية جديدة (UUID) لكل عملية منطقية، وأعد استخدامها فقط عند إعادة المحاولة لنفس العملية.',
        ),
      },
      {
        t: 'ul',
        v: [
          l(
            'Same key and same body: the first response is replayed. Nothing happens a second time.',
            'المفتاح نفسه والمحتوى نفسه: يُعاد الرد الأول ولا يحدث شيء مرة ثانية.',
          ),
          l(
            'Same key and a different body: `422 idempotency_key_reuse`.',
            'المفتاح نفسه ومحتوى مختلف: `422 idempotency_key_reuse`.',
          ),
          l(
            'Same key while the first request is still running: `409 idempotency_in_progress`. Wait and retry.',
            'المفتاح نفسه والطلب الأول لم ينتهِ: `409 idempotency_in_progress`. انتظر ثم أعد المحاولة.',
          ),
          l(
            'No key on a request that needs one: `400 idempotency_key_required`.',
            'لا مفتاح في طلب يحتاجه: `400 idempotency_key_required`.',
          ),
        ],
      },
      {
        t: 'code',
        lang: 'js',
        v: "async function createEndpoint(body) {\n  const key = crypto.randomUUID(); // one key for the whole operation\n  for (let attempt = 0; attempt < 3; attempt++) {\n    const res = await fetch(`${API}/v1/webhook-endpoints`, {\n      method: 'POST',\n      headers: { Authorization: `Bearer ${KEY}`, 'Idempotency-Key': key, 'Content-Type': 'application/json' },\n      body: JSON.stringify(body),\n    });\n    if (res.status < 500) return res.json(); // retrying is safe only because the key is reused\n    await new Promise((r) => setTimeout(r, 2 ** attempt * 500));\n  }\n  throw new Error('still failing, check the operation before trying again');\n}",
      },
    ],
  },
  {
    slug: 'errors',
    title: l('Errors', 'الأخطاء'),
    summary: l(
      'One error shape, and a stable code you can program against.',
      'شكل واحد للخطأ، ورمز ثابت تبرمج عليه.',
    ),
    blocks: [
      {
        t: 'p',
        v: l(
          'Errors follow RFC 9457 (`application/problem+json`). Branch on `code`, which is stable, never on the human text in `title`.',
          'تتبع الأخطاء RFC 9457 (`application/problem+json`). افرّع الكود على `code` وهو ثابت، ولا تعتمد على نص `title`.',
        ),
      },
      {
        t: 'code',
        lang: 'json',
        v: '{\n  "type": "about:blank",\n  "title": "Validation failed",\n  "status": 422,\n  "code": "validation_failed",\n  "traceId": "0190b1e0…",\n  "errors": [{ "field": "name", "message": "is required" }]\n}',
      },
      {
        t: 'ul',
        v: [
          l(
            'Quote `traceId` when you contact support: it finds your request in our logs.',
            'اذكر `traceId` عند التواصل مع الدعم: به نجد طلبك في السجلات.',
          ),
          l(
            '`4xx` means fix the request. `5xx` means try again with backoff, using the same `Idempotency-Key`.',
            '`4xx` تعني صحّح الطلب. و`5xx` تعني أعد المحاولة مع انتظار متزايد وبنفس `Idempotency-Key`.',
          ),
          l(
            'Rate-limit headers are not part of the contract yet. Treat `429` and `503` as a signal to slow down and retry with backoff.',
            'ترويسات حدّ المعدل ليست جزءًا من العقد بعد. اعتبر `429` و`503` إشارة للتمهّل وإعادة المحاولة بانتظار متزايد.',
          ),
        ],
      },
      { t: 'h', v: l('Error codes', 'رموز الأخطاء') },
      { t: 'errors' },
    ],
  },
  {
    slug: 'pagination',
    title: l('Pagination and filtering', 'الترقيم والتصفية'),
    summary: l('Cursor pagination, filters and sorting.', 'الترقيم بالمؤشر والتصفية والترتيب.'),
    blocks: [
      {
        t: 'p',
        v: l(
          'Lists take `limit` (1 to 200) and `cursor`, and answer `{ "items": [...], "nextCursor": "…" }`. When `nextCursor` is null you have everything.',
          'تقبل القوائم `limit` (من 1 إلى 200) و`cursor`، وتردّ `{ "items": [...], "nextCursor": "…" }`. عندما يكون `nextCursor` فارغًا تكون قد حصلت على كل شيء.',
        ),
      },
      {
        t: 'code',
        lang: 'js',
        v: "let cursor;\ndo {\n  const url = new URL(`${API}/v1/projects`);\n  url.searchParams.set('limit', '100');\n  if (cursor) url.searchParams.set('cursor', cursor);\n  const page = await (await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } })).json();\n  for (const item of page.items) handle(item);\n  cursor = page.nextCursor;\n} while (cursor);",
      },
      {
        t: 'p',
        v: l(
          'Where an endpoint supports them, filters are `filter[field]=value` and sorting is `sort=-createdAt`. The reference lists the parameters each endpoint accepts.',
          'حيث تدعمها نقطة النهاية، تكون التصفية `filter[field]=value` والترتيب `sort=-createdAt`. يعرض المرجع المعاملات التي تقبلها كل نقطة.',
        ),
      },
    ],
  },
  {
    slug: 'operations',
    title: l('Long-running work', 'الأعمال الطويلة'),
    summary: l('202 responses and operations you can follow.', 'ردود 202 وعمليات يمكنك متابعتها.'),
    blocks: [
      {
        t: 'p',
        v: l(
          'Work that takes time (creating a server, restoring a backup, publishing a site) answers `202 Accepted` with an operation. The resource shows a `status` and an `operationId`.',
          'الأعمال التي تستغرق وقتًا (إنشاء خادم، استعادة نسخة، نشر موقع) ترد بـ `202 Accepted` مع عملية. يعرض المورد `status` و`operationId`.',
        ),
      },
      {
        t: 'code',
        lang: 'bash',
        v: 'curl "$NUZM_API/v1/operations/$OPERATION_ID" \\\n  -H "Authorization: Bearer $NUZM_API_KEY"',
      },
      {
        t: 'ul',
        v: [
          l(
            'Poll with a growing delay, or use a webhook to be told when it finishes.',
            'استعلم بفاصل متزايد، أو استخدم webhook ليخبرك عند الانتهاء.',
          ),
          l(
            'If a call times out, do not repeat it blindly: look at the operation or resource first, then retry with the same `Idempotency-Key`.',
            'إذا انتهت مهلة طلب فلا تكرره عشوائيًا: انظر إلى العملية أو المورد أولًا، ثم أعد المحاولة بنفس `Idempotency-Key`.',
          ),
        ],
      },
    ],
  },
  {
    slug: 'webhooks',
    title: l('Webhooks', 'الإشعارات (Webhooks)'),
    summary: l(
      'Receive events and verify that they come from Nuzm.',
      'استقبل الأحداث وتحقق أنها قادمة من نظم.',
    ),
    blocks: [
      {
        t: 'p',
        v: l(
          'Create an endpoint with `POST /v1/webhook-endpoints`. The URL must be HTTPS and public. The signing secret (`whsec_…`) is shown once.',
          'أنشئ نقطة استقبال بـ `POST /v1/webhook-endpoints`. يجب أن يكون العنوان HTTPS وعامًا. يظهر سرّ التوقيع (`whsec_…`) مرة واحدة.',
        ),
      },
      {
        t: 'p',
        v: l(
          'Choose the events you want in `events`. The topics today are `invoice.issued`, `ai.run.completed`, `site.deployed`, `domain.registered`, `payment.succeeded`, `payment.failed`, `org.created` and `resource.state_changed`.',
          'اختر الأحداث التي تريدها في `events`. المواضيع الحالية: `invoice.issued` و`ai.run.completed` و`site.deployed` و`domain.registered` و`payment.succeeded` و`payment.failed` و`org.created` و`resource.state_changed`.',
        ),
      },
      { t: 'h', v: l('Verify the signature', 'تحقق من التوقيع') },
      {
        t: 'p',
        v: l(
          'Each delivery carries `X-Nuzm-Signature: t=<unix>,v1=<hmac>`, where the HMAC is SHA-256 over `<t>.<raw body>` with your secret. Reject a timestamp older than five minutes, and ignore an event id you already handled (`X-Nuzm-Event-Id`).',
          'تحمل كل رسالة `X-Nuzm-Signature: t=<unix>,v1=<hmac>`، حيث HMAC بخوارزمية SHA-256 على `<t>.<raw body>` بسرّك. ارفض الطابع الزمني الأقدم من خمس دقائق، وتجاهل معرّف حدث سبق أن عالجته (`X-Nuzm-Event-Id`).',
        ),
      },
      {
        t: 'code',
        lang: 'js',
        v: "import { createHmac, timingSafeEqual } from 'node:crypto';\n\nexport function verify(rawBody, header, secret, now = Date.now()) {\n  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));\n  if (Math.abs(now / 1000 - Number(parts.t)) > 300) return false; // too old\n  const expected = createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');\n  const a = Buffer.from(expected);\n  const b = Buffer.from(parts.v1 ?? '');\n  return a.length === b.length && timingSafeEqual(a, b);\n}",
      },
      { t: 'h', v: l('Delivery and retries', 'التسليم وإعادة المحاولة') },
      {
        t: 'ul',
        v: [
          l(
            'Answer with any `2xx` quickly, and do the work afterwards. Anything else counts as a failure.',
            'ردّ بأي `2xx` بسرعة، ونفّذ العمل بعد ذلك. أي رد آخر يُعدّ فشلًا.',
          ),
          l(
            'Failed deliveries are retried on an exponential schedule for up to 24 hours, then set aside.',
            'تُعاد المحاولة للرسائل الفاشلة بجدول متزايد حتى 24 ساعة، ثم تُحفظ جانبًا.',
          ),
          l(
            'Rotating a secret keeps the old one working for the overlap you choose, so you can switch without missing events.',
            'تدوير السرّ يُبقي القديم صالحًا طوال فترة التداخل التي تختارها، لتنتقل دون أن تفوتك أحداث.',
          ),
        ],
      },
    ],
  },
];

export const guideBySlug = (slug: string): Guide | undefined => GUIDES.find((g) => g.slug === slug);

/** Texts of the documentation chrome. */
export const DOC: Record<string, L> = {
  developers: l('Developers', 'المطوّرون'),
  docs: l('Documentation', 'التوثيق'),
  eyebrow: l('NUZM DEVELOPERS', 'مطوّرو نظم'),
  title: l('Build on the Nuzm API.', 'ابنِ فوق واجهة نظم.'),
  intro: l(
    'Hosting, domains, servers, email, data and AI through one REST API. Authenticate with an API key, send JSON, and connect Nuzm to your own systems.',
    'الاستضافة والنطاقات والخوادم والبريد والبيانات والذكاء الاصطناعي عبر واجهة REST واحدة. صادق بمفتاح واجهة، وأرسل JSON، واربط نظم بأنظمتك.',
  ),
  readQuickstart: l('Read the quickstart', 'اقرأ البدء السريع'),
  openReference: l('Open the API reference', 'افتح مرجع الواجهة'),
  guides: l('Guides', 'الأدلة'),
  reference: l('API reference', 'مرجع الواجهة'),
  downloads: l('Downloads', 'التنزيلات'),
  downloadOpenapi: l('OpenAPI file', 'ملف OpenAPI'),
  downloadOpenapiText: l(
    'Generate clients and server stubs in any language, or import it into your API tool.',
    'ولّد عملاء وهياكل خوادم بأي لغة، أو استورده في أداة الواجهات لديك.',
  ),
  downloadPostman: l('Postman collection', 'مجموعة Postman'),
  downloadPostmanText: l(
    'Every endpoint, ready to run. Set the `baseUrl` and `apiKey` variables.',
    'كل نقطة نهاية جاهزة للتشغيل. اضبط المتغيرين `baseUrl` و`apiKey`.',
  ),
  download: l('Download', 'تنزيل'),
  sdk: l('TypeScript types', 'أنواع TypeScript'),
  sdkText: l(
    'The platform’s own web and admin apps use a typed client generated from the same contract (`@nuzm/sdk`).',
    'تستخدم تطبيقات نظم نفسها عميلًا مُنمَّطًا مولَّدًا من العقد نفسه (`@nuzm/sdk`).',
  ),
  endpoints: l('endpoints', 'نقطة نهاية'),
  onThisSite: l('The API reference is in English.', 'مرجع الواجهة بالإنجليزية.'),
  needs: l('Permission', 'الصلاحية'),
  orgScoped: l('Organization scoped', 'خاص بالمنظمة'),
  idem: l('Idempotency-Key required', 'يتطلب Idempotency-Key'),
  ifMatch: l('If-Match for updates', 'If-Match للتعديل'),
  pathParams: l('Path parameters', 'معاملات المسار'),
  queryParams: l('Query parameters', 'معاملات الاستعلام'),
  body: l('Request body', 'محتوى الطلب'),
  response: l('Response', 'الرد'),
  errorsLabel: l('Errors', 'الأخطاء'),
  field: l('Field', 'الحقل'),
  type: l('Type', 'النوع'),
  required: l('required', 'مطلوب'),
  optional: l('optional', 'اختياري'),
  samples: l('Code samples', 'أمثلة برمجية'),
  copy: l('Copy', 'نسخ'),
  copied: l('Copied', 'تم النسخ'),
  code: l('Code', 'الرمز'),
  status: l('Status', 'الحالة'),
  meaning: l('Meaning', 'المعنى'),
  guidesNav: l('Guides', 'الأدلة'),
  referenceNav: l('Reference', 'المرجع'),
  next: l('Next', 'التالي'),
  authNote: l(
    'All endpoints below accept an organization API key: `Authorization: Bearer nzk_…`.',
    'كل نقاط النهاية أدناه تقبل مفتاح واجهة للمنظمة: `Authorization: Bearer nzk_…`.',
  ),
  noFields: l('No fields.', 'لا حقول.'),
  baseHint: l(
    'Replace `$NUZM_API` with the API address of your Nuzm deployment.',
    'استبدل `$NUZM_API` بعنوان واجهة نشر نظم الخاص بك.',
  ),
  menuLabel: l('Documentation menu', 'قائمة التوثيق'),
  backToSite: l('Back to website', 'العودة إلى الموقع'),
  searchPlaceholder: l('Search the documentation…', 'ابحث في التوثيق…'),
  searchEmpty: l('Nothing found. Try another word.', 'لا نتائج. جرّب كلمة أخرى.'),
  searchResults: l('Search results', 'نتائج البحث'),
  onThisPage: l('On this page', 'في هذه الصفحة'),
  endpointsTitle: l('Endpoints', 'نقاط النهاية'),
  kindGuide: l('Guide', 'دليل'),
  rateQuestion: l('Was this helpful?', 'هل كان هذا مفيدًا؟'),
  rateGood: l('Yes, it helped', 'نعم، أفادني'),
  rateOkay: l('Somewhat', 'إلى حد ما'),
  rateBad: l('No, it did not help', 'لا، لم يفدني'),
  rateThanks: l('Thank you for your feedback.', 'شكرًا لملاحظتك.'),
  themeGroup: l('Appearance', 'المظهر'),
  themeLight: l('Light', 'فاتح'),
  themeDark: l('Dark', 'داكن'),
  apiRef: l('API reference', 'مرجع الواجهة'),
  helpTitle: l('Need help?', 'تحتاج مساعدة؟'),
  helpText: l(
    'Include the traceId from the error response when you contact support.',
    'أرفق traceId من رد الخطأ عند التواصل مع الدعم.',
  ),
};
export const doc = (k: string, locale: 'ar' | 'en'): string => {
  const v = DOC[k];
  if (!v) throw new Error(`unknown doc text ${k}`);
  return v[locale];
};
