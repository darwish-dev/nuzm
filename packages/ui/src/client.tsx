'use client';
import QRCode from 'qrcode';
import { usePathname } from 'next/navigation';
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Button, Field, Input, Ltr } from './components';
import { Icon, type IconName } from './icons';

/** Client-side widgets. They receive strings and callbacks, never fetch on their own. */

/**
 * A whole number that counts up from 0 when it appears (the dashboard figures). The page renders the final value, so it is right without script and
 * for assistive technology (the animated digits are hidden from it); under "reduce motion" it never animates.
 */
export function CountUp({ value, ms = 800 }: { value: number; ms?: number }) {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    if (value <= 0 || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    let raf = 0;
    const t0 = performance.now();
    setShown(0);
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / ms);
      setShown(Math.round(value * (1 - Math.pow(1 - p, 3)))); // ease-out
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return (
    <>
      <span className="nz-sr">{value}</span>
      <span aria-hidden="true">{shown}</span>
    </>
  );
}

/**
 * Positions the rail's hover tooltips. The rail scrolls (so it clips anything that overflows it); its tooltips are therefore fixed-position
 * and only need the hovered icon's vertical centre, which this sets on pointer-over and keyboard focus. Renders nothing.
 */
export function RailTips() {
  useEffect(() => {
    const place = (e: Event) => {
      const el = (e.target as Element | null)?.closest?.<HTMLElement>('.nzc-rail-link[data-tip]');
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--nzc-tip-y', `${Math.round(r.top + r.height / 2)}px`);
    };
    document.addEventListener('pointerover', place);
    document.addEventListener('focusin', place);
    return () => {
      document.removeEventListener('pointerover', place);
      document.removeEventListener('focusin', place);
    };
  }, []);
  return null;
}

export function LocaleSwitch({
  current,
  locales,
  labels,
}: {
  current: string;
  locales: string[];
  labels: Record<string, string>;
}) {
  const path = usePathname() ?? `/${current}`;
  // a console whose addresses carry the language (admin) swaps the prefix; one that does not (client) asks the proxy to switch it with `?lang=`
  const prefixed = new RegExp(`^/${current}(?=/|$)`).test(path);
  return (
    <span>
      {locales
        .filter((l) => l !== current)
        .map((l) => (
          <a
            key={l}
            href={prefixed ? path.replace(new RegExp(`^/${current}(?=/|$)`), `/${l}`) : `${path}?lang=${l}`}
            lang={l}
            hrefLang={l}
          >
            {labels[l]}
          </a>
        ))}
    </span>
  );
}

export interface MfaEnrolProps {
  labels: {
    intro: string;
    start: string;
    qr: string;
    manualKey: string;
    code: string;
    verify: string;
    done: string;
    errorCode: string;
    errorGeneric: string;
  };
  start: () => Promise<{ id: string; secret: string; otpauthUri: string }>;
  verify: (id: string, code: string) => Promise<'ok' | 'bad_code' | 'locked'>;
  onDone?: () => void;
  lockedMessage: string;
}

/** TOTP enrolment: the secret is shown once (QR + manual key); nothing is stored in the browser. */
export function MfaEnrol(p: MfaEnrolProps): ReactNode {
  const [pending, setPending] = useState<{ id: string; secret: string; uri: string } | null>(null);
  const [qr, setQr] = useState('');
  const [msg, setMsg] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (pending) void QRCode.toDataURL(pending.uri, { margin: 1, width: 192 }).then(setQr);
  }, [pending]);

  async function begin() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await p.start();
      setPending({ id: r.id, secret: r.secret, uri: r.otpauthUri });
    } catch {
      setMsg({ kind: 'error', text: p.labels.errorGeneric });
    } finally {
      setBusy(false);
    }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get('code') ?? '').trim();
    setBusy(true);
    try {
      const r = await p.verify(pending!.id, code);
      if (r === 'ok') {
        setPending(null);
        setMsg({ kind: 'ok', text: p.labels.done });
        p.onDone?.();
      } else setMsg({ kind: 'error', text: r === 'locked' ? p.lockedMessage : p.labels.errorCode });
    } catch {
      setMsg({ kind: 'error', text: p.labels.errorGeneric });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p>{p.labels.intro}</p>
      {!pending && !(msg?.kind === 'ok') && (
        <Button onClick={begin} disabled={busy}>
          {p.labels.start}
        </Button>
      )}
      {pending && (
        <form onSubmit={submit} noValidate>
          {qr && <img src={qr} width={192} height={192} alt={p.labels.qr} />}
          <p>
            {p.labels.manualKey}: <Ltr>{pending.secret}</Ltr>
          </p>
          <Field
            id="code"
            label={p.labels.code}
            error={msg?.kind === 'error' ? msg.text : undefined}
          >
            {(a) => (
              <Input
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                {...a}
              />
            )}
          </Field>
          <Button type="submit" disabled={busy}>
            {p.labels.verify}
          </Button>
        </form>
      )}
      {!pending && msg && (
        <p
          role={msg.kind === 'error' ? 'alert' : 'status'}
          className={msg.kind === 'error' ? 'nz-error-text' : ''}
        >
          {msg.text}
        </p>
      )}
    </div>
  );
}

export interface MfaChallengeProps {
  labels: { code: string; verify: string; errorCode: string; errorGeneric: string; locked: string };
  verify: (code: string) => Promise<'ok' | 'bad_code' | 'locked'>;
  onDone: () => void;
}

/** Answer an MFA challenge (admin sign-in, or a step-up) with a code from the enrolled factor. */
export function MfaChallenge(p: MfaChallengeProps): ReactNode {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get('code') ?? '').trim();
    setBusy(true);
    setError('');
    try {
      const r = await p.verify(code);
      if (r === 'ok') return p.onDone();
      setError(r === 'locked' ? p.labels.locked : p.labels.errorCode);
    } catch {
      setError(p.labels.errorGeneric);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} noValidate>
      <Field id="challenge-code" label={p.labels.code} error={error || undefined}>
        {(a) => (
          <Input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            autoFocus
            {...a}
          />
        )}
      </Field>
      <Button type="submit" disabled={busy}>
        {p.labels.verify}
      </Button>
    </form>
  );
}

export interface StepUpLabels {
  title: string;
  body: string;
  challenge: MfaChallengeProps['labels'];
}

/**
 * Step-up gate for sensitive actions. `ask(retry)` shows the MFA challenge; after a correct code the original action
 * is retried. `verify` answers the challenge with the caller's enrolled factor (the app supplies the SDK call).
 */
export function useStepUp(
  labels: StepUpLabels,
  factorId: string | null,
  verify: (factorId: string, code: string) => Promise<'ok' | 'bad_code' | 'locked'>,
) {
  const [retry, setRetry] = useState<(() => void) | null>(null);
  const panel: ReactNode = retry && factorId && (
    <section aria-label={labels.title} className="nz-card">
      <h3>{labels.title}</h3>
      <p>{labels.body}</p>
      <MfaChallenge
        labels={labels.challenge}
        verify={(code) => verify(factorId, code)}
        onDone={() => {
          const go = retry;
          setRetry(null);
          go();
        }}
      />
    </section>
  );
  return { panel, ask: (fn: () => void) => setRetry(() => fn), available: factorId !== null };
}

/** Closes any open tab menu (a <details> dropdown in the section tabs) other than the one holding `keep`. */
function closeTabMenus(keep?: Element | null) {
  document.querySelectorAll<HTMLDetailsElement>('.nzc-tab-menu[open]').forEach((d) => {
    if (d !== keep) d.open = false;
  });
}

/**
 * The console frame: the top bar, the icon rail and the page, with the selected category's section tabs at the top of the page. The
 * rail and tabs are rendered on the server (so the current page is highlighted without script); this component only owns the
 * interaction: the slide-in rail drawer on small screens and closing an open tab menu on an outside click or Escape.
 */
export function ConsoleFrame(props: {
  brand: ReactNode;
  rail: ReactNode;
  /** Section tabs shown above the page content. */
  tabs?: ReactNode;
  topbar: ReactNode;
  banner?: ReactNode;
  children: ReactNode;
  labels: { openMenu: string; closeMenu: string };
  /** A side panel docked beside the content (the support chat): opened from a `SupportToggle` in the top bar, it narrows the content instead of covering it. */
  support?: { label: string; content: ReactNode };
}) {
  const [drawer, setDrawer] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setDrawer(false);
      setSupportOpen(false);
      closeTabMenus();
    };
    const onDown = (e: PointerEvent) =>
      closeTabMenus((e.target as Element | null)?.closest?.('.nzc-tab-menu'));
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, []);
  return (
    <SupportCtx.Provider
      value={{
        open: supportOpen,
        toggle: () => setSupportOpen((o) => !o),
        close: () => setSupportOpen(false),
      }}
    >
      <div
        className="nzc-app"
        data-drawer={drawer ? 'open' : 'closed'}
        onClick={(e) => {
          const link = (e.target as HTMLElement).closest('a');
          if (!link) return;
          // following a link closes the rail drawer on small screens and any open tab menu
          if (drawer && link.closest('.nzc-rail')) setDrawer(false);
          if (link.closest('.nzc-tab-menu')) closeTabMenus();
        }}
      >
        <div className="nzc-banner-slot">{props.banner}</div>
        <header className="nzc-top">
          <button
            type="button"
            className="nzc-icon-btn nzc-only-mobile"
            aria-label={props.labels.openMenu}
            aria-expanded={drawer}
            onClick={() => setDrawer(true)}
          >
            <Icon name="menu" />
          </button>
          {props.brand}
          {props.topbar}
        </header>
        <div className="nzc-main" data-support={props.support && supportOpen ? 'open' : undefined}>
          <div className="nzc-frame">
            {props.rail}
            {drawer && (
              <button
                type="button"
                className="nzc-scrim"
                aria-label={props.labels.closeMenu}
                onClick={() => setDrawer(false)}
              />
            )}
            <main id="main" tabIndex={-1} className="nzc-body">
              {props.tabs}
              {props.children}
            </main>
          </div>
          {props.support && (
            <aside
              id="nzc-support"
              className="nzc-support"
              aria-label={props.support.label}
              hidden={!supportOpen}
            >
              {props.support.content}
            </aside>
          )}
        </div>
      </div>
    </SupportCtx.Provider>
  );
}

interface SupportState {
  open: boolean;
  toggle: () => void;
  close: () => void;
}
const SupportCtx = createContext<SupportState | null>(null);
/** The docked support panel's state, for what is rendered inside it (its close button) and for the top bar's toggle. */
export function useSupportDock(): SupportState {
  return useContext(SupportCtx) ?? { open: false, toggle: () => undefined, close: () => undefined };
}
/** The top bar's support button: opens and closes the docked panel of the `ConsoleFrame` it sits in. */
export function SupportToggle({ label }: { label: string }) {
  const s = useSupportDock();
  return (
    <button
      type="button"
      className="nzc-icon-btn nzc-support-btn"
      aria-label={label}
      aria-expanded={s.open}
      aria-controls="nzc-support"
      onClick={s.toggle}
    >
      <Icon name="support" />
    </button>
  );
}

/**
 * Account menu in the top bar: profile and security, the language, the theme (dark is the default; the choice lives in a cookie so the
 * server renders it with no flash) and sign out. Closes on Escape and on an outside click.
 */
export function ProfileMenu(props: {
  initials: string;
  name: string;
  email: string;
  locale: string;
  languages: { code: string; label: string }[];
  theme: 'dark' | 'light';
  labels: { menu: string; profile?: string; language: string; darkMode: string; signOut: string };
  /** Omit for a console with no profile page. */
  profileHref?: string;
  /** Extra pages listed under the profile (the organization's team, settings and privacy pages), headed by `linksTitle`. */
  links?: { href: string; label: string; icon: IconName; current?: boolean }[];
  linksTitle?: string;
  signedOutTo: string;
  /** Ends the session on the server (each console knows its own realm and CSRF cookie); the menu then goes to `signedOutTo`. */
  onSignOut: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState(props.theme);
  const ref = useRef<HTMLDivElement>(null);
  const path = usePathname() ?? `/${props.locale}`;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const hrefFor = (code: string) =>
    path.replace(new RegExp(`^/${props.locale}(?=/|$)`), `/${code}`);
  return (
    <div className="nzc-menu" ref={ref}>
      <button
        type="button"
        className="nzc-avatar-btn"
        // WCAG 2.5.3 (label in name): the accessible name starts with the initials that are visible on the button
        aria-label={`${props.initials} ${props.labels.menu}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="nzc-avatar" aria-hidden="true">
          {props.initials}
        </span>
      </button>
      {open && (
        <div className="nzc-menu-panel" role="menu" aria-label={props.labels.menu}>
          <div className="nzc-who">
            <strong>{props.name}</strong>
            <span className="nz-muted">
              <bdi dir="ltr">{props.email}</bdi>
            </span>
          </div>
          {props.profileHref && props.labels.profile && (
            <a role="menuitem" href={props.profileHref}>
              <Icon name="user" size={18} />
              {props.labels.profile}
            </a>
          )}
          {props.links && props.links.length > 0 && (
            <>
              {props.linksTitle && <p className="nzc-menu-title">{props.linksTitle}</p>}
              {props.links.map((l) => (
                <a
                  key={l.href}
                  role="menuitem"
                  href={l.href}
                  aria-current={l.current ? 'page' : undefined}
                >
                  <Icon name={l.icon} size={18} />
                  {l.label}
                </a>
              ))}
            </>
          )}
          <p className="nzc-menu-title">{props.labels.language}</p>
          {props.languages.map((l) => (
            <a
              key={l.code}
              role="menuitemradio"
              aria-checked={l.code === props.locale}
              href={hrefFor(l.code)}
              lang={l.code}
              hrefLang={l.code}
            >
              <Icon name="globe" size={18} />
              <span className="nzc-grow">{l.label}</span>
              {l.code === props.locale && (
                <span className="nzc-check" aria-hidden="true">
                  ✓
                </span>
              )}
            </a>
          ))}
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={theme === 'dark'}
            onClick={() => {
              const next = theme === 'dark' ? 'light' : 'dark';
              setTheme(next);
              document.body.dataset.theme = next;
              document.cookie = `nuzm_theme=${next}; path=/; max-age=31536000; samesite=lax`;
            }}
          >
            <Icon name={theme === 'dark' ? 'moon' : 'sun'} size={18} />
            <span className="nzc-grow">{props.labels.darkMode}</span>
            <span className="nzc-switch" data-on={theme === 'dark'} aria-hidden="true" />
          </button>
          <hr />
          <button
            type="button"
            role="menuitem"
            onClick={async () => {
              await props.onSignOut();
              window.location.assign(props.signedOutTo);
            }}
          >
            <Icon name="logout" size={18} />
            {props.labels.signOut}
          </button>
        </div>
      )}
    </div>
  );
}
