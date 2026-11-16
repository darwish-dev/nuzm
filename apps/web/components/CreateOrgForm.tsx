'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { t, tDynamic, type Locale } from '@nuzm/i18n';
import { Button, Field, Input, Select } from '@nuzm/ui';
import { browserApi } from '../lib/client';

export function CreateOrgForm({ locale }: { locale: Locale }) {
  const router = useRouter();
  const [err, setErr] = useState<{ name?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setErr({});
    const r = await browserApi().POST('/v1/organizations', {
      body: {
        name: String(f.get('name')),
        type: f.get('type') as 'customer' | 'agency' | 'reseller',
        defaultLocale: locale,
      },
    });
    setBusy(false);
    if (!r.response.ok) {
      const p = r.error as { errors?: { field?: string; message?: string }[] } | undefined;
      const nameErr = p?.errors?.find((x) => x.field === 'name')?.message;
      return setErr(nameErr ? { name: nameErr } : { form: t(locale, 'state.error.title') });
    }
    const org = r.data as unknown as { id: string };
    document.cookie = `nuzm_org=${org.id}; path=/; samesite=lax`;
    router.push(`/${locale}`);
    router.refresh();
  }
  return (
    <form onSubmit={submit} noValidate style={{ maxInlineSize: 420 }}>
      <Field id="name" label={t(locale, 'field.name')} error={err.name}>
        {(a) => <Input name="name" required maxLength={200} autoComplete="organization" {...a} />}
      </Field>
      <Field id="type" label={t(locale, 'field.type')}>
        {(a) => (
          <Select name="type" defaultValue="customer" {...a}>
            {(['customer', 'agency', 'reseller'] as const).map((k) => (
              <option key={k} value={k}>
                {tDynamic(locale, `org.type.${k}`, k)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {err.form && (
        <p role="alert" className="nz-error-text">
          {err.form}
        </p>
      )}
      <Button type="submit" disabled={busy}>
        {t(locale, 'action.create')}
      </Button>
    </form>
  );
}
