import type { StorageProviderRole } from './storage-types';

/**
 * Deployment-level object-storage providers.
 *
 * Credentials are read from the server environment on demand and are never
 * stored in D1, sent to the browser, or written into a storage object path.
 * A provider is only "configured" when every required value is present.
 */
export type StorageProviderId = 'b2' | 'tigris' | 'filebase';

export const STORAGE_PROVIDER_IDS: StorageProviderId[] = ['b2', 'tigris', 'filebase'];

export interface StorageProviderConfig {
  id: StorageProviderId;
  label: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string | null;
  forcePathStyle: boolean;
  limitBytes: number;
  reserveBytes: number;
  safeLimitBytes: number;
  role: StorageProviderRole;
  priority: number;
}

export interface StorageProviderDefinition {
  id: StorageProviderId;
  label: string;
  envPrefix: string;
  defaultEndpoint: string | null;
  defaultRegion: string;
  defaultLimitBytes: number;
  defaultReserveBytes: number;
  role: StorageProviderRole;
  priority: number;
}

const GB = 1_000_000_000;

export const STORAGE_PROVIDER_DEFINITIONS: StorageProviderDefinition[] = [
  {
    id: 'b2',
    label: 'Backblaze B2',
    envPrefix: 'AC_B2',
    defaultEndpoint: null,
    defaultRegion: 'us-west-004',
    defaultLimitBytes: 10 * GB,
    defaultReserveBytes: 1 * GB,
    role: 'hot',
    priority: 10,
  },
  {
    id: 'tigris',
    label: 'Tigris',
    envPrefix: 'AC_TIGRIS',
    defaultEndpoint: 'https://t3.storage.dev',
    defaultRegion: 'auto',
    defaultLimitBytes: 5 * GB,
    defaultReserveBytes: 500_000_000,
    role: 'overflow',
    priority: 20,
  },
  {
    id: 'filebase',
    label: 'Filebase',
    envPrefix: 'AC_FILEBASE',
    defaultEndpoint: 'https://s3.filebase.io',
    defaultRegion: 'auto',
    defaultLimitBytes: 5 * GB,
    defaultReserveBytes: 500_000_000,
    role: 'cold',
    priority: 30,
  },
];

/** Hard aggregate target for the three free tiers. */
export const DEFAULT_STORAGE_TARGET_BYTES = 18 * GB;

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function env(prefix: string, name: string): string | undefined {
  return process.env[`${prefix}_${name}`]?.trim() || undefined;
}

function defaultB2Endpoint(region: string): string | null {
  return region && region !== 'auto' ? `https://s3.${region}.backblazeb2.com` : null;
}

function endpointIsSafe(endpoint: string): boolean {
  try {
    const parsed = new URL(endpoint);
    return (
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

function configuredFor(def: StorageProviderDefinition): StorageProviderConfig | null {
  const accessKeyId = env(def.envPrefix, 'ACCESS_KEY_ID');
  const secretAccessKey = env(def.envPrefix, 'SECRET_ACCESS_KEY');
  const bucket = env(def.envPrefix, 'BUCKET');
  if (!accessKeyId || !secretAccessKey || !bucket) return null;

  const region = env(def.envPrefix, 'REGION') ?? def.defaultRegion;
  const endpoint =
    env(def.envPrefix, 'ENDPOINT') ??
    def.defaultEndpoint ??
    (def.id === 'b2' ? defaultB2Endpoint(region) : null);
  if (!endpoint || !endpointIsSafe(endpoint)) return null;

  const limitBytes = positiveInt(env(def.envPrefix, 'LIMIT_BYTES'), def.defaultLimitBytes);
  const reserveBytes = Math.min(
    limitBytes,
    positiveInt(env(def.envPrefix, 'RESERVE_BYTES'), def.defaultReserveBytes),
  );
  return {
    id: def.id,
    label: def.label,
    endpoint: endpoint.replace(/\/+$/, ''),
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    sessionToken: env(def.envPrefix, 'SESSION_TOKEN') ?? null,
    forcePathStyle: env(def.envPrefix, 'PATH_STYLE') !== '0',
    limitBytes,
    reserveBytes,
    safeLimitBytes: Math.max(0, limitBytes - reserveBytes),
    role: def.role,
    priority: def.priority,
  };
}

/** Fully configured providers only, sorted by allocation priority. */
export function storageProviders(): StorageProviderConfig[] {
  return STORAGE_PROVIDER_DEFINITIONS
    .map(configuredFor)
    .filter((provider): provider is StorageProviderConfig => Boolean(provider))
    .sort((a, b) => a.priority - b.priority);
}

export function providerById(id: string): StorageProviderConfig | null {
  return storageProviders().find((provider) => provider.id === id) ?? null;
}

export function providerDefinition(id: string): StorageProviderDefinition | null {
  return STORAGE_PROVIDER_DEFINITIONS.find((provider) => provider.id === id) ?? null;
}

export function storagePoolConfigured(): boolean {
  return storageProviders().length > 0;
}

/**
 * The 18 GB aggregate target is fixed even when only some providers are
 * configured. Provider caps still apply, and the dashboard separately reports
 * the target as unverified until all three providers can be measured.
 */
export function storageTargetBytes(): number {
  const configuredTarget = Number(process.env.AC_STORAGE_TARGET_BYTES);
  if (Number.isFinite(configuredTarget) && configuredTarget > 0) {
    return Math.floor(configuredTarget);
  }
  return DEFAULT_STORAGE_TARGET_BYTES;
}

export function providerObjectPath(providerId: StorageProviderId, key: string): string {
  const normalized = key.replace(/^\/+/, '');
  if (!normalized) throw new Error('Storage object key is empty.');
  return `s3://${providerId}/${normalized}`;
}

export function isProviderObjectPath(target: string): boolean {
  return /^s3:\/\/[a-z0-9-]+\//.test(target);
}

export function parseProviderObjectPath(target: string): { providerId: StorageProviderId; key: string } | null {
  const match = /^s3:\/\/([a-z0-9-]+)\/(.+)$/.exec(target);
  if (!match) return null;
  const providerId = match[1] as StorageProviderId;
  if (!STORAGE_PROVIDER_IDS.includes(providerId)) return null;
  return { providerId, key: match[2] };
}
