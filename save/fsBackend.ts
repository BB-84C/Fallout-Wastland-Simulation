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

const LOCAL_DIR = 'localStorage';
const INDEXED_DIR = 'indexedDB';
const HISTORY_DIR = 'history';
const STATUS_DIR = 'status_change';
const IMAGES_DIR = 'images';

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

const getDirHandle = async (
  root: FileSystemDirectoryHandle,
  name: string,
  create: boolean
) => {
  try {
    return await root.getDirectoryHandle(name, { create });
  } catch {
    return null;
  }
};

const readTextFile = async (handle: FileSystemFileHandle) => {
  const file = await handle.getFile();
  return await file.text();
};

const writeTextFile = async (dir: FileSystemDirectoryHandle, name: string, content: string) => {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
};

const writeBlobFile = async (dir: FileSystemDirectoryHandle, name: string, blob: Blob) => {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
};

const listFiles = async (dir: FileSystemDirectoryHandle) => {
  const files: string[] = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'file') files.push(name);
  }
  return files;
};

const removeFile = async (dir: FileSystemDirectoryHandle, name: string) => {
  try {
    await dir.removeEntry(name);
  } catch {
    // Ignore missing file.
  }
};

export class FSBackend implements SaveBackend {
  private root: FileSystemDirectoryHandle;

  constructor(root: FileSystemDirectoryHandle) {
    this.root = root;
  }

  async readLocalState(_saveKey: string): Promise<RootSaveJson | null> {
    const localDir = await getDirHandle(this.root, LOCAL_DIR, false);
    if (!localDir) return null;
    try {
      const fileHandle = await localDir.getFileHandle('root_save.json');
      const raw = await readTextFile(fileHandle);
      return parseLocalState(raw);
    } catch {
      return null;
    }
  }

  async writeLocalState(_saveKey: string, data: RootSaveJson): Promise<void> {
    const localDir = await getDirHandle(this.root, LOCAL_DIR, true);
    if (!localDir) throw new Error('Unable to access save directory.');
    await writeTextFile(localDir, 'root_save.json', JSON.stringify(data));
  }

  async putHistoryChunk(
    _saveKey: string,
    chunkId: string,
    range: [number, number],
    entries: HistoryEntry[]
  ): Promise<void> {
    const indexedDir = await getDirHandle(this.root, INDEXED_DIR, true);
    if (!indexedDir) throw new Error('Unable to access save directory.');
    const historyDir = await getDirHandle(indexedDir, HISTORY_DIR, true);
    if (!historyDir) throw new Error('Unable to access history directory.');
    await writeTextFile(historyDir, `${chunkId}.json`, JSON.stringify({ range, entries }));
  }

  async getHistoryChunk(_saveKey: string, chunkId: string): Promise<HistoryChunkData | null> {
    const indexedDir = await getDirHandle(this.root, INDEXED_DIR, false);
    const historyDir = indexedDir ? await getDirHandle(indexedDir, HISTORY_DIR, false) : null;
    if (!historyDir) return null;
    try {
      const fileHandle = await historyDir.getFileHandle(`${chunkId}.json`);
      const raw = await readTextFile(fileHandle);
      const parsed = JSON.parse(raw);
      return { chunkId, range: parsed.range, entries: parsed.entries };
    } catch {
      return null;
    }
  }

  async listHistoryChunks(_saveKey: string): Promise<HistoryChunkSummary[]> {
    const indexedDir = await getDirHandle(this.root, INDEXED_DIR, false);
    const historyDir = indexedDir ? await getDirHandle(indexedDir, HISTORY_DIR, false) : null;
    if (!historyDir) return [];
    const files = await listFiles(historyDir);
    const summaries: HistoryChunkSummary[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const chunkId = file.replace(/\.json$/, '');
      try {
        const fileHandle = await historyDir.getFileHandle(file);
        const raw = await readTextFile(fileHandle);
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.range) && parsed.range.length === 2) {
          summaries.push({ chunkId, range: parsed.range });
        }
      } catch {
        // Skip unreadable chunks.
      }
    }
    return summaries;
  }

  async deleteHistoryChunk(_saveKey: string, chunkId: string): Promise<void> {
    const indexedDir = await getDirHandle(this.root, INDEXED_DIR, false);
    const historyDir = indexedDir ? await getDirHandle(indexedDir, HISTORY_DIR, false) : null;
    if (!historyDir) return;
    await removeFile(historyDir, `${chunkId}.json`);
  }

  async putStatusChangeChunk(
    _saveKey: string,
    chunkId: string,
    range: [number, number],
    entries: StatusChangeEntry[]
  ): Promise<void> {
    const indexedDir = await getDirHandle(this.root, INDEXED_DIR, true);
    if (!indexedDir) throw new Error('Unable to access save directory.');
    const statusDir = await getDirHandle(indexedDir, STATUS_DIR, true);
    if (!statusDir) throw new Error('Unable to access status directory.');
    await writeTextFile(statusDir, `${chunkId}.json`, JSON.stringify({ range, entries }));
  }

  async getStatusChangeChunk(_saveKey: string, chunkId: string): Promise<StatusChangeChunkData | null> {
    const indexedDir = await getDirHandle(this.root, INDEXED_DIR, false);
    const statusDir = indexedDir ? await getDirHandle(indexedDir, STATUS_DIR, false) : null;
    if (!statusDir) return null;
    try {
      const fileHandle = await statusDir.getFileHandle(`${chunkId}.json`);
      const raw = await readTextFile(fileHandle);
      const parsed = JSON.parse(raw);
      return { chunkId, range: parsed.range, entries: parsed.entries };
    } catch {
      return null;
    }
  }

  async listStatusChangeChunks(_saveKey: string): Promise<StatusChangeChunkSummary[]> {
    const indexedDir = await getDirHandle(this.root, INDEXED_DIR, false);
    const statusDir = indexedDir ? await getDirHandle(indexedDir, STATUS_DIR, false) : null;
    if (!statusDir) return [];
    const files = await listFiles(statusDir);
    const summaries: StatusChangeChunkSummary[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const chunkId = file.replace(/\.json$/, '');
      try {
        const fileHandle = await statusDir.getFileHandle(file);
        const raw = await readTextFile(fileHandle);
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.range) && parsed.range.length === 2) {
          summaries.push({ chunkId, range: parsed.range });
        }
      } catch {
        // Skip unreadable chunks.
      }
    }
    return summaries;
  }

  async deleteStatusChangeChunk(_saveKey: string, chunkId: string): Promise<void> {
    const indexedDir = await getDirHandle(this.root, INDEXED_DIR, false);
    const statusDir = indexedDir ? await getDirHandle(indexedDir, STATUS_DIR, false) : null;
    if (!statusDir) return;
    await removeFile(statusDir, `${chunkId}.json`);
  }

  async putImage(_saveKey: string, imageId: string, blob: Blob, mime: string): Promise<void> {
    const indexedDir = await getDirHandle(this.root, INDEXED_DIR, true);
    if (!indexedDir) throw new Error('Unable to access save directory.');
    const imagesDir = await getDirHandle(indexedDir, IMAGES_DIR, true);
    if (!imagesDir) throw new Error('Unable to access images directory.');
    await writeBlobFile(imagesDir, `${imageId}.bin`, blob);
    await writeTextFile(imagesDir, `${imageId}.json`, JSON.stringify({ mime }));
  }

  async getImage(_saveKey: string, imageId: string): Promise<{ blob: Blob; mime: string } | null> {
    const indexedDir = await getDirHandle(this.root, INDEXED_DIR, false);
    const imagesDir = indexedDir ? await getDirHandle(indexedDir, IMAGES_DIR, false) : null;
    if (!imagesDir) return null;
    try {
      let mime = 'application/octet-stream';
      try {
        const metaHandle = await imagesDir.getFileHandle(`${imageId}.json`);
        const metaRaw = await readTextFile(metaHandle);
        const meta = JSON.parse(metaRaw);
        if (typeof meta?.mime === 'string') {
          mime = meta.mime;
        }
      } catch {
        // Missing metadata; fall back to file type.
      }
      const fileHandle = await imagesDir.getFileHandle(`${imageId}.bin`);
      const file = await fileHandle.getFile();
      if (mime === 'application/octet-stream' && file.type) {
        mime = file.type;
      }
      return { blob: new Blob([await file.arrayBuffer()], { type: mime }), mime };
    } catch {
      return null;
    }
  }

  async listImages(_saveKey: string): Promise<string[]> {
    const indexedDir = await getDirHandle(this.root, INDEXED_DIR, false);
    const imagesDir = indexedDir ? await getDirHandle(indexedDir, IMAGES_DIR, false) : null;
    if (!imagesDir) return [];
    const files = await listFiles(imagesDir);
    const imageIds = new Set<string>();
    files
      .filter(name => name.endsWith('.json') || name.endsWith('.bin'))
      .forEach(name => {
        imageIds.add(name.replace(/\.(json|bin)$/, ''));
      });
    return Array.from(imageIds);
  }

  async deleteImage(_saveKey: string, imageId: string): Promise<void> {
    const indexedDir = await getDirHandle(this.root, INDEXED_DIR, false);
    const imagesDir = indexedDir ? await getDirHandle(indexedDir, IMAGES_DIR, false) : null;
    if (!imagesDir) return;
    await removeFile(imagesDir, `${imageId}.bin`);
    await removeFile(imagesDir, `${imageId}.json`);
  }

  async deleteSave(_saveKey: string): Promise<void> {
    try {
      await this.root.removeEntry(LOCAL_DIR, { recursive: true });
    } catch {
      // Ignore missing entries.
    }
    try {
      await this.root.removeEntry(INDEXED_DIR, { recursive: true });
    } catch {
      // Ignore missing entries.
    }
  }
}
