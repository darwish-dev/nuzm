import { t, type Locale } from '@nuzm/i18n';

/**
 * The two-step sign-up indicator: 1 Account, 2 Organization. A read-only ordered list (the current step is announced with
 * aria-current), so it needs no script and works the same in Arabic and English.
 */
export function OnboardingSteps({ locale, current }: { locale: Locale; current: 1 | 2 }) {
  const steps = [t(locale, 'onb.account'), t(locale, 'onb.org')];
  return (
    <nav aria-label={t(locale, 'onb.step', { n: current, total: 2 })} className="nzc-steps">
      <ol>
        {steps.map((label, i) => {
          const n = i + 1;
          const state = n < current ? 'done' : n === current ? 'current' : 'todo';
          return (
            <li
              key={label}
              data-state={state}
              aria-current={state === 'current' ? 'step' : undefined}
            >
              <span className="nzc-step-dot" aria-hidden="true">
                {state === 'done' ? '✓' : n}
              </span>
              <span className="nzc-step-label">{label}</span>
            </li>
          );
        })}
      </ol>
      <p className="nz-muted">{t(locale, 'onb.step', { n: current, total: 2 })}</p>
    </nav>
  );
}
