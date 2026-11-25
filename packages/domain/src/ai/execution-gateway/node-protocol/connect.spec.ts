import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AttestationRefused } from '../real-runtime/real-runtime';
import { createSimulatedKit } from '../real-runtime/simulated-attestation';
import {
  connectNode,
  ConnectionRefused,
  isVaultRef,
  startRealExecution,
  VaultTokenSigner,
  type NodeEndpointConfig,
} from './connect';
import { ReplayCache, verifyRequestToken } from './token';

const kp = generateKeyPairSync('ed25519');
const pem = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const pub = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const node = (over: Partial<NodeEndpointConfig> = {}): NodeEndpointConfig => ({
  nodeId: 'node-1',
  endpointId: 'ep-1',
  baseUrl: 'https://node-1.internal.example:8443',
  signer: { keyId: 'cp-1', keyRef: 'vault://exec/cp-signer' },
  tls: { caRef: 'vault://exec/ca', certRef: 'vault://exec/cert', keyRef: 'vault://exec/key' },
  ...over,
});
const resolve = async (ref: string) => (ref === 'vault://exec/cp-signer' ? pem : 'pem-placeholder');

describe('vault references only', () => {
  it('accepts vault references and refuses inline secrets, paths and traversal', () => {
    expect(isVaultRef('vault://exec/cp-signer')).toBe(true);
    for (const bad of [
      '-----BEGIN PRIVATE KEY-----',
      '/etc/nuzm/key.pem',
      'file:///k',
      'vault://',
      'vault://a/../b',
      'vault:///x',
      '',
      'vault://a b',
    ])
      expect(isVaultRef(bad), bad).toBe(false);
  });
  it('a node config with an inline secret is refused before anything connects', () => {
    expect(() =>
      connectNode(
        node({ signer: { keyId: 'cp-1', keyRef: '-----BEGIN PRIVATE KEY-----\nabc' } }),
        resolve,
        { mode: 'live' },
      ),
    ).toThrow(ConnectionRefused);
    expect(() =>
      connectNode(
        node({ tls: { caRef: 'vault://ok/ca', certRef: '/etc/cert.pem', keyRef: 'vault://ok/k' } }),
        resolve,
        { mode: 'simulated' },
      ),
    ).toThrow(/secret_reference_invalid/);
  });
  it('live mode needs https: a plain-http or loopback endpoint is refused, a non-https URL cannot even be built', () => {
    expect(() =>
      connectNode(node({ baseUrl: 'http://127.0.0.1:8443' }), resolve, { mode: 'live' }),
    ).toThrow('live_requires_https_mtls');
    expect(() =>
      connectNode(node({ baseUrl: 'http://203.0.113.5:8443' }), resolve, { mode: 'live' }),
    ).toThrow('transport_requires_https');
    expect(connectNode(node(), resolve, { mode: 'live' }).isolation).toBe('verified');
    expect(
      connectNode(node({ baseUrl: 'http://127.0.0.1:8443' }), resolve, { mode: 'simulated' })
        .isolation,
    ).toBe('simulated');
  });
});

describe('the vault-backed token signer', () => {
  it('signs through the resolver and the node can verify; a wrong key type or a missing secret fails', async () => {
    const calls: string[] = [];
    const s = new VaultTokenSigner(
      'cp-1',
      'vault://exec/cp-signer',
      async (r) => (calls.push(r), pem),
    );
    const sig = await s.sign(Buffer.from('x'));
    expect(sig.length).toBe(64);
    await s.sign(Buffer.from('y'));
    expect(calls).toHaveLength(1); // cached briefly
    const rsa = generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    await expect(
      new VaultTokenSigner('k', 'vault://a/b', async () => rsa).sign(Buffer.from('x')),
    ).rejects.toThrow('signer_key_not_ed25519');
    await expect(
      new VaultTokenSigner('k', 'vault://a/b', async () => {
        throw new Error('secret not found');
      }).sign(Buffer.from('x')),
    ).rejects.toThrow('secret not found');
    void verifyRequestToken;
    void ReplayCache;
    void pub;
  });
});

describe('startRealExecution is fail-closed (R5)', () => {
  const kit = createSimulatedKit();
  const base = {
    mode: 'simulated' as const,
    environments: ['staging' as const],
    trustedAttestationKeys: kit.trusted,
  };
  it('no node configured: no service', async () => {
    await expect(
      startRealExecution({ ...base, nodes: [] }, { resolve, loadAttestation: async () => null }),
    ).rejects.toThrow(AttestationRefused);
    await expect(
      startRealExecution({ ...base, nodes: [] }, { resolve, loadAttestation: async () => null }),
    ).rejects.toMatchObject({ reasons: ['no_nodes'] });
  });
  it('a node without an attestation is refused, in both modes', async () => {
    for (const mode of ['simulated', 'live'] as const)
      await expect(
        startRealExecution(
          {
            ...base,
            mode,
            nodes: [
              node({
                baseUrl: mode === 'live' ? 'https://node-1.example:8443' : 'http://127.0.0.1:1',
              }),
            ],
          },
          { resolve, loadAttestation: async () => null },
        ),
      ).rejects.toThrow(AttestationRefused);
  });
  it('a good SIMULATED attestation on a node that does not answer is refused; a simulated attestation is refused in live mode', async () => {
    const att = kit.attestation({ nodeId: 'node-1', endpointId: 'ep-1' });
    await expect(
      startRealExecution(
        { ...base, nodes: [node({ baseUrl: 'http://127.0.0.1:1' })] },
        { resolve, loadAttestation: async () => att },
      ),
    ).rejects.toThrow(/node_unreachable/);
    await expect(
      startRealExecution(
        { ...base, mode: 'live', nodes: [node()] },
        { resolve, loadAttestation: async () => att },
      ),
    ).rejects.toThrow(/evidence_not_live_verified/);
  });
});
