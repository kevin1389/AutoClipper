/**
 * Structural MP4 verification used by the finalize route.
 *
 * The browser probes its rendered file before uploading it. This server-side
 * check then verifies the bytes that actually reached storage, so a clip is
 * never marked ready from a zero-byte object, an HTML error page or a truncated
 * write. It is intentionally a box-level check, not a decoder: it confirms the
 * ISO base media file has `ftyp`, a complete `moov` and media data, and that
 * `moov` precedes `mdat` (faststart).
 */

export interface Mp4Inspection {
  valid: boolean;
  faststart: boolean;
  brand: string | null;
  reason: string | null;
  boxes: string[];
}

const CONTAINER_SAFE_BRANDS = new Set([
  'isom',
  'iso2',
  'iso4',
  'iso5',
  'iso6',
  'mp41',
  'mp42',
  'avc1',
  'M4V ',
  'dash',
  'cmfc',
  'msdh',
]);

function fourCc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function readUint64(bytes: Uint8Array, offset: number): number | null {
  if (offset + 8 > bytes.byteLength) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const high = view.getUint32(offset, false);
  const low = view.getUint32(offset + 4, false);
  if (high > 0x1fffff) return null;
  return high * 2 ** 32 + low;
}

/**
 * Inspects the beginning of an MP4. Callers should pass at least the first
 * 256 KiB; every faststart clip produced by the renderer has its complete moov
 * atom there. A `moov` that starts but extends past the supplied prefix is
 * reported as incomplete rather than accepted.
 */
export function inspectMp4(bytes: Uint8Array): Mp4Inspection {
  if (bytes.byteLength < 16) {
    return { valid: false, faststart: false, brand: null, reason: 'The file is too small to be an MP4.', boxes: [] };
  }

  const boxes: string[] = [];
  let offset = 0;
  let brand: string | null = null;
  let hasMoov = false;
  let hasMdat = false;
  let moovBeforeMdat = false;
  let malformed: string | null = null;

  while (offset + 8 <= bytes.byteLength) {
    let size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
    const type = fourCc(bytes, offset + 4);
    let header = 8;

    if (size === 1) {
      if (offset + 16 > bytes.byteLength) break;
      const large = readUint64(bytes, offset + 8);
      if (large === null) {
        malformed = `The ${type} atom declares an unsupported size.`;
        break;
      }
      size = large;
      header = 16;
    } else if (size === 0) {
      size = bytes.byteLength - offset;
    }

    if (size < header) {
      malformed = `The ${type} atom has an invalid size (${size}).`;
      break;
    }
    if (!/^[\x20-\x7e]{4}$/.test(type)) {
      malformed = 'The file has an invalid MP4 atom header.';
      break;
    }

    boxes.push(type);
    if (boxes.length === 1 && type !== 'ftyp') {
      malformed = 'The MP4 does not start with an ftyp atom.';
      break;
    }
    if (type === 'ftyp') {
      if (size < 12 || offset + 12 > bytes.byteLength) {
        malformed = 'The MP4 ftyp atom is incomplete.';
        break;
      }
      brand = fourCc(bytes, offset + 8);
      if (!CONTAINER_SAFE_BRANDS.has(brand)) {
        malformed = `The MP4 brand "${brand}" is not a supported video container.`;
        break;
      }
    } else if (type === 'moov') {
      if (offset + size > bytes.byteLength) {
        malformed = 'The MP4 moov atom is truncated.';
        break;
      }
      hasMoov = true;
    } else if (type === 'mdat') {
      hasMdat = true;
      if (hasMoov) moovBeforeMdat = true;
    }

    const next = offset + size;
    if (next <= offset) {
      malformed = 'The MP4 atom sizes do not advance.';
      break;
    }
    if (size > bytes.byteLength - offset) {
      // Reaching the prefix boundary is expected for mdat; everything needed
      // before it has already been collected.
      break;
    }
    offset = next;
  }

  if (malformed) {
    return { valid: false, faststart: false, brand, reason: malformed, boxes };
  }
  if (!hasMoov) {
    return {
      valid: false,
      faststart: false,
      brand,
      reason: 'The MP4 is missing a complete moov atom (it may be truncated).',
      boxes,
    };
  }
  if (!hasMdat) {
    return { valid: false, faststart: false, brand, reason: 'The MP4 has no media data (mdat).', boxes };
  }
  if (!moovBeforeMdat) {
    return { valid: false, faststart: false, brand, reason: 'The MP4 is not faststart (moov is after mdat).', boxes };
  }
  return { valid: true, faststart: true, brand, reason: null, boxes };
}
