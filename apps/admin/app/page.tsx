import { redirect } from 'next/navigation';
import { defaultLocale } from '@nuzm/i18n';

export default function Index() {
  redirect(`/${defaultLocale}/organizations`);
}
