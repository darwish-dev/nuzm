'use client';
import { CHAT_MESSAGE_MAX } from '../lib/appbuilder';
import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { t, type Locale, type MessageKey } from '@nuzm/i18n';
import { Banner, Icon } from '@nuzm/ui';
import type { Message, Page_, Run, Session } from '../lib/builder';
import { bapi, newKey, useBuilderCall } from '../lib/builder-client';
import { BrandMark } from './BrandLogo';
import { ProblemNote, when } from './BuilderBits';
import {
  AttachMenu,
  AttachmentChips,
  DictateButton,
  EngineSwitch,
  MAX_ATTACHMENTS,
  readAttachments,
  type ChatAttachment,
} from './ChatComposer';

/** What each workspace's chat starts: the kind of run, its input, the length limits and the texts. */
const CHAT = {
  website: {
    kind: 'edit',
    input: (instruction: string) => ({ instruction }),
    min: 1,
    max: CHAT_MESSAGE_MAX,
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
    max: CHAT_MESSAGE_MAX,
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
    max: CHAT_MESSAGE_MAX,
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
        {m.attachments && m.attachments.length > 0 && (
          <span className="bld-msg-atts">
            {m.attachments.map((a, i) => (
              <span key={i} className="bld-msg-att">
                <Icon name={a.kind === 'url' ? 'external' : 'paperclip'} size={12} />
                <bdi dir="auto">{a.kind === 'url' ? (a.url ?? '') : (a.name ?? '')}</bdi>
              </span>
            ))}
          </span>
        )}
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
  onClaude,
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
  /** the web app's Claude Code panel (AI Studio): offered in the assistant switcher where it exists */
  onClaude?: () => void;
}) {
  const cfg = CHAT[mode];
  const call = useBuilderCall();
  const [sessionId, setSessionId] = useState(session?.id ?? null);
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [text, setText] = useState('');
  const [atts, setAtts] = useState<ChatAttachment[]>([]);
  const [attNote, setAttNote] = useState('');
  // attachments are read by the website edit run (and the plain chat): the other workspaces start runs that take the words only
  const canAttach = mode === 'website';
  const keys = useRef({ session: newKey(), message: newKey(), run: newKey() });
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  // the box grows with the words, up to its maximum height (only the height: long words wrap, the width never changes)
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);
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
    if (!instruction || activeRun || instruction.length < cfg.min || instruction.length > cfg.max)
      return;
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
            body: {
              content: instruction,
              ...(canAttach && atts.length > 0
                ? {
                    attachments: atts.map((x) =>
                      x.kind === 'url'
                        ? { kind: 'url', url: x.url }
                        : { kind: 'text', name: x.name, text: x.text },
                    ),
                  }
                : {}),
            },
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
        setAtts([]);
        setAttNote('');
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
            <AttachmentChips
              locale={locale}
              items={atts}
              onRemove={(i) => setAtts((l) => l.filter((_, j) => j !== i))}
            />
            {/* one compact row, like a chat app: attach at the start, the words, then send and the microphone */}
            <div className="bcx-line">
              {canAttach && (
                <AttachMenu
                  locale={locale}
                  disabled={activeRun}
                  full={atts.length >= MAX_ATTACHMENTS}
                  onFiles={(files) =>
                    void readAttachments(files).then(({ ok, refused }) => {
                      const room = MAX_ATTACHMENTS - atts.length;
                      setAtts((l) => [...l, ...ok.slice(0, room)]);
                      setAttNote(
                        refused.length > 0
                          ? t(locale, 'bld.chat.att.refused', {
                              names: refused.map((r) => r.name).join('، '),
                            })
                          : ok.length > room
                            ? t(locale, 'bld.chat.att.full')
                            : '',
                      );
                    })
                  }
                  onLink={(url) => setAtts((l) => [...l, { kind: 'url', url }])}
                />
              )}
              <label className="nz-sr" htmlFor="bld-chat-input">
                {t(locale, 'bld.chat.input')}
              </label>
              <textarea
                id="bld-chat-input"
                ref={input}
                className="bld-composer-input"
                dir="auto"
                rows={1}
                placeholder={t(locale, activeRun ? cfg.busy : cfg.placeholder)}
                disabled={activeRun}
                aria-describedby="bld-chat-help"
                aria-invalid={text.trim().length > cfg.max || undefined}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  // Enter sends, Shift+Enter starts a new line (an input method still composing a word keeps its Enter)
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send(e as never);
                  }
                }}
              />
              <button
                type="submit"
                className="bld-send"
                disabled={
                  call.busy ||
                  activeRun ||
                  text.trim().length < cfg.min ||
                  text.trim().length > cfg.max
                }
                aria-label={t(locale, 'bld.chat.send')}
              >
                <Icon name="send" size={17} />
              </button>
              <DictateButton
                locale={locale}
                disabled={activeRun}
                onText={(words) =>
                  setText((cur) => (cur.trim() ? `${cur.trimEnd()} ${words}` : words))
                }
              />
            </div>
          </div>
          {/* a quiet line under the box: what the chat works on, which assistant answers, and whether a run is working */}
          <div className="bcx-meta">
            <span className="bcx-meta-type">
              {t(locale, `bld.start.type.${mode}` as MessageKey)}
            </span>
            <EngineSwitch locale={locale} projectId={projectId} mode={mode} onClaude={onClaude} />
            <span
              className="bcx-ring"
              data-active={activeRun || call.busy || undefined}
              role="img"
              aria-label={t(locale, activeRun ? 'bld.chat.state.working' : 'bld.chat.state.ready')}
              title={t(locale, activeRun ? 'bld.chat.state.working' : 'bld.chat.state.ready')}
            />
          </div>
          {attNote && (
            <p className="bld-composer-note" role="status">
              {attNote}
            </p>
          )}
          <p className="bld-composer-help" id="bld-chat-help">
            {text.trim().length > cfg.max ? (
              <span className="nz-error" role="alert">
                {t(locale, 'bld.chat.tooLong', { max: cfg.max, n: text.trim().length })}
              </span>
            ) : (
              <>
                {t(locale, cfg.help)} <span className="bcx-keys">{t(locale, 'bld.chat.keys')}</span>
              </>
            )}
          </p>
        </form>
      ) : (
        <Banner tone="warn">{t(locale, 'bld.readonly')}</Banner>
      )}
    </div>
  );
}
