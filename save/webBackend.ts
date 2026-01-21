import type { GameState, HistoryEntry, StatusChangeEntry } from '../types';
import type {
  HistoryChunkData,
  HistoryChunkSummary,
  RootSaveJson,
  SaveBackend,
  StatusChangeChunkData,
  StatusChangeChunkSummary
} from './types';
import { isRootSaveJson } from './types';

const DB_NAME = 'fallout_wasteland_save_db';
const DB_VERSION = 1;
const STORE_HISTORY = 'history_chunks';
const STORE_STATUS = 'status_change_chunks';
const STORE_IMAGES = 'images';

const getDb = (() => {
  let dbPromise: Promise<IDBDatabase> | null = null;
  return () => {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_HISTORY)) {
            const store = db.createObjectStore(STORE_HISTORY, { keyPath: 'id' });
            store.createIndex('saveKey', 'saveKey', { unique: false });
          }
          if (!db.objectStoreNames.contains(STORE_STATUS)) {
            const store = db.createObjectStore(STORE_STATUS, { keyPath: 'id' });
            store.createIndex('saveKey', 'saveKey', { unique: false });
          }
          if (!db.objectStoreNames.contains(STORE_IMAGES)) {
            const store = db.createObjectStore(STORE_IMAGES, { keyPath: 'id' });
            store.createIndex('saveKey', 'saveKey', { unique: false });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return dbPromise;
  };
})();

const requestToPromise = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const getStore = async (storeName: string, mode: IDBTransactionMode) => {
  const db = await getDb();
  const tx = db.transaction(storeName, mode);
  return { store: tx.objectStore(storeName), tx };
};

const completeTx = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

const isGameStateLike = (value: any): value is GameState =>
  !!value
  && typeof value === 'object'
  && Array.isArray(value.history)
  && value.settings
  && typeof value.settings === 'object';

const parseLocalState = (raw: string): RootSaveJson | null => {
  try {
    const parsed = JSON.parse(raw);
    if (isRootSaveJson(parsed)) return parsed;
    if (isGameStateLike(parsed)) {
      return {
        version: 1,
        username: null,
        savedAt: new Date().toISOString(),
        gameState: parsed
      };
    }
  } catch {
    return null;
  }
  return null;
};

const buildKey = (saveKey: string, id: string) => `${saveKey}::${id}`;

export class WebBackend implements SaveBackend {
  async readLocalState(saveKey: string) {
    try {
      const raw = localStorage.getItem(saveKey);
      if (!raw) return null;
      return parseLocalState(raw);
    } catch {
      return null;
    }
  }

  async writeLocalState(saveKey: string, data: RootSaveJson) {
    try {
      localStorage.setItem(saveKey, JSON.stringify(data));
    } catch (err: any) {
      if (err && typeof err === 'object' && 'name' in err) {
        throw err;
      }
      const error = new Error('Local storage quota exceeded.');
      (error as any).name = 'QuotaExceededError';
      throw error;
    }
  }

  async putHistoryChunk(saveKey: string, chunkId: string, range: [number, number], entries: HistoryEntry[]) {
    const { store, tx } = await getStore(STORE_HISTORY, 'readwrite');
    const id = buildKey(saveKey, chunkId);
    store.put({ id, saveKey, chunkId, range, entries });
    await completeTx(tx);
  }

  async getHistoryChunk(saveKey: string, chunkId: string): Promise<HistoryChunkData | null> {
    const { store } = await getStore(STORE_HISTORY, 'readonly');
    const id = buildKey(saveKey, chunkId);
    const result = await requestToPromise<any>(store.get(id));
    if (!result) return null;
    return { chunkId: result.chunkId, range: result.range, entries: result.entries };
  }

  async listHistoryChunks(saveKey: string): Promise<HistoryChunkSummary[]> {
    const { store } = await getStore(STORE_HISTORY, 'readonly');
    const index = store.index('saveKey');
    const results = await requestToPromise<any[]>(index.getAll(IDBKeyRange.only(saveKey)));
    return (results || []).map(entry => ({ chunkId: entry.chunkId, range: entry.range }));
  }

  async deleteHistoryChunk(saveKey: string, chunkId: string): Promise<void> {
    const { store, tx } = await getStore(STORE_HISTORY, 'readwrite');
    const id = buildKey(saveKey, chunkId);
    store.delete(id);
    await completeTx(tx);
  }

  async putStatusChangeChunk(
    saveKey: string,
    chunkId: string,
    range: [number, number],
    entries: StatusChangeEntry[]
  ) {
    const { store, tx } = await getStore(STORE_STATUS, 'readwrite');
    const id = buildKey(saveKey, chunkId);
    store.put({ id, saveKey, chunkId, range, entries });
    await completeTx(tx);
  }

  async getStatusChangeChunk(saveKey: string, chunkId: string): Promise<StatusChangeChunkData | null> {
    const { store } = await getStore(STORE_STATUS, 'readonly');
    const id = buildKey(saveKey, chunkId);
    const result = await requestToPromise<any>(store.get(id));
    if (!result) return null;
    return { chunkId: result.chunkId, range: result.range, entries: result.entries };
  }

  async listStatusChangeChunks(saveKey: string): Promise<StatusChangeChunkSummary[]> {
    const { store } = await getStore(STORE_STATUS, 'readonly');
    const index = store.index('saveKey');
    const results = await requestToPromise<any[]>(index.getAll(IDBKeyRange.only(saveKey)));
    return (results || []).map(entry => ({ chunkId: entry.chunkId, range: entry.range }));
  }

  async deleteStatusChangeChunk(saveKey: string, chunkId: string): Promise<void> {
    const { store, tx } = await getStore(STORE_STATUS, 'readwrite');
    const id = buildKey(saveKey, chunkId);
    store.delete(id);
    await completeTx(tx);
  }

  async putImage(saveKey: string, imageId: string, blob: Blob, mime: string) {
    const { store, tx } = await getStore(STORE_IMAGES, 'readwrite');
    const id = buildKey(saveKey, imageId);
    store.put({ id, saveKey, imageId, blob, mime });
    await completeTx(tx);
  }

  async getImage(saveKey: string, imageId: string): Promise<{ blob: Blob; mime: string } | null> {
    const { store } = await getStore(STORE_IMAGES, 'readonly');
    const id = buildKey(saveKey, imageId);
    const result = await requestToPromise<any>(store.get(id));
    if (!result) return null;
    return { blob: result.blob, mime: result.mime };
  }

  async listImages(saveKey: string): Promise<string[]> {
    const { store } = await getStore(STORE_IMAGES, 'readonly');
    const index = store.index('saveKey');
    const results = await requestToPromise<any[]>(index.getAll(IDBKeyRange.only(saveKey)));
    return (results || []).map(entry => entry.imageId);
  }

  async deleteImage(saveKey: string, imageId: string): Promise<void> {
    const { store, tx } = await getStore(STORE_IMAGES, 'readwrite');
    const id = buildKey(saveKey, imageId);
    store.delete(id);
    await completeTx(tx);
  }

  async deleteSave(saveKey: string): Promise<void> {
    const history = await this.listHistoryChunks(saveKey);
    const status = await this.listStatusChangeChunks(saveKey);
    const images = await this.listImages(saveKey);
    await Promise.all(history.map(chunk => this.deleteHistoryChunk(saveKey, chunk.chunkId)));
    await Promise.all(status.map(chunk => this.deleteStatusChangeChunk(saveKey, chunk.chunkId)));
    await Promise.all(images.map(imageId => this.deleteImage(saveKey, imageId)));
    try {
      localStorage.removeItem(saveKey);
    } catch {
      // Ignore local storage cleanup errors.
    }
  }
}
