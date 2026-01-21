import type { GameSettings, GameState, HistoryEntry, StatusChangeEntry } from '../types';
import type {
  RootSaveJson,
  HistoryChunkData,
  StatusChangeChunkData,
  SaveImageData
} from './types';

export const DEFAULT_HISTORY_CHUNK_SIZE = 100;
export const DEFAULT_LOCAL_HISTORY_LIMIT = 200;

export interface SerializedSave {
  localState: RootSaveJson;
  historyChunks: HistoryChunkData[];
  statusChangeChunks: StatusChangeChunkData[];
  images: SaveImageData[];
  historyBaseIndex: number;
  statusChangeBaseIndex: number;
}

const DATA_URL_PATTERN = /^data:([^;,]+);base64,(.+)$/;

const isDataImageUrl = (value?: string) =>
  typeof value === 'string' && value.startsWith('data:image/');

const decodeDataUrl = (dataUrl: string): { mime: string; blob: Blob } | null => {
  const match = dataUrl.match(DATA_URL_PATTERN);
  if (!match) return null;
  const mime = match[1];
  const base64 = match[2].replace(/\s/g, '');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return { mime, blob: new Blob([bytes], { type: mime }) };
};

export const getStorageHistoryLimit = (
  settings: GameSettings,
  fallback: number = DEFAULT_LOCAL_HISTORY_LIMIT
) => {
  const raw = Number.isFinite(settings?.maxHistoryTurns)
    ? Math.trunc(settings.maxHistoryTurns)
    : fallback;
  if (raw === -1) return Math.max(1, fallback);
  return Math.max(1, raw);
};

const chunkEntries = <T>(
  entries: T[],
  chunkSize: number,
  rangeOffset = 0
): { chunkId: string; range: [number, number]; entries: T[] }[] => {
  if (entries.length === 0) return [];
  const safeSize = Math.max(1, Math.floor(chunkSize));
  const chunks: { chunkId: string; range: [number, number]; entries: T[] }[] = [];
  for (let i = 0; i < entries.length; i += safeSize) {
    const slice = entries.slice(i, i + safeSize);
    const rangeStart = rangeOffset + i;
    const rangeEnd = rangeStart + slice.length - 1;
    const chunkId = `chunk_${String(chunks.length).padStart(4, '0')}`;
    chunks.push({ chunkId, range: [rangeStart, rangeEnd], entries: slice });
  }
  return chunks;
};

const cleanHistoryForStorage = (
  history: HistoryEntry[]
): { cleaned: HistoryEntry[]; images: SaveImageData[] } => {
  const images: SaveImageData[] = [];
  const imageIds = new Set<string>();
  const cleaned = history.map((entry, index) => {
    const imageUrl = entry?.imageUrl;
    if (isDataImageUrl(imageUrl)) {
      const imageId = `h_${index}`;
      if (!imageIds.has(imageId)) {
        const decoded = decodeDataUrl(imageUrl as string);
        if (decoded) {
          images.push({ imageId, blob: decoded.blob, mime: decoded.mime });
          imageIds.add(imageId);
        }
      }
      return { ...entry, imageUrl: '' };
    }
    return { ...entry };
  });
  return { cleaned, images };
};

const cleanStatusChangesForStorage = (changes: StatusChangeEntry[]) =>
  changes.map(change => ({ ...change }));

export const serializeRuntimeState = (
  state: GameState,
  options: {
    username?: string | null;
    savedAt?: string;
    chunkSize?: number;
    localHistoryLimit?: number;
  } = {}
): SerializedSave => {
  const savedAt = options.savedAt ?? new Date().toISOString();
  const username = options.username ?? null;
  const historyLimit = options.localHistoryLimit ?? getStorageHistoryLimit(state.settings);
  const fullHistory = Array.isArray(state.history) ? state.history : [];
  const { cleaned: cleanedHistory, images } = cleanHistoryForStorage(fullHistory);
  const localHistory = cleanedHistory.slice(-historyLimit);
  const historyBaseIndex = Math.max(0, cleanedHistory.length - localHistory.length);
  const historyHead = cleanedHistory.slice(0, historyBaseIndex);
  const historyChunks = chunkEntries(
    historyHead,
    options.chunkSize ?? DEFAULT_HISTORY_CHUNK_SIZE
  ).map(chunk => ({
    chunkId: chunk.chunkId,
    range: chunk.range,
    entries: chunk.entries
  }));

  const statusTrack = state.status_track ?? null;
  const fullStatusChanges = statusTrack?.status_change ?? [];
  const cleanedStatusChanges = cleanStatusChangesForStorage(fullStatusChanges);
  const localStatusChanges = cleanedStatusChanges.slice(-historyLimit);
  const statusChangeBaseIndex = Math.max(0, cleanedStatusChanges.length - localStatusChanges.length);
  const statusHead = cleanedStatusChanges.slice(0, statusChangeBaseIndex);
  const statusChangeChunks = chunkEntries(
    statusHead,
    options.chunkSize ?? DEFAULT_HISTORY_CHUNK_SIZE
  ).map(chunk => ({
    chunkId: chunk.chunkId,
    range: chunk.range,
    entries: chunk.entries
  }));

  const localState: RootSaveJson = {
    version: 1,
    username,
    savedAt,
    gameState: {
      ...state,
      history: localHistory,
      status_track: statusTrack
        ? {
          ...statusTrack,
          status_change: localStatusChanges
        }
        : statusTrack
    }
  };

  return {
    localState,
    historyChunks,
    statusChangeChunks,
    images,
    historyBaseIndex,
    statusChangeBaseIndex
  };
};

