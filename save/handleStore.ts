const HANDLE_DB_NAME = 'fallout_wasteland_save_handles';
const HANDLE_DB_VERSION = 1;
const STORE_HANDLES = 'fs_handles';

const getHandleDb = (() => {
  let dbPromise: Promise<IDBDatabase> | null = null;
  return () => {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(HANDLE_DB_NAME, HANDLE_DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_HANDLES)) {
            db.createObjectStore(STORE_HANDLES);
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

const getHandleStore = async (mode: IDBTransactionMode) => {
  const db = await getHandleDb();
  const tx = db.transaction(STORE_HANDLES, mode);
  return { store: tx.objectStore(STORE_HANDLES), tx };
};

const completeTx = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

export const saveFsHandle = async (
  saveKey: string,
  handle: FileSystemDirectoryHandle
) => {
  const { store, tx } = await getHandleStore('readwrite');
  store.put(handle, saveKey);
  await completeTx(tx);
};

export const loadFsHandle = async (saveKey: string) => {
  const { store } = await getHandleStore('readonly');
  const handle = await requestToPromise<FileSystemDirectoryHandle | undefined>(
    store.get(saveKey)
  );
  return handle ?? null;
};

export const clearFsHandle = async (saveKey: string) => {
  const { store, tx } = await getHandleStore('readwrite');
  store.delete(saveKey);
  await completeTx(tx);
};
