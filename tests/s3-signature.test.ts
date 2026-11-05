import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createMockS3, type MockS3 } from './support/mock-s3';
import { S3Error, signS3Request, s3HeadBucket, type S3Config } from '../src/lib/s3-client';

const vectorConfig: S3Config = {
  // The client adds the bucket when forcePathStyle is false.
  endpoint: 'https://s3.amazonaws.com',
  region: 'us-east-1',
  bucket: 'examplebucket',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  forcePathStyle: false,
};

test('matches the official AWS SigV4 GET Object signature vector', () => {
  const signed = signS3Request(
    vectorConfig,
    'GET',
    'test.txt',
    [],
    { range: 'bytes=0-9' },
    { now: new Date('2013-05-24T00:00:00Z') },
  );
  assert.equal(signed.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  assert.match(
    signed.canonicalRequest,
    /^GET\n\/test\.txt\n\nhost:examplebucket\.s3\.amazonaws\.com\nrange:bytes=0-9\n/,
  );
  assert.match(signed.headers.authorization ?? '', /Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request/);
  assert.match(signed.headers.authorization ?? '', /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date/);
});

test('uses path-style URLs and hashes a non-streaming payload', () => {
  const signed = signS3Request(
    { ...vectorConfig, endpoint: 'https://s3.us-east-1.amazonaws.com', forcePathStyle: true },
    'PUT',
    'folder/test file.txt',
    [['x-id', 'PutObject']],
    { 'content-type': 'text/plain' },
    { now: new Date('2013-05-24T00:00:00Z'), payloadHash: '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072' },
  );
  assert.equal(new URL(signed.url).pathname, '/examplebucket/folder/test%20file.txt');
  assert.match(signed.canonicalRequest, /x-id=PutObject/);
  assert.match(signed.canonicalRequest, /44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072$/);
});

test('Mock S3 rejects a wrong secret and accepts valid signed requests', async () => {
  let mock: MockS3 | null = null;
  try {
    mock = await createMockS3();
    const good: S3Config = {
      endpoint: mock.endpoint,
      region: 'test-region',
      bucket: 'test-b2',
      accessKeyId: 'test-access',
      secretAccessKey: 'test-secret',
      forcePathStyle: true,
    };
    await s3HeadBucket(good);
    await assert.rejects(
      () => s3HeadBucket({ ...good, secretAccessKey: 'not-the-secret' }),
      (error: unknown) => error instanceof S3Error && error.status === 403,
    );
    assert.equal(mock.signatureFailures, 1);

    // A valid signature over a different body must not authenticate a tampered
    // request. The mock recomputes the payload hash itself.
    const body = Buffer.from('hello signed world');
    const signed = signS3Request(
      good,
      'PUT',
      'tamper.txt',
      [],
      { 'content-type': 'text/plain', 'content-length': String(body.byteLength) },
      { payloadHash: createHash('sha256').update(body).digest('hex') },
    );
    const tampered = await fetch(signed.url, {
      method: 'PUT',
      headers: signed.headers,
      body: Buffer.from('tampered body here'),
    });
    assert.equal(tampered.status, 403);

    const expired = signS3Request(
      good,
      'HEAD',
      null,
      [],
      {},
      { now: new Date(Date.now() - 20 * 60_000) },
    );
    const expiredResponse = await fetch(expired.url, { method: 'HEAD', headers: expired.headers });
    assert.equal(expiredResponse.status, 403);
    assert.equal(mock.signatureFailures, 3);
  } finally {
    await mock?.close();
  }
});
