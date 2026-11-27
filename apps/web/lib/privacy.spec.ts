import { describe, expect, it } from 'vitest';
import {
  aiAllowed,
  aiPolicy,
  exportTone,
  formatCountries,
  parseCountries,
  requestBody,
  slaTone,
  statusTone,
  validSubject,
} from './privacy';

describe('residency countries', () => {
  it('parses "class=AE,BH; class=SA" and round-trips', () => {
    const m = parseCountries('personal=AE,BH; financial = SA');
    expect(m).toEqual({ personal: ['AE', 'BH'], financial: ['SA'] });
    expect(parseCountries(formatCountries(m!))).toEqual(m);
    expect(parseCountries('')).toEqual({});
  });
  it('refuses anything that is not a class and two-capital country codes', () => {
    for (const bad of [
      'personal',
      'personal=',
      'personal=ae',
      'personal=UAE',
      'Personal=AE',
      'personal=AE,,x',
      '=AE',
    ])
      expect(parseCountries(bad), bad).toBeNull();
    const many = Array.from(
      { length: 61 },
      (_, i) =>
        `${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`,
    );
    expect(new Set(many).size).toBe(61);
    expect(parseCountries(`personal=${many.join(',')}`)).toBeNull();
  });
  it('drops duplicates', () => {
    expect(parseCountries('personal=AE,AE,BH')).toEqual({ personal: ['AE', 'BH'] });
  });
});

describe('the body of a request', () => {
  const f = { type: 'access' as const, subject: '', attestation: '', text: '', displayName: '' };
  it('about oneself: only the type, details when given', () => {
    expect(requestBody(f).body).toEqual({ type: 'access' });
    expect(requestBody({ ...f, text: ' please ' }).body).toEqual({
      type: 'access',
      details: { text: 'please' },
    });
  });
  it('a correction carries the new display name as its patch', () => {
    expect(requestBody({ ...f, type: 'correction' }).error).toBe('patch');
    expect(requestBody({ ...f, type: 'correction', displayName: ' Dana ' }).body).toEqual({
      type: 'correction',
      details: { patch: { displayName: 'Dana' } },
    });
  });
  it('about someone else needs an opaque id and a written identity check', () => {
    expect(requestBody({ ...f, subject: 'a b' }).error).toBe('subject');
    expect(requestBody({ ...f, subject: 'enduser-9', attestation: 'short' }).error).toBe(
      'attestation',
    );
    expect(
      requestBody({
        ...f,
        subject: 'enduser-9',
        attestation: 'Checked the signed form and called back',
      }).body,
    ).toEqual({
      type: 'access',
      subjectRef: 'enduser-9',
      identityAttestation: 'Checked the signed form and called back',
    });
  });
  it('refuses details over the limit, and an email is not an opaque id', () => {
    expect(requestBody({ ...f, text: 'x'.repeat(2001) }).error).toBe('text');
    expect(validSubject('someone@example.com')).toBe(false);
    expect(validSubject('member:0192f1c0-7a52-7c3e-9d65-1f0e2a4b5c6d')).toBe(true);
  });
});

describe('tones', () => {
  it('flag late and refused things, never overstate', () => {
    expect(slaTone('overdue')).toBe('danger');
    expect(slaTone('escalated')).toBe('danger');
    expect(slaTone('warning')).toBe('warn');
    expect(slaTone('ok')).toBeUndefined();
    expect(statusTone('fulfilled')).toBe('success');
    expect(statusTone('rejected')).toBe('danger');
    expect(statusTone('partially_fulfilled')).toBe('warn');
    expect(exportTone('succeeded')).toBe('success');
    expect(exportTone('expired')).toBe('danger');
    expect(exportTone('pending')).toBe('warn');
  });
});

describe('AI features switch', () => {
  it('is on only when US is listed for customer content', () => {
    expect(aiAllowed('allow_listed', { 'customer-content': ['US'] })).toBe(true);
    expect(aiAllowed('allow_listed', { personal: ['US'] })).toBe(false);
    expect(aiAllowed('unrestricted_with_assessment', {})).toBe(false);
    expect(aiAllowed('in_kingdom_only', { 'customer-content': ['US'] })).toBe(false);
  });
  it('turning on lists US for customer content and keeps the other allowed countries', () => {
    expect(aiPolicy('in_kingdom_only', {}, true)).toEqual({
      mode: 'allow_listed',
      allowedCountriesByClass: { 'customer-content': ['US'] },
    });
    expect(aiPolicy('unrestricted_with_assessment', { personal: ['AE'] }, true)).toEqual({
      mode: 'allow_listed',
      allowedCountriesByClass: { 'customer-content': ['US'] },
    });
    expect(
      aiPolicy('allow_listed', { personal: ['AE'], 'customer-content': ['BH', 'US'] }, true),
    ).toEqual({
      mode: 'allow_listed',
      allowedCountriesByClass: { personal: ['AE'], 'customer-content': ['BH', 'US'] },
    });
  });
  it('turning off removes only US, and goes back to in-Kingdom when nothing is left', () => {
    expect(aiPolicy('allow_listed', { 'customer-content': ['US'] }, false)).toEqual({
      mode: 'in_kingdom_only',
      allowedCountriesByClass: {},
    });
    expect(
      aiPolicy('allow_listed', { personal: ['AE'], 'customer-content': ['BH', 'US'] }, false),
    ).toEqual({
      mode: 'allow_listed',
      allowedCountriesByClass: { personal: ['AE'], 'customer-content': ['BH'] },
    });
  });
});
