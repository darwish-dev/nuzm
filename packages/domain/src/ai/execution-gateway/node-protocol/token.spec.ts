import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  Ed25519Signer,
  ReplayCache,
  signRequestToken,
  verifyRequestToken,
  type TrustedControlKeys,
} from './token';

const kp = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const pem = (k: typeof kp) => k.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const signer = new Ed25519Signer('cp-1', kp.privateKey);
const trusted: TrustedControlKeys = { 'cp-1': pem(kp) };
const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
const body = Buffer.from('{"handle":"h-1","how":"hard"}');

async function tok(over: Partial<Parameters<typeof signRequestToken>[1]> = {}) {
  return signRequestToken(signer, {
    nodeId: 'node-1',
    op: 'kill',
    body,
    now: NOW,
    orgId: 'org-1',
    handle: 'h-1',
    ...over,
  });
}
const check = (
  header: string | undefined,
  over: Partial<Parameters<typeof verifyRequestToken>[0]> = {},
) =>
  verifyRequestToken({
    header: header === undefined ? undefined : `NuzmNode ${header}`,
    nodeId: 'node-1',
    op: 'kill',
    body,
    trusted,
    replay: new ReplayCache(),
    now: NOW + 1000,
    ...over,
  });

describe('request token', () => {
  it('accepts a fresh token and exposes its binding', async () => {
    const v = check(await tok());
    expect(v.ok).toBe(true);
    if (v.ok)
      expect(v.payload).toMatchObject({
        aud: 'node-1',
        op: 'kill',
        scope: 'run',
        orgId: 'org-1',
        handle: 'h-1',
      });
  });
  it('refuses a replay, an expired token, a future token and a TTL over the cap', async () => {
    const t = await tok();
    const replay = new ReplayCache();
    expect(check(t, { replay }).ok).toBe(true);
    expect(check(t, { replay })).toEqual({ ok: false, reason: 'token_replayed' });
    expect(check(await tok(), { now: NOW + 31_000 })).toEqual({
      ok: false,
      reason: 'token_expired',
    });
    expect(check(await tok(), { now: NOW - 60_000 })).toEqual({
      ok: false,
      reason: 'token_not_yet_valid',
    });
    // a signer asking for a long TTL is clamped to 60 s at signing time
    expect(check(await tok({ ttlSeconds: 3600 }), { now: NOW + 61_000 })).toEqual({
      ok: false,
      reason: 'token_expired',
    });
  });
  it('is bound to the node, the operation, the exact body and the scope', async () => {
    const t = await tok();
    expect(check(t, { nodeId: 'node-2' })).toEqual({
      ok: false,
      reason: 'token_audience_mismatch',
    });
    expect(check(t, { op: 'destroy' })).toEqual({ ok: false, reason: 'token_operation_mismatch' });
    expect(check(t, { body: Buffer.from('{"handle":"h-2","how":"hard"}') })).toEqual({
      ok: false,
      reason: 'token_body_mismatch',
    });
    // an admin operation needs an admin-scoped token (the signer derives scope from the op, so a run token cannot be replayed as admin)
    const run = await tok();
    expect(check(run, { op: 'emergencyStop' })).toEqual({
      ok: false,
      reason: 'token_operation_mismatch',
    });
  });
  it('refuses unknown keys, bad signatures, tampering and malformed input', async () => {
    const t = await tok();
    expect(check(t, { trusted: {} })).toEqual({ ok: false, reason: 'token_key_unknown' });
    expect(check(t, { trusted: { 'cp-1': pem(other) } })).toEqual({
      ok: false,
      reason: 'token_signature_invalid',
    });
    const [h, s] = t.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(h!, 'base64url').toString()), aud: 'node-2' }),
    ).toString('base64url');
    expect(check(`${forged}.${s}`, { nodeId: 'node-2' })).toEqual({
      ok: false,
      reason: 'token_signature_invalid',
    });
    for (const bad of [undefined, '', 'x', 'a.b.c', `${h}.`]) expect(check(bad).ok).toBe(false);
    expect(
      verifyRequestToken({
        header: 'Bearer abc',
        nodeId: 'node-1',
        op: 'kill',
        body,
        trusted,
        replay: new ReplayCache(),
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'token_malformed' });
    // a key id that is a prototype property is not a trusted key
    expect(check(t, { trusted: Object.create({ 'cp-1': pem(kp) }) })).toEqual({
      ok: false,
      reason: 'token_key_unknown',
    });
  });
  it('a refused request does not burn the one-time id; a full replay cache fails closed', async () => {
    const t = await tok();
    const replay = new ReplayCache();
    expect(check(t, { replay, nodeId: 'wrong' }).ok).toBe(false);
    expect(check(t, { replay }).ok).toBe(true);
    const tiny = new ReplayCache(1);
    expect(tiny.claim('a'.repeat(16), Math.floor(NOW / 1000) + 30, NOW)).toBe(true);
    expect(tiny.claim('b'.repeat(16), Math.floor(NOW / 1000) + 30, NOW)).toBe(false);
  });
  it('a signer must hold an ed25519 key', () => {
    const rsa = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    expect(() => new Ed25519Signer('k', rsa.privateKey)).toThrow('signer_key_not_ed25519');
  });
});
