// Private to the health module (ADR-001): not importable from outside the module.
export function buildStatus(now: Date = new Date()) {
  return { status: 'ok' as const, service: 'nuzm-api', time: now.toISOString() };
}
