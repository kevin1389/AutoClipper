import { createHash, createHmac } from 'node:crypto';

/**
 * Small S3-compatible client for the three free-tier providers.
 *
 * It intentionally uses only Put/Get/Head/List/Delete and multipart uploads.
 * Provider-specific extensions (tags, ACLs, notifications, IAM) are avoided so
 * the same implementation works on B2, Tigris and Filebase.
 *
 * Buffered bodies (multipart parts, XML requests and small uploads) are signed
 * with their real SHA-256. A streaming PUT is signed as UNSIGNED-PAYLOAD over
 * TLS because hashing it would require buffering the whole video; every
 * completed object is still HEAD-verified.
 */

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | null;
  forcePathStyle?: boolean;
}

export interface S3Object {
  body: ReadableStream<Uint8Array>;
  size: number;
  etag: string | null;
  contentType: string | null;
}

export interface S3ListedObject {
  key: string;
  size: number;
}

export interface S3ListResult {
  objects: S3ListedObject[];
  truncated: boolean;
  nextToken: string | null;
}

export interface S3Part {
  partNumber: number;
  etag: string;
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

export interface S3SignOptions {
  /** Deterministic clock for AWS test vectors and expiry tests. */
  now?: Date;
  /** Defaults to the empty-body hash. Never accepted from a caller for a body. */
  payloadHash?: string;
}

export const S3_EMPTY_PAYLOAD_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export class S3Error extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly requestId: string | null;

  constructor(message: string, status: number, code: string | null = null, requestId: string | null = null) {
    super(message);
    this.name = 'S3Error';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

const MAX_LIST_PAGES = 10_000;

function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodeKey(key: string): string {
  return key
    .split('/')
    .map((segment) => rfc3986(segment))
    .join('/');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function amzDate(date: Date): { long: string; short: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { long: iso, short: iso.slice(0, 8) };
}

function normalizeHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function objectUrl(config: S3Config, key: string | null, query: [string, string][]): URL {
  const endpoint = new URL(config.endpoint);
  const basePath = endpoint.pathname.replace(/\/+$/, '');
  let host = endpoint.host;
  let pathname = basePath;

  if (config.forcePathStyle === false) {
    host = `${config.bucket}.${endpoint.host}`;
    pathname += key === null ? '/' : `/${encodeKey(key)}`;
  } else {
    pathname += `/${rfc3986(config.bucket)}`;
    if (key !== null) pathname += `/${encodeKey(key)}`;
  }

  const url = new URL(endpoint.toString());
  url.host = host;
  url.pathname = pathname || '/';
  url.search = query
    .map(([name, value]) => [rfc3986(name), rfc3986(value)] as const)
    .sort(([aName, aValue], [bName, bValue]) => {
      if (aName !== bName) return aName < bName ? -1 : 1;
      if (aValue !== bValue) return aValue < bValue ? -1 : 1;
      return 0;
    })
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  return url;
}

/**
 * Exported so the AWS documentation test vector can be asserted without
 * making a network request. The returned URL/headers can be used by any fetch
 * client; `canonicalRequest` is useful when diagnosing a provider rejection.
 */
export function signS3Request(
  config: S3Config,
  method: string,
  key: string | null,
  query: [string, string][] = [],
  extraHeaders: Record<string, string> = {},
  options: S3SignOptions = {},
): SignedRequest {
  const url = objectUrl(config, key, query);
  const { long, short } = amzDate(options.now ?? new Date());
  const payloadHash = options.payloadHash ?? S3_EMPTY_PAYLOAD_SHA256;
  const headers: Record<string, string> = {
    ...extraHeaders,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': long,
  };
  if (config.sessionToken) headers['x-amz-security-token'] = config.sessionToken;

  // URL.host includes the port and is the Host header a standard fetch uses.
  // A caller must not override it with a different Host header.
  headers.host = url.host;

  const canonicalHeaderMap = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'authorization') continue;
    canonicalHeaderMap.set(name.toLowerCase(), normalizeHeaderValue(value));
  }
  const signedHeaderNames = [...canonicalHeaderMap.keys()].sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${canonicalHeaderMap.get(name) ?? ''}\n`)
    .join('');
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalRequest = [
    method.toUpperCase(),
    url.pathname || '/',
    url.search.startsWith('?') ? url.search.slice(1) : '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${short}/${config.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', long, scope, sha256(canonicalRequest)].join('\n');
  const dateKey = hmac(`AWS4${config.secretAccessKey}`, short);
  const regionKey = hmac(dateKey, config.region);
  const serviceKey = hmac(regionKey, 's3');
  const signingKey = hmac(serviceKey, 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope},` +
    `SignedHeaders=${signedHeaders},Signature=${signature}`;

  // The platform sets Host from the URL. Keep it in the signature, but do not
  // send a forbidden custom Host header from a Worker/browser fetch.
  const outgoing = { ...headers };
  delete outgoing.host;
  return {
    url: url.toString(),
    headers: outgoing,
    canonicalRequest,
    stringToSign,
    signature,
  };
}

function payloadHashForSyncBody(body: BodyInit | null | undefined): string {
  if (body === null || body === undefined) return S3_EMPTY_PAYLOAD_SHA256;
  if (typeof body === 'string') return sha256(body);
  if (body instanceof ArrayBuffer) {
    return createHash('sha256').update(new Uint8Array(body)).digest('hex');
  }
  if (ArrayBuffer.isView(body)) {
    return createHash('sha256')
      .update(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
      .digest('hex');
  }
  return 'UNSIGNED-PAYLOAD';
}

function errorText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function xmlValue(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return match ? decodeXml(match[1]) : null;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

async function responseError(response: Response, operation: string): Promise<S3Error> {
  const text = await response.text().catch(() => '');
  const code = xmlValue(text, 'Code');
  const message = xmlValue(text, 'Message') ?? errorText(text);
  return new S3Error(
    message ? `${operation} failed (${response.status}): ${message}` : `${operation} failed (HTTP ${response.status}).`,
    response.status,
    code,
    response.headers.get('x-amz-request-id'),
  );
}

async function request(
  config: S3Config,
  method: string,
  key: string | null,
  query: [string, string][] = [],
  options: {
    body?: BodyInit | null;
    contentType?: string;
    contentLength?: number | null;
    /** Immutable cache metadata for public browser assets. */
    cacheControl?: string;
    range?: { offset: number; length: number };
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.contentType) headers['content-type'] = options.contentType;
  if (options.cacheControl) headers['cache-control'] = options.cacheControl;
  if (options.contentLength !== null && options.contentLength !== undefined) {
    headers['content-length'] = String(options.contentLength);
  }
  if (options.range) {
    headers.range = `bytes=${options.range.offset}-${options.range.offset + options.range.length - 1}`;
  }
  const signed = signS3Request(config, method, key, query, headers, {
    payloadHash: payloadHashForSyncBody(options.body),
  });
  const controller = new AbortController();
  const timeoutMs = Math.max(5_000, Number(process.env.AC_S3_TIMEOUT_MS) || 45_000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(signed.url, {
      method,
      headers: signed.headers,
      body: options.body ?? null,
      signal: controller.signal,
      redirect: 'follow',
      ...(options.body instanceof ReadableStream ? { duplex: 'half' } : {}),
    } as RequestInit & { duplex?: 'half' });
  } finally {
    clearTimeout(timer);
  }
}

export async function s3HeadBucket(config: S3Config): Promise<void> {
  const response = await request(config, 'HEAD', null);
  if (!response.ok) throw await responseError(response, 'Bucket check');
}

export async function s3ListObjects(config: S3Config, prefix: string): Promise<S3ListResult> {
  const objects: S3ListedObject[] = [];
  let token: string | null = null;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const query: [string, string][] = [
      ['list-type', '2'],
      ['prefix', prefix],
      ['max-keys', '1000'],
    ];
    if (token) query.push(['continuation-token', token]);
    const response = await request(config, 'GET', null, query);
    if (!response.ok) throw await responseError(response, 'Object listing');
    const xml = await response.text();
    const contents = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/gi)];
    for (const match of contents) {
      const key = xmlValue(match[1], 'Key');
      if (!key) continue;
      objects.push({ key, size: Number(xmlValue(match[1], 'Size') ?? 0) || 0 });
    }
    const truncated = (xmlValue(xml, 'IsTruncated') ?? '').toLowerCase() === 'true';
    token = xmlValue(xml, 'NextContinuationToken');
    if (!truncated) return { objects, truncated: false, nextToken: null };
    if (!token) throw new S3Error('Object listing was truncated without a continuation token.', 502);
  }
  throw new S3Error('Object listing exceeded the safe page limit.', 502);
}

export async function s3HeadObject(
  config: S3Config,
  key: string,
): Promise<{ size: number; etag: string | null; contentType: string | null } | null> {
  const response = await request(config, 'HEAD', key);
  if (response.status === 404) return null;
  if (!response.ok) {
    const error = await responseError(response, 'Object check');
    if (response.status === 403) {
      throw new S3Error(
        `${error.message} The provider denied the HEAD request; check its read/download cap and key permissions.`,
        error.status,
        error.code,
        error.requestId,
      );
    }
    throw error;
  }
  return {
    size: Number(response.headers.get('content-length') ?? 0) || 0,
    etag: response.headers.get('etag')?.replace(/^"|"$/g, '') ?? null,
    contentType: response.headers.get('content-type'),
  };
}

export async function s3GetObject(
  config: S3Config,
  key: string,
  range?: { offset: number; length: number },
): Promise<S3Object | null> {
  const response = await request(config, 'GET', key, [], { range });
  if (response.status === 404) return null;
  if (!response.ok) throw await responseError(response, 'Object download');
  if (!response.body) throw new S3Error('Object download returned no body.', 502);
  const contentRange = response.headers.get('content-range');
  const total = contentRange ? Number(contentRange.split('/')[1]) : Number(response.headers.get('content-length') ?? 0);
  return {
    body: response.body,
    size: Number.isFinite(total) && total > 0 ? total : 0,
    etag: response.headers.get('etag')?.replace(/^"|"$/g, '') ?? null,
    contentType: response.headers.get('content-type'),
  };
}

export async function s3PutObject(
  config: S3Config,
  key: string,
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  contentType: string,
  expectedBytes: number | null,
  cacheControl?: string,
): Promise<{ bytes: number; etag: string | null }> {
  if (expectedBytes !== null && expectedBytes > maxBytes) throw new Error('UPLOAD_TOO_LARGE');

  let received = 0;
  let uploadBody: BodyInit;
  let contentLength: number | null = expectedBytes;

  if (expectedBytes !== null) {
    const counted = body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          received += chunk.byteLength;
          if (received > maxBytes) {
            controller.error(new Error('UPLOAD_TOO_LARGE'));
            return;
          }
          controller.enqueue(chunk);
        },
      }),
    );
    uploadBody = counted;
  } else {
    const buffered = await new Response(body).arrayBuffer();
    received = buffered.byteLength;
    if (received > maxBytes) throw new Error('UPLOAD_TOO_LARGE');
    uploadBody = buffered;
    contentLength = received;
  }

  const response = await request(config, 'PUT', key, [], {
    body: uploadBody,
    contentType,
    contentLength,
    cacheControl,
  });
  if (!response.ok) throw await responseError(response, 'Object upload');
  if (expectedBytes !== null && received !== expectedBytes) {
    throw new Error(`Upload length mismatch: expected ${expectedBytes} bytes, received ${received}.`);
  }
  return {
    bytes: expectedBytes ?? received,
    etag: response.headers.get('etag')?.replace(/^"|"$/g, '') ?? null,
  };
}

export async function s3DeleteObject(config: S3Config, key: string): Promise<void> {
  const response = await request(config, 'DELETE', key);
  if (response.status === 404) return;
  if (!response.ok) throw await responseError(response, 'Object deletion');
}

export async function s3CreateMultipart(
  config: S3Config,
  key: string,
  contentType: string,
): Promise<string> {
  const response = await request(config, 'POST', key, [['uploads', '']], { contentType });
  if (!response.ok) throw await responseError(response, 'Multipart start');
  const xml = await response.text();
  const uploadId = xmlValue(xml, 'UploadId');
  if (!uploadId) throw new S3Error('Multipart start returned no upload id.', 502);
  return uploadId;
}

export async function s3UploadPart(
  config: S3Config,
  key: string,
  uploadId: string,
  partNumber: number,
  body: ArrayBuffer,
): Promise<S3Part> {
  const response = await request(
    config,
    'PUT',
    key,
    [
      ['partNumber', String(partNumber)],
      ['uploadId', uploadId],
    ],
    {
      body,
      contentLength: body.byteLength,
      contentType: 'application/octet-stream',
    },
  );
  if (!response.ok) throw await responseError(response, `Upload part ${partNumber}`);
  const etag = response.headers.get('etag')?.replace(/^"|"$/g, '') ?? null;
  if (!etag) throw new S3Error(`Upload part ${partNumber} returned no ETag.`, 502);
  return { partNumber, etag };
}

export async function s3CompleteMultipart(
  config: S3Config,
  key: string,
  uploadId: string,
  parts: S3Part[],
): Promise<void> {
  const body = `<?xml version="1.0" encoding="UTF-8"?>` +
    `<CompleteMultipartUpload>` +
    parts
      .map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>"${part.etag.replace(/"/g, '')}"</ETag></Part>`)
      .join('') +
    `</CompleteMultipartUpload>`;
  const response = await request(config, 'POST', key, [['uploadId', uploadId]], {
    body,
    contentType: 'application/xml',
    contentLength: Buffer.byteLength(body, 'utf8'),
  });
  if (!response.ok) throw await responseError(response, 'Multipart completion');
}

export async function s3AbortMultipart(config: S3Config, key: string, uploadId: string): Promise<void> {
  const response = await request(config, 'DELETE', key, [['uploadId', uploadId]]);
  if (response.status === 404) return;
  if (!response.ok) throw await responseError(response, 'Multipart abort');
}
