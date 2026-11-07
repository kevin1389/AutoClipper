import http from 'node:http';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

interface StoredObject {
  data: Buffer;
  contentType: string;
  etag: string;
}

interface MultipartUpload {
  bucket: string;
  key: string;
  contentType: string;
  parts: Map<number, Buffer>;
}

export interface MockS3 {
  endpoint: string;
  buckets: string[];
  failPuts: boolean;
  /** Fails direct PUTs for specific buckets, to exercise provider failover. */
  failPutsFor: Set<string>;
  failDeletes: Set<string>;
  failBucketChecks: Set<string>;
  /** Fails LIST for specific buckets, to exercise a failed reconciliation. */
  failLists: Set<string>;
  failNextPart: boolean;
  lastAuthorization: string | null;
  signatureFailures: number;
  objectCount(bucket: string): number;
  multipartUploadCount(): number;
  objectData(bucket: string, key: string): Buffer | null;
  /** Direct PUT attempts, including rejected ones, for failover/retry counts. */
  putAttempts(bucket: string): number;
  /** LIST requests, to prove uploads and cached reads do not re-list. */
  listRequests(bucket: string): number;
  reset(): void;
  close(): Promise<void>;
}

export interface MockS3Options {
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
}

function md5(data: Buffer): string {
  return createHash('md5').update(data).digest('hex');
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeHeader(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value.join(',') : String(value ?? ''))
    .trim()
    .replace(/\s+/g, ' ');
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function sendError(res: http.ServerResponse, status: number, code: string, message: string): void {
  const body = `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${escapeXml(message)}</Message></Error>`;
  res.writeHead(status, { 'content-type': 'application/xml', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * Recompute the exact signature the client should have sent. This is an
 * independent implementation (not imported from src/lib/s3-client.ts), so a
 * client signing regression fails the mock's 403 rather than being mirrored.
 */
function verifySigV4(
  req: http.IncomingMessage,
  url: URL,
  requestBody: Buffer,
  options: Required<MockS3Options>,
  now = Date.now(),
): string | null {
  const authorization = req.headers.authorization;
  if (!authorization) return 'Missing Authorization header.';
  const match =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request,\s*SignedHeaders=([^,]+),\s*Signature=([0-9a-f]{64})$/.exec(
      authorization,
    );
  if (!match) return 'Malformed Authorization header.';
  const [, accessKeyId, credentialDate, region, signedHeaders, signature] = match;
  if (accessKeyId !== options.accessKeyId) return 'Unknown access key.';
  if (region !== options.region) return 'Credential region does not match.';

  const amzDate = normalizeHeader(req.headers['x-amz-date']);
  if (!/^\d{8}T\d{6}Z$/.test(amzDate)) return 'Missing or invalid x-amz-date.';
  if (amzDate.slice(0, 8) !== credentialDate) return 'Credential date does not match x-amz-date.';
  const timestamp = Date.parse(
    `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T` +
      `${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`,
  );
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > 15 * 60_000) {
    return 'Request time is outside the 15 minute window.';
  }

  const payloadHash = normalizeHeader(req.headers['x-amz-content-sha256']);
  if (!payloadHash) return 'Missing x-amz-content-sha256.';
  if (payloadHash !== 'UNSIGNED-PAYLOAD' && payloadHash !== sha256(requestBody)) {
    return 'Payload hash does not match the request body.';
  }

  const names = signedHeaders.split(';');
  const canonicalHeaders = names
    .map((name) => {
      const value = name === 'host' ? req.headers.host : req.headers[name];
      return `${name}:${normalizeHeader(value)}\n`;
    })
    .join('');
  const query = [...url.searchParams.entries()]
    .map(([name, value]) => `${rfc3986(name)}=${rfc3986(value)}`)
    .sort()
    .join('&');
  const canonicalRequest = [
    String(req.method ?? 'GET').toUpperCase(),
    url.pathname || '/',
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${credentialDate}/${options.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256(canonicalRequest),
  ].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${options.secretAccessKey}`, credentialDate), options.region), 's3'),
    'aws4_request',
  );
  const expected = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  const actual = Buffer.from(signature, 'hex');
  const wanted = Buffer.from(expected, 'hex');
  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
    ? null
    : 'The request signature we calculated does not match the signature you provided.';
}

/** Minimal S3-compatible test server that validates SigV4 and payload hashes. */
export async function createMockS3(input: MockS3Options = {}): Promise<MockS3> {
  const options: Required<MockS3Options> = {
    accessKeyId: input.accessKeyId ?? 'test-access',
    secretAccessKey: input.secretAccessKey ?? 'test-secret',
    region: input.region ?? 'test-region',
  };
  const buckets = ['test-b2', 'test-tigris', 'test-filebase'];
  const objects = new Map<string, Map<string, StoredObject>>();
  const uploads = new Map<string, MultipartUpload>();
  for (const bucket of buckets) objects.set(bucket, new Map());

  const state = {
    failPuts: false,
    failPutsFor: new Set<string>(),
    putAttempts: new Map<string, number>(),
    listRequests: new Map<string, number>(),
    failDeletes: new Set<string>(),
    failBucketChecks: new Set<string>(),
    failLists: new Set<string>(),
    failNextPart: false,
    lastAuthorization: null as string | null,
    signatureFailures: 0,
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const pathParts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    const bucket = pathParts[0] ?? '';
    const key = pathParts.slice(1).join('/');
    const bucketObjects = objects.get(bucket);
    const requestBody = await readBody(req);
    state.lastAuthorization = req.headers.authorization ?? null;

    const signatureError = verifySigV4(req, url, requestBody, options);
    if (signatureError) {
      state.signatureFailures += 1;
      sendError(res, 403, 'SignatureDoesNotMatch', signatureError);
      return;
    }

    if (!bucketObjects) {
      sendError(res, 404, 'NoSuchBucket', 'The test bucket does not exist.');
      return;
    }

    const failBucket = () => {
      if (state.failBucketChecks.has(bucket)) {
        sendError(res, 503, 'ServiceUnavailable', 'The test bucket is temporarily unavailable.');
        return true;
      }
      return false;
    };

    if (req.method === 'HEAD' && !key) {
      if (failBucket()) return;
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.method === 'GET' && !key && url.searchParams.get('list-type') === '2') {
      if (failBucket()) return;
      state.listRequests.set(bucket, (state.listRequests.get(bucket) ?? 0) + 1);
      if (state.failLists.has(bucket)) {
        sendError(res, 500, 'InternalError', 'Simulated list failure.');
        return;
      }
      const prefix = url.searchParams.get('prefix') ?? '';
      const entries = [...bucketObjects.entries()].filter(([name]) => name.startsWith(prefix));
      const contents = entries
        .map(
          ([name, object]) =>
            `<Contents><Key>${escapeXml(name)}</Key><Size>${object.data.length}</Size><ETag>"${object.etag}"</ETag></Contents>`,
        )
        .join('');
      const body =
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>` +
        `<Name>${escapeXml(bucket)}</Name><Prefix>${escapeXml(prefix)}</Prefix>` +
        `<IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`;
      res.writeHead(200, { 'content-type': 'application/xml', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }

    if (req.method === 'POST' && key && url.searchParams.has('uploads')) {
      if (failBucket()) return;
      const uploadId = randomUUID();
      uploads.set(uploadId, {
        bucket,
        key,
        contentType: normalizeHeader(req.headers['content-type']) || 'application/octet-stream',
        parts: new Map(),
      });
      const body = `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`;
      res.writeHead(200, { 'content-type': 'application/xml', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }

    if (req.method === 'PUT' && key && url.searchParams.has('partNumber')) {
      if (failBucket()) return;
      const uploadId = url.searchParams.get('uploadId') ?? '';
      const upload = uploads.get(uploadId);
      const partNumber = Number(url.searchParams.get('partNumber'));
      if (!upload || upload.bucket !== bucket || upload.key !== key || !Number.isInteger(partNumber)) {
        sendError(res, 404, 'NoSuchUpload', 'The multipart upload does not exist.');
        return;
      }
      if (state.failNextPart) {
        state.failNextPart = false;
        sendError(res, 500, 'InternalError', 'Simulated multipart part failure.');
        return;
      }
      upload.parts.set(partNumber, requestBody);
      res.writeHead(200, { etag: `"${md5(requestBody)}"` });
      res.end();
      return;
    }

    if (req.method === 'POST' && key && url.searchParams.has('uploadId')) {
      if (failBucket()) return;
      const uploadId = url.searchParams.get('uploadId') ?? '';
      const upload = uploads.get(uploadId);
      if (!upload || upload.bucket !== bucket || upload.key !== key) {
        sendError(res, 404, 'NoSuchUpload', 'The multipart upload does not exist.');
        return;
      }
      const xml = requestBody.toString('utf8');
      const partNumbers = [...xml.matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((match) =>
        Number(match[1]),
      );
      const parts = partNumbers.map((part) => upload.parts.get(part));
      if (partNumbers.length === 0 || parts.some((part) => !part)) {
        sendError(res, 400, 'InvalidPart', 'One or more multipart parts are missing.');
        return;
      }
      const data = Buffer.concat(parts as Buffer[]);
      bucketObjects.set(key, { data, contentType: upload.contentType, etag: md5(data) });
      uploads.delete(uploadId);
      const body =
        `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult>` +
        `<Key>${escapeXml(key)}</Key><ETag>"${md5(data)}"</ETag></CompleteMultipartUploadResult>`;
      res.writeHead(200, { 'content-type': 'application/xml', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }

    if (req.method === 'DELETE' && key && url.searchParams.has('uploadId')) {
      const uploadId = url.searchParams.get('uploadId') ?? '';
      uploads.delete(uploadId);
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'PUT' && key) {
      if (failBucket()) return;
      state.putAttempts.set(bucket, (state.putAttempts.get(bucket) ?? 0) + 1);
      if (state.failPuts || state.failPutsFor.has(bucket)) {
        sendError(res, 500, 'InternalError', 'Simulated upload failure.');
        return;
      }
      const etag = md5(requestBody);
      bucketObjects.set(key, {
        data: requestBody,
        contentType: normalizeHeader(req.headers['content-type']) || 'application/octet-stream',
        etag,
      });
      res.writeHead(200, { etag: `"${etag}"` });
      res.end();
      return;
    }

    const existing = key ? bucketObjects.get(key) : undefined;
    if (req.method === 'HEAD' && key) {
      if (failBucket()) return;
      if (!existing) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        'content-length': String(existing.data.length),
        etag: `"${existing.etag}"`,
        'content-type': existing.contentType,
      });
      res.end();
      return;
    }

    if (req.method === 'GET' && key) {
      if (failBucket()) return;
      if (!existing) {
        sendError(res, 404, 'NoSuchKey', 'The object does not exist.');
        return;
      }
      const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''));
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), existing.data.length - 1) : existing.data.length - 1;
        const body = existing.data.subarray(start, end + 1);
        res.writeHead(206, {
          'content-type': existing.contentType,
          'content-length': String(body.length),
          'content-range': `bytes ${start}-${end}/${existing.data.length}`,
          etag: `"${existing.etag}"`,
        });
        res.end(body);
        return;
      }
      res.writeHead(200, {
        'content-type': existing.contentType,
        'content-length': String(existing.data.length),
        etag: `"${existing.etag}"`,
      });
      res.end(existing.data);
      return;
    }

    if (req.method === 'DELETE' && key) {
      if (state.failDeletes.has(bucket)) {
        sendError(res, 500, 'InternalError', 'Simulated deletion failure.');
        return;
      }
      bucketObjects.delete(key);
      res.writeHead(204);
      res.end();
      return;
    }

    sendError(res, 405, 'MethodNotAllowed', 'That operation is not implemented by the mock.');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not bind the mock S3 server.');
  const endpoint = `http://127.0.0.1:${address.port}`;

  return {
    endpoint,
    buckets,
    get failPuts() {
      return state.failPuts;
    },
    set failPuts(value: boolean) {
      state.failPuts = value;
    },
    failPutsFor: state.failPutsFor,
    failDeletes: state.failDeletes,
    failBucketChecks: state.failBucketChecks,
    failLists: state.failLists,
    get failNextPart() {
      return state.failNextPart;
    },
    set failNextPart(value: boolean) {
      state.failNextPart = value;
    },
    get lastAuthorization() {
      return state.lastAuthorization;
    },
    get signatureFailures() {
      return state.signatureFailures;
    },
    objectCount(bucket: string) {
      return objects.get(bucket)?.size ?? 0;
    },
    multipartUploadCount() {
      return uploads.size;
    },
    objectData(bucket: string, key: string) {
      return objects.get(bucket)?.get(key)?.data ?? null;
    },
    putAttempts(bucket: string) {
      return state.putAttempts.get(bucket) ?? 0;
    },
    listRequests(bucket: string) {
      return state.listRequests.get(bucket) ?? 0;
    },
    reset() {
      for (const bucketObjects of objects.values()) bucketObjects.clear();
      uploads.clear();
      state.failPuts = false;
      state.failPutsFor.clear();
      state.putAttempts.clear();
      state.listRequests.clear();
      state.failDeletes.clear();
      state.failBucketChecks.clear();
      state.failLists.clear();
      state.failNextPart = false;
      state.lastAuthorization = null;
      state.signatureFailures = 0;
    },
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
