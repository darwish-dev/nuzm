import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { has, key, routes, type Route } from '../qa-route-scan';

/**
 * P3-S08 CI gate support: the STATIC half of the O-9 audit (billing administrators must not read customer content). The dynamic half is
 * `qa-o9-content-access.int.spec.ts` (needs a database; `pnpm test:integration`). This half needs no database and runs in `pnpm test`, so a new content route cannot be merged
 * without a decision: for every organization GET route in the customer-content areas it requires the route to be listed either as `content` (and then it must carry the shared
 * guard: the `@ContentRead(...)` decorator or an explicit `.assert(` call of the content-access service in the handler body) or as `metadata` with a written reason.
 */
export const CONTENT_AREAS =
  /^\/(v1\/(ai|builder|deployments|execution|benchmarks|sandboxes|mobile|websites|webapps|apps|previews)|p\/)/;
/** words that, anywhere in a GET path, make the route suspect even outside the areas above */
export const CONTENT_WORDS =
  /(^|\/)(files?|content|messages|sessions|artifacts|diffs?|version-diff|instructions|submissions|cms-[a-z-]+|previews?|logs|test-runs|memory|symbols|review|components|import-analysis|template-workspace|generation-plans|claude-code|events|source|builds?|apk|ipa|screens?)(\/|$)/;

export interface Classification {
  content: string[];
  metadata: Record<string, string>;
}
export const loadClassification = (root = join(process.cwd(), '../..')): Classification =>
  JSON.parse(readFileSync(join(root, 'docs/security/O9-ROUTE-CLASSIFICATION.json'), 'utf8')) as Classification;

/** organization-scoped GET routes (not public, not platform/admin) */
export const orgGets = (all: Route[] = routes()): Route[] =>
  all.filter((r) => r.method === 'GET' && !has(r, 'Public') && !has(r, 'RequirePlatformPermission') && !r.path.startsWith('/v1/admin/'));

/** the routes the gate cares about */
export const scoped = (all: Route[] = routes()): Route[] =>
  orgGets(all).filter((r) => CONTENT_AREAS.test(r.path) || CONTENT_WORDS.test(r.path));

/** does the handler of this route carry the shared content-access guard? Reads the handler text from its decorator group to the next route/class member boundary. */
export function hasGuard(r: Route, srcRoot = join(process.cwd(), 'src')): boolean {
  if (r.decos.some((d) => d.startsWith('@ContentRead('))) return true;
  const lines = readFileSync(join(srcRoot, r.file), 'utf8').split('\n');
  const m = /^@Get\(([^)]*)\)/;
  const idx = lines.findIndex((l, i) => {
    const t = l.trim();
    if (!t.startsWith('@Get(')) return false;
    // the route's own decorator group must contain every decorator we recorded for it
    const mm = m.exec(t);
    void mm;
    const group: string[] = [];
    for (let k = i - 1; k >= 0 && /^\s*@/.test(lines[k]!); k--) group.push(lines[k]!.trim());
    for (let k = i + 1; k < lines.length && /^\s*@/.test(lines[k]!); k++) group.push(lines[k]!.trim());
    return r.decos.filter((d) => d.startsWith('@Get(')).every((d) => d === t) && group.every((g) => r.decos.includes(g));
  });
  if (idx < 0) return false;
  // body: until the next line that starts a decorated member at the same indentation as the handler decorator
  const indent = /^\s*/.exec(lines[idx]!)![0].length;
  let end = idx + 1;
  while (end < lines.length) {
    const l = lines[end]!;
    if (l.trim().startsWith('@') && /^\s*/.exec(l)![0].length === indent && !/^\s*@(Get|Query|Param|Org|Access|Res|Req)\b/.test(l) && end > idx + 1) {
      // a decorator of the NEXT handler (class members decorated at the same level)
      if (/^\s*@(RequirePermission|ContentRead|Get|Post|Put|Patch|Delete|Idempotent|HttpCode|Public)\(/.test(l)) break;
    }
    end++;
  }
  const body = lines.slice(idx, end).join('\n');
  return /\.assert\(|ContentRead\(|contentAccess|ContentAccess/.test(body);
}
export { key };
