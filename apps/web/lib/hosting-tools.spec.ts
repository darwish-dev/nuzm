import { describe, expect, it } from 'vitest';
import { t } from '@nuzm/i18n';
import { REASON_KEY, SITE_TOOLS, type ToolReason } from './hosting-tools';
import { toolProblem } from './hosting-tools-client';

describe('website tools catalog', () => {
  it('lists the seven tools once, each with a path, an icon and Arabic and English texts', () => {
    expect(SITE_TOOLS.map((x) => x.id).sort()).toEqual([
      'cron',
      'files',
      'ftp',
      'logs',
      'mail',
      'php',
      'protection',
    ]);
    expect(new Set(SITE_TOOLS.map((x) => x.path)).size).toBe(SITE_TOOLS.length);
    for (const tool of SITE_TOOLS)
      for (const key of [tool.title, tool.desc]) {
        expect(t('ar', key), key).not.toBe(key);
        expect(t('en', key), key).not.toBe(key);
      }
  });
  it('says every reason the API can give in both languages', () => {
    const reasons: ToolReason[] = [
      'role',
      'site_state',
      'connection',
      'panel_version',
      'panel_service',
      'plan',
    ];
    for (const r of reasons) {
      expect(t('ar', REASON_KEY[r])).not.toBe(REASON_KEY[r]);
      expect(t('en', REASON_KEY[r])).not.toBe(REASON_KEY[r]);
    }
  });
  it('no tool is shown as "coming soon" any more', () => {
    expect(SITE_TOOLS.every((x) => !/soon/i.test(x.desc))).toBe(true);
  });
});

describe('tool error texts', () => {
  it('names plan limits, unsupported services, size, missing items, conflicts and outages', () => {
    expect(toolProblem('en', 422, 'quota_exceeded')).toBe(t('en', 'ht.err.quota'));
    expect(toolProblem('en', 422, 'unsupported_capability')).toBe(t('en', 'ht.err.unsupported'));
    expect(toolProblem('en', 413, 'payload_too_large')).toBe(t('en', 'ht.err.tooLarge'));
    expect(toolProblem('ar', 404, 'not_found')).toBe(t('ar', 'ht.err.notFound'));
    expect(toolProblem('en', 409, 'conflict')).toBe(t('en', 'ht.err.conflict'));
    expect(toolProblem('en', 503, 'service_unavailable')).toBe(t('en', 'ht.err.unavailable'));
    expect(toolProblem('en', 422, 'validation_failed', 'ht.cron.invalid')).toBe(
      t('en', 'ht.cron.invalid'),
    );
  });
});
