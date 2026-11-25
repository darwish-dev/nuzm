import { describe, expect, it } from 'vitest';
import { buildRuntimeSpec } from '../runtime-spec';
import { EXEC_ENV } from '../policy';
import {
  isWorkspaceRelativePath,
  parseNodeRequest,
  parseRuntimeSpec,
  requestBinding,
} from './protocol';

const spec = () =>
  buildRuntimeSpec({
    decision: {
      argv: ['npx', '--no-install', 'tsc', '--noEmit'],
      cwd: '',
      env: { ...EXEC_ENV },
      limits: {
        cpuSeconds: 120,
        wallSeconds: 180,
        memoryMb: 1024,
        pids: 128,
        outputKb: 256,
        diskMb: 512,
      },
      network: 'none',
    },
    orgId: 'org-1',
    runId: 'run-1',
    runtimeClass: 'gvisor-runsc',
    image: `sha256:${'a'.repeat(64)}`,
  });

describe('node protocol parsing (strict, total)', () => {
  it('accepts a well-formed spec unchanged and refuses unknown members', () => {
    const s = spec();
    expect(parseRuntimeSpec(JSON.parse(JSON.stringify(s)))).toEqual(s);
    expect(parseRuntimeSpec({ ...s, extra: 1 })).toBeNull();
    expect(parseRuntimeSpec({ ...s, argv: 'rm -rf /' })).toBeNull();
    expect(parseRuntimeSpec({ ...s, limits: { ...s.limits, cpuSeconds: '1' } })).toBeNull();
    expect(
      parseRuntimeSpec({ ...s, mounts: [{ source: 'host', target: '/', readOnly: false }] }),
    ).toBeNull();
    expect(parseRuntimeSpec({ ...s, orgId: '../x' })).toBeNull();
    expect(parseRuntimeSpec(null)).toBeNull();
  });
  it('a weak spec is well-formed (so the node can refuse it for the right reason)', () => {
    expect(parseRuntimeSpec({ ...spec(), privileged: true })).not.toBeNull();
  });
  it('workspace-relative paths', () => {
    for (const p of ['a', 'src/index.ts', 'a/b/c.txt'])
      expect(isWorkspaceRelativePath(p)).toBe(true);
    for (const p of [
      '',
      '/etc/passwd',
      '../x',
      'a/../b',
      'a//b',
      './a',
      'a/.',
      'a\\b',
      'a\0b',
      'x'.repeat(301),
    ])
      expect(isWorkspaceRelativePath(p)).toBe(false);
  });
  it('each operation rejects unknown members, wrong types and out-of-range values', () => {
    const bad = (op: Parameters<typeof parseNodeRequest>[0], b: unknown) =>
      expect(parseNodeRequest(op, b).ok).toBe(false);
    bad('identity', { x: 1 });
    bad('health', []);
    bad('createWorkspace', { workspaceId: 'ws-r', orgId: 'o', runId: 'r', diskMb: 0 });
    bad('createWorkspace', { workspaceId: 'ws-r', orgId: 'o', runId: 'r', diskMb: 10, extra: 1 });
    bad('putFiles', { workspaceId: 'ws-r', files: [['../x', 'a']] });
    bad('putFiles', {
      workspaceId: 'ws-r',
      files: [
        ['a', 'x'],
        ['a', 'y'],
      ],
    });
    bad('putFiles', { workspaceId: 'ws-r', files: [['a']] });
    bad('wait', { handle: 'h', maxWaitMs: 999_999 });
    bad('kill', { handle: 'h', how: 'term' });
    bad('readProduced', { workspaceId: 'w', path: '/etc/shadow', maxBytes: 10 });
    bad('readProduced', { workspaceId: 'w', path: 'dist/a', maxBytes: 10 ** 9 });
    bad('start', { spec: { runtimeClass: 'x' } });
    expect(parseNodeRequest('kill', { handle: 'h-1', how: 'hard' }).ok).toBe(true);
    expect(
      parseNodeRequest('createWorkspace', {
        workspaceId: 'ws-r',
        orgId: 'o',
        runId: 'r',
        diskMb: 512,
      }).ok,
    ).toBe(true);
  });
  it('an oversized file is too_large, not bad_request', () => {
    const r = parseNodeRequest('putFiles', {
      workspaceId: 'w',
      files: [['a', 'x'.repeat(2 * 1024 * 1024 + 1)]],
    });
    expect(r).toEqual({ ok: false, code: 'too_large' });
  });
  it('binding extracts the tenant addressing of each call', () => {
    expect(requestBinding('createWorkspace', { workspaceId: 'w', orgId: 'o' })).toEqual({
      workspaceId: 'w',
      orgId: 'o',
    });
    expect(requestBinding('start', { spec: spec() })).toEqual({
      workspaceId: 'ws-run-1',
      orgId: 'org-1',
    });
    expect(requestBinding('kill', { handle: 'h' })).toEqual({ handle: 'h' });
    expect(requestBinding('health', {})).toEqual({});
  });
});
