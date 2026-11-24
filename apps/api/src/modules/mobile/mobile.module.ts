import { Inject, Module, type OnApplicationBootstrap } from '@nestjs/common';
import type { Db } from '@nuzm/platform';
import { AuditSink } from '../../common/audit';
import { DB } from '../../common/tokens';
import { RunKindRegistry } from '../ai';
import { MobileProjectService } from '../builder';
import { ResidencyService } from '../compliance';
import { IdentityModule } from '../identity';
import { BuildsController } from './builds.controller';
import { ReleasesController } from './releases.controller';
import { SigningController } from './signing.controller';
import {
  ArtifactBytesPort,
  LocalDirArtifactBytes,
  MemoryArtifactBytes,
  UnavailableArtifactBytes,
} from './internal/builds/blobs';
import { BuildService, DEFAULT_BUILD_CONFIG } from './internal/builds/build.service';
import {
  BuildRunnerPort,
  LocalAndroidRunner,
  MockBuildRunner,
  UnavailableBuildRunner,
} from './internal/builds/runner';
import { DisposableAndroidRunner } from './internal/builds/disposable-runner';
import { MacosIosRunner } from './internal/builds/ios-runner';
import { MobileBuilderEnabledGuard } from './internal/flag.guard';
import { MobileRunHandler } from './internal/mobile-run.handler';
import { PubAdvisoryPort, StaticPubAdvisories } from './internal/policy/pub-policy';
import { ReleaseService } from './internal/releases/release.service';
import {
  SigningService,
  SigningStagePort,
  UnavailableSigningStage,
} from './internal/signing/signing.service';

/**
 * Build runner selection. Production (and any unset environment) has NO runner: D-21 (sandbox technology) and D-22 / HG-10-01 (macOS capacity, accounts, signing material) are open, so the
 * API answers 503 instead of pretending. `MOBILE_BUILD_RUNNER=local-android` enables the LOCAL, UNSIGNED, NON-ISOLATED debug runner (development only, refused in production);
 * `mock` is for tests.
 */
export const makeBuildRunner = (env: NodeJS.ProcessEnv = process.env): BuildRunnerPort => {
  if (env.NODE_ENV === 'production') return new UnavailableBuildRunner();
  if (env.MOBILE_BUILD_RUNNER === 'local-android') return new LocalAndroidRunner();
  // refuses to run anywhere but a declared disposable environment (internal/builds/build-env-guard.ts); `supports()` is false there, so the API answers 503 instead of queueing
  if (env.MOBILE_BUILD_RUNNER === 'disposable-android') return new DisposableAndroidRunner();
  // iOS without code signing; only on a macOS host with full Xcode inside a declared dedicated build user (B-iOS); `supports()` is false anywhere else
  if (env.MOBILE_BUILD_RUNNER === 'macos-ios') return new MacosIosRunner();
  if (env.MOBILE_BUILD_RUNNER === 'mock') return new MockBuildRunner();
  return new UnavailableBuildRunner();
};
export const makeArtifactBytes = (env: NodeJS.ProcessEnv = process.env): ArtifactBytesPort =>
  env.NODE_ENV === 'production'
    ? new UnavailableArtifactBytes()
    : env.NODE_ENV === 'test'
      ? new MemoryArtifactBytes()
      : new LocalDirArtifactBytes(env.MOBILE_ARTIFACT_DIR);

/**
 * Mobile builder (M10B S48-S50): Flutter generation (`kind=mobile` run handler on the M09 registry, template set, pub allow-list), build workers and artifacts, signing credential
 * REFERENCES, release-preparation records. Feature flag `mobile_builder.enabled` (default OFF). No isolating runtime, no macOS capacity, no signing stage and no store account exist:
 * those paths answer 503 honestly (HG-10-01, D-21, D-22). The platform never submits to a store.
 */
@Module({
  imports: [IdentityModule],
  controllers: [BuildsController, SigningController, ReleasesController],
  providers: [
    MobileBuilderEnabledGuard,
    { provide: BuildRunnerPort, useFactory: () => makeBuildRunner() },
    { provide: ArtifactBytesPort, useFactory: () => makeArtifactBytes() },
    { provide: SigningStagePort, useFactory: () => new UnavailableSigningStage() },
    { provide: PubAdvisoryPort, useFactory: () => new StaticPubAdvisories() },
    {
      provide: SigningService,
      useFactory: (db: Db, a: AuditSink) => new SigningService(db, a, DEFAULT_BUILD_CONFIG.region),
      inject: [DB, AuditSink],
    },
    {
      provide: BuildService,
      useFactory: (
        db: Db,
        a: AuditSink,
        p: MobileProjectService,
        s: SigningService,
        st: SigningStagePort,
        r: BuildRunnerPort,
        b: ArtifactBytesPort,
        adv: PubAdvisoryPort,
        res: ResidencyService,
      ) => new BuildService(db, a, p, s, st, r, b, adv, res, DEFAULT_BUILD_CONFIG),
      inject: [
        DB,
        AuditSink,
        MobileProjectService,
        SigningService,
        SigningStagePort,
        BuildRunnerPort,
        ArtifactBytesPort,
        PubAdvisoryPort,
        ResidencyService,
      ],
    },
    {
      provide: ReleaseService,
      useFactory: (db: Db, a: AuditSink, p: MobileProjectService) =>
        new ReleaseService(db, a, p, DEFAULT_BUILD_CONFIG.region),
      inject: [DB, AuditSink, MobileProjectService],
    },
  ],
  exports: [BuildService, SigningService, ReleaseService],
})
export class MobileModule implements OnApplicationBootstrap {
  constructor(
    @Inject(RunKindRegistry) private readonly registry: RunKindRegistry,
    @Inject(MobileProjectService) private readonly projects: MobileProjectService,
  ) {}
  onApplicationBootstrap() {
    this.registry.register(new MobileRunHandler(this.projects));
  }
}
