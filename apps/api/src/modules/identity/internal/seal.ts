import { EncryptJWT, jwtDecrypt } from 'jose';

export interface LoginState {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
}

/** AES-256-GCM sealed, 10-minute login context (holds the PKCE verifier; never readable by the browser). */
export async function sealLoginState(s: LoginState, key: Uint8Array): Promise<string> {
  return new EncryptJWT({ ...s })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .encrypt(key);
}

export async function openLoginState(token: string, key: Uint8Array): Promise<LoginState | null> {
  try {
    const { payload } = await jwtDecrypt(token, key);
    const { state, nonce, verifier, returnTo } = payload as Record<string, unknown>;
    if ([state, nonce, verifier, returnTo].every((v) => typeof v === 'string')) {
      return { state, nonce, verifier, returnTo } as LoginState;
    }
    return null;
  } catch {
    return null;
  }
}
