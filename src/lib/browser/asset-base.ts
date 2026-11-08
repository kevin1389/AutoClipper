/// <reference lib="webworker" />
import {
  DEFAULT_BROWSER_ASSET_BASE,
  joinBrowserAssetDirectoryUrl,
  joinBrowserAssetUrl,
  normalizeBrowserAssetBase,
} from '../browser-assets';

/**
 * The asset base is runtime configuration, not a build-time constant, so the
 * same build can use a public B2/Tigris/Filebase bucket, a CDN, or the
 * same-origin `/api/browser-assets` route.
 *
 * Each Web Worker starts with the default and receives the server-provided
 * value before it loads FFmpeg or Whisper.
 */
let base = DEFAULT_BROWSER_ASSET_BASE;

export function setBrowserAssetBase(value: string | null | undefined): void {
  if (!value) return;
  base = normalizeBrowserAssetBase(value);
}

export function currentBrowserAssetBase(): string {
  return base;
}

/** Absolute URL for one exact asset, resolved against this worker's origin. */
export function browserAssetUrl(path: string): string {
  return new URL(joinBrowserAssetUrl(base, path), self.location.origin).href;
}

/** Absolute URL for a directory such as `models/` or `transformers/`. */
export function browserAssetDirectoryUrl(directory: string): string {
  return new URL(joinBrowserAssetDirectoryUrl(base, directory), self.location.origin).href;
}
