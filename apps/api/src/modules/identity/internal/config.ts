export interface IdentityConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Absolute origins allowed in returnTo besides relative paths. */
  returnToOrigins: string[];
  defaultReturnTo: string;
  /** 32-byte key sealing the short-lived login-state cookie (PKCE verifier lives in it). */
  sealKey: Uint8Array;
  idleSeconds: number; // proposal 30 min (D-30)
  absoluteSeconds: number; // proposal 12 h (D-30)
  secureCookies: boolean;
  loginRatePerMinute: number;
  mfaLockThreshold: number; // proposal 5 consecutive failures
  mfaLockSeconds: number; // proposal 15 min
  stepUpMaxAgeSeconds: number; // proposal 5 min
  /** Built-in password sign-in (ADR-008). */
  passwordLockThreshold: number; // proposal 5 consecutive failures
  passwordLockSeconds: number; // proposal 15 min
  /** log2(N) of new scrypt hashes; 17 in production. */
  scryptLogN: number;
  verifyTokenHours: number;
  resetTokenMinutes: number;
}

export function loadIdentityConfig(env: NodeJS.ProcessEnv = process.env): IdentityConfig {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`missing required env ${k}`);
    return v;
  };
  const key = Buffer.from(need('SESSION_SEAL_KEY'), 'base64');
  if (key.length !== 32) throw new Error('SESSION_SEAL_KEY must be 32 bytes, base64-encoded');
  return {
    issuer: need('OIDC_ISSUER'),
    clientId: need('OIDC_CLIENT_ID'),
    clientSecret: need('OIDC_CLIENT_SECRET'), // dev only via env; production = vault ref (D-12)
    redirectUri: need('OIDC_REDIRECT_URI'),
    returnToOrigins: (env.RETURN_TO_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    defaultReturnTo: env.DEFAULT_RETURN_TO ?? '/',
    sealKey: new Uint8Array(key),
    idleSeconds: Number(env.SESSION_IDLE_SECONDS ?? 1800),
    absoluteSeconds: Number(env.SESSION_ABSOLUTE_SECONDS ?? 43200),
    secureCookies: env.NODE_ENV === 'production',
    loginRatePerMinute: Number(env.LOGIN_RATE_PER_MINUTE ?? 20),
    mfaLockThreshold: Number(env.MFA_LOCK_THRESHOLD ?? 5),
    mfaLockSeconds: Number(env.MFA_LOCK_SECONDS ?? 900),
    stepUpMaxAgeSeconds: Number(env.STEP_UP_MAX_AGE_SECONDS ?? 300),
    passwordLockThreshold: Number(env.PASSWORD_LOCK_THRESHOLD ?? 5),
    passwordLockSeconds: Number(env.PASSWORD_LOCK_SECONDS ?? 900),
    scryptLogN: Number(env.PASSWORD_SCRYPT_LOG_N ?? 17),
    verifyTokenHours: Number(env.EMAIL_VERIFY_TOKEN_HOURS ?? 24),
    resetTokenMinutes: Number(env.PASSWORD_RESET_TOKEN_MINUTES ?? 60),
  };
}
