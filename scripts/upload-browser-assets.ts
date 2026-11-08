/**
 * Uploads browser-assets/ to one of the configured S3-compatible providers.
 *
 * Dry-run is the default: nothing is written until `--upload` is supplied.
 * Credentials are read from the existing AC_B2_* / AC_TIGRIS_* / AC_FILEBASE_*
 * variables (or the untracked .env) and never printed. The deployed Worker does
 * not need these credentials when the bucket is public.
 *
 * Usage:
 *   npm run assets:upload -- --provider b2 --prefix browser-assets/v1
 *   npm run assets:upload -- --provider tigris --prefix browser-assets/v1 --upload
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  BROWSER_ASSET_SPECS,
  browserAssetSpec,
} from '../src/lib/browser-assets';
import { s3HeadObject, s3PutObject, type S3Config } from '../src/lib/s3-client';
import { storageProviders, type StorageProviderId } from '../src/lib/storage-providers';

const ROOT = path.join(process.cwd(), 'browser-assets');
const IMMUTABLE = 'public, max-age=31536000, immutable';

function loadLocalEnv(): void {
  try {
    (process as unknown as { loadEnvFile?: (file: string) => void }).loadEnvFile?.('.env');
  } catch {
    // A missing .env is fine when the variables are already exported.
  }
}

function argument(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

async function walk(directory: string): Promise<string[]> {
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.DS_Store' || entry.name === 'browser-assets.json') continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

async function main(): Promise<void> {
  loadLocalEnv();

  const providerId = (argument('provider') ??
    process.env.AC_BROWSER_ASSET_PROVIDER ??
    'b2') as StorageProviderId;
  const prefix = (argument('prefix') ?? 'browser-assets/v1').replace(/^\/+|\/+$/g, '');
  const upload = process.argv.includes('--upload');

  if (!/^(b2|tigris|filebase)$/.test(providerId)) {
    throw new Error(`Unknown provider "${providerId}". Use b2, tigris or filebase.`);
  }
  if (!prefix || prefix.includes('..') || prefix.includes('\\')) {
    throw new Error('The prefix must be a clean object-key prefix.');
  }

  const provider = storageProviders().find((entry) => entry.id === providerId);
  if (!provider) {
    const envPrefix = `AC_${providerId.toUpperCase()}`;
    throw new Error(
      `${providerId} is not configured. Set ${envPrefix}_ACCESS_KEY_ID, ${envPrefix}_SECRET_ACCESS_KEY and ${envPrefix}_BUCKET (optional: ${envPrefix}_REGION, ${envPrefix}_ENDPOINT).`,
    );
  }

  const files = await walk(ROOT);
  if (files.length === 0) throw new Error(`No files were found in ${ROOT}. Run npm run prepare:browser first.`);

  const unknown = files
    .map((file) => path.relative(ROOT, file).split(path.sep).join('/'))
    .filter((rel) => !browserAssetSpec(rel));
  if (unknown.length > 0) {
    throw new Error(
      `These files are not in the browser asset manifest, so the app would never request them:\n${unknown.join('\n')}`,
    );
  }

  const config: S3Config = {
    endpoint: provider.endpoint,
    region: provider.region,
    bucket: provider.bucket,
    accessKeyId: provider.accessKeyId,
    secretAccessKey: provider.secretAccessKey,
    sessionToken: provider.sessionToken,
    forcePathStyle: provider.forcePathStyle,
  };

  console.log(
    `${upload ? 'Uploading' : 'Dry run — no objects will be written'} ${files.length} files to ${provider.label} (${provider.bucket}), prefix ${prefix}/`,
  );

  let written = 0;
  let bytes = 0;
  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const spec = browserAssetSpec(rel);
    if (!spec) continue;
    const stat = await fsp.stat(file);
    if (stat.size !== spec.bytes) {
      throw new Error(
        `Manifest size mismatch for ${rel}: manifest says ${spec.bytes} bytes, file is ${stat.size}. Update src/lib/browser-assets.ts.`,
      );
    }
    const key = `${prefix}/${rel}`;
    if (!upload) {
      console.log(`  ${key}  ${stat.size} bytes  ${spec.contentType}`);
      continue;
    }
    const result = await s3PutObject(
      config,
      key,
      Readable.toWeb(fs.createReadStream(file)) as ReadableStream<Uint8Array>,
      stat.size,
      spec.contentType,
      stat.size,
      IMMUTABLE,
    );
    if (result.bytes !== stat.size) {
      throw new Error(`${rel} uploaded ${result.bytes} of ${stat.size} bytes.`);
    }
    const head = await s3HeadObject(config, key);
    if (!head || head.size !== stat.size) {
      throw new Error(`${rel} did not verify after upload (expected ${stat.size} bytes).`);
    }
    written += 1;
    bytes += stat.size;
    console.log(`  verified ${key}  ${stat.size} bytes`);
  }

  console.log(
    upload
      ? `Uploaded and verified ${written} files (${(bytes / 1_000_000).toFixed(1)} MB).`
      : `Dry run complete: ${files.length} files, ${BROWSER_ASSET_SPECS.length} allow-listed paths.`,
  );

  if (providerId === 'tigris') {
    console.log(`Public base: https://${provider.bucket}.t3.tigrisfiles.io/${prefix}/`);
  } else if (providerId === 'filebase') {
    console.log(`Public base: https://${provider.bucket}.s3.filebase.io/${prefix}/`);
  } else {
    console.log('Public base: copy the bucket Friendly URL from the B2 dashboard and append /' + prefix + '/');
  }
  console.log(`Set BROWSER_ASSET_BASE_URL to that public base, then redeploy. No provider credentials belong in production.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
