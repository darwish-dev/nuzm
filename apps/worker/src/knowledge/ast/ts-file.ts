import ts from 'typescript';
import {
  COMPONENT_LIMITS as L,
  emptyFacts,
  longestLine,
  safeName,
  type ComponentFact,
  type FileFacts,
  type ImportFact,
  type LinkFact,
  type PropFact,
} from '@nuzm/domain';

/**
 * Parse-only analysis of one TypeScript/JavaScript file (S-K2c). Uses `ts.createSourceFile` and nothing else of the compiler: no program, no type checker, no module
 * resolution, no plugins, no file system. The traversal is iterative (a deeply nested file cannot overflow the stack), bounded by a node budget, and every name that comes
 * from the source is restricted to identifier characters. The result is path-independent so it can be cached by the file's content hash.
 */
const MAX_NODES = 400_000;
const HOOK = /^use[A-Z0-9]\w*$/;
const STYLE = /\.(?:css|scss|sass|less|styl)$/i;
const ASSET = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|mp4|webm|mp3)$/i;
const VALIDATORS = new Set([
  'IsString',
  'IsNumber',
  'IsInt',
  'IsBoolean',
  'IsEmail',
  'IsOptional',
  'IsNotEmpty',
  'IsEnum',
  'IsArray',
  'IsDate',
  'IsUUID',
  'IsUrl',
  'Length',
  'Min',
  'Max',
  'MinLength',
  'MaxLength',
  'ValidateNested',
  'Matches',
  'IsDefined',
]);
const WRAPPERS = new Set(['memo', 'forwardRef', 'observer', 'lazy']);

const kindOf = (f: string): ts.ScriptKind =>
  f.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : f.endsWith('.ts') || f.endsWith('.mts') || f.endsWith('.cts')
      ? ts.ScriptKind.TS
      : f.endsWith('.jsx')
        ? ts.ScriptKind.JSX
        : ts.ScriptKind.JS;
const cap = <T>(a: T[], n: number) => (a.length > n ? a.slice(0, n) : a);
const typeText = (sf: ts.SourceFile, n: ts.TypeNode | undefined): string | null =>
  n ? ((t) => (t.length <= 60 ? t.replace(/\s+/g, ' ') : null))(n.getText(sf)) : null;
const nameOf = (n: ts.Node | undefined): string | null =>
  n && (ts.isIdentifier(n) || ts.isStringLiteral(n)) ? safeName(n.text) : null;
const isCap = (s: string) => /^[A-Z]/.test(s);

/** All descendants of `root` (iteratively), calling `fn`; stops descending into a node when `fn` returns false. */
function walk(
  root: ts.Node,
  fn: (n: ts.Node) => boolean | void,
  budget: { n: number; max: number },
): void {
  const stack: ts.Node[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (++budget.n > budget.max) throw new Error('budget');
    if (fn(n) === false) continue;
    ts.forEachChild(n, (c) => void stack.push(c));
  }
}

function membersOfType(
  sf: ts.SourceFile,
  t: ts.TypeNode | undefined,
  local: Map<string, ts.TypeElement[]>,
  depth = 0,
): PropFact[] {
  if (!t || depth > 3) return [];
  if (ts.isTypeLiteralNode(t)) return fromMembers(sf, t.members);
  if (ts.isTypeReferenceNode(t)) {
    const n = t.typeName.getText(sf);
    const m = local.get(n);
    if (m) return fromMembers(sf, m);
    // FC<Props>, PropsWithChildren<Props>, Readonly<Props>: the first type argument
    if (
      t.typeArguments?.[0] &&
      /^(?:React\.)?(?:FC|FunctionComponent|PropsWithChildren|Readonly|Partial)$/.test(n)
    )
      return membersOfType(sf, t.typeArguments[0], local, depth + 1);
  }
  if (ts.isIntersectionTypeNode(t))
    return t.types.flatMap((x) => membersOfType(sf, x, local, depth + 1));
  return [];
}
function fromMembers(sf: ts.SourceFile, members: readonly ts.TypeElement[]): PropFact[] {
  const out: PropFact[] = [];
  for (const m of members) {
    if ((ts.isPropertySignature(m) || ts.isMethodSignature(m)) && m.name) {
      const name = nameOf(m.name);
      if (name && out.length < L.maxPropsPerComponent)
        out.push({
          name,
          type: ts.isPropertySignature(m) ? typeText(sf, m.type) : '(…) => …',
          required: !m.questionToken,
        });
    }
  }
  return out;
}
function propsOf(
  sf: ts.SourceFile,
  fn: ts.SignatureDeclarationBase | undefined,
  typeArg: ts.TypeNode | undefined,
  local: Map<string, ts.TypeElement[]>,
): PropFact[] {
  const param = fn?.parameters[0];
  const byType = membersOfType(sf, typeArg ?? param?.type, local);
  const byBinding: PropFact[] = [];
  if (param && ts.isObjectBindingPattern(param.name))
    for (const el of param.name.elements) {
      const name = nameOf((el.propertyName ?? el.name) as ts.Node);
      if (name && !el.dotDotDotToken && byBinding.length < L.maxPropsPerComponent)
        byBinding.push({ name, type: null, required: !el.initializer });
    }
  if (byType.length === 0) return byBinding;
  const dflt = new Set(byBinding.filter((b) => !b.required).map((b) => b.name));
  return byType.map((p) => (dflt.has(p.name) ? { ...p, required: false } : p));
}
function hooksAndChildren(
  root: ts.Node,
  self: string,
  budget: { n: number; max: number },
): { jsx: boolean; hooks: string[]; children: string[] } {
  let jsx = false;
  const hooks = new Set<string>();
  const kids = new Set<string>();
  walk(
    root,
    (n) => {
      if (ts.isClassDeclaration(n) && n !== root) return false;
      if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) jsx = true;
      if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
        const tag = n.tagName;
        const t = ts.isIdentifier(tag)
          ? tag.text
          : ts.isPropertyAccessExpression(tag) && ts.isIdentifier(tag.expression)
            ? tag.expression.text
            : null;
        if (t && isCap(t) && t !== self && safeName(t) && kids.size < L.maxChildrenPerComponent)
          kids.add(t);
      }
      if (ts.isCallExpression(n)) {
        const e = n.expression;
        const h = ts.isIdentifier(e)
          ? e.text
          : ts.isPropertyAccessExpression(e) &&
              ts.isIdentifier(e.expression) &&
              e.expression.text === 'React'
            ? e.name.text
            : null;
        if (h && HOOK.test(h) && hooks.size < 30) hooks.add(h);
      }
    },
    budget,
  );
  return { jsx, hooks: [...hooks].sort(), children: [...kids].sort() };
}
const decoratorsOf = (n: ts.Node): ts.Decorator[] =>
  ts.canHaveDecorators(n) ? [...(ts.getDecorators(n) ?? [])] : [];
const decoName = (d: ts.Decorator): string | null =>
  ts.isCallExpression(d.expression) && ts.isIdentifier(d.expression.expression)
    ? d.expression.expression.text
    : ts.isIdentifier(d.expression)
      ? d.expression.text
      : null;
const idArgs = (e: ts.Expression | undefined): string[] =>
  e && ts.isArrayLiteralExpression(e)
    ? e.elements
        .filter(ts.isIdentifier)
        .map((x) => x.text)
        .filter((x): x is string => !!safeName(x))
    : [];

export function analyzeTsFile(
  text: string,
  fileName: string,
  opts: { maxNodes?: number } = {},
): FileFacts {
  const facts = emptyFacts('ts');
  if (longestLine(text) > L.maxLine) return emptyFacts('ts', 'minified');
  if (text.includes('\u0000')) return emptyFacts('ts', 'parse_error');
  const budget = { n: 0, max: Math.min(opts.maxNodes ?? MAX_NODES, MAX_NODES) };
  try {
    const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, kindOf(fileName));
    const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const local = new Map<string, ts.TypeElement[]>();
    const exportedNames = new Set<string>();
    let defaultName: string | null = null;
    const comps: ComponentFact[] = [];
    const addComp = (c: ComponentFact) => {
      if (
        comps.length < L.maxComponentsPerFile &&
        !comps.some((x) => x.name === c.name && x.kind === c.kind)
      )
        comps.push(c);
      else if (comps.length >= L.maxComponentsPerFile) facts.truncated = true;
    };

    // pass 1: local interfaces / type aliases (props types), imports, exports, directives
    for (const st of sf.statements) {
      if (ts.isInterfaceDeclaration(st)) local.set(st.name.text, [...st.members]);
      else if (ts.isTypeAliasDeclaration(st) && ts.isTypeLiteralNode(st.type))
        local.set(st.name.text, [...st.type.members]);
      else if (ts.isTypeAliasDeclaration(st) && ts.isIntersectionTypeNode(st.type))
        local.set(
          st.name.text,
          st.type.types.flatMap((t) => (ts.isTypeLiteralNode(t) ? [...t.members] : [])),
        );
      if (
        ts.isExpressionStatement(st) &&
        ts.isStringLiteral(st.expression) &&
        ['use client', 'use server'].includes(st.expression.text)
      )
        facts.directives.push(st.expression.text);
      if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
        const spec = st.moduleSpecifier.text.slice(0, 300);
        const names: string[] = [];
        const c = st.importClause;
        if (c?.name) names.push(`default:${c.name.text}`);
        if (c?.namedBindings) {
          if (ts.isNamespaceImport(c.namedBindings)) names.push(`ns:${c.namedBindings.name.text}`);
          else
            for (const el of c.namedBindings.elements)
              names.push(
                el.propertyName ? `${el.name.text}=${el.propertyName.text}` : el.name.text,
              );
        }
        if (facts.imports.length < L.maxImportsPerFile)
          facts.imports.push({
            spec,
            kind: spec.startsWith('.') ? 'relative' : 'package',
            names: cap(names, 40),
            line: lineOf(st),
            style: STYLE.test(spec),
            asset: ASSET.test(spec),
          });
      }
      if (ts.isExportDeclaration(st)) {
        if (st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier))
          facts.reexports.push({ spec: st.moduleSpecifier.text.slice(0, 300), line: lineOf(st) });
        else if (st.exportClause && ts.isNamedExports(st.exportClause))
          for (const el of st.exportClause.elements)
            exportedNames.add((el.propertyName ?? el.name).text);
      }
      if (ts.isExportAssignment(st) && !st.isExportEquals) {
        const e = st.expression;
        if (ts.isIdentifier(e)) defaultName = e.text;
        else if (ts.isCallExpression(e) && e.arguments[0] && ts.isIdentifier(e.arguments[0]))
          defaultName = e.arguments[0].text;
      }
    }
    // require()/import() with literal specifiers (JS and dynamic imports)
    walk(
      sf,
      (n) => {
        if (
          ts.isCallExpression(n) &&
          n.arguments[0] &&
          ts.isStringLiteral(n.arguments[0]) &&
          facts.imports.length < L.maxImportsPerFile
        ) {
          const e = n.expression;
          const isDyn = e.kind === ts.SyntaxKind.ImportKeyword;
          const isReq = ts.isIdentifier(e) && e.text === 'require';
          if (isDyn || isReq) {
            const spec = n.arguments[0].text.slice(0, 300);
            facts.imports.push({
              spec,
              kind: isDyn ? 'dynamic' : spec.startsWith('.') ? 'relative' : 'package',
              names: [],
              line: lineOf(n),
              style: STYLE.test(spec),
              asset: ASSET.test(spec),
            });
          }
        }
      },
      budget,
    );

    // pass 2: declarations
    const isExported = (st: ts.Node) =>
      ts.canHaveModifiers(st)
        ? (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
        : false;
    const isDefault = (st: ts.Node) =>
      ts.canHaveModifiers(st)
        ? (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
        : false;
    const reactComp = (
      name: string,
      node: ts.Node,
      fn: ts.SignatureDeclarationBase | undefined,
      body: ts.Node,
      typeArg: ts.TypeNode | undefined,
      exported: boolean,
      dflt: boolean,
    ) => {
      const hc = hooksAndChildren(body, name, budget);
      if (!hc.jsx) return;
      addComp({
        name,
        kind: 'react-component',
        framework: 'react',
        line: lineOf(node),
        exported,
        isDefault: dflt,
        props: propsOf(sf, fn, typeArg, local),
        hooks: hc.hooks,
        children: hc.children,
        decorators: [],
        links: [],
      });
    };
    const unwrap = (
      e: ts.Expression,
    ): { fn: ts.FunctionLikeDeclaration | undefined; typeArg: ts.TypeNode | undefined } => {
      let cur: ts.Expression = e;
      let typeArg: ts.TypeNode | undefined;
      for (let i = 0; i < 4; i++) {
        if (ts.isParenthesizedExpression(cur)) cur = cur.expression;
        else if (ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur)) cur = cur.expression;
        else if (ts.isCallExpression(cur)) {
          const callee = ts.isIdentifier(cur.expression)
            ? cur.expression.text
            : ts.isPropertyAccessExpression(cur.expression)
              ? cur.expression.name.text
              : '';
          if (!WRAPPERS.has(callee) || !cur.arguments[0]) break;
          if (callee === 'forwardRef' && cur.typeArguments?.[1]) typeArg = cur.typeArguments[1];
          cur = cur.arguments[0];
        } else break;
      }
      return {
        fn: ts.isArrowFunction(cur) || ts.isFunctionExpression(cur) ? cur : undefined,
        typeArg,
      };
    };
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st)) {
        const name = st.name ? safeName(st.name.text) : isDefault(st) ? 'default' : null;
        if (name && st.body && (isCap(name) || name === 'default'))
          reactComp(
            name,
            st,
            st,
            st.body,
            undefined,
            isExported(st) || exportedNames.has(name) || defaultName === name,
            isDefault(st) || defaultName === name,
          );
        if (st.name && isExported(st)) exportedNames.add(st.name.text);
        if (
          st.name &&
          ['generateStaticParams', 'generateMetadata', 'generateViewport'].includes(st.name.text) &&
          isExported(st)
        )
          facts.directives.push(`export:${st.name.text}`);
      } else if (ts.isVariableStatement(st)) {
        const exp = isExported(st);
        for (const d of st.declarationList.declarations) {
          if (!ts.isIdentifier(d.name)) continue;
          const name = safeName(d.name.text);
          if (!name) continue;
          if (exp) exportedNames.add(d.name.text);
          if (exp && ['metadata', 'viewport', 'dynamic', 'revalidate'].includes(name))
            facts.directives.push(`export:${name}`);
          if (!d.initializer || !isCap(name)) continue;
          const { fn, typeArg } = unwrap(d.initializer);
          if (!fn) continue;
          const annotated =
            d.type && ts.isTypeReferenceNode(d.type) && d.type.typeArguments?.[0]
              ? d.type.typeArguments[0]
              : undefined;
          reactComp(
            name,
            d,
            fn,
            fn.body ?? fn,
            typeArg ?? annotated,
            exp || exportedNames.has(name) || defaultName === name,
            defaultName === name,
          );
        }
      } else if (ts.isClassDeclaration(st) && st.name) {
        const name = safeName(st.name.text);
        if (!name) continue;
        const exp = isExported(st);
        if (exp) exportedNames.add(st.name.text);
        const decos = decoratorsOf(st);
        const dn = decos.map(decoName).filter((x): x is string => !!x);
        const heritage = st.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)
          ?.types[0];
        const base = heritage ? heritage.expression.getText(sf) : '';
        if (/^(?:React\.)?(?:Pure)?Component$/.test(base)) {
          const hc = hooksAndChildren(st, name, budget);
          const typeArg = heritage?.typeArguments?.[0];
          addComp({
            name,
            kind: 'react-class-component',
            framework: 'react',
            line: lineOf(st),
            exported: exp || exportedNames.has(name) || defaultName === name,
            isDefault: isDefault(st) || defaultName === name,
            props: membersOfType(sf, typeArg, local),
            hooks: [],
            children: hc.children,
            decorators: [],
            links: [],
          });
          continue;
        }
        const links: LinkFact[] = [];
        const push = (relation: LinkFact['relation'], ids: string[]) => {
          for (const t of ids) if (links.length < 60) links.push({ relation, target: t });
        };
        // constructor injection (types of the constructor parameters)
        const ctor = st.members.find(ts.isConstructorDeclaration);
        if (ctor)
          push(
            'injects',
            ctor.parameters
              .map((p) =>
                p.type && ts.isTypeReferenceNode(p.type) && ts.isIdentifier(p.type.typeName)
                  ? p.type.typeName.text
                  : '',
              )
              .filter((x) => x && safeName(x)),
          );
        for (const d of [...decos, ...st.members.flatMap((m) => decoratorsOf(m))]) {
          if (decoName(d) === 'UseGuards' && ts.isCallExpression(d.expression))
            push(
              'guarded_by',
              d.expression.arguments
                .filter(ts.isIdentifier)
                .map((x) => x.text)
                .filter((x) => safeName(x)),
            );
        }
        if (dn.includes('Module')) {
          const dec = decos.find((d) => decoName(d) === 'Module');
          const arg =
            dec && ts.isCallExpression(dec.expression) ? dec.expression.arguments[0] : undefined;
          if (arg && ts.isObjectLiteralExpression(arg))
            for (const p of arg.properties) {
              if (!ts.isPropertyAssignment(p)) continue;
              const k = nameOf(p.name);
              if (k === 'imports') push('imports', idArgs(p.initializer));
              else if (k === 'controllers' || k === 'providers')
                push('declares', idArgs(p.initializer));
              else if (k === 'exports') push('exports', idArgs(p.initializer));
            }
          addComp({
            name,
            kind: 'nest-module',
            framework: 'nestjs',
            line: lineOf(st),
            exported: exp || exportedNames.has(name),
            isDefault: false,
            props: [],
            hooks: [],
            children: [],
            decorators: ['Module'],
            links,
          });
        } else if (dn.includes('Controller'))
          addComp({
            name,
            kind: 'nest-controller',
            framework: 'nestjs',
            line: lineOf(st),
            exported: exp || exportedNames.has(name),
            isDefault: false,
            props: [],
            hooks: [],
            children: [],
            decorators: ['Controller'],
            links,
          });
        else if (dn.includes('Injectable'))
          addComp({
            name,
            kind: 'nest-provider',
            framework: 'nestjs',
            line: lineOf(st),
            exported: exp || exportedNames.has(name),
            isDefault: false,
            props: [],
            hooks: [],
            children: [],
            decorators: ['Injectable'],
            links,
          });
        else if (
          st.members.some(
            (m) =>
              ts.isPropertyDeclaration(m) &&
              decoratorsOf(m).some((d) => VALIDATORS.has(decoName(d) ?? '')),
          )
        ) {
          const props: PropFact[] = [];
          for (const m of st.members)
            if (ts.isPropertyDeclaration(m) && m.name && props.length < L.maxPropsPerComponent) {
              const pn = nameOf(m.name);
              if (pn)
                props.push({
                  name: pn,
                  type: typeText(sf, m.type),
                  required:
                    !m.questionToken && !decoratorsOf(m).some((d) => decoName(d) === 'IsOptional'),
                });
            }
          addComp({
            name,
            kind: 'nest-dto',
            framework: 'nestjs',
            line: lineOf(st),
            exported: exp || exportedNames.has(name),
            isDefault: false,
            props,
            hooks: [],
            children: [],
            decorators: [],
            links: [],
          });
        }
      }
    }
    facts.imports.sort(
      (x, y) => x.line - y.line || (x.spec < y.spec ? -1 : x.spec > y.spec ? 1 : 0),
    );
    for (const n of exportedNames) if (!facts.exports.includes(n)) facts.exports.push(n);
    if (defaultName && !facts.exports.includes(defaultName)) facts.exports.push(defaultName);
    facts.exports = cap([...new Set(facts.exports)].filter((x) => safeName(x)).sort(), 200);
    // an exported-later or default-exported component is marked after the fact
    for (const c of comps) {
      if (exportedNames.has(c.name) || defaultName === c.name) c.exported = true;
      if (defaultName === c.name) c.isDefault = true;
    }
    facts.components = comps;
    facts.directives = [...new Set(facts.directives)].sort();
    return facts;
  } catch (e) {
    return emptyFacts('ts', (e as Error).message === 'budget' ? 'budget' : 'parse_error');
  }
}
export type { ImportFact };
