'use client';
import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { t, type Locale, type MessageKey } from '@nuzm/i18n';
import { Banner, Icon } from '@nuzm/ui';
import type { Message, Page_, Run, Session } from '../lib/builder';
import { bapi, newKey, useBuilderCall } from '../lib/builder-client';
import { BrandMark } from './BrandLogo';
import { ProblemNote, when } from './BuilderBits';

/** What each workspace's chat starts: the kind of run, its input, the length limits and the texts. */
const CHAT = {
  website: {
    kind: 'edit',
    input: (instruction: string) => ({ instruction }),
    min: 1,
    max: 2000,
    title: 'bld.chat.title',
    empty: 'bld.chat.empty',
    placeholder: 'bld.chat.placeholder',
    busy: 'bld.chat.placeholderBusy',
    help: 'bld.chat.help',
  },
  mobile: {
    kind: 'mobile',
    input: (description: string) => ({ description }),
    min: 3,
    max: 600,
    title: 'mws.chat.title',
    empty: 'mws.chat.empty',
    placeholder: 'mws.chat.placeholder',
    busy: 'mws.chat.placeholderBusy',
    help: 'mws.chat.help',
  },
  webapp: {
    kind: 'webapp',
    input: (prompt: string) => ({ brief: { prompt } }),
    min: 1,
    max: 8000,
    title: 'mws.web.chat.title',
    empty: 'mws.web.chat.empty',
    placeholder: 'mws.web.chat.placeholder',
    busy: 'mws.web.chat.placeholderBusy',
    help: 'mws.web.chat.help',
  },
} as const;

/** One message of the conversation: your words as a soft bubble on the end side; the assistant's as plain text under the brand mark, with a copy button. The time is kept for assistive technology and as a tooltip. */
function ChatMessage({ locale, m }: { locale: Locale; m: Message }) {
  const [copied, setCopied] = useState(false);
  const when_ = when(m.createdAt, locale);
  if (m.role === 'user')
    return (
      <li className="bld-msg" data-role="user" title={when_}>
        <bdi dir="auto" className="bld-msg-body">
          {m.content}
        </bdi>
        <time className="nz-sr" dateTime={m.createdAt}>
          {t(locale, 'bld.chat.role.user')} · {when_}
        </time>
      </li>
    );
  const copy = () =>
    void navigator.clipboard?.writeText(m.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  return (
    <li className="bld-msg" data-role={m.role}>
      <span className="bld-msg-head">
        <BrandMark />
        <strong>{m.role === 'assistant' ? 'Nuzm' : t(locale, `bld.chat.role.${m.role}`)}</strong>
      </span>
      <bdi dir="auto" className="bld-msg-body">
        {m.content}
      </bdi>
      <span className="bld-msg-actions">
        <button
          type="button"
          onClick={copy}
          aria-label={t(locale, copied ? 'bld.chat.copied' : 'bld.chat.copy')}
          title={t(locale, copied ? 'bld.chat.copied' : 'bld.chat.copy')}
        >
          <Icon name={copied ? 'check' : 'copy'} size={15} />
        </button>
        <time dateTime={m.createdAt}>{when_}</time>
      </span>
    </li>
  );
}

/**
 * UI-M09-03 left panel: the conversation of the project's AI session. "Edit by chat": the instruction is stored as a message and starts a `kind=edit` run; the
 * run only PROPOSES a change set, which the human approves in the run timeline before anything is applied. Needs `ai:write`; a viewer reads the conversation.
 */
export function Chat({
  locale,
  projectId,
  projectName,
  session,
  initialMessages,
  canWrite,
  refreshKey,
  activeRun,
  onRun,
  thread,
  history,
  mode = 'website',
}: {
  locale: Locale;
  projectId: string;
  projectName: string;
  session: Session | null;
  initialMessages: Message[];
  canWrite: boolean;
  /** bumped by the workspace when a run changed state, to re-read the conversation */
  refreshKey: number;
  /** a run is queued, running or waiting: a second one cannot start (one active run per session) */
  activeRun: boolean;
  onRun: (run: Run) => void;
  /** the live run card, shown inside the scrolling thread after the messages */
  thread?: ReactNode;
  /**
   * earlier runs of the project placed in the conversation (the web-app studio): `before` is shown ahead of the first message and `after(m)` right after a message;
   * both are lists of `<li>` elements, computed from the messages the chat currently shows
   */
  history?: (messages: Message[]) => { before?: ReactNode; after?: (m: Message) => ReactNode };
  /**
   * which workspace the chat belongs to. `website`: the message starts an `edit` run (a change set to approve). `mobile`: a `mobile` run (a new design request,
   * 3..600 characters). `webapp`: a `webapp` run (a brief of up to 8000 characters for the agent graph). The texts say so.
   */
  mode?: 'website' | 'webapp' | 'mobile';
}) {
  const cfg = CHAT[mode];
  const call = useBuilderCall();
  const [sessionId, setSessionId] = useState(session?.id ?? null);
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [text, setText] = useState('');
  const keys = useRef({ session: newKey(), message: newKey(), run: newKey() });
  const log = useRef<HTMLDivElement>(null);
  const hist = history?.(messages) ?? {};
  /** the instruction already stored as a message whose run could not start: a retry must not add the same message twice */
  const storedText = useRef<string | null>(null);

  useEffect(() => {
    if (!sessionId || refreshKey === 0) return;
    void bapi
      .get<Page_<Message>>(`/v1/ai/sessions/${sessionId}/messages`, { query: { limit: 100 } })
      .then((r) => {
        if (r.response.ok && r.data) setMessages(r.data.items);
      });
  }, [sessionId, refreshKey]);
  useEffect(() => {
    // keep the newest message and the live run card in view
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, refreshKey, activeRun]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const instruction = text.trim();
    if (!instruction || activeRun || instruction.length < cfg.min) return;
    let sid = sessionId;
    if (!sid) {
      const ok = await call.run(
        () =>
          bapi.post<Session>('/v1/ai/sessions', {
            body: { title: projectName.slice(0, 200), projectId },
            idempotencyKey: keys.current.session,
          }),
        (s) => {
          sid = s.id;
          setSessionId(s.id);
        },
      );
      if (!ok || !sid) return;
    }
    const sessionRef = sid;
    if (storedText.current !== instruction) {
      const stored = await call.run(
        () =>
          bapi.post<Message>(`/v1/ai/sessions/${sessionRef}/messages`, {
            body: { content: instruction },
            idempotencyKey: keys.current.message,
          }),
        (m) => {
          keys.current.message = newKey();
          storedText.current = instruction;
          setMessages((l) => [...l, m]);
        },
        // content_blocked / secret_detected: nothing was stored, the same text may be edited and sent again with a new key
        () => {
          keys.current.message = newKey();
        },
      );
      if (!stored) return;
    }
    await call.run(
      () =>
        bapi.post<Run>('/v1/ai/runs', {
          body: { sessionId: sessionRef, kind: cfg.kind, projectId, input: cfg.input(instruction) },
          idempotencyKey: keys.current.run,
        }),
      (run) => {
        keys.current.run = newKey();
        storedText.current = null;
        setText('');
        onRun(run);
      },
      (p) => {
        if (p.status !== 599) keys.current.run = newKey();
      },
    );
  }

  return (
    <div className="bld-chat">
      <h2 className="bld-chat-title">{t(locale, cfg.title)}</h2>
      <div className="bld-chat-scroll" role="log" aria-label={t(locale, 'bld.chat.log')} ref={log}>
        {messages.length === 0 && !thread && !hist.before ? (
          <p className="nz-muted bld-chat-empty">{t(locale, cfg.empty)}</p>
        ) : (
          <ol className="bld-list">
            {hist.before}
            {messages.map((m) => (
              <Fragment key={m.id}>
                <ChatMessage locale={locale} m={m} />
                {hist.after?.(m)}
              </Fragment>
            ))}
          </ol>
        )}
        {thread}
      </div>
      {canWrite ? (
        <form className="bld-composer" onSubmit={(e) => void send(e)}>
          {call.problem && <ProblemNote locale={locale} problem={call.problem} />}
          <div className="bld-composer-box">
            <label className="nz-sr" htmlFor="bld-chat-input">
              {t(locale, 'bld.chat.input')}
            </label>
            <textarea
              id="bld-chat-input"
              className="bld-composer-input"
              dir="auto"
              rows={3}
              maxLength={cfg.max}
              placeholder={t(locale, activeRun ? cfg.busy : cfg.placeholder)}
              disabled={activeRun}
              aria-describedby="bld-chat-help"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(e as never);
              }}
            />
            <div className="bld-composer-foot">
              <span className="bld-chip">
                <Icon
                  name={mode === 'website' ? 'globe' : mode === 'webapp' ? 'code' : 'phone'}
                  size={14}
                />
                {t(locale, `bld.start.type.${mode}` as MessageKey)}
              </span>
              <button
                type="submit"
                className="bld-send"
                disabled={call.busy || activeRun || text.trim().length < cfg.min}
                aria-label={t(locale, 'bld.chat.send')}
              >
                <Icon name="send" size={18} />
              </button>
            </div>
          </div>
          <p className="bld-composer-help" id="bld-chat-help">
            {t(locale, cfg.help)}
          </p>
        </form>
      ) : (
        <Banner tone="warn">{t(locale, 'bld.readonly')}</Banner>
      )}
    </div>
  );
}
