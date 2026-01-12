import { GameSettings, UserTier } from './types';

export const ADMIN_MAX_AP = 100;
export const NORMAL_MAX_AP = 5;
export const GUEST_MAX_AP = 20;

export type ApRecoveryConfig = { amount: number; intervalMs: number };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const TIER_SETTINGS: Record<UserTier, {
  maxAp: number;
  minImageTurns: number;
  defaultImageTurns: number;
  historyLimit: number;
  apRecovery?: ApRecoveryConfig | null;
}> = {
  admin: { maxAp: ADMIN_MAX_AP, minImageTurns: 1, defaultImageTurns: 1, historyLimit: 100, apRecovery: null },
  normal: { maxAp: NORMAL_MAX_AP, minImageTurns: 20, defaultImageTurns: 20, historyLimit: 100, apRecovery: { amount: 1, intervalMs: HOUR_MS } },
  guest: { maxAp: GUEST_MAX_AP, minImageTurns: 20, defaultImageTurns: 20, historyLimit: 20, apRecovery: null }
};

export const DEFAULT_SETTINGS: GameSettings = {
  highQualityImages: true,
  imageEveryTurns: TIER_SETTINGS.normal.defaultImageTurns,
  maxHistoryTurns: TIER_SETTINGS.normal.historyLimit,
  useProxy: false,
  proxyBaseUrl: '',
  modelProvider: 'gemini',
  textModel: '',
  imageModel: ''
};

export const getTierSettings = (tier: UserTier) => TIER_SETTINGS[tier];

export const getMaxApForTier = (tier: UserTier) => TIER_SETTINGS[tier].maxAp;

export const getMinImageTurnsForTier = (tier: UserTier) => TIER_SETTINGS[tier].minImageTurns;

export const getDefaultImageTurnsForTier = (tier: UserTier) =>
  TIER_SETTINGS[tier].defaultImageTurns;

export const getHistoryLimitForTier = (tier: UserTier) =>
  TIER_SETTINGS[tier].historyLimit;

export const getApRecoveryForTier = (tier: UserTier) =>
  TIER_SETTINGS[tier].apRecovery ?? null;

export const normalizeSettingsForTier = (
  settings: GameSettings,
  tier: UserTier,
  minTurnsOverride?: number
) => {
  const minTurns = typeof minTurnsOverride === 'number'
    ? minTurnsOverride
    : getMinImageTurnsForTier(tier);
  const fallbackTurns = settings.imageEveryTurns || getDefaultImageTurnsForTier(tier);
  const rawHistory = settings.maxHistoryTurns;
  const historyValue = Number.isFinite(rawHistory)
    ? Math.trunc(rawHistory as number)
    : DEFAULT_SETTINGS.maxHistoryTurns;
  const normalizedHistory = historyValue === -1
    ? -1
    : historyValue < -1
      ? -1
      : Math.max(1, historyValue);
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    imageEveryTurns: Math.max(minTurns, Math.floor(fallbackTurns)),
    maxHistoryTurns: normalizedHistory
  };
};
