import type { AppSpec } from '../spec/app-spec';

export interface RbacMatrix {
  roles: { name: string; scope: string; admin: boolean }[];
  entities: { entity: string; ownership: string; byRole: Record<string, string[]> }[];
}
/** Roles -> permissions per entity, plus the row-level rule, as data (tests and docs are generated from it; the runtime reads the same data from META). */
export function buildRbac(spec: AppSpec): RbacMatrix {
  return {
    roles: spec.roles.map((r) => ({ name: r.name, scope: r.scope, admin: r.admin === true })),
    entities: spec.entities.map((e) => ({
      entity: e.name,
      ownership: e.ownership,
      byRole: Object.fromEntries(
        spec.roles.map((r) => [r.name, [...(r.permissions[e.name] ?? [])]]),
      ),
    })),
  };
}
export function rbacMarkdown(spec: AppSpec): string {
  const m = buildRbac(spec);
  const lines = [
    '# Access control',
    '',
    'Row-level rule: a role with scope `own` sees and changes only the records it owns; `team` also the records of its team; `all` every record. Entities with ownership `org` are organisation-wide. A record outside the caller scope answers 404.',
    '',
    '| Role | Scope |',
    '|---|---|',
    ...m.roles.map((r) => `| ${r.name}${r.admin ? ' (administrator)' : ''} | ${r.scope} |`),
    '',
  ];
  for (const e of m.entities) {
    lines.push(
      `## ${e.entity} (ownership: ${e.ownership})`,
      '',
      '| Role | Actions |',
      '|---|---|',
      ...Object.entries(e.byRole).map(([r, a]) => `| ${r} | ${a.join(', ') || '-'} |`),
      '',
    );
  }
  return lines.join('\n');
}
