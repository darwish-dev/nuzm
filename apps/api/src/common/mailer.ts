/**
 * Outbound mail port. The real transactional-email provider is decided in M08 (D-08); until then the
 * dev mailer logs and production refuses to send (so invitations fail loudly instead of vanishing).
 */
interface MailBase {
  to: string;
  locale: 'ar' | 'en';
}
export type MailMessage =
  | (MailBase & {
      template: 'invitation';
      data: {
        invitationId: string;
        orgName: string;
        role: string;
        inviterEmail: string;
        token: string;
        expiresAt: string;
      };
    })
  | (MailBase & {
      /** Account emails (ADR-008): the token is single use and expires; the provider renders the link from the web origin. */
      template: 'email_verification' | 'password_reset';
      data: { token: string; expiresAt: string };
    })
  | (MailBase & {
      /** Rendered per locale by the mail provider integration (M08); params carry only non-sensitive facts. */
      template: 'notification';
      data: { kind: string; params: Record<string, unknown> };
    });

export abstract class Mailer {
  abstract send(m: MailMessage): Promise<void>;
}

export class DevLogMailer extends Mailer {
  async send(m: MailMessage): Promise<void> {
    // DEV ONLY: invitation tokens are printed so a developer can accept the invitation locally.
    process.stdout.write(JSON.stringify({ mail: m.template, to: m.to, data: m.data }) + '\n');
  }
}

export class UnconfiguredMailer extends Mailer {
  async send(): Promise<void> {
    throw new Error('mail provider not configured (D-08)');
  }
}
