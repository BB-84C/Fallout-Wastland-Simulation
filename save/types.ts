import type { GameState, HistoryEntry, StatusChangeEntry } from '../types';

export interface RootSaveJson {
  version: number;
  username: string | null;
  savedAt: string;
  gameState: GameState;
}

export interface HistoryChunkSummary {
  chunkId: string;
  range: [number, number];
}

export interface StatusChangeChunkSummary {
  chunkId: string;
  range: [number, number];
}

export interface HistoryChunkData extends HistoryChunkSummary {
  entries: HistoryEntry[];
}

export interface StatusChangeChunkData extends StatusChangeChunkSummary {
  entries: StatusChangeEntry[];
}

export interface SaveImageData {
  imageId: string;
  blob: Blob;
  mime: string;
}

export interface SaveBackend {
  readLocalState(saveKey: string): Promise<RootSaveJson | null>;
  writeLocalState(saveKey: string, data: RootSaveJson): Promise<void>;

  putHistoryChunk(
    saveKey: string,
    chunkId: string,
    range: [number, number],
    entries: HistoryEntry[]
  ): Promise<void>;
  getHistoryChunk(saveKey: string, chunkId: string): Promise<HistoryChunkData | null>;
  listHistoryChunks(saveKey: string): Promise<HistoryChunkSummary[]>;
  deleteHistoryChunk(saveKey: string, chunkId: string): Promise<void>;

  putStatusChangeChunk(
    saveKey: string,
    chunkId: string,
    range: [number, number],
    entries: StatusChangeEntry[]
  ): Promise<void>;
  getStatusChangeChunk(saveKey: string, chunkId: string): Promise<StatusChangeChunkData | null>;
  listStatusChangeChunks(saveKey: string): Promise<StatusChangeChunkSummary[]>;
  deleteStatusChangeChunk(saveKey: string, chunkId: string): Promise<void>;

  putImage(saveKey: string, imageId: string, blob: Blob, mime: string): Promise<void>;
  getImage(saveKey: string, imageId: string): Promise<{ blob: Blob; mime: string } | null>;
  listImages(saveKey: string): Promise<string[]>;
  deleteImage(saveKey: string, imageId: string): Promise<void>;

  deleteSave(saveKey: string): Promise<void>;
}

export const isRootSaveJson = (value: any): value is RootSaveJson =>
  !!value
  && typeof value === 'object'
  && typeof value.version === 'number'
  && typeof value.savedAt === 'string'
  && value.gameState
  && typeof value.gameState === 'object';

