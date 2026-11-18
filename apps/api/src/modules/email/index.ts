// Public surface of the email module (M08).
export { EmailModule, DnsResolvers } from './email.module';
export { EmailDomainService } from './internal/domain.service';
export { MailboxService } from './internal/mailbox.service';
export { MessageService, loadEmailConfig } from './internal/message.service';
export type { EmailConfig, MessageDto } from './internal/message.service';
export { SenderTemplateService } from './internal/sender-template.service';
export { SuppressionService, addressHash } from './internal/suppression.service';
export { DnsLinkagePort, NoDnsLinkage, MemoryDnsLinkage } from './internal/dns-linkage.port';
export { FakeDnsResolver } from './internal/dns';
export type { DnsResolverPort } from './internal/dns';
export {
  FormsNotificationPort,
  MessageFormsNotification,
} from './internal/forms-notification.port';
