import { describe, expect, it } from 'vitest';
import { loadDunningPolicy, parseDunningPolicy } from './dunning-policy';

const GOOD = `
version: 2
status: PROPOSED-NOT-APPROVED
retries: { afterDays: [1, 3, 5] }
stages:
  - { stage: reminder_1, afterDays: 3 }
  - { stage: reminder_2, afterDays: 7 }
  - { stage: restricted, afterDays: 14 }
  - { stage: suspended, afterDays: 21 }
  - { stage: terminated_pending, afterDays: 45 }
`;

describe('dunning policy', () => {
  it('the repository file loads and matches the docs/11 proposal', () => {
    const p = loadDunningPolicy();
    expect(p.status).toBe('PROPOSED-NOT-APPROVED');
    expect(p.retryAfterDays).toEqual([1, 3, 5]);
    expect(p.stages.map((s) => [s.stage, s.afterDays])).toEqual([
      ['reminder_1', 3],
      ['reminder_2', 7],
      ['restricted', 14],
      ['suspended', 21],
      ['terminated_pending', 45],
    ]);
  });
  it('parses a valid policy', () => {
    expect(parseDunningPolicy(GOOD)).toMatchObject({ version: 2, retryAfterDays: [1, 3, 5] });
  });
  it('refuses broken policies loudly instead of changing when customers are restricted', () => {
    const bad: [string, RegExp][] = [
      ['version: 1', /status is required/],
      [GOOD.replace('version: 2', 'version: 0'), /version/],
      [GOOD.replace('status: PROPOSED-NOT-APPROVED', 'status: x'), /status/],
      [GOOD.replace('[1, 3, 5]', '[3, 1]'), /ascending/],
      [GOOD.replace('[1, 3, 5]', '[0]'), /1\.\.90/],
      [GOOD.replace('[1, 3, 5]', '[20]'), /retries must come first/],
      [GOOD.replace('afterDays: 7', 'afterDays: 3'), /ascending/],
      [GOOD.replace('reminder_2', 'suspended'), /stage 2 must be reminder_2/],
      [
        GOOD.replace(
          '{ stage: terminated_pending, afterDays: 45 }',
          '{ stage: terminated_pending, afterDays: 45, action: delete_data }',
        ),
        /cannot add actions/,
      ],
      [GOOD.replace('  - { stage: terminated_pending, afterDays: 45 }\n', ''), /exactly/],
      [GOOD.replace('afterDays: 45', 'afterDays: 9999'), /at most 365/],
    ];
    for (const [text, re] of bad)
      expect(() => parseDunningPolicy(text), text.slice(0, 40)).toThrow(re);
  });
});
