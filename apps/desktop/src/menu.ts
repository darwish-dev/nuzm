import { Menu, type MenuItemConstructorOptions } from 'electron';
import type { Locale } from './policy';
import { s, type StringKey } from './strings';

/** Console areas reachable from the Go menu (paths as the console shows them; it adds the language itself). */
export const consoleSections: readonly { key: StringKey; path: string; accel?: string }[] = [
  { key: 'console', path: '/console', accel: 'CmdOrCtrl+1' },
  { key: 'navHosting', path: '/hosting', accel: 'CmdOrCtrl+2' },
  { key: 'navDomains', path: '/domains', accel: 'CmdOrCtrl+3' },
  { key: 'navEmail', path: '/email', accel: 'CmdOrCtrl+4' },
  { key: 'navDatabases', path: '/databases', accel: 'CmdOrCtrl+5' },
  { key: 'navCompute', path: '/compute', accel: 'CmdOrCtrl+6' },
  { key: 'navStorage', path: '/storage', accel: 'CmdOrCtrl+7' },
  { key: 'navAi', path: '/ai', accel: 'CmdOrCtrl+8' },
  { key: 'navBuilder', path: '/builder', accel: 'CmdOrCtrl+9' },
  { key: 'navBilling', path: '/billing' },
  { key: 'navSettings', path: '/settings' },
  { key: 'navAccount', path: '/account' },
];

export interface MenuActions {
  locale: Locale;
  isMac: boolean;
  isDev: boolean;
  go(path: string): void;
  reload(): void;
  back(): void;
  forward(): void;
  setLocale(l: Locale): void;
  signIn(): void;
  help(): void;
  about(): void;
}

/** The application menu, in the shell's current language. Standard roles keep native shortcuts on both platforms. */
export function buildMenu(a: MenuActions): Menu {
  const t = (k: StringKey) => s(a.locale, k);
  const languageItems: MenuItemConstructorOptions[] = [
    {
      label: 'العربية',
      type: 'radio',
      checked: a.locale === 'ar',
      click: () => a.setLocale('ar'),
    },
    {
      label: 'English',
      type: 'radio',
      checked: a.locale === 'en',
      click: () => a.setLocale('en'),
    },
  ];
  const template: MenuItemConstructorOptions[] = [
    ...(a.isMac
      ? [
          {
            label: t('menuApp'),
            submenu: [
              { label: t('about'), click: a.about },
              { type: 'separator' },
              { label: t('language'), submenu: languageItems },
              { type: 'separator' },
              { label: t('hide'), role: 'hide' },
              { label: t('hideOthers'), role: 'hideOthers' },
              { label: t('showAll'), role: 'unhide' },
              { type: 'separator' },
              { label: t('quit'), role: 'quit' },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: t('menuFile'),
      submenu: [
        { label: t('signIn'), click: a.signIn },
        ...(a.isMac
          ? []
          : ([
              { type: 'separator' },
              { label: t('language'), submenu: languageItems },
            ] satisfies MenuItemConstructorOptions[])),
        { type: 'separator' },
        a.isMac ? { label: t('close'), role: 'close' } : { label: t('quit'), role: 'quit' },
      ],
    },
    {
      label: t('menuEdit'),
      submenu: [
        { label: t('undo'), role: 'undo' },
        { label: t('redo'), role: 'redo' },
        { type: 'separator' },
        { label: t('cut'), role: 'cut' },
        { label: t('copy'), role: 'copy' },
        { label: t('paste'), role: 'paste' },
        { label: t('selectAll'), role: 'selectAll' },
      ],
    },
    {
      label: t('menuView'),
      submenu: [
        { label: t('reload'), accelerator: 'CmdOrCtrl+R', click: a.reload },
        { type: 'separator' },
        { label: t('zoomReset'), role: 'resetZoom' },
        { label: t('zoomIn'), role: 'zoomIn' },
        { label: t('zoomOut'), role: 'zoomOut' },
        { type: 'separator' },
        { label: t('fullscreen'), role: 'togglefullscreen' },
        ...(a.isDev
          ? ([
              { type: 'separator' },
              { label: t('devtools'), role: 'toggleDevTools' },
            ] satisfies MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: t('menuGo'),
      submenu: [
        { label: t('back'), accelerator: 'CmdOrCtrl+[', click: a.back },
        { label: t('forward'), accelerator: 'CmdOrCtrl+]', click: a.forward },
        { type: 'separator' },
        ...consoleSections.map((c): MenuItemConstructorOptions => ({
          label: t(c.key),
          ...(c.accel ? { accelerator: c.accel } : {}),
          click: () => a.go(c.path),
        })),
      ],
    },
    {
      label: t('menuWindow'),
      submenu: [
        { label: t('minimize'), role: 'minimize' },
        { label: t('zoomWindow'), role: 'zoom' },
        ...(a.isMac ? [] : [{ label: t('close'), role: 'close' } as const]),
      ],
    },
    {
      label: t('menuHelp'),
      role: 'help',
      submenu: [
        { label: t('help'), click: a.help },
        ...(a.isMac ? [] : [{ label: t('about'), click: a.about }]),
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}
