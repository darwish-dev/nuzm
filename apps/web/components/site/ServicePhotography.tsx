import { Icon } from '@nuzm/ui';
import type { Locale } from '@nuzm/i18n';
import { pick, type ServiceContent } from '../../lib/site-content';

const photos: Record<string, { file: string; alt: { en: string; ar: string } }> = {
  hosting: {
    file: 'workspace',
    alt: {
      en: 'Laptop displaying website analytics on a desk',
      ar: 'حاسوب يعرض تحليلات موقع على مكتب',
    },
  },
  cloud: {
    file: 'infrastructure',
    alt: { en: 'Rows of server racks in a data center', ar: 'صفوف خوادم في مركز بيانات' },
  },
  vps: {
    file: 'infrastructure',
    alt: { en: 'Server infrastructure in a data center', ar: 'بنية خوادم في مركز بيانات' },
  },
  domains: {
    file: 'workspace',
    alt: { en: 'Digital workspace with website analytics', ar: 'مساحة عمل رقمية وتحليلات موقع' },
  },
  'ai-builder': {
    file: 'development',
    alt: { en: 'Laptop and code in a developer workspace', ar: 'حاسوب وبرمجة في مساحة عمل مطور' },
  },
  email: {
    file: 'team',
    alt: { en: 'A bright shared office workspace', ar: 'مساحة مكتب مشتركة مضيئة' },
  },
  data: {
    file: 'infrastructure',
    alt: { en: 'Data center server equipment', ar: 'معدات خوادم في مركز بيانات' },
  },
  automation: {
    file: 'development',
    alt: { en: 'Software development workspace', ar: 'مساحة عمل لتطوير البرمجيات' },
  },
};

export function ServicePhotography({
  locale,
  s,
  steps = false,
}: {
  locale: Locale;
  s: ServiceContent;
  steps?: boolean;
}) {
  const photo = steps
    ? photos[s.slug === 'email' ? 'hosting' : 'ai-builder']!
    : (photos[s.slug] ?? photos.hosting!);
  return (
    <figure className={`svc-photo${steps ? ' svc-photo-steps' : ''}`}>
      <img
        src={`/images/services/photos/${photo.file}.jpg`}
        alt={pick(photo.alt, locale)}
        width={1400}
        height={1000}
        loading="lazy"
      />
      <figcaption>
        <span className="svc-photo-symbol">
          <Icon name={s.icon} size={25} />
        </span>
        <span>
          <small>
            {locale === 'ar' ? 'مساحة واحدة. إمكانيات أكثر.' : 'One workspace. More possibilities.'}
          </small>
          <strong>{pick(s.name, locale)}</strong>
        </span>
      </figcaption>
      <span className="svc-photo-label">
        {locale === 'ar' ? 'صورة توضيحية' : 'Illustrative photography'}
      </span>
    </figure>
  );
}
