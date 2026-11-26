/**
 * Nuzm desktop (Windows + macOS). A locked-down window around the customer console (`apps/web`): it opens on the
 * console's login page, and after sign-in every console area (hosting, domains, email, databases, compute, storage,
 * AI, builder, billing, settings…) runs inside the window with the same session, permissions and audit as the web.
 *
 * Security posture (Electron security checklist): sandboxed renderer, context isolation, no Node in pages, only the
 * console origin (and configured sign-in origins) may load in the window, other links open in the system browser,
 * device permissions denied, no <webview>. The shell never sees or stores passwords.
 */
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
  type WebContents,
} from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  decideNavigation,
  isConsoleUrl,
  loginUrl,
  pickLocale,
  resolveConfig,
  switchLocaleUrl,
  type Locale,
  type ShellConfig,
} from './policy';
import { buildMenu } from './menu';
import { loadSettings, saveSettings, type Settings } from './settings';
import { s } from './strings';

const PARTITION = 'persist:nuzm';
const APP_NAME = 'Nuzm AI';
const appIcon = join(__dirname, '..', 'resources', 'icon.png');

// the name in the macOS menu bar, the Dock and the About box, also when run unpackaged (`pnpm start`), where Electron would show its own name
app.setName(APP_NAME);
const offlinePage = join(__dirname, '..', 'static', 'offline.html');

let config: ShellConfig;
let settings: Settings;
let locale: Locale;
let win: BrowserWindow | undefined;

function readBundledConfig(): Partial<ShellConfig> | undefined {
  const file = join(__dirname, '..', 'app-config.json');
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8')) as Partial<ShellConfig>;
}

function openExternal(url: string) {
  // decideNavigation already rejected non-http(s) schemes; this is a second guard
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
}

function showOffline(wc: WebContents, failedUrl: string) {
  const u = pathToFileURL(offlinePage);
  u.searchParams.set('lang', locale);
  u.searchParams.set('origin', config.webOrigin);
  // remember where the person was, so Retry returns them there (only console pages are kept)
  u.searchParams.set(
    'retry',
    isConsoleUrl(config, failedUrl) ? failedUrl : loginUrl(config, locale),
  );
  void wc.loadURL(u.toString());
}

function guard(wc: WebContents) {
  wc.setWindowOpenHandler(({ url }) => {
    if (decideNavigation(config, url) !== 'block') openExternal(url);
    return { action: 'deny' };
  });
  const onNavigate = (e: { preventDefault(): void }, url: string) => {
    if (url.startsWith('file:') && url.split('?')[0] === pathToFileURL(offlinePage).toString())
      return; // our own offline page
    const d = decideNavigation(config, url);
    if (d === 'allow') return;
    e.preventDefault();
    if (d === 'external') openExternal(url);
  };
  wc.on('will-navigate', onNavigate);
  wc.on('will-redirect', onNavigate);
  wc.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    // -3 = ERR_ABORTED (a navigation we cancelled, or a download): not an outage
    if (isMainFrame && code !== -3) showOffline(wc, url);
  });
  wc.on('page-title-updated', (e, title) => {
    e.preventDefault();
    win?.setTitle(title ? `${title} — ${s(locale, 'appName')}` : s(locale, 'appName'));
  });
}

function setLocale(next: Locale) {
  locale = next;
  settings = { ...settings, locale };
  saveSettings(app.getPath('userData'), settings);
  refreshMenu();
  const wc = win?.webContents;
  if (!wc) return;
  const current = wc.getURL();
  void wc.loadURL(
    current.startsWith('file:')
      ? loginUrl(config, locale)
      : switchLocaleUrl(config, current, locale),
  );
}

function go(path: string) {
  if (!win) createWindow();
  void win?.webContents.loadURL(`${config.webOrigin}${path}`);
}

function refreshMenu() {
  Menu.setApplicationMenu(
    buildMenu({
      locale,
      isMac: process.platform === 'darwin',
      isDev: !app.isPackaged,
      go,
      reload: () => win?.webContents.reload(),
      back: () => win?.webContents.navigationHistory.goBack(),
      forward: () => win?.webContents.navigationHistory.goForward(),
      setLocale,
      signIn: () => go(`/login?lang=${locale}`),
      help: () => go('/docs'),
      about: () =>
        void dialog.showMessageBox({
          type: 'info',
          title: s(locale, 'about'),
          message: s(locale, 'appName'),
          detail: s(locale, 'aboutDetail', { version: app.getVersion(), origin: config.webOrigin }),
          buttons: [s(locale, 'ok')],
        }),
    }),
  );
}

function createWindow() {
  const b = settings.bounds;
  win = new BrowserWindow({
    width: b?.width ?? 1280,
    height: b?.height ?? 820,
    ...(b?.x !== undefined && b?.y !== undefined ? { x: b.x, y: b.y } : {}),
    minWidth: 900,
    minHeight: 600,
    title: s(locale, 'appName'),
    backgroundColor: '#0b0b0c',
    show: false,
    icon: appIcon,
    webPreferences: {
      partition: PARTITION,
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
    },
  });
  if (settings.maximized) win.maximize();
  win.once('ready-to-show', () => win?.show());
  const remember = () => {
    if (!win || win.isMinimized()) return;
    settings = {
      ...settings,
      maximized: win.isMaximized(),
      bounds: win.isMaximized() ? settings.bounds : win.getBounds(),
    };
  };
  win.on('resize', remember);
  win.on('move', remember);
  win.on('close', () => {
    remember();
    saveSettings(app.getPath('userData'), settings);
  });
  win.on('closed', () => (win = undefined));
  guard(win.webContents);
  void win.loadURL(loginUrl(config, locale));
}

function hardenSession() {
  const ses = session.fromPartition(PARTITION);
  // camera, microphone, location, notifications, HID/USB… are all denied; copying to the clipboard and full screen are allowed
  const allowed = new Set(['clipboard-sanitized-write', 'fullscreen']);
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
  ses.setUserAgent(`${ses.getUserAgent()} NuzmDesktop/${app.getVersion()}`);
}

function start() {
  try {
    config = resolveConfig({ argv: process.argv, env: process.env, bundled: readBundledConfig() });
  } catch (err) {
    dialog.showErrorBox('Nuzm', (err as Error).message);
    app.exit(1);
    return;
  }
  settings = loadSettings(app.getPath('userData'));
  locale = pickLocale(settings.locale, app.getPreferredSystemLanguages());

  // pages may never attach a <webview> or open new Electron windows on their own
  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-attach-webview', (ev) => ev.preventDefault());
  });

  // the offline page's Retry button: only that local page may ask, and only for an allowed address
  ipcMain.on('nuzm:retry', (e, url: unknown) => {
    if (!e.senderFrame?.url.startsWith(pathToFileURL(offlinePage).toString())) return;
    const target =
      typeof url === 'string' && decideNavigation(config, url) === 'allow'
        ? url
        : loginUrl(config, locale);
    void e.sender.loadURL(target);
  });

  // a packaged app carries its icon in the bundle; an unpackaged run would show Electron's, so set it on the Dock
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(appIcon);
  hardenSession();
  // Persist sign-in/sign-out changes promptly without extending the API's cookie or session expiry.
  const jar = session.fromPartition(PARTITION).cookies;
  jar.on('changed', (_event, cookie) => {
    if (cookie.name === 'nuzm_session' || cookie.name === 'nuzm_csrf')
      void jar.flushStore().catch(() => undefined);
  });
  app.on('before-quit', () => void jar.flushStore().catch(() => undefined));
  refreshMenu();
  createWindow();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return createWindow();
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(start, (err: unknown) => {
    console.error(err);
    app.exit(1);
  });
  app.on('activate', () => {
    if (app.isReady() && config && !win) createWindow();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
