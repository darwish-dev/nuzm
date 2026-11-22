import type { ReadOnlyWorkspace } from '@nuzm/domain';
import type { AgentWorkspaceProvider } from '../../../ai';
import type { GenerationService } from './generation';

/**
 * The read-only workspace of a web-app project for the agent tools (S-AG2, D-46). Registered with the AI module's registry for the `webapp` run kind. It only READS the project through
 * the same port and the same template rules as the S-K6 context assembly: a file that is still the template's is readable only when the template permits AI processing.
 */
export class AgentProjectWorkspace implements AgentWorkspaceProvider {
  constructor(private readonly generation: GenerationService) {}
  open(orgId: string, projectId: string): Promise<ReadOnlyWorkspace | null> {
    return this.generation.workspaceView(orgId, projectId);
  }
}
