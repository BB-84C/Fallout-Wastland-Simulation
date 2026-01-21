import JSZip from 'jszip';
import type { GameState, HistoryEntry, StatusChangeEntry } from '../types';
import type {
  HistoryChunkSummary,
  RootSaveJson,
  SaveBackend,
  StatusChangeChunkSummary
} from './types';
import {
  DEFAULT_HISTORY_CHUNK_SIZE,
  DEFAULT_LOCAL_HISTORY_LIMIT,
  getStorageHistoryLimit,
  serializeRuntimeState
} from './serializer';

export interface LoadResult {
  root: RootSaveJson;
  gameState: GameState;
  historyBaseIndex: number;
  statusChangeBaseIndex: number;
}

const buildImageId = (historyIndex: number) => `h_${historyIndex}`;

const sortChunks = <T extends { range: [number, number] }>(chunks: T[]) =>
  [...chunks].sort((a, b) => a.range[0] - b.range[0]);

const readJsonFile = async (file: JSZip.JSZipObject) =>
  JSON.parse(await file.async('string'));

export class SaveRepository {
  private backend: SaveBackend;
  private imageUrlCache = new Map<string, string>();
  private chunkCache = new Map<string, HistoryChunkSummary[]>();

  constructor(backend: SaveBackend) {
    this.backend = backend;
  }

  setBackend(backend: SaveBackend) {
    this.backend = backend;
    this.imageUrlCache.clear();
    this.chunkCache.clear();
  }

  async hasSave(saveKey: string) {
    const local = await this.backend.readLocalState(saveKey);
    return !!local;
  }

  async hasIndexedData(saveKey: string) {
    const [history, status, images] = await Promise.all([
      this.backend.listHistoryChunks(saveKey),
      this.backend.listStatusChangeChunks(saveKey),
      this.backend.listImages(saveKey)
    ]);
    return history.length > 0 || status.length > 0 || images.length > 0;
  }

  async loadRuntimeState(saveKey: string): Promise<LoadResult | null> {
    const local = await this.backend.readLocalState(saveKey);
    if (!local) return null;
    const historyChunks = sortChunks(await this.backend.listHistoryChunks(saveKey));
    const statusChunks = sortChunks(await this.backend.listStatusChangeChunks(saveKey));
    const historyHead: HistoryEntry[] = [];
    for (const chunk of historyChunks) {
      const data = await this.backend.getHistoryChunk(saveKey, chunk.chunkId);
      if (data?.entries?.length) {
        historyHead.push(...data.entries);
      }
    }
    const statusHead: StatusChangeEntry[] = [];
    for (const chunk of statusChunks) {
      const data = await this.backend.getStatusChangeChunk(saveKey, chunk.chunkId);
      if (data?.entries?.length) {
        statusHead.push(...data.entries);
      }
    }
    const localState = local.gameState;
    const history = [...historyHead, ...(localState.history || [])];
    const statusTrack = localState.status_track;
    const statusChange = statusTrack
      ? [...statusHead, ...(statusTrack.status_change || [])]
      : statusTrack;
    const mergedState: GameState = {
      ...localState,
      history,
      status_track: statusTrack
        ? {
          ...statusTrack,
          status_change: statusChange as StatusChangeEntry[]
        }
        : statusTrack
    };
    this.chunkCache.set(saveKey, historyChunks);
    return {
      root: local,
      gameState: mergedState,
      historyBaseIndex: historyHead.length,
      statusChangeBaseIndex: statusHead.length
    };
  }

  async commitRuntimeState(
    saveKey: string,
    state: GameState,
    options: {
      username?: string | null;
      chunkSize?: number;
      localHistoryLimit?: number;
    } = {}
  ) {
    const serialized = serializeRuntimeState(state, {
      username: options.username,
      chunkSize: options.chunkSize ?? DEFAULT_HISTORY_CHUNK_SIZE,
      localHistoryLimit: options.localHistoryLimit ?? getStorageHistoryLimit(state.settings, DEFAULT_LOCAL_HISTORY_LIMIT)
    });
    await this.backend.writeLocalState(saveKey, serialized.localState);

    const existingHistory = await this.backend.listHistoryChunks(saveKey);
    const nextHistoryIds = new Set(serialized.historyChunks.map(chunk => chunk.chunkId));
    await Promise.all(
      existingHistory
        .filter(chunk => !nextHistoryIds.has(chunk.chunkId))
        .map(chunk => this.backend.deleteHistoryChunk(saveKey, chunk.chunkId))
    );
    await Promise.all(
      serialized.historyChunks.map(chunk =>
        this.backend.putHistoryChunk(saveKey, chunk.chunkId, chunk.range, chunk.entries)
      )
    );
    this.chunkCache.set(saveKey, serialized.historyChunks);

    const existingStatus = await this.backend.listStatusChangeChunks(saveKey);
    const nextStatusIds = new Set(serialized.statusChangeChunks.map(chunk => chunk.chunkId));
    await Promise.all(
      existingStatus
        .filter(chunk => !nextStatusIds.has(chunk.chunkId))
        .map(chunk => this.backend.deleteStatusChangeChunk(saveKey, chunk.chunkId))
    );
    await Promise.all(
      serialized.statusChangeChunks.map(chunk =>
        this.backend.putStatusChangeChunk(saveKey, chunk.chunkId, chunk.range, chunk.entries)
      )
    );

    const existingImages = await this.backend.listImages(saveKey);
    const existingImageSet = new Set(existingImages);
    await Promise.all(
      serialized.images
        .filter(image => !existingImageSet.has(image.imageId))
        .map(image => this.backend.putImage(saveKey, image.imageId, image.blob, image.mime))
    );
  }

  async fetchHistoryBefore(
    saveKey: string,
    beforeIndex: number,
    limitEntries: number
  ): Promise<HistoryEntry[]> {
    if (beforeIndex <= 0 || limitEntries <= 0) return [];
    const chunks = sortChunks(this.chunkCache.get(saveKey) ?? await this.backend.listHistoryChunks(saveKey));
    this.chunkCache.set(saveKey, chunks);
    const relevant = chunks.filter(chunk => chunk.range[0] < beforeIndex);
    if (relevant.length === 0) return [];
    const result: HistoryEntry[] = [];
    for (let i = relevant.length - 1; i >= 0 && result.length < limitEntries; i -= 1) {
      const chunk = relevant[i];
      const data = await this.backend.getHistoryChunk(saveKey, chunk.chunkId);
      if (!data?.entries?.length) continue;
      let entries = data.entries;
      if (beforeIndex <= chunk.range[1]) {
        const cutoff = Math.max(0, beforeIndex - chunk.range[0]);
        entries = entries.slice(0, cutoff);
      }
      const remaining = limitEntries - result.length;
      const slice = entries.slice(-remaining);
      result.unshift(...slice);
    }
    return result;
  }

  async resolveImageUrl(saveKey: string, historyIndex: number): Promise<string | null> {
    const imageId = buildImageId(historyIndex);
    const cacheKey = `${saveKey}::${imageId}`;
    const cached = this.imageUrlCache.get(cacheKey);
    if (cached) return cached;
    const image = await this.backend.getImage(saveKey, imageId);
    if (!image) return null;
    const url = URL.createObjectURL(image.blob);
    this.imageUrlCache.set(cacheKey, url);
    return url;
  }

  async exportZip(saveKey: string): Promise<Blob | null> {
    const local = await this.backend.readLocalState(saveKey);
    if (!local) return null;
    const zip = new JSZip();
    const rootName = `save_${saveKey}`;
    const root = zip.folder(rootName);
    if (!root) throw new Error('Unable to create zip root.');
    root.file('localStorage/root_save.json', JSON.stringify(local, null, 2));

    const historyChunks = sortChunks(await this.backend.listHistoryChunks(saveKey));
    const statusChunks = sortChunks(await this.backend.listStatusChangeChunks(saveKey));
    const images = await this.backend.listImages(saveKey);

    const meta = {
      historyChunks,
      statusChangeChunks: statusChunks,
      images: [] as { imageId: string; mime: string }[]
    };

    for (const chunk of historyChunks) {
      const data = await this.backend.getHistoryChunk(saveKey, chunk.chunkId);
      if (!data) continue;
      root.file(
        `indexedDB/history/${chunk.chunkId}.json`,
        JSON.stringify({ range: data.range, entries: data.entries }, null, 2)
      );
    }

    for (const chunk of statusChunks) {
      const data = await this.backend.getStatusChangeChunk(saveKey, chunk.chunkId);
      if (!data) continue;
      root.file(
        `indexedDB/status_change/${chunk.chunkId}.json`,
        JSON.stringify({ range: data.range, entries: data.entries }, null, 2)
      );
    }

    for (const imageId of images) {
      const image = await this.backend.getImage(saveKey, imageId);
      if (!image) continue;
      meta.images.push({ imageId, mime: image.mime });
      root.file(`indexedDB/images/${imageId}.bin`, image.blob);
    }

    root.file('indexedDB/meta.json', JSON.stringify(meta, null, 2));
    return await zip.generateAsync({ type: 'blob' });
  }

  async importZip(
    saveKey: string,
    blob: Blob,
    options: { username?: string | null } = {}
  ) {
    const zip = await JSZip.loadAsync(blob);
    const localFile = Object.values(zip.files)
      .find(file => file.name.endsWith('localStorage/root_save.json'));
    if (!localFile) throw new Error('Missing root_save.json');
    const rootPrefix = localFile.name.replace('localStorage/root_save.json', '');
    const rawLocal = await readJsonFile(localFile);
    let rootSave: RootSaveJson | null = null;
    if (rawLocal?.gameState) {
      rootSave = rawLocal as RootSaveJson;
    } else if (rawLocal?.history && rawLocal?.settings) {
      rootSave = {
        version: 1,
        username: options.username ?? null,
        savedAt: new Date().toISOString(),
        gameState: rawLocal as GameState
      };
    }
    if (!rootSave) throw new Error('Invalid save format');
    if (typeof options.username === 'string') {
      rootSave = { ...rootSave, username: options.username };
    }

    await this.backend.deleteSave(saveKey);
    await this.backend.writeLocalState(saveKey, rootSave);

    const metaFile = zip.file(`${rootPrefix}indexedDB/meta.json`);
    const meta = metaFile ? await readJsonFile(metaFile) : null;
    const imageMimeMap = new Map<string, string>();
    if (meta?.images) {
      meta.images.forEach((entry: any) => {
        if (entry?.imageId && entry?.mime) {
          imageMimeMap.set(entry.imageId, entry.mime);
        }
      });
    }

    const historyFiles = Object.values(zip.files).filter(file =>
      file.name.startsWith(`${rootPrefix}indexedDB/history/`) && file.name.endsWith('.json')
    );
    for (const file of historyFiles) {
      const chunkId = file.name.split('/').pop()!.replace(/\.json$/, '');
      const data = await readJsonFile(file);
      if (data?.entries && data?.range) {
        await this.backend.putHistoryChunk(saveKey, chunkId, data.range, data.entries);
      }
    }

    const statusFiles = Object.values(zip.files).filter(file =>
      file.name.startsWith(`${rootPrefix}indexedDB/status_change/`) && file.name.endsWith('.json')
    );
    for (const file of statusFiles) {
      const chunkId = file.name.split('/').pop()!.replace(/\.json$/, '');
      const data = await readJsonFile(file);
      if (data?.entries && data?.range) {
        await this.backend.putStatusChangeChunk(saveKey, chunkId, data.range, data.entries);
      }
    }

    const imageFiles = Object.values(zip.files).filter(file =>
      file.name.startsWith(`${rootPrefix}indexedDB/images/`) && file.name.endsWith('.bin')
    );
    for (const file of imageFiles) {
      const imageId = file.name.split('/').pop()!.replace(/\.bin$/, '');
      const mime = imageMimeMap.get(imageId) || 'application/octet-stream';
      const buffer = await file.async('arraybuffer');
      const imageBlob = new Blob([buffer], { type: mime });
      await this.backend.putImage(saveKey, imageId, imageBlob, mime);
    }
    this.chunkCache.delete(saveKey);
    this.imageUrlCache.clear();
  }

  async deleteSave(saveKey: string) {
    await this.backend.deleteSave(saveKey);
    this.chunkCache.delete(saveKey);
    for (const key of this.imageUrlCache.keys()) {
      if (key.startsWith(`${saveKey}::`)) {
        this.imageUrlCache.delete(key);
      }
    }
  }
}
