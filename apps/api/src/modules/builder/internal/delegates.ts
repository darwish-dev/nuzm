/**
 * Project types other than `website` (M10: `webapp`; `mobile` in M10B) are served by their own module. M09 owns the paths `/v1/builder/projects/**`; for a project of
 * another type the safe-diff `POST …/changes` is dispatched to the delegate the owning module registers at bootstrap (same pattern as `RunKindRegistry`).
 * Without a registered delegate the call answers 422 `unsupported_capability`.
 */
export interface ProjectTypeDelegate {
  /** `POST /v1/builder/projects/{id}/changes` for a project of this type: `{baseVersion, patches[], message?}`. */
  applyChanges(
    orgId: string,
    userId: string,
    projectId: string,
    body: Record<string, unknown>,
  ): Promise<unknown>;
}
export class ProjectDelegates {
  private readonly m = new Map<string, ProjectTypeDelegate>();
  register(type: string, d: ProjectTypeDelegate) {
    this.m.set(type, d);
  }
  get(type: string): ProjectTypeDelegate | undefined {
    return this.m.get(type);
  }
}
