import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { RealmOnly, StepUp } from '../identity';
import { ModelProviderService } from './internal/provider.service';

/**
 * `GET/POST /v1/admin/ai/model-providers` (docs/04 §2.9). One POST with an `action`: configure | attest | request_enable | enable | disable | kill_switch.
 * Nothing is seeded and D-18/HG-09-01 are OPEN: a provider cannot be enabled without a human data-terms attestation, a registered adapter and a second person.
 * `set_credential` takes an API key typed by an administrator and keeps it in the sealed secret store (dev profile only until D-12); the response never contains a
 * credential: only the vault REFERENCE.
 */
@RealmOnly('admin')
@Controller('v1/admin/ai/model-providers')
export class AdminAiProvidersController {
  constructor(private readonly providers: ModelProviderService) {}

  @RequirePlatformPermission('admin:ai:read')
  @Get()
  list() {
    return this.providers.list();
  }

  /** A LIVE, read-only check that the stored Claude key is accepted. Needs `admin:ai:manage` and a recent MFA; changes nothing; audited. */
  @RequirePlatformPermission('admin:ai:read')
  @StepUp()
  @Post(':id/connection-test')
  @HttpCode(200)
  async connectionTest(@Platform() who: PlatformContext, @Param('id') id: string) {
    if (!who.permissions.has('admin:ai:manage'))
      throw new ProblemException(
        'forbidden',
        'permission admin:ai:manage is required for this action',
      );
    return this.providers.testConnection(who.userId, id);
  }

  @RequirePlatformPermission('admin:ai:read')
  @StepUp()
  @Post()
  @HttpCode(200)
  async act(@Platform() who: PlatformContext, @Body() body: Record<string, unknown> | undefined) {
    const b = body ?? {};
    const need = (p: string) => {
      if (!who.permissions.has(p))
        throw new ProblemException('forbidden', `permission ${p} is required for this action`);
    };
    const id = String(b.id ?? '');
    switch (b.action ?? 'configure') {
      case 'configure':
        need('admin:ai:manage');
        return this.providers.configure(who.userId, b);
      case 'save_claude_key':
        need('admin:ai:manage');
        return this.providers.saveClaudeKey(who.userId, b.apiKey);
      case 'set_credential':
        need('admin:ai:manage');
        return this.providers.setCredential(who.userId, id, b.apiKey);
      case 'clear_credential':
        need('admin:ai:manage');
        return this.providers.clearCredential(who.userId, id);
      case 'attest':
        need('admin:ai:approve');
        return this.providers.attest(who.userId, id, b);
      case 'request_enable':
        need('admin:ai:manage');
        return this.providers.requestEnable(who.userId, id);
      case 'enable':
        need('admin:ai:approve');
        return this.providers.enable(who.userId, id);
      case 'disable':
        need('admin:ai:manage');
        return this.providers.disable(who.userId, id);
      case 'record_capability_evidence':
        need('admin:ai:approve');
        return this.providers.recordCapabilityEvidence(who.userId, id, b);
      case 'probe_tool_use':
        need('admin:ai:approve');
        return this.providers.probeToolUse(who.userId, id, b);
      case 'kill_switch':
        need('admin:ai:manage');
        if (typeof b.on !== 'boolean')
          throw new ProblemException('validation_failed', 'on must be true or false');
        return this.providers.setKillSwitch(
          who.userId,
          b.on,
          typeof b.orgId === 'string' ? b.orgId : undefined,
        );
      default:
        throw new ProblemException(
          'validation_failed',
          'action must be configure, save_claude_key, set_credential, clear_credential, attest, request_enable, enable, disable, record_capability_evidence, probe_tool_use or kill_switch',
        );
    }
  }
}
