import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileSize, getBlob, isRemoteObjectPath } from './storage';

export function jsonError(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return Response.json({ error: message, code, ...extra }, { status });
}

function parseRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;

  if (!rawStart) {
    const suffixLength = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number.parseInt(rawStart, 10);
  const end = rawEnd ? Number.parseInt(rawEnd, 10) : size - 1;
  if (!Number.isFinite(start) || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

/**
 * Serves a file with HTTP range support so the browser's <video> element can
 * seek. Clips are real MP4 files on disk, never generated previews.
 */
export async function fileResponse(
  request: Request,
  filePath: string,
  options: { contentType: string; downloadName?: string },
): Promise<Response> {
  let size: number;
  if (isRemoteObjectPath(filePath)) {
    let remoteSize: number | null;
    try {
      remoteSize = await fileSize(filePath);
    } catch {
      return jsonError(
        503,
        'storage_unavailable',
        'The storage provider could not be read. This is not a missing file; retry when storage is available.',
      );
    }
    if (remoteSize === null || remoteSize === 0) {
      return jsonError(404, 'file_not_found', 'That file is no longer available.');
    }
    size = remoteSize;
  } else {
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      return jsonError(404, 'file_not_found', 'That file is no longer available.');
    }
    if (!stat.isFile() || stat.size === 0) {
      return jsonError(404, 'file_not_found', 'That file is no longer available.');
    }
    size = stat.size;
  }

  const rangeHeader = request.headers.get('range');
  const range = rangeHeader ? parseRange(rangeHeader, size) : null;
  const isDownload = Boolean(options.downloadName);

  const baseHeaders: Record<string, string> = {
    'content-type': options.contentType,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=0, must-revalidate',
    'x-content-type-options': 'nosniff',
  };
  if (isDownload) {
    baseHeaders['content-disposition'] = `attachment; filename="${encodeURIComponent(
      path.basename(options.downloadName as string),
    )}"`;
  }

  if (rangeHeader && !range) {
    return new Response(null, {
      status: 416,
      headers: { ...baseHeaders, 'content-range': `bytes */${size}` },
    });
  }

  if (isRemoteObjectPath(filePath)) {
    let object: Awaited<ReturnType<typeof getBlob>>;
    try {
      object = await getBlob(
        filePath,
        range ? { offset: range.start, length: range.end - range.start + 1 } : undefined,
      );
    } catch {
      return jsonError(
        503,
        'storage_unavailable',
        'The storage provider could not be read. This is not a missing file; retry when storage is available.',
      );
    }
    if (!object) return jsonError(404, 'file_not_found', 'That file is no longer available.');
    return new Response(object.body, {
      status: range ? 206 : 200,
      headers: {
        ...baseHeaders,
        'content-length': String(range ? range.end - range.start + 1 : size),
        ...(range ? { 'content-range': `bytes ${range.start}-${range.end}/${size}` } : {}),
      },
    });
  }

  if (range) {
    const stream = fs.createReadStream(filePath, { start: range.start, end: range.end });
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: {
        ...baseHeaders,
        'content-length': String(range.end - range.start + 1),
        'content-range': `bytes ${range.start}-${range.end}/${size}`,
      },
    });
  }

  const stream = fs.createReadStream(filePath);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: { ...baseHeaders, 'content-length': String(size) },
  });
}
