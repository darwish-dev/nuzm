// Generated application front end: a metadata-driven single-page app (no dependencies). Every string that comes from data is inserted with textContent, never as HTML.
const meta = await (await fetch('/meta.json')).json();
const API = meta.basePath;
const UI = {
  ar: {
    signIn: 'تسجيل الدخول',
    email: 'البريد الإلكتروني',
    pwLabel: 'كلمة المرور',
    signOut: 'خروج',
    home: 'الرئيسية',
    users: 'المستخدمون',
    search: 'بحث',
    save: 'حفظ',
    cancel: 'إلغاء',
    new: 'جديد',
    edit: 'تعديل',
    del: 'حذف',
    confirmDel: 'هل تريد الحذف؟',
    loading: 'جارٍ التحميل…',
    empty: 'لا توجد سجلات',
    error: 'حدث خطأ',
    forbidden: 'ليس لديك صلاحية',
    next: 'التالي',
    prev: 'السابق',
    export: 'تصدير CSV',
    import: 'استيراد CSV',
    board: 'اللوحة',
    audit: 'سجل التغييرات',
    skip: 'تخطَّ إلى المحتوى',
    lang: 'English',
    stage: 'المرحلة',
    saved: 'تم الحفظ',
    conflict: 'تم تعديل السجل من مستخدم آخر، أعد التحميل',
    all: 'الكل',
    imported: 'تم الاستيراد',
    owner: 'المسؤول',
    total: 'الإجمالي',
    sort: 'ترتيب',
    none: '—',
  },
  en: {
    signIn: 'Sign in',
    email: 'Email',
    pwLabel: 'Password',
    signOut: 'Sign out',
    home: 'Home',
    users: 'Users',
    search: 'Search',
    save: 'Save',
    cancel: 'Cancel',
    new: 'New',
    edit: 'Edit',
    del: 'Delete',
    confirmDel: 'Delete this record?',
    loading: 'Loading…',
    empty: 'No records',
    error: 'Something went wrong',
    forbidden: 'You do not have access',
    next: 'Next',
    prev: 'Previous',
    export: 'Export CSV',
    import: 'Import CSV',
    board: 'Board',
    audit: 'Change history',
    skip: 'Skip to content',
    lang: 'العربية',
    stage: 'Stage',
    saved: 'Saved',
    conflict: 'The record was changed by someone else; reload it',
    all: 'All',
    imported: 'Imported',
    owner: 'Owner',
    total: 'Total',
    sort: 'Sort',
    none: '—',
  },
};
const st = {
  lang: localStorage.getItem('lang') || meta.defaultLocale,
  token: sessionStorage.getItem('token'),
  user: null,
  perms: {},
};
const t = (k) => UI[st.lang][k] ?? k;
const L = (o) => (o ? (o[st.lang] ?? o.en) : '');
const $ = (s) => document.querySelector(s);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids.flat())
    if (k !== null && k !== undefined && k !== false)
      el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}
function announce(msg) {
  $('#live').textContent = msg;
}
function applyLang() {
  document.documentElement.lang = st.lang;
  document.documentElement.dir = st.lang === 'ar' ? 'rtl' : 'ltr';
  document.title = meta.name;
  $('#skip').textContent = t('skip');
}
async function api(method, path, body, opts = {}) {
  const headers = { accept: 'application/json' };
  if (st.token) headers.authorization = 'Bearer ' + st.token;
  if (body !== undefined && !opts.raw) headers['content-type'] = 'application/json';
  if (opts.ifMatch) headers['if-match'] = opts.ifMatch;
  const res = await fetch(API + path, {
    method,
    headers,
    body: opts.raw ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && st.token) {
    st.token = null;
    sessionStorage.removeItem('token');
    location.hash = '#/login';
  }
  if (opts.blob) return res;
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok)
    throw Object.assign(new Error((data && data.detail) || t('error')), {
      status: res.status,
      data,
    });
  return data;
}
const main = () => $('#main');
function state(kind, msg) {
  return h('div', { class: 'state ' + kind, role: kind === 'error' ? 'alert' : null }, msg);
}
function renderHeader() {
  const top = $('#top');
  top.replaceChildren();
  top.append(h('strong', {}, meta.name));
  if (st.user) {
    const nav = h('nav', { 'aria-label': 'main' }, h('a', { href: '#/' }, t('home')));
    for (const em of Object.values(meta.entities))
      if ((st.perms[em.name] || []).includes('read'))
        nav.append(h('a', { href: '#/e/' + em.plural }, L(em.labels) + 's'.slice(0, 0)));
    if (meta.roles[st.user.role] && meta.roles[st.user.role].admin)
      nav.append(h('a', { href: '#/users' }, t('users')));
    top.append(
      nav,
      h('span', {}, st.user.name),
      h('button', { class: 'btn secondary', onclick: signOut }, t('signOut')),
    );
  } else top.append(h('span', { style: 'flex:1' }));
  top.append(
    h(
      'button',
      {
        class: 'btn secondary',
        onclick: () => {
          st.lang = st.lang === 'ar' ? 'en' : 'ar';
          localStorage.setItem('lang', st.lang);
          applyLang();
          renderHeader();
          route();
        },
      },
      t('lang'),
    ),
  );
}
async function signOut() {
  await api('POST', '/auth/logout').catch(() => null);
  st.token = null;
  st.user = null;
  sessionStorage.removeItem('token');
  location.hash = '#/login';
  renderHeader();
}
function loginView() {
  const err = h('div', { class: 'err', role: 'alert' });
  const email = h('input', {
    id: 'email',
    type: 'email',
    autocomplete: 'username',
    required: true,
  });
  const pw = h('input', {
    id: 'pw',
    type: 'password',
    autocomplete: 'current-password',
    required: true,
  });
  const form = h(
    'form',
    {
      class: 'card',
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        try {
          const r = await api('POST', '/auth/login', { email: email.value, password: pw.value });
          st.token = r.token;
          sessionStorage.setItem('token', r.token);
          await boot();
          location.hash = '#/';
        } catch (x) {
          err.textContent = x.status === 429 || x.status === 401 ? x.message : t('error');
        }
      },
    },
    h('h1', {}, t('signIn')),
    h('div', { class: 'field' }, h('label', { for: 'email' }, t('email')), email),
    h('div', { class: 'field' }, h('label', { for: 'pw' }, t('pwLabel')), pw),
    err,
    h('button', { class: 'btn', type: 'submit' }, t('signIn')),
  );
  main().replaceChildren(form);
  email.focus();
}
async function dashboardView() {
  main().replaceChildren(state('', t('loading')));
  try {
    const d = await api('GET', '/dashboard');
    const grid = h('div', { class: 'grid' });
    for (const p of meta.pages)
      for (const w of p.widgets) {
        if (!(w.id in d.widgets)) continue;
        const v = d.widgets[w.id];
        const body =
          typeof v === 'number'
            ? h('div', { class: 'stat' }, String(v))
            : Array.isArray(v)
              ? h(
                  'ul',
                  {},
                  v.map((r) => h('li', {}, labelOf(meta.entities[w.entity], r))),
                )
              : h(
                  'ul',
                  {},
                  Object.entries(v).map(([k, n]) => h('li', {}, k + ': ' + n)),
                );
        grid.append(
          h('section', { class: 'card', 'aria-label': L(w.title) }, h('h2', {}, L(w.title)), body),
        );
      }
    main().replaceChildren(h('h1', {}, t('home')), grid);
  } catch (e) {
    main().replaceChildren(state('error', e.message));
  }
}
const labelOf = (em, r) => {
  const f = em.fields.find((x) => x.type === 'string') || em.fields[0];
  return String(r[f.name] ?? r.id);
};
function cell(f, v) {
  if (v === null || v === undefined || v === '') return t('none');
  if (f.type === 'boolean') return v ? '✓' : '✗';
  if (f.type === 'file') return v.name;
  return String(v);
}
async function listView(plural, query) {
  const em = Object.values(meta.entities).find((e) => e.plural === plural);
  if (!em) return main().replaceChildren(state('error', t('error')));
  const can = (a) => (st.perms[em.name] || []).includes(a);
  if (!can('read')) return main().replaceChildren(state('error', t('forbidden')));
  const params = new URLSearchParams(query);
  const body = h('div', {}, state('', t('loading')));
  const search = h('input', { id: 'q', type: 'search', value: params.get('search') || '' });
  const sort = h(
    'select',
    { id: 'sort' },
    h('option', { value: '' }, t('none')),
    em.sortable.map((s) =>
      h('option', { value: s + ':asc', selected: params.get('sort') === s + ':asc' }, s + ' ↑'),
    ),
    em.sortable.map((s) =>
      h('option', { value: s + ':desc', selected: params.get('sort') === s + ':desc' }, s + ' ↓'),
    ),
  );
  const go = () => {
    const p = new URLSearchParams();
    if (search.value) p.set('search', search.value);
    if (sort.value) p.set('sort', sort.value);
    location.hash = '#/e/' + plural + '?' + p;
  };
  const bar = h(
    'div',
    { class: 'row' },
    h('div', {}, h('label', { for: 'q' }, t('search')), search),
    h('div', {}, h('label', { for: 'sort' }, t('sort')), sort),
    h('button', { class: 'btn secondary', onclick: go }, t('search')),
    can('create') ? h('a', { class: 'btn', href: '#/e/' + plural + '/new' }, t('new')) : null,
    em.stageField
      ? h('a', { class: 'btn secondary', href: '#/board/' + plural }, t('board'))
      : null,
    meta.csvImportExport && can('export')
      ? h('button', { class: 'btn secondary', onclick: () => exportCsv(em, params) }, t('export'))
      : null,
    meta.csvImportExport && can('import')
      ? h(
          'label',
          { class: 'btn secondary' },
          t('import'),
          h('input', {
            type: 'file',
            accept: '.csv,text/csv',
            class: 'sr-only',
            onchange: (e) => importCsv(em, e.target.files[0]),
          }),
        )
      : null,
  );
  main().replaceChildren(h('h1', {}, L(em.labels)), bar, body);
  try {
    const r = await api('GET', '/' + plural + '?' + params);
    if (!r.items.length) return body.replaceChildren(state('', t('empty')));
    const cols = em.fields.filter((f) => f.type !== 'text').slice(0, 6);
    const prev = Math.max(0, r.offset - r.limit);
    body.replaceChildren(
      h(
        'table',
        {},
        h('caption', {}, L(em.labels) + ' — ' + t('total') + ': ' + r.total),
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            cols.map((f) => h('th', { scope: 'col' }, L(f.labels))),
            h('th', {}, ''),
          ),
        ),
        h(
          'tbody',
          {},
          r.items.map((row) =>
            h(
              'tr',
              {},
              cols.map((f) => h('td', {}, cell(f, row[f.name]))),
              h(
                'td',
                {},
                h(
                  'a',
                  { href: '#/e/' + plural + '/' + row.id },
                  can('update') ? t('edit') : t('home'),
                ),
              ),
            ),
          ),
        ),
      ),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'btn secondary',
            disabled: r.offset === 0,
            onclick: () => {
              params.set('offset', String(prev));
              location.hash = '#/e/' + plural + '?' + params;
            },
          },
          t('prev'),
        ),
        h(
          'button',
          {
            class: 'btn secondary',
            disabled: r.offset + r.limit >= r.total,
            onclick: () => {
              params.set('offset', String(r.offset + r.limit));
              location.hash = '#/e/' + plural + '?' + params;
            },
          },
          t('next'),
        ),
      ),
    );
  } catch (e) {
    body.replaceChildren(state('error', e.status === 403 ? t('forbidden') : e.message));
  }
}
async function exportCsv(em, params) {
  const res = await api('GET', '/' + em.plural + '/export.csv?' + params, undefined, {
    blob: true,
  });
  const url = URL.createObjectURL(await res.blob());
  const a = h('a', { href: url, download: em.plural + '.csv' });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
async function importCsv(em, file) {
  if (!file) return;
  try {
    const r = await api('POST', '/' + em.plural + '/import', await file.text(), { raw: true });
    announce(t('imported') + ': ' + r.imported);
    route();
  } catch (e) {
    announce(e.message);
    main().prepend(
      state(
        'error',
        e.data && e.data.errors ? JSON.stringify(e.data.errors.slice(0, 3)) : e.message,
      ),
    );
  }
}
async function formView(plural, id) {
  const em = Object.values(meta.entities).find((e) => e.plural === plural);
  if (!em) return main().replaceChildren(state('error', t('error')));
  main().replaceChildren(state('', t('loading')));
  let row = null;
  try {
    if (id !== 'new') row = await api('GET', '/' + plural + '/' + id);
  } catch (e) {
    return main().replaceChildren(state('error', e.status === 404 ? t('empty') : e.message));
  }
  const can = (a) => (st.perms[em.name] || []).includes(a);
  const inputs = {};
  const errs = {};
  const fields = [];
  for (const f of em.fields) {
    let input;
    const val = row ? row[f.name] : null;
    if (f.type === 'enum')
      input = h(
        'select',
        { id: 'f_' + f.name, required: f.required },
        h('option', { value: '' }, t('none')),
        f.enumValues.map((v) => h('option', { value: v, selected: val === v }, v)),
      );
    else if (f.type === 'boolean')
      input = h('input', { id: 'f_' + f.name, type: 'checkbox', checked: val === true });
    else if (f.type === 'text') input = h('textarea', { id: 'f_' + f.name, rows: 4 }, val || '');
    else if (f.type === 'reference') {
      input = h(
        'select',
        { id: 'f_' + f.name, required: f.required },
        h('option', { value: '' }, t('none')),
      );
      api('GET', '/' + meta.entities[f.references].plural + '?limit=' + meta.maxLimit)
        .then((r) =>
          r.items.forEach((o) =>
            input.append(
              h(
                'option',
                { value: o.id, selected: val === o.id },
                labelOf(meta.entities[f.references], o),
              ),
            ),
          ),
        )
        .catch(() => null);
    } else if (f.type === 'file') input = h('input', { id: 'f_' + f.name, type: 'file' });
    else
      input = h('input', {
        id: 'f_' + f.name,
        type:
          {
            integer: 'number',
            decimal: 'number',
            date: 'date',
            email: 'email',
            url: 'url',
            phone: 'tel',
            datetime: 'datetime-local',
          }[f.type] || 'text',
        step: f.type === 'decimal' ? 'any' : null,
        value:
          val === null || val === undefined
            ? ''
            : f.type === 'datetime'
              ? String(val).slice(0, 16)
              : val,
        maxlength: f.maxLength,
        required: f.required,
      });
    inputs[f.name] = input;
    errs[f.name] = h('div', { class: 'err', role: 'alert' });
    input.setAttribute('aria-describedby', 'e_' + f.name);
    errs[f.name].id = 'e_' + f.name;
    fields.push(
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'f_' + f.name }, L(f.labels) + (f.required ? ' *' : '')),
        input,
        errs[f.name],
      ),
    );
  }
  const top = h('div', { role: 'alert', class: 'err' });
  const submit = async (e) => {
    e.preventDefault();
    for (const k of Object.keys(errs)) errs[k].textContent = '';
    top.textContent = '';
    const body = {};
    for (const f of em.fields) {
      const el = inputs[f.name];
      if (f.type === 'boolean') body[f.name] = el.checked;
      else if (f.type === 'file') {
        const file = el.files[0];
        if (file)
          body[f.name] = {
            name: file.name,
            mime: file.type,
            contentBase64: btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer()))),
          };
      } else if (el.value !== '' || row)
        body[f.name] =
          el.value === ''
            ? null
            : f.type === 'integer' || f.type === 'decimal'
              ? Number(el.value)
              : f.type === 'datetime'
                ? new Date(el.value).toISOString()
                : el.value;
    }
    try {
      if (row)
        await api('PATCH', '/' + plural + '/' + id, body, { ifMatch: '"' + row.version + '"' });
      else await api('POST', '/' + plural, body);
      announce(t('saved'));
      location.hash = '#/e/' + plural;
    } catch (x) {
      if (x.status === 409) top.textContent = t('conflict');
      else if (x.data && x.data.errors)
        for (const er of x.data.errors) {
          if (errs[er.field]) errs[er.field].textContent = er.message;
          else top.textContent += er.field + ': ' + er.message + ' ';
        }
      else top.textContent = x.status === 403 ? t('forbidden') : x.message;
    }
  };
  const actions = h(
    'div',
    { class: 'row' },
    can(row ? 'update' : 'create')
      ? h('button', { class: 'btn', type: 'submit' }, t('save'))
      : null,
    h('a', { class: 'btn secondary', href: '#/e/' + plural }, t('cancel')),
    row && can('delete')
      ? h(
          'button',
          {
            class: 'btn danger',
            type: 'button',
            onclick: async () => {
              if (!confirm(t('confirmDel'))) return;
              try {
                await api('DELETE', '/' + plural + '/' + id);
                location.hash = '#/e/' + plural;
              } catch (x) {
                top.textContent = x.message;
              }
            },
          },
          t('del'),
        )
      : null,
  );
  const audit = h('section', { class: 'card', 'aria-label': t('audit') }, h('h2', {}, t('audit')));
  main().replaceChildren(
    h('h1', {}, L(em.labels)),
    h('form', { class: 'card', onsubmit: submit, novalidate: true }, top, fields, actions),
    row && em.audit ? audit : '',
  );
  if (row && em.audit)
    api('GET', '/' + plural + '/' + id + '/audit')
      .then((r) =>
        audit.append(
          h(
            'ul',
            {},
            r.items.map((a) => h('li', {}, a.at + ' — ' + a.action)),
          ),
        ),
      )
      .catch(() => null);
}
async function boardView(plural) {
  const em = Object.values(meta.entities).find((e) => e.plural === plural);
  main().replaceChildren(state('', t('loading')));
  try {
    const r = await api('GET', '/' + plural + '/board');
    const can = (st.perms[em.name] || []).includes('update');
    const cols = h(
      'div',
      { class: 'board' },
      r.stages.map((s) =>
        h(
          'section',
          { class: 'col', 'aria-label': s },
          h('h2', {}, s + ' (' + r.columns[s].total + ')'),
          r.columns[s].items.map((it) =>
            h(
              'div',
              { class: 'item' },
              h('a', { href: '#/e/' + plural + '/' + it.id }, labelOf(em, it)),
              can
                ? h(
                    'select',
                    {
                      'aria-label': t('stage'),
                      onchange: async (e) => {
                        try {
                          await api(
                            'PATCH',
                            '/' + plural + '/' + it.id,
                            { [r.stageField]: e.target.value },
                            { ifMatch: '"' + it.version + '"' },
                          );
                          announce(t('saved'));
                          boardView(plural);
                        } catch (x) {
                          announce(x.message);
                          boardView(plural);
                        }
                      },
                    },
                    r.stages.map((o) =>
                      h(
                        'option',
                        { value: o, selected: o === it.stage || o === it[r.stageField] },
                        o,
                      ),
                    ),
                  )
                : null,
            ),
          ),
        ),
      ),
    );
    main().replaceChildren(h('h1', {}, L(em.labels) + ' — ' + t('board')), cols);
  } catch (e) {
    main().replaceChildren(state('error', e.message));
  }
}
async function usersView() {
  main().replaceChildren(state('', t('loading')));
  try {
    const r = await api('GET', '/users');
    main().replaceChildren(
      h('h1', {}, t('users')),
      h(
        'table',
        {},
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            ['email', 'name', 'role'].map((c) => h('th', { scope: 'col' }, c)),
          ),
        ),
        h(
          'tbody',
          {},
          r.items.map((u) =>
            h(
              'tr',
              {},
              h('td', {}, u.email),
              h('td', {}, u.name),
              h('td', {}, L(meta.roles[u.role] && meta.roles[u.role].labels) || u.role),
            ),
          ),
        ),
      ),
    );
  } catch (e) {
    main().replaceChildren(state('error', e.message));
  }
}
async function route() {
  const [path, query = ''] = location.hash.slice(1).split('?');
  const seg = path.split('/').filter(Boolean);
  if (!st.token && seg[0] !== 'login') {
    location.hash = '#/login';
    return;
  }
  if (st.token && !st.user) await boot();
  renderHeader();
  if (seg[0] === 'login') return loginView();
  if (seg.length === 0) return dashboardView();
  if (seg[0] === 'e' && seg.length === 2) return listView(seg[1], query);
  if (seg[0] === 'e' && seg.length === 3) return formView(seg[1], seg[2]);
  if (seg[0] === 'board') return boardView(seg[1]);
  if (seg[0] === 'users') return usersView();
  main().replaceChildren(state('error', t('error')));
  main().focus();
}
async function boot() {
  if (!st.token) return;
  try {
    const me = await api('GET', '/auth/me');
    st.user = me.user;
    st.perms = me.permissions;
  } catch {
    st.user = null;
  }
}
applyLang();
window.addEventListener('hashchange', route);
await boot();
route();
