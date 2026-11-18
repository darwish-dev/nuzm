-- DEV ONLY. Production is forward-fix: email records (domains, messages, events, suppressions) are customer data and evidence and are never dropped.
DROP TABLE IF EXISTS email.suppressions, email.email_events, email.messages, email.templates, email.sender_identities, email.aliases, email.mailboxes, email.email_domains CASCADE;
DROP FUNCTION IF EXISTS email.message_guard(), email.template_immutable(), email.mailbox_guard(), email.domain_guard();
DELETE FROM tenancy.role_permissions WHERE permission IN ('email:read','email:domain:manage','email:mailbox:manage','email:send','email:template:write');
DELETE FROM tenancy.permissions WHERE name IN ('email:read','email:domain:manage','email:mailbox:manage','email:send','email:template:write');
