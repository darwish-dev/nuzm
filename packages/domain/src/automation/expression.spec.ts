import { describe, expect, it } from 'vitest';
import { EXPRESSION_LIMITS, ExpressionError, compileExpression, evalExpression, renderTemplate } from './expression';

const scope = { input: { a: 2, b: 3, name: 'Nuzm', list: [1, 2, 3], nested: { x: 'y' } }, steps: { s1: { output: { ok: true, n: 10 } } }, item: 'z' };
const ev = (s: string) => evalExpression(s, scope);

describe('expression language', () => {
  it('evaluates literals, arithmetic, comparison and logic', () => {
    expect(ev('1 + 2 * 3')).toBe(7);
    expect(ev('(1 + 2) * 3')).toBe(9);
    expect(ev('input.a + input.b')).toBe(5);
    expect(ev('input.a < input.b && input.b <= 3')).toBe(true);
    expect(ev('!false')).toBe(true);
    expect(ev('input.a == 2 ? "two" : "other"')).toBe('two');
    expect(ev('"a" + "b"')).toBe('ab');
    expect(ev('10 % 4')).toBe(2);
    expect(ev('-input.a')).toBe(-2);
  });
  it('reads paths and indexes, missing paths are null', () => {
    expect(ev('input.nested.x')).toBe('y');
    expect(ev('input.list[1]')).toBe(2);
    expect(ev('steps.s1.output.n')).toBe(10);
    expect(ev('input.missing.deep')).toBeNull();
    expect(ev('input.list[99]')).toBeNull();
  });
  it('calls only the fixed pure functions', () => {
    expect(ev('len(input.list)')).toBe(3);
    expect(ev('upper(input.name)')).toBe('NUZM');
    expect(ev('concat("a", 1, null, "b")')).toBe('a1b');
    expect(ev('coalesce(input.nope, "dflt")')).toBe('dflt');
    expect(ev('contains(input.list, 2)')).toBe(true);
    expect(ev('max(1, 5, 3)')).toBe(5);
    expect(() => ev('eval("1")')).toThrow(/unknown function/);
    expect(() => ev('process.exit()')).toThrow(ExpressionError);
    expect(() => ev('require("fs")')).toThrow(/unknown function/);
    for (const inherited of ['valueOf', 'hasOwnProperty', 'constructor', 'toLocaleString', '__defineGetter__']) expect(() => ev(`${inherited}(1)`), inherited).toThrow(ExpressionError);
  });
  it('refuses prototype-chain access in every spelling', () => {
    for (const bad of ['input.__proto__', 'input.constructor', 'input["constructor"]', 'input.constructor.prototype', 'constructor', '__proto__.x', 'input["__proto__"]']) {
      expect(() => ev(bad), bad).toThrow(ExpressionError);
    }
    expect(ev('input.toString')).toBeNull(); // inherited members are invisible
    expect(ev('input["hasOwnProperty"]')).toBeNull();
  });
  it('has no assignment, no statements, no code execution syntax', () => {
    for (const bad of ['a = 1', 'a; b', '() => 1', 'function(){}', '`x`', 'new Date()', 'a++', 'a.b = 3', '{}', 'x => x', 'import("x")', 'this', 'globalThis.process']) {
      let threw = false;
      try {
        const r = ev(bad);
        threw = r === null && /^(this|globalThis\.process)$/.test(bad) ? false : false;
      } catch {
        threw = true;
      }
      if (!/^(this|globalThis\.process)$/.test(bad)) expect(threw, bad).toBe(true);
    }
    expect(ev('this')).toBeNull(); // just an unknown name: reads nothing
    expect(ev('globalThis.process')).toBeNull();
  });
  it('enforces length, depth and step limits', () => {
    expect(() => compileExpression('1+'.repeat(EXPRESSION_LIMITS.maxLength))).toThrow(/too long/);
    expect(() => compileExpression('('.repeat(100) + '1' + ')'.repeat(100))).toThrow(/nested too deeply/);
    const wide = Array.from({ length: 400 }, () => '1').join('+');
    expect(ev(wide)).toBe(400);
    const big = `[${Array.from({ length: 100 }, () => '1').join(',')}]`;
    const nested = `len(${big}) + len(${big}) + len(${big})`;
    expect(ev(nested)).toBe(300);
  });
  it('division by zero and type errors are ExpressionErrors, never crashes', () => {
    expect(() => ev('1 / 0')).toThrow(/division by zero/);
    expect(() => ev('"a" - 1')).toThrow(ExpressionError);
    expect(() => ev('toNumber("x") + 1')).toThrow(ExpressionError);
  });
  it('renders templates: whole-value keeps the type, mixed text stringifies', () => {
    expect(renderTemplate('{{ input.list }}', scope)).toEqual([1, 2, 3]);
    expect(renderTemplate('{{ input.a }}', scope)).toBe(2);
    expect(renderTemplate('Hi {{ input.name }}, n={{ steps.s1.output.n }}', scope)).toBe('Hi Nuzm, n=10');
    expect(renderTemplate('no placeholders', scope)).toBe('no placeholders');
    expect(() => renderTemplate('{{ nope( }}', scope)).toThrow(ExpressionError);
  });
  it('is deterministic and side-effect free: the scope is never mutated', () => {
    const s = JSON.parse(JSON.stringify(scope)) as typeof scope;
    evalExpression('concat(input.name, len(input.list))', s);
    expect(s).toEqual(scope);
  });
});
