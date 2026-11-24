# DEFECT-5 — sandbox control plane follows symlinks left by sandboxed code (named read, directory write)

Reporter: Session 07 (QA) · Owner: Session 04 (`apps/api/src/modules/appbuilder/internal/sandbox/**`) · cc Master · Severity: **LOW today** (the affected class `LocalDevSandboxRuntime` is dev-only, `isolation:'none'`, refuses to start in production; **HIGH as a design rule** for the real runtime port Session 04 is building: the control plane must never follow a path that sandboxed code can influence) · Status: OPEN · Found 2026-11-24, baseline `f81872d5`

## Where
`apps/api/src/modules/appbuilder/internal/sandbox/local-dev-runtime.ts`
- `readFiles(handle, paths)` (named-path branch, ~line 94-101): `readFileSync(join(root, p))` follows a symlink. (The whole-tree walk right above correctly skips symlinks: `if (f.isSymbolicLink()) continue`.)
- `writeFiles` (~line 66-80): `checkPath` + `relative(root, full).startsWith('..')` are **lexical** only; `mkdirSync(dirname(full),{recursive:true})` and `writeFileSync` follow a symlinked directory created by earlier sandboxed code.

## Reproduction (nothing is executed; the symlink is made with the file system in the runner's temp dir, `apps/api/src/qa/qa-local-dev-sandbox.int.spec.ts`)
1. `SANDBOX_LOCAL_DEV=true`; `rt.create()`; create `link.txt -> /outside/host-secret.txt` and `out -> /outside` inside the sandbox directory (stand-in for what code running in the sandbox can do).
2. `rt.readFiles(h, ['link.txt'])` → returns the content of the outside file (canary found).
3. `rt.writeFiles(h, {'out/planted.txt': 'x'})` → `/outside/planted.txt` is created.

## Expected
Any control-plane read or write of a sandbox path is confined to the sandbox root *after* symlink resolution (`realpath` of the parent must stay under the root; `O_NOFOLLOW`/`lstat` on the leaf; refuse a symlink anywhere on the path), exactly as the whole-tree listing already does.

## Actual
Named reads and directory writes follow symlinks. In the dev runner this is a confused-deputy path (the platform, not the sandboxed code, performs the read/write, so any policy applied to the sandbox's own syscalls does not apply). A real runtime that shares this code pattern would turn a customer-controlled symlink into reads of control-plane files (artifacts, exports, prompts) or writes outside the workspace.

## Suggested fix
1. `local-dev-runtime.ts`: resolve with `realpathSync` of the deepest existing ancestor and require `startsWith(realRoot + sep)`; reject symlink leaves with `lstatSync(...).isSymbolicLink()`.
2. Add control-plane attempts to the escape suite (`escape-suite.ts`, currently PT-* only exercise the lexical `checkPath`): `SYM-READ` (named read through a symlink to a canary outside the root), `SYM-WRITE` (write through a symlinked directory), `SYM-HARDLINK` (hard link to an outside file). The escape suite is the acceptance gate of D-21: a runtime that only passes lexical path tests must not be called verified.

## Tests
`qa-local-dev-sandbox.int.spec.ts` → `4 passed | 2 expected fail`: the two `it.fails('DEFECT-5: …')` state the secure expectation and fail today (remove the marker when fixed); passing controls: traversal/absolute/encoded paths refused, full-tree listing skips symlinks, ordinary round trip works, the runner refuses to start without `SANDBOX_LOCAL_DEV` or in production.
