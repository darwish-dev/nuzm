import type { Notifier } from './types.ts';

/** Default notifier: records messages in memory (tests) and logs a line without the address (no personal data in logs). Production wires an email adapter. */
export class MemoryNotifier implements Notifier {
  sent: { to: string; template: string; data: Record<string, unknown> }[] = [];
  async send(msg: { to: string; template: string; data: Record<string, unknown> }): Promise<void> {
    this.sent.push(msg);
  }
}
export class LogNotifier implements Notifier {
  async send(msg: { to: string; template: string; data: Record<string, unknown> }): Promise<void> {
    console.log(JSON.stringify({ notify: msg.template, at: new Date().toISOString() }));
  }
}
/**
 * Sends through a transactional-email HTTP API. The URL and the bearer token come from the environment (NOTIFY_URL, NOTIFY_TOKEN); the token is never logged.
 * The endpoint receives {to, template, data}. Nothing is sent when NOTIFY_URL is unset.
 */
export class HttpNotifier implements Notifier {
  private url: string;
  private token: string;
  constructor(url: string, token: string) {
    this.url = url;
    this.token = token;
  }
  async send(msg: { to: string; template: string; data: Record<string, unknown> }): Promise<void> {
    const r = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.token },
      body: JSON.stringify(msg),
    });
    if (!r.ok) throw new Error('notification failed with status ' + r.status);
  }
}
