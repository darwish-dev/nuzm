/**
 * Outbound mail port. The real transactional-email provider is decided in M08 (D-08); until then the
 * dev mailer logs and production refuses to send (so invitations fail loudly instead of vanishing).
 */
export interface MailMessage {
  to: string;
  template: 'invitation';
  locale: 'ar' | 'en';
  data: { orgName: string; role: string; inviterEmail: string; token: string; expiresAt: string };
}

export abstract class Mailer {
  abstract send(m: MailMessage): Promise<void>;
}

export class DevLogMailer extends Mailer {
  async send(m: MailMessage): Promise<void> {
    // DEV ONLY: the token is printed so a developer can accept the invitation locally.
    process.stdout.write(JSON.stringify({ mail: m.template, to: m.to, data: m.data }) + '\n');
  }
}

export class UnconfiguredMailer extends Mailer {
  async send(): Promise<void> {
    throw new Error('mail provider not configured (D-08)');
  }
}
