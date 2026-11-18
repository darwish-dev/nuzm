import { MessageService, type MessageDto } from './message.service';

/**
 * `FormsNotificationPort` (M08 → M09): a published site's form submission can notify the owner by email through the SAME `POST /v1/email/messages` rules (verified sender,
 * suppression, guardrails, residency, idempotency). M09 passes `idempotencyKey = form submission id`, so a retried submission is one message. Marketing/bulk is refused here
 * exactly as it is on the HTTP endpoint.
 */
export interface FormNotification {
  senderId: string;
  to: string[];
  templateId?: string;
  subject?: string;
  html?: string;
  text?: string;
  variables?: Record<string, unknown>;
  idempotencyKey: string;
}
export abstract class FormsNotificationPort {
  abstract notify(orgId: string, actorUserId: string, n: FormNotification): Promise<MessageDto>;
}
export class MessageFormsNotification extends FormsNotificationPort {
  constructor(private readonly messages: MessageService) {
    super();
  }
  notify(orgId: string, actorUserId: string, n: FormNotification): Promise<MessageDto> {
    const { idempotencyKey, ...rest } = n;
    return this.messages.send(orgId, actorUserId, idempotencyKey, {
      ...rest,
      category: 'transactional',
    });
  }
}
