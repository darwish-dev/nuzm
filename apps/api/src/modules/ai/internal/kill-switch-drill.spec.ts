import { describe, expect, it } from 'vitest';
import { runKillSwitchDrill, type DrillPorts } from './kill-switch-drill';

/** The drill logic against an in-memory switch: SIMULATED (the real gateway is exercised by p3-s01-credentials.int.spec.ts). */
function ports(
  over: Partial<{
    initial: boolean;
    slow: number;
    broken: boolean;
    liftFails: boolean;
    unavailable: boolean;
  }> = {},
) {
  let engaged = over.initial ?? false;
  let t = 0;
  const audits: { detail: Record<string, unknown>; outcome: string }[] = [];
  const p: DrillPorts = {
    isEngaged: async () => engaged,
    setEngaged: async (on) => {
      if (!on && over.liftFails) return;
      engaged = on;
    },
    probe: async () => {
      if (engaged && over.slow) t += over.slow;
      if (over.unavailable) return 'other';
      return engaged && !over.broken ? 'killswitch' : 'available';
    },
    audit: async (detail, outcome) => void audits.push({ detail, outcome }),
    now: () => t,
  };
  return { p, audits, state: () => engaged };
}

describe('kill switch drill', () => {
  it('engages, sees the switch refuse AI within the bound, lifts, sees AI restored, audits', async () => {
    const h = ports();
    const r = await runKillSwitchDrill(h.p);
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => s.id)).toEqual([
      'baseline',
      'engage',
      'refused_within_bound',
      'lift',
      'restored',
    ]);
    expect(r.restored).toBe(true);
    expect(h.state()).toBe(false);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]!.outcome).toBe('success');
  });
  it('refuses to start while the switch is already engaged (an incident) and leaves it engaged', async () => {
    const h = ports({ initial: true });
    const r = await runKillSwitchDrill(h.p);
    expect(r.ok).toBe(false);
    expect(h.state()).toBe(true);
    expect(h.audits[0]!.outcome).toBe('failure');
  });
  it('a switch that does not stop AI fails the drill, and the drill still lifts it', async () => {
    const h = ports({ broken: true });
    const r = await runKillSwitchDrill(h.p);
    expect(r.ok).toBe(false);
    expect(r.steps.find((s) => s.id === 'refused_within_bound')!.ok).toBe(false);
    expect(h.state()).toBe(false);
  });
  it('a switch slower than the bound fails the drill', async () => {
    const r = await runKillSwitchDrill(ports({ slow: 6_000 }).p);
    expect(r.ok).toBe(false);
    expect(r.steps.find((s) => s.id === 'refused_within_bound')!.detail).toMatch(
      /longer than 5000/,
    );
  });
  it('no baseline (AI unavailable for another reason) proves nothing: the switch is never engaged', async () => {
    const h = ports({ unavailable: true });
    const r = await runKillSwitchDrill(h.p);
    expect(r.ok).toBe(false);
    expect(r.steps.some((s) => s.id === 'engage')).toBe(false);
    expect(h.state()).toBe(false);
  });
  it('if the lift does not take, the report says so loudly and is not ok', async () => {
    const r = await runKillSwitchDrill(ports({ liftFails: true }).p);
    expect(r.ok).toBe(false);
    expect(r.restored).toBe(false);
    expect(r.steps.find((s) => s.id === 'lift')!.detail).toMatch(/STILL ENGAGED/);
  });
  it('a port that throws is a failed step, never an unhandled error, and the switch is still lifted', async () => {
    const h = ports();
    const bad: DrillPorts = {
      ...h.p,
      probe: async () => {
        throw new Error('boom');
      },
    };
    const r = await runKillSwitchDrill(bad);
    expect(r.ok).toBe(false);
    expect(h.state()).toBe(false);
  });
});
