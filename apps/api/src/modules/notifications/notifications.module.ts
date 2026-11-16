import { Global, Module } from '@nestjs/common';
import type { Db } from '@nuzm/platform';
import { DevLogMailer, Mailer, UnconfiguredMailer } from '../../common/mailer';
import { DB } from '../../common/tokens';
import { UserService, IdentityModule } from '../identity';
import { EmailChannel, InAppChannel, type Recipient } from './internal/channels';
import { NotificationService } from './internal/notification.service';
import { NotificationsController } from './notifications.controller';

/** Owns the Mailer port (the transactional-email provider is decided in M08/D-08) and the notification pipeline. */
@Global()
@Module({
  imports: [IdentityModule],
  controllers: [NotificationsController],
  providers: [
    {
      provide: Mailer,
      useFactory: () =>
        process.env.NODE_ENV === 'production' ? new UnconfiguredMailer() : new DevLogMailer(),
    },
    {
      provide: NotificationService,
      useFactory: (db: Db, mailer: Mailer, users: UserService) =>
        new NotificationService(
          db,
          [new InAppChannel(db), new EmailChannel(mailer)],
          async (userId): Promise<Recipient | null> => {
            const u = await users.get(userId);
            return u && u.status === 'active'
              ? { email: u.email, emailVerified: u.email_verified, locale: u.locale }
              : null;
          },
          (e, channel, kind) =>
            process.stderr.write(
              JSON.stringify({
                notification_channel_failed: channel,
                kind,
                error: (e as Error).message,
              }) + '\n',
            ),
        ),
      inject: [DB, Mailer, UserService],
    },
  ],
  exports: [Mailer, NotificationService],
})
export class NotificationsModule {}
