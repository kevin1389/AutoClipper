import { randomUUID } from 'node:crypto';
import {
  s3DeleteObject,
  s3GetObject,
  s3HeadBucket,
  s3HeadObject,
  s3ListObjects,
  s3PutObject,
  type S3Config,
} from '../src/lib/s3-client';
import { storageProviders } from '../src/lib/storage-providers';

/**
 * Operator-only real-provider smoke test. It creates one tiny, uniquely named
 * text object, reads it back, lists it, deletes it and confirms it is gone.
 * It never prints credentials and is never run automatically by the app.
 *
 * It intentionally uses the same signed client as production. A pass here
 * proves the credentials, endpoint, bucket, signing and basic permissions for
 * that provider; it does not prove every multipart/browser path.
 */
async function smokeProvider(provider: ReturnType<typeof storageProviders>[number]): Promise<void> {
  const config: S3Config = {
    endpoint: provider.endpoint,
    region: provider.region,
    bucket: provider.bucket,
    accessKeyId: provider.accessKeyId,
    secretAccessKey: provider.secretAccessKey,
    sessionToken: provider.sessionToken,
    forcePathStyle: provider.forcePathStyle,
  };
  const key = `autoclipper-smoke/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.txt`;
  const payload = 'AutoClipper signed provider smoke test';
  const bytes = new TextEncoder().encode(payload);
  let uploaded = false;
  try {
    await s3HeadBucket(config);
    await s3PutObject(
      config,
      key,
      new Response(payload).body as ReadableStream<Uint8Array>,
      1024,
      'text/plain; charset=utf-8',
      bytes.byteLength,
    );
    uploaded = true;
    const head = await s3HeadObject(config, key);
    if (!head || head.size !== bytes.byteLength) {
      throw new Error(`HEAD verification returned ${head?.size ?? 'no object'}; expected ${bytes.byteLength}.`);
    }
    const object = await s3GetObject(config, key);
    if (!object) throw new Error('GET did not return the uploaded object.');
    const readBack = await new Response(object.body).text();
    if (readBack !== payload) throw new Error('GET returned different bytes.');
    const listing = await s3ListObjects(config, 'autoclipper-smoke/');
    if (!listing.objects.some((entry) => entry.key === key)) {
      throw new Error('The uploaded object did not appear in the provider listing.');
    }
  } finally {
    if (uploaded) {
      await s3DeleteObject(config, key);
      const remaining = await s3HeadObject(config, key);
      if (remaining) throw new Error(`The smoke object ${key} is still present after deletion.`);
    }
  }
  console.log(`${provider.label}: PASS (signed HEAD, PUT, GET, LIST, DELETE)`);
}

async function main(): Promise<void> {
  const providers = storageProviders();
  if (providers.length === 0) {
    throw new Error(
      'No provider is configured. Set the AC_B2_*, AC_TIGRIS_* or AC_FILEBASE_* server secrets first.',
    );
  }
  for (const provider of providers) {
    try {
      await smokeProvider(provider);
    } catch (error) {
      console.error(`${provider.label}: FAIL — ${(error as Error).message}`);
      process.exitCode = 1;
    }
  }
}

void main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
