import type { ReadOnlyWorkspace } from '@nuzm/domain';

/**
 * Where the read-only agent tools get the project they read (D-46, SCR-K-10 §3). The AI module owns the gateway and knows nothing of projects or templates: the module that does
 * (the app builder) registers a provider per run kind that opens a READ-ONLY, in-memory snapshot of ONE project of ONE organization. A provider must return `null` for a project
 * that is not visible to that organization (row-level security does that), and must mark which files are still a template's and whether that template permits AI processing.
 */
export interface AgentWorkspaceProvider {
  open(orgId: string, projectId: string): Promise<ReadOnlyWorkspace | null>;
}
export abstract class AgentWorkspaceRegistry {
  abstract register(runKind: string, provider: AgentWorkspaceProvider): void;
  abstract get(runKind: string): AgentWorkspaceProvider | undefined;
}
export class StaticAgentWorkspaceRegistry extends AgentWorkspaceRegistry {
  private readonly m = new Map<string, AgentWorkspaceProvider>();
  register(runKind: string, provider: AgentWorkspaceProvider) {
    this.m.set(runKind, provider);
  }
  get(runKind: string) {
    return this.m.get(runKind);
  }
}
