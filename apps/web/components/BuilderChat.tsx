'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Banner, Icon } from '@nuzm/ui';
import type { Message, Page_, Run, Session } from '../lib/builder';
import { bapi, newKey, useBuilderCall } from '../lib/builder-client';
import { ProblemNote, when } from './BuilderBits';

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
}) {
  const call = useBuilderCall();
  const [sessionId, setSessionId] = useState(session?.id ?? null);
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [text, setText] = useState('');
  const keys = useRef({ session: newKey(), message: newKey(), run: newKey() });
  const log = useRef<HTMLDivElement>(null);
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
    log.current?.querySelector('li:last-child')?.scrollIntoView?.({ block: 'nearest' });
  }, [messages.length]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const instruction = text.trim();
    if (!instruction || activeRun) return;
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
          body: { sessionId: sessionRef, kind: 'edit', projectId, input: { instruction } },
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
      <h2 className="bld-chat-title">{t(locale, 'bld.chat.title')}</h2>
      {messages.length === 0 ? (
        <p className="nz-muted bld-chat-empty">{t(locale, 'bld.chat.empty')}</p>
      ) : (
        <div role="log" aria-label={t(locale, 'bld.chat.log')} ref={log} className="bld-chat-log">
          <ol className="bld-list">
            {messages.map((m) => (
              <li key={m.id} className="bld-msg" data-role={m.role}>
                <strong>{t(locale, `bld.chat.role.${m.role}`)}</strong>{' '}
                <span className="nz-muted">{when(m.createdAt, locale)}</span>
                <div>
                  <bdi dir="auto" style={{ whiteSpace: 'pre-wrap' }}>
                    {m.content}
                  </bdi>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
      {canWrite ? (
        <form className="bld-composer" onSubmit={(e) => void send(e)}>
          {activeRun && <Banner tone="warn">{t(locale, 'bld.chat.runActive')}</Banner>}
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
              maxLength={2000}
              placeholder={t(locale, 'bld.chat.placeholder')}
              aria-describedby="bld-chat-help"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(e as never);
              }}
            />
            <div className="bld-composer-foot">
              <span className="bld-composer-help" id="bld-chat-help">
                {t(locale, 'bld.chat.help')}
              </span>
              <button
                type="submit"
                className="bld-send"
                disabled={call.busy || activeRun || text.trim() === ''}
                aria-label={t(locale, 'bld.chat.send')}
              >
                <Icon name="send" size={18} />
              </button>
            </div>
          </div>
        </form>
      ) : (
        <Banner tone="warn">{t(locale, 'bld.readonly')}</Banner>
      )}
    </div>
  );
}
