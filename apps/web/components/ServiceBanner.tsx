import { Icon, ButtonLink } from '@nuzm/ui';

/** Decorative service artwork inherits the console's brand palette. */
export function ServiceBanner({ locale, service, canCreate }: {
  locale: string; service: 'hosting' | 'compute'; canCreate: boolean;
}) {
  const ar = locale === 'ar';
  const hosting = service === 'hosting';
  return <section className="nzc-service-banner">
    <div className="nzc-service-copy">
      <h2>{hosting ? (ar ? 'امنح موقعك بداية مميزة' : 'Give your website a great home') : (ar ? 'مساحة أكبر لفكرتك القادمة' : 'More power for your next idea')}</h2>
      <p>{hosting ? (ar ? 'اختر الاستضافة المناسبة وانطلق بموقعك من مكان واحد.' : 'Find your hosting plan, connect a domain, and bring your website to life.') : (ar ? 'اختر موارد خادمك ومنطقته وأدره من مكان واحد.' : 'Choose your resources and region. Build, launch, and manage your cloud server in one place.')}</p>
      {canCreate && <ButtonLink href={`/${locale}/${hosting ? 'hosting/sites/new' : 'compute/instances/new'}`}><Icon name="plus" size={18}/>{ar ? (hosting ? 'أضف موقعًا' : 'أنشئ خادمًا') : (hosting ? 'Add website' : 'Create cloud server')}</ButtonLink>}
    </div>
    <div className={`nzc-service-art nzc-service-art--${service}`} aria-hidden="true">
      <div className="nzc-service-orbit" />
      <div className="nzc-service-tile"><Icon name={hosting ? 'hosting' : 'cloud'} size={80}/></div>
      <div className="nzc-service-layer nzc-service-layer--back"><Icon name={hosting ? 'globe' : 'hosting'} size={30}/><span/><span/></div>
      <div className="nzc-service-layer nzc-service-layer--front"><Icon name="check" size={24}/><span/><span/></div>
    </div>
  </section>;
}
