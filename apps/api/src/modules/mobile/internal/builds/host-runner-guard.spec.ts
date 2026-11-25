import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executionGateway as eg } from '@nuzm/domain';
import { LocalAndroidRunner } from './runner';

/** R5: the local Android runner refuses model/customer-origin builds before touching Flutter or the file system. Nothing is executed. */
const BAD: [string, unknown][] = [
  ['no origin', undefined],
  ['model', 'model'],
  ['customer', 'customer'],
  ['"template" as text', 'template'],
  ['a JSON body claiming template', { kind: 'template', templateId: 'x1' }],
];
beforeEach(() => {
  process.env.NUZM_LOCAL_DEV_EXEC = '1';
});
afterEach(() => {
  delete process.env.NUZM_LOCAL_DEV_EXEC;
});

describe('LocalAndroidRunner (host runner)', () => {
  const input = (origin: unknown) => ({
    buildId: '00000000-0000-7000-8000-000000000001',
    platform: 'android' as const,
    profile: 'debug' as const,
    files: {},
    verifyLock: async () => undefined,
    origin,
  });
  it.each(BAD)('refuses %s before touching Flutter or the file system', async (_n, origin) => {
    await expect(
      new LocalAndroidRunner().run(input(origin), () => undefined),
    ).rejects.toBeInstanceOf(eg.HostExecRefused);
  });
  it('is refused in production whatever the origin', async () => {
    const was = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(
        new LocalAndroidRunner().run(input(eg.templateOrigin('flutter-core')), () => undefined),
      ).rejects.toMatchObject({ reasons: ['production'] });
    } finally {
      process.env.NODE_ENV = was;
    }
  });
});
