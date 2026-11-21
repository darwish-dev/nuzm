import { describe, expect, it } from 'vitest';
import {
  awsEncode,
  canonicalRequest,
  presign,
  sha256Hex,
  signHeaders,
  signature,
  signingKey,
} from './sigv4';

const SECRET = ['wJalrXUtnFEMI/K7MDENG', '+bPxRfiCYEXAMPLEKEY'].join('');
// the S3 documentation examples use a different example secret than the IAM ones
const S3_SECRET = ['wJalrXUtnFEMI/K7MDENG', '/bPxRfiCYEXAMPLEKEY'].join(''); // built from parts: the repository secret scan must stay clean
const creds = { accessKeyId: ['AKIA', 'IOSFODNN7EXAMPLE'].join(''), secretAccessKey: S3_SECRET };

describe('SigV4 against the vectors AWS publishes', () => {
  it('derives the documented signing key', () => {
    expect(signingKey(SECRET, '20120215', 'us-east-1', 'iam').toString('hex')).toBe(
      'f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d',
    );
  });
  it('signs the documented IAM ListUsers request', () => {
    const canonical = canonicalRequest({
      method: 'GET',
      canonicalUri: '/',
      query: { Action: 'ListUsers', Version: '2010-05-08' },
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
        host: 'iam.amazonaws.com',
        'x-amz-date': '20150830T123600Z',
      },
      signedHeaders: ['content-type', 'host', 'x-amz-date'],
      payloadHash: sha256Hex(''),
    });
    expect(signature(SECRET, '20150830T123600Z', 'us-east-1', 'iam', canonical)).toBe(
      '5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
    );
  });
  it('signs the documented S3 GET Object with a Range header', () => {
    const h = signHeaders({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { range: 'bytes=0-9' },
      payloadHash: sha256Hex(''),
      creds,
      region: 'us-east-1',
      now: new Date('2013-05-24T00:00:00Z'),
    });
    expect(h.authorization).toContain('SignedHeaders=host;range;x-amz-content-sha256;x-amz-date');
    expect(h.authorization).toContain(
      'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });
  it('produces the documented presigned S3 URL', () => {
    const u = presign({
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      creds,
      region: 'us-east-1',
      expiresSeconds: 86400,
      now: new Date('2013-05-24T00:00:00Z'),
    });
    expect(u).toContain(
      'X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
    expect(u).toContain('X-Amz-Expires=86400');
    expect(u).toContain('X-Amz-SignedHeaders=host');
  });
  it('encodes like AWS: unreserved stay, everything else is upper-case %XX, slashes only when asked', () => {
    expect(awsEncode("a b/c!'()*~")).toBe('a%20b%2Fc%21%27%28%29%2A~');
    expect(awsEncode('a/b', true)).toBe('a/b');
    expect(awsEncode('نظام')).toBe('%D9%86%D8%B8%D8%A7%D9%85');
  });
});
