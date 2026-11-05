'use client';

/**
 * A browser-local source store.
 *
 * The normal processing path never uploads the original to R2. The File is
 * kept in IndexedDB so navigation/reloads can reuse the same local bytes; the
 * worker receives the File object and mounts it through FFmpeg's WORKERFS.
 * Nothing here reaches the server.
 */

const DB_NAME = 'autoclipper-local-sources';
const DB_VERSION = 1;
const STORE_NAME = 'sources';

interface StoredSource {
  projectId: string;
  file: File;
  savedAt: number;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This browser does not provide local storage for source videos.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'projectId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open local source storage.'));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const request = action(transaction.objectStore(STORE_NAME));
      let result = undefined as T;
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => {
        // The transaction error/abort handlers below reject with the real cause.
      };
      // A large File can still be committing when the request callback fires.
      // Resolve only after the transaction commits so navigation cannot drop it.
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error ?? new Error('Local source storage failed.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Local source storage was interrupted.'));
    });
  } finally {
    db.close();
  }
}

export async function saveLocalSource(projectId: string, file: File): Promise<void> {
  try {
    if (navigator.storage?.persist) await navigator.storage.persist().catch(() => false);
  } catch {
    // Persistence is a best-effort hint; the put below is the actual storage.
  }
  await withStore('readwrite', (store) =>
    store.put({ projectId, file, savedAt: Date.now() } satisfies StoredSource),
  );
}

export async function loadLocalSource(projectId: string): Promise<File | null> {
  const record = await withStore<StoredSource | undefined>('readonly', (store) => store.get(projectId));
  if (!record?.file) return null;
  return record.file;
}

export async function deleteLocalSource(projectId: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(projectId));
}

/** Gives the UI an honest local-space estimate before a large file is attached. */
export async function localSourceStorageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (!estimate) return null;
    return { usage: Number(estimate.usage) || 0, quota: Number(estimate.quota) || 0 };
  } catch {
    return null;
  }
}
