import { Controller, Get } from '@nestjs/common';
import { RequirePlatformPermission } from '../../common/access';
import { RealmOnly } from '../identity';
import { NodesService } from './internal/nodes.service';

@RealmOnly('admin')
@Controller('v1/admin/hosting/agents')
export class AdminAgentsController {
  constructor(private readonly nodes: NodesService) {}
  @RequirePlatformPermission('admin:hosting:read')
  @Get()
  async list() {
    return { items: await this.nodes.listAgents() };
  }
}
