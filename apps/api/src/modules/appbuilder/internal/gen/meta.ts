import type { AppSpec, FieldSpec } from '../spec/app-spec';
import { toSnake } from '../spec/app-spec';

/** Runtime metadata of the generated application, derived from the approved spec (src/meta.ts and public/meta.json). The shape is `AppMeta` of the runtime types. */
export interface AuthMeta {
  signupRole: string | null;
  tenancy: 'single' | 'multi';
}
export function buildMeta(spec: AppSpec, auth?: AuthMeta): Record<string, unknown> {
  const field = (f: FieldSpec) => ({
    name: f.name,
    column: toSnake(f.name),
    type: f.type,
    required: f.required === true,
    unique: f.unique === true,
    maxLength: f.maxLength ?? null,
    min: f.min ?? null,
    max: f.max ?? null,
    enumValues: f.enumValues ?? null,
    references: f.references ?? null,
    pii: f.pii === true,
    labels: f.labels,
  });
  return {
    ...(auth ? { auth } : {}),
    slug: spec.slug,
    name: spec.name,
    locales: spec.locales,
    defaultLocale: spec.defaultLocale,
    basePath: spec.api.basePath,
    defaultLimit: spec.api.defaultLimit,
    maxLimit: spec.api.maxLimit,
    attachmentMaxBytes: spec.nonFunctional.attachmentMaxBytes,
    csvImportExport: spec.nonFunctional.csvImportExport,
    notifications: spec.nonFunctional.notifications,
    entities: Object.fromEntries(
      spec.entities.map((e) => [
        e.name,
        {
          name: e.name,
          plural: e.plural,
          table: e.plural,
          labels: e.labels,
          ownership: e.ownership,
          audit: e.audit,
          searchable: e.searchable,
          sortable: e.sortable,
          stageField: e.stageField ?? null,
          fields: e.fields.map(field),
        },
      ]),
    ),
    roles: Object.fromEntries(
      spec.roles.map((r) => [
        r.name,
        {
          name: r.name,
          labels: r.labels,
          scope: r.scope,
          admin: r.admin === true,
          permissions: r.permissions,
        },
      ]),
    ),
    pages: spec.pages.map((p) => ({
      path: p.path,
      kind: p.kind,
      title: p.title,
      entity: p.entity ?? null,
      roles: p.roles ?? null,
      widgets: (p.widgets ?? []).map((w) => ({
        id: w.id,
        kind: w.kind,
        entity: w.entity,
        field: w.field ?? null,
        title: w.title,
      })),
    })),
  };
}
export const renderMetaTs = (meta: Record<string, unknown>): string =>
  `// generated from the approved application spec; do not edit by hand\nimport type { AppMeta } from './types.ts';\n\nexport const META: AppMeta = ${JSON.stringify(meta, null, 2)};\n`;
