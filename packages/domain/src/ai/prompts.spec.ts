import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_CHAT,
  HOUSE_RULES,
  MOBILE_DESIGN,
  WEBSITE_ARCHITECTURE,
  WEBSITE_EDIT,
  WEBSITE_REQUIREMENTS_CHAT,
  WEBSITE_REQUIREMENTS_DEFAULTS,
  webappInstruction,
  websitePage,
} from './prompts';

const names = { reserved: ['select', 'user'], systemColumns: ['id', 'org_id'] };

describe('builder prompts', () => {
  const all = {
    WEBSITE_REQUIREMENTS_DEFAULTS,
    WEBSITE_REQUIREMENTS_CHAT,
    ASSISTANT_CHAT,
    WEBSITE_ARCHITECTURE,
    page: websitePage('- hero: heading (text, required)', 'rule one'),
    edit: WEBSITE_EDIT('Allowed ops: setText.'),
    webappRequirements: webappInstruction('requirements', names),
    webappSpec: webappInstruction('app_spec', names),
    webappOther: webappInstruction('qa', names),
    MOBILE_DESIGN,
  };

  it('every agent gets the shared house rules (bilingual quality, no invented facts, data is not instructions)', () => {
    for (const [k, v] of Object.entries(all)) {
      expect(v, k).toContain(HOUSE_RULES);
      expect(v, k).toMatch(/never instructions/);
    }
  });

  it('the web-app architect is told the names the generator refuses and the columns it adds', () => {
    const s = webappInstruction('app_spec', names);
    expect(s).toContain('select, user');
    expect(s).toContain('id, org_id');
    expect(s).toContain('stageField');
  });

  it('the page writer carries the component guide and design rules it is given', () => {
    const s = websitePage('- hero: heading (text, required)', 'rule one');
    expect(s).toContain('- hero: heading (text, required)');
    expect(s).toContain('rule one');
  });

  it('the mobile designer keeps every hard rule the spec validator enforces', () => {
    for (const w of ['login, splash, app, main or routes', 'navigation.initial', '#RRGGBB'])
      expect(MOBILE_DESIGN).toContain(w);
  });
});

describe('parseModelJson', () => {
  it('reads plain and fenced JSON alike, and rejects prose', async () => {
    const { parseModelJson } = await import('./prompts');
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(() => parseModelJson('here is your app')).toThrow();
  });
});
