'use client';
/** Browser reads of what a web-app build produced: the `app_spec`, `db_schema` and `api_contract` artifacts of a run (the browser's twin of the server's `loadBuilt`). */
import { readApi, readSchema, readSpec } from './appworkspace';
import type { Built } from './appworkspace-server';
import type { Run } from './builder';
import { bapi } from './builder-client';

/** The three artifacts a run holds, read through `GET /v1/ai/runs/{id}/artifacts/{artifactId}`; one that is missing or unreadable is null (the view says "not generated yet"). */
export async function readRunBuilt(run: Run): Promise<Built> {
  const payload = async (type: string): Promise<unknown> => {
    const a = run.artifacts.find((x) => x.type === type);
    if (!a) return null;
    const r = await bapi.get<{ payload: unknown }>(`/v1/ai/runs/${run.id}/artifacts/${a.id}`);
    return r.response.ok ? (r.data?.payload ?? null) : null;
  };
  const [spec, schema, api] = await Promise.all([
    payload('app_spec'),
    payload('db_schema'),
    payload('api_contract'),
  ]);
  return { run, spec: readSpec(spec), schema: readSchema(schema), api: readApi(api) };
}
