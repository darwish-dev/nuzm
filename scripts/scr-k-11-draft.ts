/**
 * `tsx scripts/scr-k-11-draft.ts <out-dir>`: builds the PROPOSED public surface of SCR-K-11 (items 1-4) from the CURRENT spec and writes two draft documents to <out-dir> (never to
 * spec/): `draft-enum.yaml` (item 1 as three new capability strings) and `draft-flag.yaml` (item 1 as one boolean `supportsTools`). They exist only to be linted, compared with the
 * current contract (scripts/openapi-compat.ts) and fed to the SDK generator before the owner decides (D7). Applying a change to spec/openapi/openapi.yaml needs the owner's approval.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a throwaway transformation of a parsed document
const out = process.argv[2];
if (!out) {
  console.error('usage: tsx scripts/scr-k-11-draft.ts <out-dir>');
  process.exit(2);
}
const root = join(import.meta.dirname, '..');
const load = (): J => parse(readFileSync(join(root, 'spec/openapi/openapi.yaml'), 'utf8')) as J;

function common(d: J): void {
  const s = d.components.schemas;
  // item 2: read-only facts of a provider
  s.AiModelProvider.properties.contractVersion = {
    type: 'string',
    enum: ['1.0.0', '1.1.0'],
    description: 'The ModelAdapter contract the registered adapter implements.',
  };
  s.AiModelProvider.properties.liveCallsApproved = {
    type: 'boolean',
    description:
      'True when this environment lists the provider as approved for live calls (AI_LIVE_PROVIDERS).',
  };
  // items 3 and 4: two more admin actions (a REQUEST enum: adding values is not breaking)
  const a = s.AiModelProviderAction;
  a.properties.action.enum.push('record_capability_evidence', 'probe_tool_use');
  a.properties.model = { type: 'string', description: 'record_capability_evidence: the model id.' };
  a.properties.capability = {
    type: 'string',
    enum: ['tool-use', 'streaming-tool-calls', 'parallel-tool-calls'],
    description: 'record_capability_evidence: the capability.',
  };
  a.properties.state = {
    type: 'string',
    enum: ['VERIFIED', 'NOT VERIFIED'],
    description: 'record_capability_evidence: the recorded state.',
  };
  a.properties.evidenceRef = {
    type: 'string',
    maxLength: 200,
    description: 'record_capability_evidence: reference to the stored probe report.',
  };
  a.properties.approvalRef = {
    type: 'string',
    maxLength: 200,
    description: 'probe_tool_use: the recorded approval of the live probe (D9).',
  };
  a.properties.maxTotalTokens = {
    type: 'integer',
    minimum: 1,
    description: 'probe_tool_use: the approved token ceiling for the whole probe.',
  };
}

mkdirSync(out, { recursive: true });
const A = load();
common(A);
A.components.schemas.AiModel.properties.capabilities.items.enum.push(
  'tool-use',
  'streaming-tool-calls',
  'parallel-tool-calls',
);
writeFileSync(join(out, 'draft-enum.yaml'), stringify(A, { lineWidth: 0 }));
const B = load();
common(B);
B.components.schemas.AiModel.properties.supportsTools = {
  type: 'boolean',
  description: 'True when the model may be offered tools (a recorded, verified capability).',
};
writeFileSync(join(out, 'draft-flag.yaml'), stringify(B, { lineWidth: 0 }));
console.log(`wrote ${join(out, 'draft-enum.yaml')} and ${join(out, 'draft-flag.yaml')}`);
