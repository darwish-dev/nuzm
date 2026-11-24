'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { t, type Locale } from '@nuzm/i18n';
import { Icon, type IconName } from '@nuzm/ui';
import { bapi } from '../lib/builder-client';
import type { ClaudeCodeStatus } from '../lib/ai-studio';
import { looksBinary } from '../lib/start-sources';

/**
 * Pieces of the workspace chat composer, the way a modern chat works:
 *  - attachments: text and code files (read in the browser, at most 20 000 characters each) and links (the server fetches them safely); they travel
 *    with the message (`attachments: [{kind: text|url}]`), where the API validates, moderates and secret-scans them, and the edit run reads them as data;
 *  - dictation: speak instead of typing, through the browser's own speech recognition (shown only where the browser offers it; the text is editable
 *    before sending, nothing is sent by voice alone);
 *  - the assistant switcher: Nuzm AI (the built-in assistant, billed in AI credits) or Claude Code (the customer's own Claude subscription inside the
 *    project's sandbox, a proof of concept behind the organization switch and the compliance gate — never a billable fallback).
 */
export type ChatAttachment =
  { kind: 'text'; name: string; text: string; size: number } | { kind: 'url'; url: string };

export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_CHARS = 20_000;
const TEXT_EXT =
  /\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|html?|css|scss|js|jsx|ts|tsx|mjs|cjs|py|rb|php|java|kt|swift|dart|go|rs|c|h|cpp|cs|sql|sh|env\.example|ini|toml|svg)$/i;

/** Reads picked files into text attachments; anything that is not text, or too long, is refused with a reason. */
export async function readAttachments(
  files: readonly File[],
): Promise<{ ok: ChatAttachment[]; refused: { name: string; why: 'type' | 'size' }[] }> {
  const ok: ChatAttachment[] = [];
  const refused: { name: string; why: 'type' | 'size' }[] = [];
  for (const f of files) {
    if (!(f.type.startsWith('text/') || TEXT_EXT.test(f.name))) {
      refused.push({ name: f.name, why: 'type' });
      continue;
    }
    const text = await f.text();
    if (looksBinary(text)) refused.push({ name: f.name, why: 'type' });
    else if (text.length > MAX_ATTACHMENT_CHARS) refused.push({ name: f.name, why: 'size' });
    else ok.push({ kind: 'text', name: f.name.slice(0, 100), text, size: f.size });
  }
  return { ok, refused };
}

export const isHttpUrl = (s: string) => /^https?:\/\/[^\s<>"']{3,1900}$/.test(s.trim());
const host = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};
const kb = (n: number) => (n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`);

/** The attachments waiting to be sent, above the text box. */
export function AttachmentChips({
  locale,
  items,
  onRemove,
}: {
  locale: Locale;
  items: ChatAttachment[];
  onRemove: (i: number) => void;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="bcx-chips" aria-label={t(locale, 'bld.chat.att.list')}>
      {items.map((a, i) => (
        <li key={i} className="bcx-chip" data-kind={a.kind}>
          <span className="bcx-chip-icon" aria-hidden="true">
            <Icon name={a.kind === 'url' ? 'external' : 'copy'} size={14} />
          </span>
          <span className="bcx-chip-text">
            <b dir="auto">{a.kind === 'url' ? host(a.url) : a.name}</b>
            <small>{a.kind === 'url' ? t(locale, 'bld.chat.att.link') : kb(a.size)}</small>
          </span>
          <button
            type="button"
            className="bcx-chip-x"
            aria-label={t(locale, 'bld.chat.att.remove', {
              name: a.kind === 'url' ? host(a.url) : a.name,
            })}
            onClick={() => onRemove(i)}
          >
            <Icon name="close" size={12} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A small popover anchored to a composer button (rendered on the page so the chat's scroll and blur never clip it). */
function Popover({
  anchor,
  open,
  onClose,
  label,
  children,
}: {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ bottom: number; start: number } | null>(null);
  useEffect(() => {
    if (!open || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const rtl = getComputedStyle(anchor).direction === 'rtl';
    setPos({
      bottom: window.innerHeight - r.top + 8,
      start: rtl ? window.innerWidth - r.right : r.left,
    });
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        anchor.focus();
      }
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open, anchor, onClose]);
  if (!open || !pos) return null;
  return createPortal(
    <div
      ref={box}
      className="bcx-pop"
      role="menu"
      aria-label={label}
      style={{ insetBlockEnd: pos.bottom, insetInlineStart: pos.start }}
    >
      {children}
    </div>,
    document.body,
  );
}

function MenuItem({
  icon,
  title,
  hint,
  onClick,
  disabled,
  checked,
  tone,
}: {
  icon: IconName;
  title: string;
  hint: string;
  onClick: () => void;
  disabled?: boolean;
  checked?: boolean;
  tone?: 'warm';
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={checked}
      className="bcx-item"
      data-tone={tone}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="bcx-item-icon" aria-hidden="true">
        <Icon name={icon} size={16} />
      </span>
      <span className="bcx-item-text">
        <b>{title}</b>
        <small>{hint}</small>
      </span>
      {checked && <Icon name="check" size={15} />}
    </button>
  );
}

/** "+": attach files or a link. */
export function AttachMenu({
  locale,
  disabled,
  full,
  onFiles,
  onLink,
}: {
  locale: Locale;
  disabled: boolean;
  /** the 10-attachment limit is reached */
  full: boolean;
  onFiles: (files: File[]) => void;
  onLink: (url: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [linking, setLinking] = useState(false);
  const [url, setUrl] = useState('');
  const btn = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const close = () => {
    setOpen(false);
    setLinking(false);
    setUrl('');
  };
  return (
    <>
      <button
        ref={btn}
        type="button"
        className="bcx-icon-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t(locale, 'bld.chat.att.add')}
        title={full ? t(locale, 'bld.chat.att.full') : t(locale, 'bld.chat.att.add')}
        disabled={disabled || full}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="plus" size={18} />
      </button>
      <input
        ref={input}
        type="file"
        hidden
        multiple
        onChange={(e) => {
          if (e.target.files) onFiles([...e.target.files]);
          e.target.value = '';
        }}
      />
      <Popover
        anchor={btn.current}
        open={open}
        onClose={close}
        label={t(locale, 'bld.chat.att.add')}
      >
        {linking ? (
          <form
            className="bcx-link-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!isHttpUrl(url)) return;
              onLink(url.trim());
              close();
            }}
          >
            <label className="nz-sr" htmlFor="bcx-link">
              {t(locale, 'bld.chat.att.linkLabel')}
            </label>
            <input
              id="bcx-link"
              type="url"
              dir="ltr"
              autoFocus
              placeholder="https://"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <button type="submit" disabled={!isHttpUrl(url)}>
              {t(locale, 'bld.chat.att.addLink')}
            </button>
          </form>
        ) : (
          <>
            <MenuItem
              icon="paperclip"
              title={t(locale, 'bld.chat.att.files')}
              hint={t(locale, 'bld.chat.att.filesHint')}
              onClick={() => {
                close();
                input.current?.click();
              }}
            />
            <MenuItem
              icon="external"
              title={t(locale, 'bld.chat.att.linkTitle')}
              hint={t(locale, 'bld.chat.att.linkHint')}
              onClick={() => setLinking(true)}
            />
          </>
        )}
      </Popover>
    </>
  );
}

type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult:
    | ((e: {
        resultIndex: number;
        results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
      }) => void)
    | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};
const recognitionCtor = (): (new () => Recognition) | null => {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => Recognition;
    webkitSpeechRecognition?: new () => Recognition;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

/** The microphone: dictation into the text box (final phrases are added; the words stay editable). Shown only where the browser can do it. */
export function DictateButton({
  locale,
  disabled,
  onText,
}: {
  locale: Locale;
  disabled: boolean;
  onText: (text: string) => void;
}) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState(false);
  const rec = useRef<Recognition | null>(null);
  useEffect(() => setSupported(recognitionCtor() !== null), []);
  useEffect(() => () => rec.current?.stop(), []);
  if (!supported) return null;
  const toggle = () => {
    if (listening) {
      rec.current?.stop();
      return;
    }
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    const r = new Ctor();
    r.lang = locale === 'ar' ? 'ar-SA' : 'en-US';
    r.interimResults = false;
    r.continuous = true;
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]!;
        if (res.isFinal) onText(res[0]!.transcript.trim());
      }
    };
    r.onerror = (e) => setError(e.error !== 'aborted' && e.error !== 'no-speech');
    r.onend = () => setListening(false);
    rec.current = r;
    setError(false);
    setListening(true);
    r.start();
  };
  return (
    <>
      <button
        type="button"
        className="bcx-icon-btn bcx-mic"
        aria-pressed={listening}
        aria-label={t(locale, listening ? 'bld.chat.mic.stop' : 'bld.chat.mic.start')}
        title={t(locale, listening ? 'bld.chat.mic.stop' : 'bld.chat.mic.hint')}
        disabled={disabled}
        onClick={toggle}
      >
        <Icon name={listening ? 'stop' : 'mic'} size={16} />
      </button>
      {listening && (
        <span className="bcx-live" role="status">
          <i aria-hidden="true" />
          {t(locale, 'bld.chat.mic.listening')}
        </span>
      )}
      {error && !listening && (
        <span className="bcx-live bcx-live-err" role="alert">
          {t(locale, 'bld.chat.mic.error')}
        </span>
      )}
    </>
  );
}

export type Engine = 'nuzm' | 'claude';

/**
 * Who answers: Nuzm AI (the built-in assistant) or Claude Code with the customer's own subscription. Claude Code runs only in a web app's sandbox,
 * only while the organization turned it on, and only once the compliance approval is recorded; choosing it opens the AI Studio's Claude Code panel.
 */
export function EngineSwitch({
  locale,
  projectId,
  mode,
  onClaude,
}: {
  locale: Locale;
  projectId: string;
  mode: 'website' | 'webapp' | 'mobile';
  /** opens the Claude Code panel of the web app (absent where there is none) */
  onClaude?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ClaudeCodeStatus | null | 'error'>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open || status !== null || mode !== 'webapp' || !onClaude) return;
    void bapi
      .get<ClaudeCodeStatus>(`/v1/builder/projects/${projectId}/claude-code`)
      .then((r) => setStatus(r.response.ok && r.data ? r.data : 'error'));
  }, [open, status, mode, onClaude, projectId]);
  const claudeHint =
    mode !== 'webapp' || !onClaude
      ? t(locale, 'bld.chat.engine.claudeWebapp')
      : status === null
        ? t(locale, 'state.loading')
        : status === 'error'
          ? t(locale, 'bld.chat.engine.claudeOff')
          : status.available
            ? t(locale, 'bld.chat.engine.claudeHint')
            : status.reason === 'compliance_pending'
              ? t(locale, 'bld.chat.engine.claudePending')
              : t(locale, 'bld.chat.engine.claudeOff');
  const claudeReady =
    mode === 'webapp' && !!onClaude && status !== null && status !== 'error' && status.available;
  return (
    <>
      <button
        ref={btn}
        type="button"
        className="bcx-engine"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span>Nuzm AI</span>
        <Icon name="chevron" size={10} />
      </button>
      <Popover
        anchor={btn.current}
        open={open}
        onClose={() => setOpen(false)}
        label={t(locale, 'bld.chat.engine.label')}
      >
        <p className="bcx-pop-title">{t(locale, 'bld.chat.engine.label')}</p>
        <MenuItem
          icon="sparkle"
          title="Nuzm AI"
          hint={t(locale, 'bld.chat.engine.nuzmHint')}
          checked
          onClick={() => setOpen(false)}
        />
        <MenuItem
          icon="code"
          tone="warm"
          title="Claude Code"
          hint={claudeHint}
          checked={false}
          disabled={!claudeReady}
          onClick={() => {
            setOpen(false);
            onClaude?.();
          }}
        />
        <p className="bcx-pop-note">{t(locale, 'bld.chat.engine.note')}</p>
      </Popover>
    </>
  );
}
