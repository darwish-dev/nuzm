import 'server-only';
import {
  latestBuiltRun,
  readApi,
  readSchema,
  readSpec,
  type ApiView,
  type SchemaView,
  type SpecView,
} from './appworkspace';
import type { Page_, Run } from './builder';
import type { serverCompute } from './compute-server';

type Server = Awaited<ReturnType<typeof serverCompute>>;

export interface Built {
  run: Run;
  spec: SpecView | null;
  schema: SchemaView | null;
  api: ApiView | null;
}

/**
 * What the newest successful-enough build run of a project produced: the `app_spec`, `db_schema` and `api_contract` artifacts of `GET /v1/ai/runs?projectId=`
 * (newest first) read through `GET /v1/ai/runs/{id}/artifacts/{artifactId}`. Reading the artifacts (not the generated files) keeps the views independent of how
 * the files are laid out. A missing artifact is null (the view says "not generated yet"); a failed read never breaks the page. Returns null when no run has a spec.
 */
export async function loadBuilt(c: Server, projectId: string): Promise<Built | null> {
  const runs = await c.get<Page_<Run>>('/v1/ai/runs', { query: { projectId, limit: 20 } });
  if (!runs.response.ok || !runs.data) return null;
  const run = latestBuiltRun(runs.data.items);
  if (!run) return null;
  const payload = async (type: string): Promise<unknown> => {
    const a = run.artifacts.find((x) => x.type === type);
    if (!a) return null;
    const r = await c.get<{ payload: unknown }>(`/v1/ai/runs/${run.id}/artifacts/${a.id}`);
    return r.response.ok ? (r.data?.payload ?? null) : null;
  };
  const [spec, schema, api] = await Promise.all([
    payload('app_spec'),
    payload('db_schema'),
    payload('api_contract'),
  ]);
  return { run, spec: readSpec(spec), schema: readSchema(schema), api: readApi(api) };
}
