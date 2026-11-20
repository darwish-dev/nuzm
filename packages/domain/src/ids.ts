/** A UUID in canonical text form (any version; ids are UUIDv7 by convention). The one definition every module uses. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a canonical UUID string; false for anything else (including non-strings), so it is safe on untrusted input. */
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
