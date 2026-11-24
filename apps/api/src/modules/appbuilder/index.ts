// Public surface of the app-builder module (M10A: web / full-stack apps).
export {
  AppBuilderModule,
  M09_PORT_PROVIDERS,
  M09_STUB_PROVIDERS,
  makeRuntime,
} from './appbuilder.module';
export { APP_BUILDER_FLAG, M09_STUBS_FLAG } from './internal/flag.guard';
// the M09 boundary: what M09 must implement (docs/reports/M10-m09-interface-assumptions.md)
export {
  RunStorePort,
  ModelGatewayPort,
  ArtifactStorePort,
  ProjectsPort,
  OrgBudgetPort,
} from './internal/ports/m09';
export type {
  RunRecord,
  RunBudget,
  RunKind,
  RunState,
  ProjectRecord,
  ProjectVersion,
  ModelRequest,
  ModelResponse,
} from './internal/ports/m09';
export {
  ApprovalService,
  APPROVAL_POLICY,
  scopeHashOf,
} from './internal/approvals/approval.service';
export type { ApprovalDto } from './internal/approvals/approval.service';
export { AppSpecService } from './internal/spec/spec.service';
export { validateAppSpec } from './internal/spec/app-spec';
export type { AppSpec } from './internal/spec/app-spec';
export { GraphRunner } from './internal/graph/runner';
export { WEBAPP_GRAPH, validateGraph } from './internal/graph/dag';
export { SandboxService } from './internal/sandbox/sandbox.service';
export { SandboxRuntime } from './internal/sandbox/runtime';
export { ChangeService } from './internal/changes/change.service';
export { TestRunService } from './internal/tests/test-run.service';
export { AppDeploymentService } from './internal/deploy/deployment.service';
export { ExportService } from './internal/export/export.service';
export { AppRunService } from './internal/run.service';
export { generateProject } from './internal/gen/project';
export { CRM_SPEC } from './internal/fixtures/crm-appspec';
export { ATTEMPTS, runEscapeSuite } from './internal/sandbox/escape-suite';
// the builder loop's plug-in point for the product tracks (website, full-stack, mobile): one generator per product type
export { ProductGeneratorRegistry } from './internal/lifecycle/generator-registry';
export type { FileGenerator } from './internal/lifecycle/lifecycle.types';
