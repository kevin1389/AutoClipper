import { browserAssetSpec, normalizeBrowserAssetBase } from '@/lib/browser-assets';
import type { R2Bucket } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Same-origin browser-asset host.
 *
 * Production uses this only when BROWSER_ASSET_BASE_URL is not set (or is set
 * to this route). It reads the R2 FILES binding. A public bucket/CDN configured
 * through BROWSER_ASSET_BASE_URL bypasses the Worker entirely.
 *
 * Local `next dev`/`next start` reads `browser-assets/` from disk, so the same
 * loader works without R2 credentials or an internet connection.
 */

const CACHE_CONTROL = 'public, max-age=86400, stale-while-revalidate=604800';
const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'accept-ranges, content-length, content-range, etag',
  'cross-origin-resource-policy': 'cross-origin',
  'x-content-type-options': 'nosniff',
};

interface AssetLocation {
  bucket: R2Bucket | null;
  onCloudflare: boolean;
}

function failure(status: number, code: string, message: string): Response {
  return Response.json(
    { error: message, code },
    { status, headers: { ...CORS_HEADERS, 'cache-control': 'no-store' } },
  );
}

function decodePath(segments: string[]): string | null {
  if (!Array.isArray(segments) || segments.length === 0) return null;
  const parts: string[] = [];
  for (const segment of segments) {
    let value: string;
    try {
      value = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
      return null;
    }
    parts.push(value);
  }
  return parts.join('/');
}

async function resolveLocation(): Promise<AssetLocation> {
  try {
    const { getCloudflareContext } = await import('@opennextjs/cloudflare');
    const env = getCloudflareContext().env as { FILES?: R2Bucket };
    return { bucket: env.FILES ?? null, onCloudflare: true };
  } catch {
    // No OpenNext/Cloudflare context: local Node development.
    return { bucket: null, onCloudflare: false };
  }
}

function parseRange(header: string, size: number): { offset: number; length: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;
  if (!rawStart) {
    const suffix = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    const start = Math.max(0, size - suffix);
    return { offset: start, length: size - start };
  }
  const start = Number.parseInt(rawStart, 10);
  const end = rawEnd ? Number.parseInt(rawEnd, 10) : size - 1;
  if (!Number.isFinite(start) || start >= size || end < start) return null;
  const boundedEnd = Math.min(end, size - 1);
  return { offset: start, length: boundedEnd - start + 1 };
}

function etagFor(size: number, mtimeMs?: number): string {
  return mtimeMs
    ? `W/"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`
    : `W/"${size.toString(16)}"`;
}

function notModified(request: Request, etag: string): boolean {
  const header = request.headers.get('if-none-match');
  if (!header) return false;
  return header.split(',').some((value) => value.trim() === etag || value.trim() === '*');
}

function assetHeaders(
  contentType: string,
  size: number,
  etag: string,
  range: { offset: number; length: number } | null,
): Headers {
  const headers = new Headers({
    ...CORS_HEADERS,
    'content-type': contentType,
    'content-length': String(range?.length ?? size),
    'cache-control': CACHE_CONTROL,
    'accept-ranges': 'bytes',
    etag,
    'content-disposition': 'inline',
  });
  if (range) {
    headers.set('content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`);
  }
  return headers;
}

async function diskStat(key: string): Promise<{ size: number; mtimeMs: number; file: string } | null> {
  try {
    const [fs, path] = await Promise.all([import('node:fs/promises'), import('node:path')]);
    const file = path.join(process.cwd(), 'browser-assets', key);
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size === 0) return null;
    return { size: stat.size, mtimeMs: stat.mtimeMs, file };
  } catch {
    return null;
  }
}

async function serve(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
  headOnly: boolean,
): Promise<Response> {
  const { path: segments } = await context.params;
  const rel = decodePath(segments);
  const spec = rel ? browserAssetSpec(rel) : null;
  if (!spec) {
    return failure(404, 'browser_asset_not_found', 'That browser asset does not exist.');
  }

  let base: string;
  try {
    base = normalizeBrowserAssetBase(process.env.BROWSER_ASSET_BASE_URL);
  } catch {
    return failure(
      503,
      'browser_asset_config_invalid',
      'BROWSER_ASSET_BASE_URL is not a valid asset base. Fix the deployment configuration.',
    );
  }

  // A configured external base means the browser should have loaded directly
  // from it. Redirect older/stale clients rather than proxying 200 MB.
  if (/^https?:/i.test(base)) {
    return new Response(null, {
      status: 307,
      headers: { ...CORS_HEADERS, location: `${base}${rel}`, 'cache-control': 'no-store' },
    });
  }

  const { bucket, onCloudflare } = await resolveLocation();
  const key = `browser-assets/${rel}`;

  if (bucket) {
    const head = await bucket.head(key);
    if (!head || head.size === 0) {
      return failure(
        404,
        'browser_asset_missing',
        `The browser asset ${spec.path} has not been uploaded to this deployment's R2 bucket.`,
      );
    }
    const rangeHeader = request.headers.get('range');
    const range = rangeHeader ? parseRange(rangeHeader, head.size) : null;
    if (rangeHeader && !range) {
      return new Response(null, {
        status: 416,
        headers: { ...CORS_HEADERS, 'content-range': `bytes */${head.size}` },
      });
    }
    const etag = etagFor(head.size);
    if (notModified(request, etag)) {
      return new Response(null, { status: 304, headers: assetHeaders(spec.contentType, head.size, etag, null) });
    }
    if (headOnly) {
      return new Response(null, { status: 200, headers: assetHeaders(spec.contentType, head.size, etag, null) });
    }
    const object = await bucket.get(key, range ? { range } : undefined);
    if (!object) {
      return failure(404, 'browser_asset_missing', `The browser asset ${spec.path} disappeared during the read.`);
    }
    return new Response(object.body, {
      status: range ? 206 : 200,
      headers: assetHeaders(spec.contentType, head.size, etag, range),
    });
  }

  if (onCloudflare) {
    return failure(
      503,
      'browser_asset_storage_unavailable',
      'The R2 FILES binding is not attached, so browser assets cannot be read. Set BROWSER_ASSET_BASE_URL or attach FILES.',
    );
  }

  const disk = await diskStat(key);
  if (!disk) {
    return failure(
      404,
      'browser_asset_missing',
      `The browser asset ${spec.path} is missing from browser-assets/. Run npm run prepare:browser and restart.`,
    );
  }
  const rangeHeader = request.headers.get('range');
  const range = rangeHeader ? parseRange(rangeHeader, disk.size) : null;
  if (rangeHeader && !range) {
    return new Response(null, {
      status: 416,
      headers: { ...CORS_HEADERS, 'content-range': `bytes */${disk.size}` },
    });
  }
  const etag = etagFor(disk.size, disk.mtimeMs);
  if (notModified(request, etag)) {
    return new Response(null, { status: 304, headers: assetHeaders(spec.contentType, disk.size, etag, null) });
  }
  if (headOnly) {
    return new Response(null, { status: 200, headers: assetHeaders(spec.contentType, disk.size, etag, null) });
  }

  const [fs, stream] = await Promise.all([import('node:fs'), import('node:stream')]);
  const read = range
    ? fs.createReadStream(disk.file, { start: range.offset, end: range.offset + range.length - 1 })
    : fs.createReadStream(disk.file);
  return new Response(stream.Readable.toWeb(read) as ReadableStream<Uint8Array>, {
    status: range ? 206 : 200,
    headers: assetHeaders(spec.contentType, disk.size, etag, range),
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  try {
    return await serve(request, context, false);
  } catch (error) {
    console.error(
      '[browser-assets] read failed:',
      error instanceof Error ? error.message : String(error),
    );
    return failure(
      503,
      'browser_asset_unavailable',
      'Browser assets are temporarily unavailable. Retry in a moment.',
    );
  }
}

export async function HEAD(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  try {
    return await serve(request, context, true);
  } catch (error) {
    console.error(
      '[browser-assets] head failed:',
      error instanceof Error ? error.message : String(error),
    );
    return failure(
      503,
      'browser_asset_unavailable',
      'Browser assets are temporarily unavailable. Retry in a moment.',
    );
  }
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      'access-control-allow-headers': '*',
      'access-control-max-age': '86400',
      'cache-control': 'public, max-age=86400',
    },
  });
}
