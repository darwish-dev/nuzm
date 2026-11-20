import { describe, expect, it } from 'vitest';
import {
  addRule,
  addSection,
  installCallback,
  newSectionId,
  removeRule,
  setRule,
} from './ai-studio';
import { appTabsFor } from './webapp-workspace';

describe('AI Studio helpers', () => {
  it('section ids are unique within a layer', () => {
    const one = addSection([], 'A');
    expect(one[0]).toMatchObject({
      id: 'section-1',
      title: 'A',
      rules: [{ text: '', strength: 'should' }],
    });
    const two = addSection([{ id: 'section-2', title: 'x', rules: [] }], 'B');
    expect(two.map((s) => s.id)).toEqual(['section-2', 'section-3']);
    expect(newSectionId([{ id: 'section-1', title: '', rules: [] }])).toBe('section-2');
  });
  it('rule edits are immutable and touch only their rule', () => {
    const v = addSection([], 'A');
    const w = setRule(addRule(v, 0), 0, 1, { text: 'Use integers for money', strength: 'must' });
    expect(v[0]!.rules).toHaveLength(1);
    expect(w[0]!.rules[1]).toEqual({ text: 'Use integers for money', strength: 'must' });
    expect(removeRule(w, 0, 0)[0]!.rules).toEqual([
      { text: 'Use integers for money', strength: 'must' },
    ]);
  });
  it('the installation callback needs a positive installation id and a state', () => {
    expect(installCallback({ installation_id: '42', state: 'a.b' })).toEqual({
      installationId: 42,
      state: 'a.b',
    });
    expect(installCallback({ installation_id: ['7', '8'], state: ['s'] })).toEqual({
      installationId: 7,
      state: 's',
    });
    expect(installCallback({ installation_id: '0', state: 'a' })).toBeNull();
    expect(installCallback({ installation_id: 'x', state: 'a' })).toBeNull();
    expect(installCallback({ installation_id: '1' })).toBeNull();
  });
  it('the AI Studio tab is listed only while the flag is on', () => {
    const all = () => true;
    expect(appTabsFor(all)).not.toContain('studio');
    expect(appTabsFor(all, true)).toContain('studio');
    expect(appTabsFor((p) => p !== 'builder:read', true)).not.toContain('studio');
  });
});
