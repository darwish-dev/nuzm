'use client';
import QRCode from 'qrcode';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button, Field, Input, Ltr } from './components';
import { Icon, type IconName } from './icons';

/** Client-side widgets. They receive strings and callbacks, never fetch on their own. */

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
  return (
    <span>
      {locales
        .filter((l) => l !== current)
        .map((l) => (
          <a
            key={l}
            href={path.replace(new RegExp(`^/${current}(?=/|$)`), `/${l}`)}
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
}) {
  const [drawer, setDrawer] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setDrawer(false);
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
    </div>
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
        aria-label={props.labels.menu}
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
