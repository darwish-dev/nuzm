import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { Db } from '@nuzm/platform';
import { DB } from './common/tokens';

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: '127.0.0.1' }),
    { rawBody: true, logger: ['error', 'warn'] },
  );
  await configureApp(app);
  await app.get<Db>(DB).withoutScope(async (client) => {
    const { rows } = await client.query<{ ready: boolean }>(
      "SELECT to_regclass('identity.credentials') IS NOT NULL AS ready",
    );
    if (!rows[0]?.ready) throw new Error('Run database migrations before starting the API');
  });
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 4000), '127.0.0.1');
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'API startup failed');
  process.exitCode = 1;
});
