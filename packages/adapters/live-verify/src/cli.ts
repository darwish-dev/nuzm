#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import type { AccountContext, ComputeAdapter } from '@nuzm/adapter-contracts';
import { runLiveVerification, type LvResult, type OwnerTrigger } from './runner';

/**
 * Owner-run live verification CLI (M05 §5). It REFUSES to do anything unless the owner supplies the trigger: the HG id, the evidence id of
 * the recorded gate and a spend cap. The agent never sets these variables. Without them it prints `NOT RUN` and exits 2 (no network call).
 *
 * Environment (all required to run): NUZM_LV_PROVIDER (alibaba|huawei|contabo), NUZM_LV_VAULT_REF, NUZM_LV_OWNER_HG (HG-05-0x),
 * NUZM_LV_OWNER_EVIDENCE_ID, NUZM_LV_SPEND_CAP_MINOR, NUZM_LV_CURRENCY, NUZM_LV_REGION, NUZM_LV_PLAN, NUZM_LV_IMAGE, NUZM_LV_SSH_PUBLIC_KEY,
 * NUZM_LV_EST_COST_MINOR; optional NUZM_LV_RESIZE_TO_PLAN, NUZM_LV_RESULT_FILE.
 */
export interface CliDeps {
  /** Builds the adapter for a provider key; the production implementation lives in the owner's runner script (vault + egress-guarded transport). */
  makeAdapter(provider: string, env: Record<string, string | undefined>): Promise<ComputeAdapter>;
  log(line: string): void;
}
const NEEDED = [
  'NUZM_LV_PROVIDER',
  'NUZM_LV_VAULT_REF',
  'NUZM_LV_OWNER_HG',
  'NUZM_LV_OWNER_EVIDENCE_ID',
  'NUZM_LV_SPEND_CAP_MINOR',
  'NUZM_LV_CURRENCY',
  'NUZM_LV_REGION',
  'NUZM_LV_PLAN',
  'NUZM_LV_IMAGE',
  'NUZM_LV_SSH_PUBLIC_KEY',
  'NUZM_LV_EST_COST_MINOR',
] as const;

export async function runCli(
  env: Record<string, string | undefined>,
  deps: CliDeps,
): Promise<{ exitCode: number; result: LvResult | null }> {
  const missing = NEEDED.filter((k) => !env[k]);
  if (missing.length) {
    deps.log(`NOT RUN: live verification is human-triggered only; missing ${missing.join(', ')}`);
    return { exitCode: 2, result: null };
  }
  const provider = env.NUZM_LV_PROVIDER!;
  if (!['alibaba', 'huawei', 'contabo'].includes(provider)) {
    deps.log(`NOT RUN: unknown provider ${provider}`);
    return { exitCode: 2, result: null };
  }
  const trigger: OwnerTrigger = {
    hgId: env.NUZM_LV_OWNER_HG as OwnerTrigger['hgId'],
    evidenceId: env.NUZM_LV_OWNER_EVIDENCE_ID!,
    spendCapMinor: Number(env.NUZM_LV_SPEND_CAP_MINOR),
    currency: env.NUZM_LV_CURRENCY!,
  };
  const adapter = await deps.makeAdapter(provider, env);
  const ctx: AccountContext = {
    providerAccountId: `lv-${provider}`,
    credentialRef: env.NUZM_LV_VAULT_REF!,
    traceId: `lv-${provider}-${Date.now()}`,
    deadlineMs: 30_000,
  };
  const result = await runLiveVerification({
    jobId: `live-verify-${provider}`,
    adapter,
    ctx,
    trigger,
    target: {
      providerRegionId: env.NUZM_LV_REGION!,
      planRef: env.NUZM_LV_PLAN!,
      imageRef: env.NUZM_LV_IMAGE!,
      sshPublicKey: env.NUZM_LV_SSH_PUBLIC_KEY!,
      estimatedCostMinor: Number(env.NUZM_LV_EST_COST_MINOR),
      currency: env.NUZM_LV_CURRENCY!,
      ...(env.NUZM_LV_RESIZE_TO_PLAN ? { resizeToPlanRef: env.NUZM_LV_RESIZE_TO_PLAN } : {}),
    },
  });
  if (env.NUZM_LV_RESULT_FILE)
    writeFileSync(env.NUZM_LV_RESULT_FILE, JSON.stringify(result, null, 2) + '\n');
  deps.log(`${result.status}: ${result.reason}`);
  return {
    exitCode: result.status === 'LIVE-VERIFIED' || result.status === 'NOT VERIFIED' ? 0 : 1,
    result,
  };
}
