import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { analyzeTsFile } from './ts-file';

vi.setConfig({ testTimeout: 60_000 });
const names = (src: string, file = 'a.tsx') =>
  analyzeTsFile(src, file).components.map((c) => `${c.kind}:${c.name}`);

const BUTTON = `'use client';
import React, { useState, forwardRef as fr, memo } from 'react';
import Card from './card';
import * as Icons from '../icons';
import { Glyph as Icon, type X } from '@/ui/glyph';
import styles from './button.module.css';
import logo from './logo.svg';
export interface ButtonProps { label: string; size?: 'sm' | 'lg'; onClick: () => void }
type Extra = { disabled?: boolean };
export function Button({ label, size = 'sm', onClick }: ButtonProps) {
  const [n, setN] = useState(0);
  useEffect(() => {}, []);
  return <Card><Icon /><Icons.Star />{label}</Card>;
}
export const Chip = memo(function Chip(props: { text: string; dense?: boolean } & Extra) { return <span>{props.text}</span>; });
const Hidden = () => <div />;
export const Wrapped = forwardRef<HTMLDivElement, ButtonProps>((props, ref) => <div ref={ref} />);
export const Typed: React.FC<ButtonProps> = ({ label }) => <b>{label}</b>;
export class Legacy extends React.Component<ButtonProps> { render() { return <Button label="x" onClick={() => {}} />; } }
function helper() { return 1 }
const lower = () => <div />;
export default Hidden;
export { Glyph as GlyphExport } from './x';
export const metadata = { title: 'x' };
export async function generateStaticParams() { return []; }
const lazyLoad = () => import('./lazy');
const legacy = require('./cjs');
`;

describe('TypeScript file analyzer (parse-only)', () => {
  const f = analyzeTsFile(BUTTON, 'button.tsx');
  it('finds components of every common shape and ignores lookalikes', () => {
    expect(f.components.map((c) => `${c.kind}:${c.name}`).sort()).toEqual(
      [
        'react-class-component:Legacy',
        'react-component:Button',
        'react-component:Chip',
        'react-component:Hidden',
        'react-component:Typed',
        'react-component:Wrapped',
      ].sort(),
    );
    // `helper` (no JSX, lower-case) and `lower` (lower-case) are not components
  });
  it('props from declared types, inline types, intersections, FC generics and destructuring defaults', () => {
    const by = Object.fromEntries(f.components.map((c) => [c.name, c.props]));
    expect(by.Button).toEqual([
      { name: 'label', type: 'string', required: true },
      { name: 'size', type: "'sm' | 'lg'", required: false },
      { name: 'onClick', type: '() => void', required: true },
    ]);
    expect(by.Chip).toEqual([
      { name: 'text', type: 'string', required: true },
      { name: 'dense', type: 'boolean', required: false },
      { name: 'disabled', type: 'boolean', required: false }, // from the intersected local type
    ]);
    expect(by.Wrapped!.map((p) => p.name)).toEqual(['label', 'size', 'onClick']);
    expect(by.Typed!.map((p) => p.name)).toEqual(['label', 'size', 'onClick']);
    expect(by.Legacy!.map((p) => p.name)).toEqual(['label', 'size', 'onClick']);
  });
  it('hooks and rendered children (tags, namespace members), not intrinsic elements', () => {
    const b = f.components.find((c) => c.name === 'Button')!;
    expect(b.hooks).toEqual(['useEffect', 'useState']);
    expect(b.children).toEqual(['Card', 'Icon', 'Icons']);
    expect(f.components.find((c) => c.name === 'Legacy')!.children).toEqual(['Button']);
  });
  it('exports (named, default, later, re-exported), directives and Next conventions', () => {
    expect(f.exports).toEqual(
      expect.arrayContaining([
        'Button',
        'Chip',
        'Legacy',
        'Hidden',
        'Wrapped',
        'Typed',
        'metadata',
        'generateStaticParams',
      ]),
    );
    expect(f.components.find((c) => c.name === 'Hidden')).toMatchObject({
      exported: true,
      isDefault: true,
    });
    expect(f.components.find((c) => c.name === 'Button')).toMatchObject({
      exported: true,
      isDefault: false,
    });
    expect(f.reexports).toEqual([{ spec: './x', line: 23 }]);
    expect(f.directives).toEqual(['export:generateStaticParams', 'export:metadata', 'use client']);
  });
  it('imports with binding names, style and asset flags, require and dynamic imports', () => {
    expect(
      f.imports.map(
        (i) =>
          `${i.kind}:${i.spec}:${i.names.join('|')}${i.style ? ':style' : ''}${i.asset ? ':asset' : ''}`,
      ),
    ).toEqual([
      'package:react:default:React|useState|fr=forwardRef|memo',
      'relative:./card:default:Card',
      'relative:../icons:ns:Icons',
      'package:@/ui/glyph:Icon=Glyph|X',
      'relative:./button.module.css:default:styles:style',
      'relative:./logo.svg:default:logo:asset',
      'dynamic:./lazy:',
      'relative:./cjs:',
    ]);
  });
  it('anonymous default export is a component named "default"; page and layout style files', () => {
    expect(names('export default function () { return <div /> }')).toEqual([
      'react-component:default',
    ]);
    expect(names('export default () => <div />')).toEqual([]); // an anonymous arrow is not named: reported only when declared as a function
  });
});

describe('NestJS decorators (AST, not text patterns)', () => {
  const SRC = `
@Module({ imports: [UsersModule, forwardRef(() => X)], controllers: [AppController], providers: [AppService, { provide: A, useClass: B }], exports: [AppService] })
export class AppModule {}
@Controller('users') @UseGuards(JwtGuard, RolesGuard)
export class UsersController { constructor(private readonly users: UsersService, private log: Logger) {} @Get() @UseGuards(AdminGuard) list() {} }
@Injectable() export class UsersService { constructor(private repo: UsersRepo) {} }
export class CreateUserDto { @IsString() name: string; @IsOptional() @IsInt() age?: number; plain: string; }
export class NotADto { x: string }
`;
  const f = analyzeTsFile(SRC, 'a.ts');
  it('modules, controllers, providers and DTOs with their links', () => {
    expect(f.components.map((c) => `${c.kind}:${c.name}`)).toEqual([
      'nest-module:AppModule',
      'nest-controller:UsersController',
      'nest-provider:UsersService',
      'nest-dto:CreateUserDto',
    ]);
    expect(f.components[0]!.links).toEqual([
      { relation: 'imports', target: 'UsersModule' },
      { relation: 'declares', target: 'AppController' },
      { relation: 'declares', target: 'AppService' },
      { relation: 'exports', target: 'AppService' },
    ]);
    expect(f.components[1]!.links).toEqual([
      { relation: 'injects', target: 'UsersService' },
      { relation: 'injects', target: 'Logger' },
      { relation: 'guarded_by', target: 'JwtGuard' },
      { relation: 'guarded_by', target: 'RolesGuard' },
      { relation: 'guarded_by', target: 'AdminGuard' },
    ]);
    expect(f.components[2]!.links).toEqual([{ relation: 'injects', target: 'UsersRepo' }]);
    expect(f.components[3]!.props).toEqual([
      { name: 'name', type: 'string', required: true },
      { name: 'age', type: 'number', required: false },
      { name: 'plain', type: 'string', required: true },
    ]);
  });
});

describe('negative: text that merely looks like code', () => {
  it('commented-out components, strings, template literals, markdown code blocks and JSON-in-.ts produce nothing', () => {
    expect(
      names(
        "// export function Fake() { return <div/> }\n/* const Fake2 = () => <div/> */\nconst s = 'function Fake3() { return <div/> }';\nconst t = `const Fake4 = () => <div/>`;\n",
      ),
    ).toEqual([]);
    expect(
      names('# docs\n```tsx\nexport function Doc() { return <div/> }\n```\n', 'README.md.ts'),
    ).toEqual([]);
    expect(names('{"name":"x","dependencies":{"react":"1"}}', 'data.ts')).toEqual([]);
    expect(names('export function Foo() { return null }')).toEqual([]); // no JSX: not a component
    expect(names('export const x = <T,>(a: T) => a;', 'a.ts')).toEqual([]);
  });
});

describe('hostile input', () => {
  it('minified lines, NUL bytes and invalid syntax are skipped or tolerated, never thrown', () => {
    expect(analyzeTsFile('a'.repeat(6000), 'min.js').skipped).toBe('minified');
    expect(analyzeTsFile('export function A() { return <div/> }\u0000', 'a.tsx').skipped).toBe(
      'parse_error',
    );
    expect(() => analyzeTsFile('export function A( { return <div> ', 'a.tsx')).not.toThrow();
    expect(analyzeTsFile('}}}} <<<< @@@@ ``` "unterminated', 'a.tsx').skipped).toBeNull();
  });
  it('deeply nested expressions and a very large file stay bounded (iterative traversal, node budget)', () => {
    const deep = `export function A() { return ${'(\n'.repeat(20_000)}<div/>${')\n'.repeat(20_000)}; }`;
    const t0 = Date.now();
    const r = analyzeTsFile(deep, 'a.tsx');
    expect(['budget', 'parse_error', null]).toContain(r.skipped);
    const big = analyzeTsFile(
      `export const x = [${'1,\n'.repeat(300_000)}];\nexport function B() { return <i/> }`,
      'b.tsx',
    );
    expect(['budget', null]).toContain(big.skipped);
    expect(Date.now() - t0).toBeLessThan(15_000);
  });
  it('a thousand components in one file are capped; names that are not identifiers never appear; __proto__ is only a name', () => {
    const many = analyzeTsFile(
      Array.from({ length: 1000 }, (_, i) => `export const C${i} = () => <i/>;`).join('\n'),
      'a.tsx',
    );
    expect(many.components).toHaveLength(200);
    expect(many.truncated).toBe(true);
    const p = analyzeTsFile(
      'export function __proto__() { return <div/> }\nexport function Constructor() { return <i/> }\nexport const constructor = () => <b/>;',
      'a.tsx',
    );
    expect(p.components.map((c) => c.name)).toEqual(['Constructor']); // `__proto__` and `constructor` are not capitalised names: not components; `Constructor` is just a name
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const evil = analyzeTsFile(
      "export function A() { return <div/> }\nimport x from 'a\\u202eb';",
      'a.tsx',
    );
    expect(evil.components).toHaveLength(1);
  });
  it('never executes anything in the file', () => {
    (globalThis as Record<string, unknown>).__ts_pwned = undefined;
    analyzeTsFile(
      "globalThis.__ts_pwned = 1; require('child_process').execSync('touch /tmp/ts-pwned'); export function A() { return <div/> }",
      'a.tsx',
    );
    expect((globalThis as Record<string, unknown>).__ts_pwned).toBeUndefined();
  });
  it('fuzz: arbitrary text never throws and the facts stay bounded and serialisable', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 500 }),
        fc.constantFrom('a.ts', 'a.tsx', 'a.js', 'a.jsx'),
        (s, f) => {
          const r = analyzeTsFile(s, f);
          const j = JSON.stringify(r);
          expect(j.length).toBeLessThan(150_000);
          expect(JSON.parse(j)).toEqual(r);
        },
      ),
      { numRuns: 300 },
    );
  });
  it('is deterministic', () => {
    expect(JSON.stringify(analyzeTsFile(BUTTON, 'a.tsx'))).toBe(
      JSON.stringify(analyzeTsFile(BUTTON, 'b.tsx')),
    );
  });
});
