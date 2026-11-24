/**
 * KILL SWITCH DRILL (P3-S01): proves, on a running system, that the global kill switch stops AI and that lifting it restores it, within the documented bound (AC: effective on the
 * next call, at most 5 s). It sends NOTHING to a vendor: the probe is the gateway's cheap pre-flight (`assertAvailable`), which reads the switch and the routing state and never calls
 * a model, so a drill costs nothing and needs no live gate. Steps: (1) baseline: AI is available; (2) engage; (3) the switch is seen within the bound; (4) lift (ALWAYS, even if a step
 * failed); (5) AI is available again. It refuses to start while the switch is already engaged (that is an incident: a drill must not lift it).
 */
export interface DrillPorts {
  /** is the GLOBAL switch engaged right now? */
  isEngaged(): Promise<boolean>;
  setEngaged(on: boolean): Promise<void>;
  /** the cheap pre-flight: 'available' when AI would be served, 'killswitch' when the switch refused it, 'other' for any other refusal (no provider, residency, credits) */
  probe(): Promise<'available' | 'killswitch' | 'other'>;
  /** audit one event (no content) */
  audit(detail: Record<string, unknown>, outcome: 'success' | 'failure'): Promise<void>;
  now?: () => number;
}
export interface DrillStep {
  id: 'baseline' | 'engage' | 'refused_within_bound' | 'lift' | 'restored';
  ok: boolean;
  ms: number;
  detail: string;
}
export interface DrillReport {
  ok: boolean;
  /** the switch is off again (the drill's own invariant) */
  restored: boolean;
  boundMs: number;
  steps: DrillStep[];
}
export const KILL_SWITCH_BOUND_MS = 5_000;

export async function runKillSwitchDrill(
  p: DrillPorts,
  boundMs = KILL_SWITCH_BOUND_MS,
): Promise<DrillReport> {
  const now = p.now ?? Date.now;
  const steps: DrillStep[] = [];
  const t = async (id: DrillStep['id'], f: () => Promise<{ ok: boolean; detail: string }>) => {
    const t0 = now();
    let r: { ok: boolean; detail: string };
    try {
      r = await f();
    } catch {
      r = { ok: false, detail: 'the step failed unexpectedly' };
    }
    steps.push({ id, ok: r.ok, ms: Math.max(0, now() - t0), detail: r.detail });
    return r.ok;
  };
  if (await p.isEngaged()) {
    const rep: DrillReport = {
      ok: false,
      restored: false,
      boundMs,
      steps: [
        {
          id: 'baseline',
          ok: false,
          ms: 0,
          detail:
            'the kill switch is already engaged: that is an incident, the drill will not touch it',
        },
      ],
    };
    await p.audit({ drill: true, refused: true }, 'failure');
    return rep;
  }
  const base = await t('baseline', async () => {
    const r = await p.probe();
    return {
      ok: r === 'available',
      detail:
        r === 'available'
          ? 'AI is available before the drill'
          : `AI is not available before the drill (${r}): the drill proves nothing`,
    };
  });
  let ok = base;
  try {
    if (base) {
      const engaged = await t('engage', async () => {
        await p.setEngaged(true);
        return { ok: true, detail: 'the global kill switch was engaged' };
      });
      if (engaged) {
        const t0 = now();
        const refused = await t('refused_within_bound', async () => {
          const r = await p.probe();
          const ms = now() - t0;
          const within = ms <= boundMs;
          return {
            ok: r === 'killswitch' && within,
            detail:
              r !== 'killswitch'
                ? `AI was still ${r === 'available' ? 'served' : 'refused for another reason'} after the switch was engaged`
                : within
                  ? 'the switch refused AI on the very next call'
                  : `the switch took longer than ${boundMs} ms`,
          };
        });
        ok = ok && refused;
      } else ok = false;
    }
  } finally {
    // the drill ALWAYS puts the switch back, whatever happened above
    const lifted = await t('lift', async () => {
      await p.setEngaged(false);
      const still = await p.isEngaged();
      return {
        ok: !still,
        detail: still
          ? 'THE SWITCH IS STILL ENGAGED: lift it by hand'
          : 'the global kill switch was lifted',
      };
    });
    ok = ok && lifted;
  }
  const restored = base
    ? await t('restored', async () => {
        const r = await p.probe();
        return {
          ok: r === 'available',
          detail:
            r === 'available'
              ? 'AI is available again'
              : `AI is not available after the drill (${r})`,
        };
      })
    : false;
  ok = ok && (base ? restored : false);
  const rep: DrillReport = { ok, restored: !(await p.isEngaged()), boundMs, steps };
  await p.audit(
    { drill: true, ok, steps: steps.map((s) => ({ id: s.id, ok: s.ok, ms: s.ms })) },
    ok ? 'success' : 'failure',
  );
  return rep;
}
