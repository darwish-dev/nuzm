'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { t, type Locale } from '@nuzm/i18n';
import { Banner, Button, Field, Input } from '@nuzm/ui';
import { useAction } from '../lib/actions';
import { browserApi } from '../lib/client';

/**
 * Delete a project (a website, a web app or a mobile app). The API soft-deletes it with a retention window and wants the project NAME typed as the approval of this
 * destructive action (`confirmName`); so does this dialog, and the confirm button stays disabled until the name matches exactly. A deployment in progress answers 409.
 * `redirectTo` is where to go after the delete (the workspace leaves for the project list); without it the page is refreshed (the list drops the card).
 * The trigger is a button on a card (`button`) or an entry of the workspace "more" menu (`menu`); the dialog is rendered in a portal so a closed menu cannot hide it.
 */
export function DeleteProject({
  locale,
  project,
  mfaFactorId = null,
  redirectTo,
  variant = 'button',
}: {
  locale: Locale;
  project: { id: string; name: string };
  mfaFactorId?: string | null;
  redirectTo?: string;
  variant?: 'button' | 'menu';
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const a = useAction(locale, mfaFactorId);
  const dlg = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const matches = typed.trim() === project.name;

  useEffect(() => {
    const d = dlg.current;
    if (!open || !d) return;
    // jsdom (the unit tests) has no showModal; a real browser gets the focus trap and the Escape key
    if (typeof d.showModal === 'function') {
      if (!d.open) d.showModal();
    } else d.setAttribute('open', '');
    input.current?.focus();
  }, [open]);

  function close() {
    const d = dlg.current;
    if (d && typeof d.close === 'function') d.close();
    setOpen(false);
    setTyped('');
    a.setNotice(null);
  }
  function submit(ev: FormEvent) {
    ev.preventDefault();
    if (!matches || a.busy) return;
    void a.run(
      () =>
        browserApi().DELETE('/v1/builder/projects/{id}', {
          params: { path: { id: project.id }, query: { confirmName: typed.trim() } },
        }),
      () => {
        close();
        if (redirectTo) router.push(redirectTo);
        else router.refresh();
      },
      {
        404: t(locale, 'pdel.err.notFound'),
        409: t(locale, 'pdel.err.inUse'),
        422: t(locale, 'pdel.err.mismatch'),
      },
    );
  }

  const label = t(locale, variant === 'menu' ? 'pdel.menu' : 'action.delete');
  return (
    <>
      {variant === 'menu' ? (
        <button
          type="button"
          className="bws-more-item bws-more-danger"
          onClick={() => setOpen(true)}
        >
          {label}
        </button>
      ) : (
        <Button
          variant="danger"
          aria-label={t(locale, 'pdel.aria', { name: project.name })}
          onClick={() => setOpen(true)}
        >
          {label}
        </Button>
      )}
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <dialog
            ref={dlg}
            className="pdel-dialog"
            aria-labelledby={`pdel-h-${project.id}`}
            onCancel={(e) => {
              e.preventDefault();
              close();
            }}
          >
            <form onSubmit={submit} noValidate>
              <h2 className="nz-h2" id={`pdel-h-${project.id}`}>
                {t(locale, 'pdel.title', { name: project.name })}
              </h2>
              <p>{t(locale, 'pdel.body')}</p>
              <Field
                id={`pdel-in-${project.id}`}
                label={t(locale, 'pdel.type')}
                help={t(locale, 'pdel.typeHelp', { name: project.name })}
              >
                {(x) => (
                  <Input
                    {...x}
                    ref={input}
                    autoComplete="off"
                    spellCheck={false}
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                  />
                )}
              </Field>
              {a.notice && <Banner tone="danger">{a.notice.text}</Banner>}
              <div className="nz-row pdel-actions">
                <Button variant="secondary" onClick={close} disabled={a.busy}>
                  {t(locale, 'action.cancel')}
                </Button>
                <Button type="submit" variant="danger" disabled={!matches || a.busy}>
                  {t(locale, 'pdel.confirm')}
                </Button>
              </div>
            </form>
            {a.panel}
          </dialog>,
          document.body,
        )}
    </>
  );
}
