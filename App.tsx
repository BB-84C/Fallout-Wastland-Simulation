
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { GameState, Actor, Language, Quest, HistoryEntry, GameSettings, UserRecord, UserTier, CompanionUpdate, PlayerCreationResult, ModelProvider, SpecialAttr, Skill, SkillSet, SpecialSet, TokenUsage, StatusChange, StatusTrack, StatusSnapshot, StatusChangeEntry, InventoryItem, InventoryChange, PlayerChange, ArenaState, PipelineMode, EventOutcome, EventNarrationResponse, InterfaceColor, SavedStatusSnapshot } from './types';
import { DEFAULT_SPECIAL, FALLOUT_ERA_STARTS } from './constants';
import { formatYear, localizeLocation } from './localization';
import Terminal from './components/Terminal';
import StatBar from './components/StatBar';
import { createPlayerCharacter, getNarrativeResponse, getArenaNarration, getStatusUpdate, getEventOutcome, getEventNarration, auditInventoryWeights, recoverInventoryStatus, generateSceneImage, generateArenaAvatar, generateCompanionAvatar, compressMemory } from './services/modelService';
import wechatQr from './assets/wech.png';
import alipayQr from './assets/zhif.png';
import venmoQr from './assets/venm.png';
import {
  NORMAL_MAX_AP,
  GUEST_MAX_AP,
  DEFAULT_SETTINGS,
  getApRecoveryForTier,
  getDefaultImageTurnsForTier,
  getHistoryLimitForTier,
  getMaxApForTier,
  getMinImageTurnsForTier,
  normalizeSettingsForTier
} from './tierSettings';
import type { ApRecoveryConfig } from './tierSettings';

const SAVE_KEY_PREFIX = 'fallout_wasteland_save';
const ARENA_SAVE_KEY_PREFIX = 'fallout_wasteland_arena_save';
const USERS_DB_KEY = 'fallout_users_db';
const USER_API_KEY_PREFIX = 'fallout_user_api_key';
const USER_PROXY_KEY_PREFIX = 'fallout_user_proxy_key';
const USER_ONBOARD_PREFIX = 'fallout_user_onboarded';
const RESERVED_ADMIN_USERNAME = 'admin';
const GUEST_COOLDOWN_KEY = 'fallout_guest_cooldown_until';
const GUEST_COOLDOWN_MS = 30 * 60 * 1000;
const MEMORY_ENTRY_TAG = 'COMPRESSED MEMORY';
const DEFAULT_USER_PROMPT_ZH = `1. 输出约 800 tokens 的叙事内容。
2. 每轮给出三个可选行动，行动应体现不同的风险结构，而不是简单的“成功率高低”。
3. 玩家追求高难度体验：
   - 成功通常伴随代价或长期后果。
   - 失败不一定立刻致命，但会改变局势或资源结构。
4. 鼓励出现看似非常规、但事后逻辑自洽的情节发展。
5. 避免直接依赖运气或奇迹；如果出现偶然因素，其作用必须有限。除非玩家角色的某个SPECIAL属性很高（>7） 。`;
const DEFAULT_USER_PROMPT_EN = `1. Generate approximately 800 tokens of narrative content.
2. Present three action options per round, each reflecting distinct risk structures rather than simple "success rate variations."
3. Players seek high-difficulty experiences:
   - Success often comes with costs or long-term consequences.
   - Failure isn't immediately fatal but alters the situation or resource dynamics.
4. Encourage plot developments that seem unconventional but become logically consistent in hindsight.
5. Avoid direct reliance on luck or miracles; if random elements occur, their impact must be limited. Exceptions apply only if a player character possesses an exceptionally high SPECIAL attribute (>7). `;
const DEFAULT_ARENA_PROMPT_ZH = `1. 输出约 1000 tokens，完整描述冲突的展开与结果。
2. 不仅比较军力规模与装备，还需考虑：
   - 地形与基础设施
   - 情报不对称
   - 后勤与补给
   - 阵营文化与战术偏好
3. 如果一方处于明显劣势，应优先探索非正面对抗手段。
4. 决定胜负前，应至少发生一次改变局势的关键行动或失误。
5. 战斗结果必须可被复盘为一条因果链，而非简单的“谁更强”。`;
const DEFAULT_ARENA_PROMPT_EN = `1. Output approximately 1000 tokens, fully describing the conflict's progression and outcome.
2. Consider not only military strength and equipment, but also:
   - Terrain and infrastructure
   - Information asymmetry
   - Logistics and supply chains
   - Faction culture and tactical preferences
3. If one side is at a significant disadvantage, prioritize exploring non-confrontational approaches.
4. At least one pivotal action or critical error must occur before determining the outcome.
5. The battle result must be traceable as a chain of causality, not merely "who was stronger.".`;
const MODEL_PROVIDER_OPTIONS: { value: ModelProvider; label: string }[] = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'claude', label: 'Claude' },
  { value: 'doubao', label: 'Doubao' }
];

const syncApState = (
  ap: number,
  apLastUpdated: number,
  now: number,
  maxAp: number,
  recovery: ApRecoveryConfig | null
) => {
  if (!recovery || recovery.amount <= 0 || recovery.intervalMs <= 0) {
    return { ap, apLastUpdated };
  }
  if (ap >= maxAp) return { ap, apLastUpdated };
  const elapsed = Math.max(0, now - apLastUpdated);
  if (elapsed < recovery.intervalMs) return { ap, apLastUpdated };
  const intervals = Math.floor(elapsed / recovery.intervalMs);
  const recovered = intervals * recovery.amount;
  const nextAp = Math.min(maxAp, ap + recovered);
  const nextLastUpdated = apLastUpdated + intervals * recovery.intervalMs;
  return { ap: nextAp, apLastUpdated: nextLastUpdated };
};

const getSaveKey = (username: string) => `${SAVE_KEY_PREFIX}_${username}`;
const getArenaSaveKey = (username: string) => `${ARENA_SAVE_KEY_PREFIX}_${username}`;
type ApiKeyScope = 'text' | 'image';

const getUserApiKeyKey = (username: string, provider: ModelProvider, scope?: ApiKeyScope) =>
  `${USER_API_KEY_PREFIX}_${username}_${provider}${scope ? `_${scope}` : ''}`;
const getUserProxyKeyKey = (username: string, provider: ModelProvider, scope?: ApiKeyScope) =>
  `${USER_PROXY_KEY_PREFIX}_${username}_${provider}${scope ? `_${scope}` : ''}`;
const getUserOnboardKey = (username: string) => `${USER_ONBOARD_PREFIX}_${username}`;

const loadUserApiKey = (username: string, provider: ModelProvider, scope?: ApiKeyScope) => {
  try {
    const scopedKey = getUserApiKeyKey(username, provider, scope);
    const scopedValue = localStorage.getItem(scopedKey);
    if (scopedValue !== null) return scopedValue;
    if (!scope) return '';
    return localStorage.getItem(getUserApiKeyKey(username, provider)) || '';
  } catch {
    return '';
  }
};

const loadUserProxyKey = (username: string, provider: ModelProvider, scope?: ApiKeyScope) => {
  try {
    const scopedKey = getUserProxyKeyKey(username, provider, scope);
    const scopedValue = localStorage.getItem(scopedKey);
    if (scopedValue !== null) return scopedValue;
    if (!scope) return '';
    return localStorage.getItem(getUserProxyKeyKey(username, provider)) || '';
  } catch {
    return '';
  }
};

const persistUserApiKey = (
  username: string,
  provider: ModelProvider,
  key: string,
  scope?: ApiKeyScope
) => {
  try {
    const trimmed = key.trim();
    const storageKey = getUserApiKeyKey(username, provider, scope);
    if (!trimmed) {
      localStorage.removeItem(storageKey);
      return;
    }
    localStorage.setItem(storageKey, trimmed);
  } catch {
    // Ignore storage errors.
  }
};

const persistUserProxyKey = (
  username: string,
  provider: ModelProvider,
  key: string,
  scope?: ApiKeyScope
) => {
  try {
    const trimmed = key.trim();
    const storageKey = getUserProxyKeyKey(username, provider, scope);
    if (!trimmed) {
      localStorage.removeItem(storageKey);
      return;
    }
    localStorage.setItem(storageKey, trimmed);
  } catch {
    // Ignore storage errors.
  }
};

const normalizeProxyBaseUrl = (value: string) => value.trim().replace(/\/+$/, '');
const clampNumber = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const DEFAULT_INTERFACE_COLOR: InterfaceColor = DEFAULT_SETTINGS.interfaceColor ?? { r: 26, g: 255, b: 26 };
const buildSavedSnapshot = (state: GameState): SavedStatusSnapshot => ({
  compressedMemory: state.compressedMemory || '',
  compressionTurnCounter: typeof state.compressionTurnCounter === 'number' ? state.compressionTurnCounter : 0,
  currentTime: state.currentTime,
  currentYear: state.currentYear,
  knownNpcs: state.knownNpcs,
  location: state.location,
  player: state.player,
  quests: state.quests,
  tokenUsage: state.tokenUsage,
  turnCount: state.turnCount
});

const normalizeHistorySavedFlags = (history: HistoryEntry[]) =>
  history.map(entry => (typeof entry.isSaved === 'boolean' ? entry : { ...entry, isSaved: true }));

const normalizeStatusChangeSavedFlags = (changes: StatusChangeEntry[]) =>
  changes.map(change => (typeof change.isSaved === 'boolean' ? change : { ...change, isSaved: true }));

const markHistorySaved = (history: HistoryEntry[]) =>
  history.map(entry => ({ ...entry, isSaved: true }));

const markStatusChangesSaved = (changes: StatusChangeEntry[]) =>
  changes.map(change => ({ ...change, isSaved: true }));

const filterUnsavedHistory = (history: HistoryEntry[]) =>
  history.filter(entry => entry.isSaved !== false);

const filterUnsavedStatusChanges = (changes: StatusChangeEntry[]) =>
  changes.filter(change => change.isSaved !== false);

const normalizeSavedSnapshot = (raw: any, fallback: GameState): SavedStatusSnapshot | null => {
  if (!raw || typeof raw !== 'object') return null;
  const hasPlayer = Object.prototype.hasOwnProperty.call(raw, 'player');
  const hasKnownNpcs = Object.prototype.hasOwnProperty.call(raw, 'knownNpcs');
  const playerValue = raw.player;
  const knownNpcValue = raw.knownNpcs;
  const normalizedPlayer = hasPlayer
    ? (playerValue === null ? null : (playerValue ? normalizeActor(playerValue) : fallback.player))
    : fallback.player;
  const normalizedKnownNpcs = hasKnownNpcs && Array.isArray(knownNpcValue)
    ? normalizeKnownNpcList(knownNpcValue).cleaned
    : fallback.knownNpcs;
  const tokenUsage = raw?.tokenUsage ? normalizeTokenUsage(raw.tokenUsage) : fallback.tokenUsage;
  return {
    compressedMemory: typeof raw?.compressedMemory === 'string' ? raw.compressedMemory : fallback.compressedMemory,
    compressionTurnCounter: typeof raw?.compressionTurnCounter === 'number'
      ? raw.compressionTurnCounter
      : fallback.compressionTurnCounter,
    currentTime: typeof raw?.currentTime === 'string' ? raw.currentTime : fallback.currentTime,
    currentYear: typeof raw?.currentYear === 'number' ? Math.trunc(raw.currentYear) : fallback.currentYear,
    knownNpcs: normalizedKnownNpcs,
    location: typeof raw?.location === 'string' ? raw.location : fallback.location,
    player: normalizedPlayer,
    quests: Array.isArray(raw?.quests) ? raw.quests : fallback.quests,
    tokenUsage,
    turnCount: typeof raw?.turnCount === 'number' ? Math.trunc(raw.turnCount) : fallback.turnCount
  };
};

const isLikelyJsonParseError = (detail: string) => {
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("expected ',' or ']'") ||
    normalized.includes('unexpected end of json input') ||
    normalized.includes('unexpected token') ||
    normalized.includes('json at position') ||
    normalized.includes('json parse failed')
  );
};

const appendJsonParseGuidance = (detail: string, isZh: boolean) => {
  if (!isLikelyJsonParseError(detail)) return detail;
  const guidance = isZh
    ? '请打开设置，查看「原始输出缓存」中的信息，如果有正常的文字对话，但是明显末尾处一句话没说完就结束了，并且没有以任何"]"或者“}” 作为结尾。那就说明这通常是设备与模型提供方的连接中断导致（例如外出乘车使用了手机流量数据、启用的 VPN连接不稳定，或当前网络不稳定）。'
    : 'Please open Settings and check the information in the "Raw Output Cache." If you see normal text dialogue but notice that a sentence abruptly ends without finishing, and there is no closing "]" or "}" character, this typically indicates a connection interruption between the device and the model provider. This can occur due to factors such as using mobile data while commuting, an unstable VPN connection, or poor network conditions.';
  return `${detail}\n${guidance}`;
};

const clampColorChannel = (value: number, fallback: number) => {
  if (!Number.isFinite(value)) return fallback;
  return Math.round(clampNumber(value, 0, 255));
};

const normalizeInterfaceColor = (
  value?: Partial<InterfaceColor> | null,
  fallback: InterfaceColor = DEFAULT_INTERFACE_COLOR
): InterfaceColor => {
  if (!value || typeof value !== 'object') return { ...fallback };
  return {
    r: clampColorChannel(Number(value.r), fallback.r),
    g: clampColorChannel(Number(value.g), fallback.g),
    b: clampColorChannel(Number(value.b), fallback.b)
  };
};

const mixColorChannel = (value: number, mix: number) =>
  Math.round(clampNumber(value + (255 - value) * mix, 0, 255));

const buildSoftColor = (color: InterfaceColor): InterfaceColor => ({
  r: mixColorChannel(color.r, 0.75),
  g: mixColorChannel(color.g, 0.75),
  b: mixColorChannel(color.b, 0.75)
});

const PANEL_BASE_WIDTH = 320;
const STAT_PANEL_MIN = 240;
const STAT_PANEL_MAX = 520;
const ARENA_PANEL_MIN = 240;
const ARENA_PANEL_MAX = 520;
const VIEW_PADDING_CLASS = 'pt-[15vh] pb-[5vh] md:pt-0 md:pb-0 box-border';

const isUserOnboarded = (username: string) => {
  try {
    return localStorage.getItem(getUserOnboardKey(username)) === '1';
  } catch {
    return false;
  }
};

const markUserOnboarded = (username: string) => {
  try {
    localStorage.setItem(getUserOnboardKey(username), '1');
  } catch {
    // Ignore storage errors.
  }
};

const getGuestCooldownRemainingMs = () => {
  try {
    const raw = localStorage.getItem(GUEST_COOLDOWN_KEY);
    const until = raw ? Number(raw) : 0;
    if (!Number.isFinite(until)) return 0;
    return Math.max(0, until - Date.now());
  } catch {
    return 0;
  }
};

const setGuestCooldownUntil = (until: number) => {
  try {
    localStorage.setItem(GUEST_COOLDOWN_KEY, String(until));
  } catch {
    // Ignore storage errors.
  }
};

const lockImageTurnsForTier = (settings: GameSettings, tier: UserTier, hasKey: boolean) => {
  if (tier === 'normal' && !hasKey) {
    const fixed = getDefaultImageTurnsForTier('normal');
    if (settings.imageEveryTurns !== fixed) {
      return { ...settings, imageEveryTurns: fixed };
    }
  }
  if (tier === 'guest') {
    const fixed = getDefaultImageTurnsForTier('guest');
    if (settings.imageEveryTurns !== fixed) {
      return { ...settings, imageEveryTurns: fixed };
    }
  }
  return settings;
};

const lockHistoryTurnsForTier = (settings: GameSettings, tier: UserTier) => {
  if (tier === 'guest') {
    const fixed = getHistoryLimitForTier('guest');
    if (settings.maxHistoryTurns !== fixed) {
      return { ...settings, maxHistoryTurns: fixed };
    }
  }
  return settings;
};

const normalizeKey = (value: string) =>
  value.toLowerCase().replace(/[\s\-_]+/g, '').trim();

const SPECIAL_KEY_MAP: Record<string, SpecialAttr> = {
  s: SpecialAttr.Strength,
  strength: SpecialAttr.Strength,
  str: SpecialAttr.Strength,
  p: SpecialAttr.Perception,
  perception: SpecialAttr.Perception,
  per: SpecialAttr.Perception,
  e: SpecialAttr.Endurance,
  endurance: SpecialAttr.Endurance,
  end: SpecialAttr.Endurance,
  c: SpecialAttr.Charisma,
  charisma: SpecialAttr.Charisma,
  cha: SpecialAttr.Charisma,
  i: SpecialAttr.Intelligence,
  intelligence: SpecialAttr.Intelligence,
  int: SpecialAttr.Intelligence,
  a: SpecialAttr.Agility,
  agility: SpecialAttr.Agility,
  agi: SpecialAttr.Agility,
  l: SpecialAttr.Luck,
  luck: SpecialAttr.Luck,
  力量: SpecialAttr.Strength,
  感知: SpecialAttr.Perception,
  耐力: SpecialAttr.Endurance,
  魅力: SpecialAttr.Charisma,
  智力: SpecialAttr.Intelligence,
  敏捷: SpecialAttr.Agility,
  幸运: SpecialAttr.Luck
};

const SKILL_ALIASES: Record<Skill, string[]> = {
  [Skill.SmallGuns]: ['small guns', 'smallguns', 'small_guns', '轻型枪械', '小型枪械', '轻枪械'],
  [Skill.BigGuns]: ['big guns', 'bigguns', 'big_guns', '重型枪械', '大型枪械'],
  [Skill.EnergyWeapons]: ['energy weapons', 'energyweapons', 'energy_weapons', '能量武器'],
  [Skill.Unarmed]: ['unarmed', '徒手', '徒手格斗', '徒手戰鬥'],
  [Skill.MeleeWeapons]: ['melee weapons', 'meleeweapons', 'melee_weapons', '近战武器', '近戰武器'],
  [Skill.Medicine]: ['medicine', '医药', '醫藥'],
  [Skill.Repair]: ['repair', '修理'],
  [Skill.Science]: ['science', '科学', '科學'],
  [Skill.Sneak]: ['sneak', '潜行', '潛行'],
  [Skill.Lockpick]: ['lockpick', 'lock pick', '开锁', '開鎖'],
  [Skill.Steal]: ['steal', '盗窃', '盜竊'],
  [Skill.Speech]: ['speech', '口才', '說服'],
  [Skill.Barter]: ['barter', '交易', '贸易', '貿易'],
  [Skill.Survival]: ['survival', '生存']
};

const SKILL_KEY_MAP: Record<string, Skill> = Object.values(Skill).reduce((acc, skill) => {
  acc[normalizeKey(skill)] = skill;
  SKILL_ALIASES[skill].forEach(alias => {
    acc[normalizeKey(alias)] = skill;
  });
  return acc;
}, {} as Record<string, Skill>);

const normalizeSpecial = (special: Record<string, any> | null | undefined) => {
  const next = { ...DEFAULT_SPECIAL };
  if (!special || typeof special !== 'object') return next;
  Object.entries(special).forEach(([key, value]) => {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) return;
    const normalized = normalizeKey(key);
    const mapped = SPECIAL_KEY_MAP[normalized] ?? SPECIAL_KEY_MAP[key];
    if (!mapped) return;
    next[mapped] = num;
  });
  return next;
};

const normalizeSpecialDelta = (special: Record<string, any> | null | undefined) => {
  const deltas: Partial<SpecialSet> = {};
  if (!special || typeof special !== 'object') return deltas;
  Object.entries(special).forEach(([key, value]) => {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) return;
    const normalized = normalizeKey(key);
    const mapped = SPECIAL_KEY_MAP[normalized] ?? SPECIAL_KEY_MAP[key];
    if (!mapped) return;
    const existing = deltas[mapped];
    deltas[mapped] = (typeof existing === 'number' ? existing : 0) + num;
  });
  return deltas;
};

const clampSpecialSet = (special: SpecialSet): SpecialSet => {
  const clamped = { ...special };
  Object.values(SpecialAttr).forEach(attr => {
    const value = typeof clamped[attr] === 'number' && Number.isFinite(clamped[attr])
      ? clamped[attr]
      : 0;
    clamped[attr] = clampNumber(value, 0, 10);
  });
  return clamped;
};

const buildSkillDefaults = (special: SpecialSet): SkillSet => ({
  [Skill.SmallGuns]: special[SpecialAttr.Agility] * 2 + 5,
  [Skill.BigGuns]: special[SpecialAttr.Endurance] * 2 + 5,
  [Skill.EnergyWeapons]: special[SpecialAttr.Perception] * 2 + 5,
  [Skill.Unarmed]: special[SpecialAttr.Endurance] * 2 + 5,
  [Skill.MeleeWeapons]: special[SpecialAttr.Strength] * 2 + 5,
  [Skill.Medicine]: special[SpecialAttr.Intelligence] * 2 + 5,
  [Skill.Repair]: special[SpecialAttr.Intelligence] * 2 + 5,
  [Skill.Science]: special[SpecialAttr.Intelligence] * 2 + 5,
  [Skill.Sneak]: special[SpecialAttr.Agility] * 2 + 5,
  [Skill.Lockpick]: special[SpecialAttr.Perception] * 2 + 5,
  [Skill.Steal]: special[SpecialAttr.Agility] * 2 + 5,
  [Skill.Speech]: special[SpecialAttr.Charisma] * 2 + 5,
  [Skill.Barter]: special[SpecialAttr.Charisma] * 2 + 5,
  [Skill.Survival]: special[SpecialAttr.Endurance] * 2 + 5
});

const normalizeSkills = (
  skills: Record<string, any> | null | undefined,
  special?: SpecialSet,
  includeDefaults = false
): SkillSet => {
  const normalizedSkills: SkillSet = includeDefaults && special
    ? buildSkillDefaults(special)
    : {};
  if (!skills || typeof skills !== 'object') return normalizedSkills;
  Object.entries(skills).forEach(([key, value]) => {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) return;
    const normalized = normalizeKey(key);
    const mapped = SKILL_KEY_MAP[normalized];
    if (!mapped) return;
    const existing = normalizedSkills[mapped];
    if (typeof existing === 'number') {
      normalizedSkills[mapped] = Math.max(existing, num);
    } else {
      normalizedSkills[mapped] = num;
    }
  });
  return normalizedSkills;
};

const normalizeSkillDelta = (skills: Record<string, any> | null | undefined): SkillSet => {
  const deltas: SkillSet = {};
  if (!skills || typeof skills !== 'object') return deltas;
  Object.entries(skills).forEach(([key, value]) => {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) return;
    const normalized = normalizeKey(key);
    const mapped = SKILL_KEY_MAP[normalized];
    if (!mapped) return;
    const existing = deltas[mapped];
    deltas[mapped] = (typeof existing === 'number' ? existing : 0) + num;
  });
  return deltas;
};

const clampSkillSet = (skills: SkillSet): SkillSet => {
  const clamped: SkillSet = { ...skills };
  Object.values(Skill).forEach(skill => {
    const value = clamped[skill];
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    clamped[skill] = clampNumber(value, 0, 100);
  });
  return clamped;
};

const normalizeInventoryItem = (item: InventoryItem): InventoryItem | null => {
  if (!item || typeof item !== 'object') return null;
  const count = Number.isFinite(item.count) ? Math.max(0, Math.floor(item.count)) : 1;
  if (count <= 0) return null;
  const weight = Number.isFinite(item.weight) ? item.weight : 0;
  const value = Number.isFinite(item.value) ? item.value : 0;
  return {
    ...item,
    weight,
    value,
    count,
    isConsumable: typeof item.isConsumable === 'boolean' ? item.isConsumable : false
  };
};

const normalizeInventory = (items: InventoryItem[] | undefined) => {
  if (!Array.isArray(items)) return [];
  return items
    .map(item => normalizeInventoryItem(item))
    .filter((item): item is InventoryItem => !!item);
};

const normalizeInventoryChange = (change?: InventoryChange | null) => {
  if (!change || typeof change !== 'object') return null;
  const add = Array.isArray(change.add) ? change.add : [];
  const remove = Array.isArray(change.remove) ? change.remove : [];
  return {
    add,
    remove
  };
};

const applyInventoryChange = (items: InventoryItem[], change?: InventoryChange | null) => {
  const normalizedChange = normalizeInventoryChange(change);
  if (!normalizedChange) return items;
  const next = normalizeInventory(items).map(item => ({ ...item }));
  const findIndex = (name: string) =>
    next.findIndex(item => normalizeKey(item.name) === normalizeKey(name));
  normalizedChange.remove.forEach(entry => {
    if (!entry?.name) return;
    const index = findIndex(entry.name);
    if (index < 0) return;
    const removeCount = Number.isFinite(entry.count) ? Math.max(1, Math.floor(entry.count)) : 1;
    const existing = next[index];
    const nextCount = existing.count - removeCount;
    if (nextCount > 0) {
      next[index] = { ...existing, count: nextCount };
    } else {
      next.splice(index, 1);
    }
  });
  normalizedChange.add.forEach(item => {
    const normalizedItem = normalizeInventoryItem(item);
    if (!normalizedItem) return;
    const index = findIndex(normalizedItem.name);
    if (index >= 0) {
      const existing = next[index];
      const nextCount = existing.count + normalizedItem.count;
      next[index] = {
        ...existing,
        count: nextCount,
        description: normalizedItem.description || existing.description,
        type: normalizedItem.type || existing.type,
        weight: Number.isFinite(normalizedItem.weight) ? normalizedItem.weight : existing.weight,
        value: Number.isFinite(normalizedItem.value) ? normalizedItem.value : existing.value,
        isConsumable: typeof normalizedItem.isConsumable === 'boolean' ? normalizedItem.isConsumable : existing.isConsumable
      };
    } else {
      next.push(normalizedItem);
    }
  });
  return normalizeInventory(next);
};

const applyPlayerChange = (base: Actor, change?: PlayerChange | null) => {
  if (!change) return base;
  const next: Actor = { ...base };
  const hasHealthDelta = Number.isFinite(change.health);
  const hasMaxHealthDelta = Number.isFinite(change.maxHealth);
  if (hasHealthDelta || hasMaxHealthDelta) {
    const baseHealth = Number.isFinite(next.health) ? next.health : 0;
    const baseMaxHealth = Number.isFinite(next.maxHealth) ? next.maxHealth : 1;
    const healthDelta = hasHealthDelta ? (change.health as number) : 0;
    const maxHealthDelta = hasMaxHealthDelta ? (change.maxHealth as number) : 0;
    const updatedMaxHealth = Math.max(1, baseMaxHealth + maxHealthDelta);
    const updatedHealth = clampNumber(baseHealth + healthDelta, 0, updatedMaxHealth);
    next.maxHealth = updatedMaxHealth;
    next.health = updatedHealth;
  }
  if (Number.isFinite(change.caps)) {
    const delta = change.caps as number;
    next.caps = Math.max(0, (Number.isFinite(next.caps) ? next.caps : 0) + delta);
  }
  if (Number.isFinite(change.karma)) {
    const delta = change.karma as number;
    const baseKarma = Number.isFinite(next.karma) ? next.karma : 0;
    next.karma = clampNumber(baseKarma + delta, -100, 100);
  }
  const baseSpecial = normalizeSpecial(next.special);
  const specialDelta = normalizeSpecialDelta(change.special);
  if (Object.keys(specialDelta).length > 0) {
    const updatedSpecial = { ...baseSpecial };
    Object.entries(specialDelta).forEach(([key, delta]) => {
      const attr = key as SpecialAttr;
      const baseValue = Number.isFinite(updatedSpecial[attr]) ? updatedSpecial[attr] : 0;
      updatedSpecial[attr] = baseValue + (delta as number);
    });
    next.special = updatedSpecial;
  }
  const baseSkills = normalizeSkills(next.skills, baseSpecial, true);
  const skillDelta = normalizeSkillDelta(change.skills);
  if (Object.keys(skillDelta).length > 0) {
    const updatedSkills = { ...next.skills };
    Object.entries(skillDelta).forEach(([key, delta]) => {
      const skill = key as Skill;
      const baseValue = Number.isFinite(baseSkills[skill] as number) ? (baseSkills[skill] as number) : 0;
      updatedSkills[skill] = baseValue + (delta as number);
    });
    next.skills = updatedSkills;
  }
  if (Array.isArray(change.perksAdd) && change.perksAdd.length > 0) {
    const existingNames = new Set(next.perks.map(perk => perk.name));
    const added = change.perksAdd.filter(perk => perk?.name && !existingNames.has(perk.name));
    next.perks = [...next.perks, ...added];
  }
  if (Array.isArray(change.perksRemove) && change.perksRemove.length > 0) {
    const removeNames = new Set(change.perksRemove.map(perk => perk.name));
    next.perks = next.perks.filter(perk => !removeNames.has(perk.name));
  }
  if (change.inventoryChange) {
    next.inventory = applyInventoryChange(next.inventory, change.inventoryChange);
  }
  const normalized = normalizeActor(next);
  return {
    ...normalized,
    special: clampSpecialSet(normalized.special),
    skills: clampSkillSet(normalized.skills)
  };
};

const buildStatusSnapshot = (
  player: Actor,
  quests: Quest[],
  knownNpcs: Actor[],
  location: string,
  currentYear: number,
  currentTime: string
): StatusSnapshot => ({
  player: normalizeActor({
    ...player,
    special: { ...player.special },
    skills: { ...player.skills },
    perks: player.perks.map(perk => ({ ...perk })),
    inventory: player.inventory.map(item => ({ ...item }))
  }),
  quests: quests.map(quest => ({ ...quest })),
  knownNpcs: knownNpcs.map(npc => normalizeActor({
    ...npc,
    special: { ...npc.special },
    skills: { ...npc.skills },
    perks: npc.perks.map(perk => ({ ...perk })),
    inventory: npc.inventory.map(item => ({ ...item }))
  })),
  location,
  currentYear,
  currentTime
});

const getNarrationEntries = (history: HistoryEntry[]) =>
  history.filter(entry => entry.sender === 'narrator' && entry.meta !== 'memory');

const countNarrations = (history: HistoryEntry[]) => getNarrationEntries(history).length;

const getPendingPlayerAction = (history: HistoryEntry[]) => {
  if (history.length === 0) return null;
  const last = history[history.length - 1];
  if (last.sender !== 'player') return null;
  return {
    text: last.text,
    trimmedHistory: history.slice(0, -1)
  };
};

const rebuildInventoryFromStatusTrack = (track: StatusTrack) => {
  let inventory = normalizeInventory(track.initial_status.player.inventory);
  track.status_change.forEach(change => {
    inventory = applyInventoryChange(inventory, change.playerChange?.inventoryChange);
  });
  return inventory;
};

const rebuildStatusFromTrack = (track: StatusTrack) => {
  const initialKnownNpcs = normalizeKnownNpcList(track.initial_status.knownNpcs).cleaned;
  let player = normalizeActor(track.initial_status.player);
  let quests = Array.isArray(track.initial_status.quests) ? track.initial_status.quests : [];
  let knownNpcs: Actor[] = initialKnownNpcs.map(withCompanionFlag);
  let location = typeof track.initial_status.location === 'string' ? track.initial_status.location : '';
  let currentYear = typeof track.initial_status.currentYear === 'number'
    ? Math.trunc(track.initial_status.currentYear)
    : 0;
  let currentTime = typeof track.initial_status.currentTime === 'string' ? track.initial_status.currentTime : '';
  const changes = Array.isArray(track.status_change) ? [...track.status_change] : [];
  changes.sort((a, b) => a.narration_index - b.narration_index);
  changes.forEach(change => {
    if (change.playerChange) {
      player = applyPlayerChange(player, change.playerChange);
    }
    if (change.questUpdates) {
      const result = applyQuestUpdates(quests, change.questUpdates);
      quests = result.merged;
    }
    let nextKnownNpcs: Actor[] = knownNpcs;
    const newNpcList = normalizeNewNpcList(change.newNpc);
    newNpcList.forEach(npc => {
      if (npc) {
        nextKnownNpcs = upsertNpc(nextKnownNpcs, npc);
      }
    });
    if (change.companionUpdates) {
      nextKnownNpcs = applyCompanionUpdates(nextKnownNpcs, change.companionUpdates);
    }
    knownNpcs = nextKnownNpcs.map(npc => normalizeActor(npc));
    if (typeof change.location === 'string' && change.location.trim()) {
      location = change.location.trim();
    }
    if (typeof change.currentYear === 'number' && Number.isFinite(change.currentYear)) {
      currentYear = Math.trunc(change.currentYear);
    }
    if (typeof change.currentTime === 'string' && change.currentTime.trim()) {
      currentTime = change.currentTime.trim();
    }
  });
  return {
    player,
    quests,
    knownNpcs,
    location,
    currentYear,
    currentTime
  };
};

const mergeInventoryWeights = (base: InventoryItem[], audited: InventoryItem[]) => {
  const weightMap = new Map<string, number>();
  audited.forEach(item => {
    if (!item?.name) return;
    if (!Number.isFinite(item.weight)) return;
    weightMap.set(normalizeKey(item.name), item.weight);
  });
  return base.map(item => {
    const weight = weightMap.get(normalizeKey(item.name));
    if (!Number.isFinite(weight)) return item;
    return { ...item, weight: weight as number };
  });
};

const hasMissingInventoryCounts = (items: any) => {
  if (!Array.isArray(items)) return false;
  return items.some(item => !Number.isFinite(item?.count));
};

const getRawOutputFromError = (err: unknown) => {
  if (!err || typeof err !== 'object') return '';
  if ('rawOutput' in err) {
    const raw = (err as { rawOutput?: unknown }).rawOutput;
    return typeof raw === 'string' ? raw : '';
  }
  if ('cause' in err) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause && typeof cause === 'object' && 'rawOutput' in cause) {
      const raw = (cause as { rawOutput?: unknown }).rawOutput;
      return typeof raw === 'string' ? raw : '';
    }
  }
  return '';
};

const getDefaultUserPrompt = (language: Language) =>
  language === 'zh' ? DEFAULT_USER_PROMPT_ZH : DEFAULT_USER_PROMPT_EN;

const applyDefaultUserPrompt = (settings: GameSettings, language: Language): GameSettings => {
  if (settings.userSystemPromptCustom) return settings;
  const currentPrompt = (settings.userSystemPrompt || '').trim();
  const defaultPrompt = getDefaultUserPrompt(language);
  if (
    !currentPrompt ||
    currentPrompt === DEFAULT_USER_PROMPT_ZH ||
    currentPrompt === DEFAULT_USER_PROMPT_EN
  ) {
    return {
      ...settings,
      userSystemPrompt: defaultPrompt,
      userSystemPromptCustom: false
    };
  }
  return settings;
};

const getDefaultArenaPrompt = (language: Language) =>
  language === 'zh' ? DEFAULT_ARENA_PROMPT_ZH : DEFAULT_ARENA_PROMPT_EN;

const applyDefaultArenaPrompt = (state: ArenaState, language: Language): ArenaState => {
  if (state.userPromptCustom) return state;
  const currentPrompt = (state.userPrompt || '').trim();
  const defaultPrompt = getDefaultArenaPrompt(language);
  if (
    !currentPrompt ||
    currentPrompt === DEFAULT_ARENA_PROMPT_ZH ||
    currentPrompt === DEFAULT_ARENA_PROMPT_EN
  ) {
    return {
      ...state,
      userPrompt: defaultPrompt,
      userPromptCustom: false
    };
  }
  return state;
};

const clampCompressedMemory = (text: string, maxMemoryK: number, language: Language) => {
  if (!text) return text;
  const safeK = Math.max(1, Math.floor(maxMemoryK || 1));
  const charCap = safeK * 1000 * (language === 'zh' ? 1 : 4);
  if (text.length <= charCap) return text.trim();
  const suffix = language === 'zh' ? '…' : '...';
  return `${text.slice(0, charCap).trim()}${suffix}`;
};

const extractLegacyCompressedMemory = (history: HistoryEntry[]) => {
  let memoryText = '';
  const cleaned: HistoryEntry[] = [];
  history.forEach(entry => {
    const anyEntry = entry as any;
    if (anyEntry && typeof anyEntry === 'object' && typeof anyEntry.compressed_memory === 'string') {
      if (!memoryText) memoryText = anyEntry.compressed_memory;
      return;
    }
    if (entry.meta === 'memory') {
      if (!memoryText) memoryText = entry.text || '';
      return;
    }
    cleaned.push(entry);
  });
  return { memoryText: memoryText.trim(), cleanedHistory: cleaned };
};

const buildNarratorHistory = (
  history: HistoryEntry[],
  limit: number | null,
  compressedMemory: string | undefined,
  useMemory = true
): HistoryEntry[] => {
  const nonMemory = history.filter(item => item.meta !== 'memory' && !isErrorHistoryEntry(item));
  const recent = limit ? nonMemory.slice(-limit) : nonMemory;
  const memoryText = (compressedMemory || '').trim();
  if (!memoryText || !useMemory) return recent;
  const memoryEntry: HistoryEntry = {
    sender: 'narrator',
    text: `${MEMORY_ENTRY_TAG}:\n${memoryText}`,
    isSaved: false
  };
  return [
    memoryEntry,
    ...recent
  ];
};

const buildCompressionPayload = (state: GameState, limit: number) => {
  const nonMemory = state.history.filter(item => item.meta !== 'memory' && !isErrorHistoryEntry(item));
  const recentHistory = nonMemory.slice(-limit);
  const { history, compressedMemory, savedSnapshot, ...saveState } = state;
  return {
    saveState,
    compressedMemory: (compressedMemory || '').trim(),
    recentHistory
  };
};

const isErrorHistoryEntry = (entry: HistoryEntry) => {
  if (entry.sender !== 'narrator') return false;
  const text = entry.text || '';
  return (
    text.includes('VAULT-TEC ERROR') ||
    text.includes('避难所科技错误') ||
    text.includes('[RULE ERROR') ||
    text.includes('规则错误')
  );
};

const normalizeProviderSettings = (settings: GameSettings): GameSettings => {
  const fallbackProvider = settings.textProvider || settings.imageProvider || settings.modelProvider || 'gemini';
  const defaultTextScale = Number.isFinite(DEFAULT_SETTINGS.textScale)
    ? (DEFAULT_SETTINGS.textScale as number)
    : 1;
  const textScale = Number.isFinite(settings.textScale)
    ? clampNumber(settings.textScale as number, 0.8, 5)
    : defaultTextScale;
  const interfaceColor = normalizeInterfaceColor(settings.interfaceColor, DEFAULT_INTERFACE_COLOR);
  return {
    ...settings,
    textProvider: settings.textProvider || fallbackProvider,
    imageProvider: settings.imageProvider || fallbackProvider,
    userSystemPrompt: settings.userSystemPrompt ?? '',
    userSystemPromptCustom: settings.userSystemPromptCustom ?? false,
    pipelineMode: settings.pipelineMode ?? 'event',
    autoSaveEnabled: settings.autoSaveEnabled ?? false,
    textScale,
    interfaceColor
  };
};

const normalizeSessionSettings = (settings: GameSettings, tier: UserTier, hasKey: boolean) => {
  const minTurnsOverride = tier === 'normal' && hasKey ? 1 : undefined;
  const normalized = normalizeSettingsForTier(settings, tier, minTurnsOverride);
  const lockedImages = lockImageTurnsForTier(normalized, tier, hasKey);
  const normalizedProviders = normalizeProviderSettings(lockedImages);
  const normalizedProxyBaseUrl = normalizeProxyBaseUrl(normalizedProviders.proxyBaseUrl || '');
  const normalizedTextProxyBaseUrl = normalizeProxyBaseUrl(
    normalizedProviders.textProxyBaseUrl || normalizedProviders.proxyBaseUrl || ''
  );
  const normalizedImageProxyBaseUrl = normalizeProxyBaseUrl(
    normalizedProviders.imageProxyBaseUrl || normalizedProviders.proxyBaseUrl || ''
  );
  return lockHistoryTurnsForTier({
    ...normalizedProviders,
    proxyBaseUrl: normalizedProxyBaseUrl,
    textProxyBaseUrl: normalizedTextProxyBaseUrl,
    imageProxyBaseUrl: normalizedImageProxyBaseUrl
  }, tier);
};

const normalizeTokenUsage = (usage?: TokenUsage | null): TokenUsage => {
  if (!usage) return { sent: 0, received: 0, total: 0 };
  const sent = Number.isFinite(usage.sent) ? usage.sent : 0;
  const received = Number.isFinite(usage.received) ? usage.received : 0;
  const total = Number.isFinite(usage.total) ? usage.total : sent + received;
  return { sent, received, total };
};

const mergeTokenUsage = (base: TokenUsage, delta?: TokenUsage | null): TokenUsage => {
  if (!delta) return base;
  const normalizedDelta = normalizeTokenUsage(delta);
  return {
    sent: base.sent + normalizedDelta.sent,
    received: base.received + normalizedDelta.received,
    total: base.total + normalizedDelta.total
  };
};

const rollEra = () => {
  const era = FALLOUT_ERA_STARTS[Math.floor(Math.random() * FALLOUT_ERA_STARTS.length)];
  const randomHour = Math.floor(Math.random() * 12) + 6;
  const date = new Date(Date.UTC(era.year, 6, 15, randomHour, 0, 0));
  return {
    year: era.year,
    region: era.region,
    time: date.toISOString()
  };
};

const cloneGameState = (state: GameState): GameState => {
  if (typeof structuredClone === 'function') {
    return structuredClone(state);
  }
  return JSON.parse(JSON.stringify(state)) as GameState;
};

const stripFailedAction = (history: HistoryEntry[], failedText?: string | null) => {
  if (!failedText || history.length === 0) return history;
  const last = history[history.length - 1];
  if (last.sender === 'player' && last.text === failedText) {
    return history.slice(0, -1);
  }
  return history;
};

const normalizeQuestUpdate = (update: any): Quest | null => {
  if (!update || typeof update !== 'object') return null;
  const name = typeof update.name === 'string'
    ? update.name
    : (typeof update.title === 'string' ? update.title : '');
  const objective = typeof update.objective === 'string'
    ? update.objective
    : Array.isArray(update.objectives)
      ? update.objectives.filter((item: any) => typeof item === 'string').join('\n')
      : (typeof update.notes === 'string' ? update.notes : '');
  const rawStatus = typeof update.status === 'string' ? update.status : '';
  const status = rawStatus === 'active' || rawStatus === 'completed' || rawStatus === 'failed'
    ? rawStatus
    : 'active';
  const id = typeof update.id === 'string'
    ? update.id
    : (name ? `q-${name.toLowerCase().replace(/\s+/g, '-')}` : '');
  if (!id || !name) return null;
  const hiddenProgress = typeof update.hiddenProgress === 'string'
    ? update.hiddenProgress
    : (typeof update.notes === 'string' ? update.notes : '');
  return {
    id,
    name,
    objective,
    status,
    hiddenProgress
  };
};

const applyQuestUpdates = (base: Quest[], updates?: Quest[]) => {
  const merged = [...base];
  const completedNotes: string[] = [];
  if (!updates || updates.length === 0) return { merged, completedNotes };
  updates.forEach(update => {
    const normalized = normalizeQuestUpdate(update);
    if (!normalized) return;
    const index = merged.findIndex(q => q.id === normalized.id || q.name === normalized.name);
    if (index > -1) {
      const oldQuest = merged[index];
      if (normalized.status === 'completed' && oldQuest.status === 'active') {
        completedNotes.push(`[QUEST FINISHED: ${normalized.name}]\n${normalized.hiddenProgress}`);
      }
      merged[index] = {
        ...oldQuest,
        ...normalized,
        name: normalized.name || oldQuest.name,
        objective: normalized.objective || oldQuest.objective,
        hiddenProgress: normalized.hiddenProgress || oldQuest.hiddenProgress
      };
    } else {
      merged.push(normalized);
    }
  });
  return { merged, completedNotes };
};

const getCreationPhaseText = (phase: 'request' | 'image' | 'finalize', isZh: boolean) => {
  switch (phase) {
    case 'request':
      return isZh
        ? '正在提交访问避难所科技人口档案库的许可申请。'
        : 'Submitting clearance request to access Vault-Tec Demographic Database.';
    case 'image':
      return isZh
        ? '许可已通过。正在生成入场影像。'
        : 'Clearance granted. Generating onboarding visual.';
    case 'finalize':
      return isZh
        ? '正在整理档案并启动系统。'
        : 'Finalizing dossier and boot sequence.';
    default:
      return '';
  }
};

const formatExportLabel = (sender: HistoryEntry['sender'], language: Language) => {
  if (sender === 'player') {
    return language === 'zh' ? '用户记录' : 'USER LOG';
  }
  return language === 'zh' ? '系统叙事' : 'SYSTEM NARRATION';
};

const buildExportMarkdown = (history: HistoryEntry[], language: Language) => {
  const blocks: string[] = [];
  history.forEach(entry => {
    if (entry.meta === 'memory') return;
    blocks.push(`## ${formatExportLabel(entry.sender, language)}`);
    blocks.push(entry.text);
    if (entry.imageUrl) {
      blocks.push('');
      blocks.push(`![Scene](${entry.imageUrl})`);
    }
    blocks.push('');
  });
  return blocks.join('\n').trim() + '\n';
};

const buildSaveExportPayload = (state: GameState, username?: string | null) => ({
  version: 1,
  username: username ?? null,
  savedAt: new Date().toISOString(),
  gameState: state
});

const extractImportedSave = (data: any): { gameState: GameState; username?: string | null } | null => {
  if (!data || typeof data !== 'object') return null;
  if (data.gameState && typeof data.gameState === 'object') {
    return { gameState: data.gameState as GameState, username: typeof data.username === 'string' ? data.username : null };
  }
  if (Array.isArray((data as GameState).history) && (data as GameState).settings) {
    return { gameState: data as GameState, username: typeof (data as any).username === 'string' ? (data as any).username : null };
  }
  return null;
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const escapeHtmlAttr = (value: string) => escapeHtml(value);

const buildExportHtml = (history: HistoryEntry[], language: Language) => {
  const entries = history
    .filter(entry => entry.meta !== 'memory')
    .map(entry => {
      const label = formatExportLabel(entry.sender, language);
      const text = escapeHtml(entry.text).replace(/\n/g, '<br />');
      const image = entry.imageUrl
        ? `<div class="image"><img src="${escapeHtmlAttr(entry.imageUrl)}" alt="Scene" /></div>`
        : '';
      return `
        <section class="entry">
          <div class="label">${label}</div>
          <div class="text">${text}</div>
          ${image}
        </section>
      `;
    }).join('\n');
  return `<!doctype html>
<html lang="${language}">
  <head>
    <meta charset="utf-8" />
    <title>Fallout Terminal Log</title>
    <style>
      body { font-family: "Segoe UI", Arial, sans-serif; color: #111; margin: 24px; }
      .entry { margin-bottom: 24px; }
      .label { font-size: 12px; letter-spacing: 0.2em; text-transform: uppercase; color: #1a7f37; margin-bottom: 6px; }
      .text { font-size: 14px; line-height: 1.6; white-space: normal; }
      .image { margin-top: 10px; }
      .image img { max-width: 100%; height: auto; display: block; }
    </style>
  </head>
  <body>
    ${entries}
  </body>
</html>`;
};

const downloadTextFile = (content: string, filename: string, mimeType: string) => {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

const formatCreationProgress = (message: string, isZh: boolean, showDebug: boolean) => {
  if (message.startsWith('Requesting character profile')) {
    return getCreationPhaseText('request', isZh);
  }
  if (message.startsWith('API key:')) {
    return showDebug ? message : null;
  }
  if (message.startsWith('Primary model failed')) {
    return isZh
      ? '主线路受阻，正在切换至备用通道。'
      : 'Primary line denied. Rerouting through auxiliary relay.';
  }
  if (message.startsWith('Response received')) {
    return isZh
      ? '已获取避难所科技档案，正在校验完整性。'
      : 'Vault-Tec record acquired. Verifying integrity.';
  }
  if (message.startsWith('Character JSON parsed successfully')) {
    return isZh
      ? '档案已通过验证。'
      : 'Profile integrity verified.';
  }
  if (message.startsWith('JSON parse failed:')) {
    const detail = appendJsonParseGuidance(
      message.replace('JSON parse failed:', '').trim(),
      isZh
    );
    return isZh ? `数据完整性错误：${detail}` : `Data integrity error: ${detail}`;
  }
  if (message.startsWith('Response preview:')) {
    if (!showDebug) return null;
    const detail = message.replace('Response preview:', '').trim();
    return isZh ? `原始预览：${detail}` : `Raw preview: ${detail}`;
  }
  return showDebug ? message : null;
};

const formatRecoveryInterval = (minutes: number, isZh: boolean) => {
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return isZh ? `${hours} 小时` : `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return isZh ? `${minutes} 分钟` : `${minutes} minute${minutes === 1 ? '' : 's'}`;
};

const createInitialGameState = (
  settings: GameSettings,
  ap: number,
  apLastUpdated: number,
  language: Language = 'en'
): GameState => {
  const nextSettings = applyDefaultUserPrompt(settings, language);
  return {
    player: null,
    currentYear: 2281,
    location: 'Mojave Wasteland',
    currentTime: new Date(Date.UTC(2281, 9, 23, 10, 0, 0)).toISOString(),
    history: [],
    knownNpcs: [],
    quests: [],
    isThinking: false,
    language,
    settings: nextSettings,
    ap,
    apLastUpdated,
    turnCount: 0,
    tokenUsage: { sent: 0, received: 0, total: 0 },
    compressedMemory: '',
    rawOutputCache: '',
    status_track: null,
    compressionTurnCounter: 0,
    compressionEnabled: true
  };
};

const createInitialArenaState = (
  settings: GameSettings,
  language: Language = 'en'
): ArenaState => {
  const next: ArenaState = {
    mode: 'scenario',
    focus: '',
    involvedParties: [{ description: '' }, { description: '' }],
    history: [],
    isThinking: false,
    settings,
    turnCount: 0,
    tokenUsage: { sent: 0, received: 0, total: 0 },
    finished: false,
    briefingComplete: false,
    userPrompt: getDefaultArenaPrompt(language),
    userPromptCustom: false
  };
  return applyDefaultArenaPrompt(next, language);
};

const normalizeArenaState = (
  state: any,
  settings: GameSettings,
  language: Language
): ArenaState => {
  const base = createInitialArenaState(settings, language);
  if (!state || typeof state !== 'object') return base;
  const rawMode = typeof state.mode === 'string' ? state.mode : '';
  const mode = rawMode === 'wargame' ? 'wargame' : 'scenario';
  const involvedParties = Array.isArray(state.involvedParties)
    ? state.involvedParties.map((party: any) => {
        if (party && typeof party === 'object') {
          return {
            description: typeof party.description === 'string' ? party.description : '',
            forcePower: Number.isFinite(party.forcePower) ? Math.max(0, Math.floor(party.forcePower)) : undefined,
            maxForcePower: Number.isFinite(party.maxForcePower) ? Math.max(0, Math.floor(party.maxForcePower)) : undefined,
            avatarUrl: typeof party.avatarUrl === 'string' ? party.avatarUrl : undefined
          };
        }
        return { description: String(party ?? '') };
      })
    : base.involvedParties;
  const cappedParties = involvedParties.slice(0, 10);
  const safeParties = cappedParties.length >= 2 ? cappedParties : [{ description: '' }, { description: '' }];
  const history = Array.isArray(state.history) ? state.history : base.history;
  const tokenUsage = normalizeTokenUsage(state.tokenUsage);
  const merged: ArenaState = {
    ...base,
    mode,
    focus: typeof state.focus === 'string' ? state.focus : base.focus,
    involvedParties: safeParties,
    history,
    settings: state.settings && typeof state.settings === 'object'
      ? normalizeProviderSettings(state.settings)
      : settings,
    turnCount: Number.isFinite(state.turnCount) ? Math.max(0, Math.floor(state.turnCount)) : base.turnCount,
    tokenUsage,
    finished: !!state.finished,
    briefingComplete: !!state.briefingComplete,
    userPrompt: typeof state.userPrompt === 'string' ? state.userPrompt : base.userPrompt,
    userPromptCustom: !!state.userPromptCustom,
    isThinking: false
  };
  return applyDefaultArenaPrompt(merged, language);
};

const stripAdminUser = (db: Record<string, UserRecord>) => {
  if (!db[RESERVED_ADMIN_USERNAME]) return db;
  const next = { ...db };
  delete next[RESERVED_ADMIN_USERNAME];
  return next;
};

const normalizeUsersDb = (data: any): Record<string, UserRecord> => {
  if (!data) return {};
  if (Array.isArray(data)) {
    const normalized = data.reduce((acc, user) => {
      if (user?.username) acc[user.username] = user;
      return acc;
    }, {} as Record<string, UserRecord>);
    return stripAdminUser(normalized);
  }
  if (Array.isArray(data.users)) {
    const normalized = data.users.reduce((acc: Record<string, UserRecord>, user: UserRecord) => {
      if (user?.username) acc[user.username] = user;
      return acc;
    }, {});
    return stripAdminUser(normalized);
  }
  if (data.users && typeof data.users === 'object') {
    return stripAdminUser(data.users as Record<string, UserRecord>);
  }
  if (typeof data === 'object') {
    const entries = Object.entries(data);
    if (
      entries.length > 0 &&
      entries.every(([, value]) => value && typeof value === 'object' && 'username' in value)
    ) {
      return stripAdminUser(data as Record<string, UserRecord>);
    }
  }
  return {};
};

const extractInvitationCode = (data: any) =>
  typeof data?.invitationCode === 'string' ? data.invitationCode : null;

const serializeUsersDb = (db: Record<string, UserRecord>, invitationCode: string) =>
  JSON.stringify({ invitationCode, users: Object.values(db) }, null, 2);

const mergeUsersDb = (
  fileDb: Record<string, UserRecord>,
  storedDb: Record<string, UserRecord>
): Record<string, UserRecord> => {
  const merged: Record<string, UserRecord> = { ...storedDb };
  Object.entries(fileDb).forEach(([username, fileUser]) => {
    const storedUser = storedDb[username];
    if (!storedUser) {
      merged[username] = fileUser;
      return;
    }
    merged[username] = {
      ...fileUser,
      ap: typeof storedUser.ap === 'number' ? storedUser.ap : fileUser.ap,
      apLastUpdated: typeof storedUser.apLastUpdated === 'number' ? storedUser.apLastUpdated : fileUser.apLastUpdated,
      settings: storedUser.settings ?? fileUser.settings
    };
  });
  return merged;
};

const normalizeActor = (actor: Actor): Actor => {
  const nextSpecial = normalizeSpecial(actor.special);
  return {
    ...actor,
    appearance: typeof actor.appearance === 'string' ? actor.appearance.trim() : '',
    special: nextSpecial,
    skills: normalizeSkills(actor.skills, nextSpecial, true),
    perks: Array.isArray(actor.perks) ? actor.perks : [],
    inventory: normalizeInventory(actor.inventory)
  };
};

const mergeActor = (base: Actor, update: Actor): Actor => {
  const nextSpecial = update.special ? normalizeSpecial(update.special) : base.special;
  const updateSkills = update.skills ? normalizeSkills(update.skills, nextSpecial, false) : {};
  return {
    ...base,
    ...update,
    appearance: typeof update.appearance === 'string' ? update.appearance.trim() : base.appearance,
    special: nextSpecial,
    skills: update.skills ? { ...base.skills, ...updateSkills } : base.skills,
    perks: Array.isArray(update.perks) ? update.perks : base.perks,
    inventory: Array.isArray(update.inventory) ? normalizeInventory(update.inventory) : base.inventory
  };
};

const mergeNpc = (existing: Actor, incoming: Actor): Actor => {
  const merged = mergeActor(existing, incoming);
  return {
    ...merged,
    ifCompanion: incoming.ifCompanion ?? existing.ifCompanion,
    avatarUrl: existing.avatarUrl ?? incoming.avatarUrl
  };
};

const upsertNpc = (list: Actor[], npc: Actor): Actor[] => {
  const index = list.findIndex(entry => entry.name === npc.name);
  const nextNpc = { ...npc, ifCompanion: npc.ifCompanion ?? false };
  if (index === -1) {
    return [...list, normalizeActor(nextNpc)];
  }
  const next = [...list];
  next[index] = mergeNpc(next[index], nextNpc);
  return next;
};

const applyCompanionUpdates = (list: Actor[], updates?: CompanionUpdate[]): Actor[] => {
  if (!updates || updates.length === 0) return list;
  const updatesByName = new Map(updates.map(update => [update.name, update]));
  return list.map(npc => {
    const update = updatesByName.get(npc.name);
    if (!update) return npc;
    return { ...npc, ifCompanion: update.ifCompanion };
  });
};

const withCompanionFlag = (npc: Actor): Actor => ({
  ...npc,
  ifCompanion: npc.ifCompanion ?? false
});

const upsertNpcByKey = (list: Actor[], npc: Actor): Actor[] => {
  const key = normalizeKey(npc.name);
  if (!key) return list;
  const index = list.findIndex(entry => normalizeKey(entry.name) === key);
  if (index === -1) {
    return [...list, npc];
  }
  const next = [...list];
  next[index] = mergeNpc(next[index], npc);
  return next;
};

const normalizeKnownNpcList = (raw: unknown) => {
  let fixed = false;
  let cleaned: Actor[] = [];
  const pushActor = (actor: Actor) => {
    if (!actor || typeof actor !== 'object' || typeof actor.name !== 'string') {
      fixed = true;
      return;
    }
    const normalized = normalizeActor({ ...actor, ifCompanion: actor.ifCompanion ?? false });
    const beforeLen = cleaned.length;
    cleaned = upsertNpcByKey(cleaned, normalized);
    if (cleaned.length === beforeLen) {
      fixed = true;
    }
  };
  const walk = (entry: unknown) => {
    if (!entry || typeof entry !== 'object') {
      fixed = true;
      return;
    }
    if (Array.isArray(entry)) {
      fixed = true;
      entry.forEach(walk);
      return;
    }
    if ('name' in entry && typeof (entry as Actor).name === 'string') {
      pushActor(entry as Actor);
      return;
    }
    const keys = Object.keys(entry as Record<string, unknown>);
    const numericKeys = keys.filter(key => /^\d+$/.test(key));
    if (numericKeys.length > 0) {
      fixed = true;
      numericKeys.forEach(key => walk((entry as Record<string, unknown>)[key]));
      return;
    }
    fixed = true;
  };
  if (Array.isArray(raw)) {
    raw.forEach(walk);
    return { cleaned, fixed };
  }
  if (raw && typeof raw === 'object') {
    const keys = Object.keys(raw as Record<string, unknown>);
    const numericKeys = keys.filter(key => /^\d+$/.test(key));
    if (numericKeys.length > 0) {
      fixed = true;
      numericKeys.forEach(key => walk((raw as Record<string, unknown>)[key]));
      return { cleaned, fixed };
    }
  }
  return { cleaned: [], fixed: raw != null };
};

const normalizeNewNpcList = (value: unknown) => {
  if (!value) return [];
  if (Array.isArray(value)) return value as Actor[];
  if (typeof value === 'object') {
    if ('name' in value && typeof (value as Actor).name === 'string') {
      return [value as Actor];
    }
    const entries = Object.entries(value as Record<string, unknown>);
    const numeric = entries
      .filter(([key, entry]) => /^\d+$/.test(key) && entry && typeof entry === 'object');
    if (numeric.length > 0) {
      return numeric.map(([, entry]) => entry as Actor);
    }
  }
  return [];
};

type UserSession = {
  username: string;
  tier: UserTier;
  ap: number;
  apLastUpdated: number;
  settings: GameSettings;
  textApiKey?: string;
  imageApiKey?: string;
  textProxyKey?: string;
  imageProxyKey?: string;
  isTemporary: boolean;
};

type LastActionState = {
  text: string;
  snapshot: GameState;
  status: 'pending' | 'resolved' | 'error';
};

type LegacyCompressionPrompt = {
  state: GameState;
  limit: number;
  reason: 'no-memory' | 'memory-no-counter';
};

type LegacyInventoryPrompt = {
  state: GameState;
  reason: 'missing-status-track' | 'missing-counts';
};

type LegacyKnownNpcPrompt = {
  state: GameState;
};

type StatusRebuildPrompt = {
  step: 'choose' | 'llm-confirm';
};

type StageStatus = 'idle' | 'pending' | 'running' | 'done' | 'error' | 'skipped';

const App: React.FC = () => {
  const [view, setView] = useState<'auth' | 'start' | 'creation' | 'playing' | 'arena_setup' | 'arena_play'>('auth');
  const [gameState, setGameState] = useState<GameState>(
    createInitialGameState(DEFAULT_SETTINGS, NORMAL_MAX_AP, Date.now(), 'en')
  );
  const [arenaState, setArenaState] = useState<ArenaState>(
    createInitialArenaState(DEFAULT_SETTINGS, 'en')
  );
  const [userInput, setUserInput] = useState('');
  const [charDescription, setCharDescription] = useState('');
  const [hasSave, setHasSave] = useState(false);
  const [hasArenaSave, setHasArenaSave] = useState(false);
  const [systemError, setSystemError] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<LastActionState | null>(null);
  const [isCompressing, setIsCompressing] = useState(false);
  const [compressionError, setCompressionError] = useState<string | null>(null);
  const [compressionStatus, setCompressionStatus] = useState<string | null>(null);
  const [legacyCompressionPrompt, setLegacyCompressionPrompt] = useState<LegacyCompressionPrompt | null>(null);
  const [legacyInventoryPrompt, setLegacyInventoryPrompt] = useState<LegacyInventoryPrompt | null>(null);
  const [legacyKnownNpcPrompt, setLegacyKnownNpcPrompt] = useState<LegacyKnownNpcPrompt | null>(null);
  const [isInventoryRefreshing, setIsInventoryRefreshing] = useState(false);
  const [inventoryRefreshError, setInventoryRefreshError] = useState<string | null>(null);
  const [companionAvatarPending, setCompanionAvatarPending] = useState<Record<string, boolean>>({});
  const [isStatusRebuilding, setIsStatusRebuilding] = useState(false);
  const [statusRebuildPrompt, setStatusRebuildPrompt] = useState<StatusRebuildPrompt | null>(null);
  const [narrationStage, setNarrationStage] = useState<StageStatus>('idle');
  const [statusStage, setStatusStage] = useState<StageStatus>('idle');
  const [imageStage, setImageStage] = useState<StageStatus>('idle');
  const [arenaNarrationStage, setArenaNarrationStage] = useState<StageStatus>('idle');
  const [arenaImageStage, setArenaImageStage] = useState<StageStatus>('idle');
  const [arenaAvatarStage, setArenaAvatarStage] = useState<StageStatus>('idle');
  const [statusManagerError, setStatusManagerError] = useState<string | null>(null);
  const [isManualCompressionConfirmOpen, setIsManualCompressionConfirmOpen] = useState(false);
  const [keyAlert, setKeyAlert] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [isUserPromptOpen, setIsUserPromptOpen] = useState(false);
  const [isArenaPromptOpen, setIsArenaPromptOpen] = useState(false);
  const [isTipOpen, setIsTipOpen] = useState(false);
  const [arenaError, setArenaError] = useState<string | null>(null);
  const [showArenaExportMenu, setShowArenaExportMenu] = useState(false);
  const [arenaSidebarFolded, setArenaSidebarFolded] = useState(false);
  const [usersDb, setUsersDb] = useState<Record<string, UserRecord>>({});
  const [usersLoaded, setUsersLoaded] = useState(false);
  const [currentUser, setCurrentUser] = useState<UserSession | null>(null);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authName, setAuthName] = useState('');
  const [authPasskey, setAuthPasskey] = useState('');
  const [authConfirm, setAuthConfirm] = useState('');
  const [authError, setAuthError] = useState('');
  const [showGuestNotice, setShowGuestNotice] = useState(false);
  const [isUsersEditorOpen, setIsUsersEditorOpen] = useState(false);
  const [usersEditorText, setUsersEditorText] = useState('');
  const [usersEditorError, setUsersEditorError] = useState('');
  const [invitationCode, setInvitationCode] = useState('');
  const [creationPhase, setCreationPhase] = useState('');
  const [creationStartTime, setCreationStartTime] = useState<number | null>(null);
  const [creationElapsed, setCreationElapsed] = useState(0);
  const [isRawOutputOpen, setIsRawOutputOpen] = useState(false);
  const [statPanelWidth, setStatPanelWidth] = useState(PANEL_BASE_WIDTH);
  const [arenaPanelWidth, setArenaPanelWidth] = useState(PANEL_BASE_WIDTH);
  const [draggingPanel, setDraggingPanel] = useState<null | 'stat' | 'arena'>(null);
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window === 'undefined' ? true : window.innerWidth >= 768
  );
  const lastHistoryLength = useRef(0);
  const lastCompressedMemory = useRef('');
  const lastInventorySignature = useRef('');
  const lastRawOutputCache = useRef('');
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);
  const compressionStatusTimeout = useRef<number | null>(null);

  const activeTier: UserTier = currentUser?.tier ?? 'guest';
  const isAdmin = activeTier === 'admin';
  const isNormal = activeTier === 'normal';
  const isGuest = activeTier === 'guest';
  const hasTextUserKey = !!currentUser?.textApiKey;
  const hasImageUserKey = !!currentUser?.imageApiKey;
  const hasTextProxyKey = !!currentUser?.textProxyKey;
  const hasImageProxyKey = !!currentUser?.imageProxyKey;
  const useProxy = isNormal && !!gameState.settings.useProxy;
  const textProxyBaseUrl = normalizeProxyBaseUrl(
    gameState.settings.textProxyBaseUrl || gameState.settings.proxyBaseUrl || ''
  );
  const imageProxyBaseUrl = normalizeProxyBaseUrl(
    gameState.settings.imageProxyBaseUrl || gameState.settings.proxyBaseUrl || ''
  );
  const hasTextAuthKey = useProxy ? hasTextProxyKey : hasTextUserKey;
  const hasImageAuthKey = useProxy ? hasImageProxyKey : hasImageUserKey;
  const normalKeyUnlocked = isNormal && hasTextAuthKey;
  const isKeyUnlocked = isAdmin || normalKeyUnlocked;
  const apUnlimited = isKeyUnlocked;
  const maxAp = isKeyUnlocked ? getMaxApForTier('admin') : getMaxApForTier(activeTier);
  const minImageTurns = isKeyUnlocked ? 1 : getMinImageTurnsForTier(activeTier);
  const apRecovery = isKeyUnlocked ? null : getApRecoveryForTier(activeTier);
  const guestMaxAp = getMaxApForTier('guest');
  const guestFixedImageTurns = getMinImageTurnsForTier('guest');
  const normalDefaultImageTurns = getDefaultImageTurnsForTier('normal');
  const rawHistoryLimit = Number.isFinite(gameState.settings.maxHistoryTurns)
    ? Math.trunc(gameState.settings.maxHistoryTurns)
    : DEFAULT_SETTINGS.maxHistoryTurns;
    const lockedHistoryLimit = isGuest ? getHistoryLimitForTier('guest') : rawHistoryLimit;
    const historyLimit = lockedHistoryLimit === -1 ? null : Math.max(1, lockedHistoryLimit);
  const textProvider: ModelProvider = isGuest || isAdmin
    ? 'gemini'
    : (gameState.settings.textProvider || gameState.settings.modelProvider || 'gemini');
  const imageProvider: ModelProvider = isGuest || isAdmin
    ? 'gemini'
    : (gameState.settings.imageProvider || gameState.settings.modelProvider || 'gemini');
  const selectedTextModel = gameState.settings.textModel?.trim() || undefined;
  const selectedImageModel = gameState.settings.imageModel?.trim() || undefined;
  const imagesEnabled = gameState.settings.imagesEnabled !== false;
  const effectiveTextModel = selectedTextModel;
  const effectiveImageModel = selectedImageModel;
  const isZh = gameState.language === 'zh';
  const canManualSave = isAdmin || normalKeyUnlocked;
  const canAdjustImageFrequency = isAdmin || normalKeyUnlocked;
  const arenaTokenUsage = normalizeTokenUsage(arenaState.tokenUsage);
  const statusRebuildNarrationCount = countNarrations(gameState.history);
  const canRegenerateCompanionAvatar = imagesEnabled
    && !isGuest
    && imageProvider !== 'claude'
    && !!effectiveImageModel
    && (isAdmin || hasImageAuthKey);
  const textScale = Number.isFinite(gameState.settings.textScale)
    ? clampNumber(gameState.settings.textScale as number, 0.8, 5)
    : 1;
  const interfaceColor = normalizeInterfaceColor(gameState.settings.interfaceColor, DEFAULT_INTERFACE_COLOR);
  const interfaceColorSoft = buildSoftColor(interfaceColor);
  const interfaceColorRgb = `${interfaceColor.r}, ${interfaceColor.g}, ${interfaceColor.b}`;
  const interfaceColorSoftRgb = `${interfaceColorSoft.r}, ${interfaceColorSoft.g}, ${interfaceColorSoft.b}`;
  const interfaceColorCss = `rgb(${interfaceColor.r} ${interfaceColor.g} ${interfaceColor.b})`;
  const interfaceColorSoftCss = `rgb(${interfaceColorSoft.r} ${interfaceColorSoft.g} ${interfaceColorSoft.b})`;
  const scaledRootStyle: React.CSSProperties = {};
  const statPanelScale = isDesktop
    ? clampNumber(statPanelWidth / PANEL_BASE_WIDTH, 0.85, 1.2)
    : 1;
  const arenaPanelScale = isDesktop
    ? clampNumber(arenaPanelWidth / PANEL_BASE_WIDTH, 0.85, 1.2)
    : 1;
  const arenaNarrationFlexClass = isDesktop
    ? 'flex-1'
    : (arenaSidebarFolded ? 'flex-[5]' : 'flex-[2]');
  const arenaSidebarFlexClass = isDesktop ? '' : 'flex-[1]';
  const isArenaSidebarFolded = !isDesktop && arenaSidebarFolded;
  const textProxyOk = useProxy ? !!textProxyBaseUrl : true;
  const imageProxyOk = useProxy ? !!imageProxyBaseUrl : true;
  const textConfigured = !!textProvider && !!hasTextAuthKey && textProxyOk && !!selectedTextModel;
  const imageConfigured = !imagesEnabled || (!!imageProvider && !!hasImageAuthKey && imageProxyOk && !!selectedImageModel);
  const isModelConfigured = isNormal ? (textConfigured && imageConfigured) : true;
  const canPlay = isGuest || isAdmin || isModelConfigured;
  const compressionLocked = isCompressing || !!compressionError || !!legacyCompressionPrompt || isManualCompressionConfirmOpen;
  const inventoryLocked = isInventoryRefreshing || !!legacyInventoryPrompt;
  const statusRebuildLocked = isStatusRebuilding || !!statusRebuildPrompt;
  const canReroll = !!lastAction && !gameState.isThinking && !compressionLocked && !inventoryLocked && !statusRebuildLocked;
  const inputLocked = gameState.isThinking || compressionLocked || inventoryLocked || statusRebuildLocked;
  const useEventPipeline = gameState.settings.pipelineMode === 'event';
  const progressVisible = gameState.isThinking || narrationStage === 'error' || statusStage === 'error' || imageStage === 'error';
  const progressStages = progressVisible ? [
    {
      label: isZh ? '叙事生成' : 'Narration',
      status: narrationStage
    },
    {
      label: useEventPipeline ? (isZh ? '事件管理' : 'Event') : (isZh ? '状态管理' : 'Status'),
      status: statusStage
    },
    {
      label: isZh ? '图像生成' : 'Image',
      status: imageStage
    }
  ] : [];
  const stageStatusLabels = isZh
    ? {
      idle: '待命',
      pending: '排队',
      running: '处理中',
      done: '完成',
      error: '错误',
      skipped: '跳过'
    }
    : {
      idle: 'IDLE',
      pending: 'PENDING',
      running: 'RUNNING',
      done: 'DONE',
      error: 'ERROR',
      skipped: 'SKIPPED'
    };

  useEffect(() => {
    let active = true;
    let storedDb: Record<string, UserRecord> = {};
    let storedInvitation: string | null = null;
    const stored = localStorage.getItem(USERS_DB_KEY);
    if (stored) {
      try {
        const storedData = JSON.parse(stored);
        storedDb = normalizeUsersDb(storedData);
        storedInvitation = extractInvitationCode(storedData);
      } catch (e) {
        storedDb = {};
      }
    }
    const baseUrl =
      (import.meta as any)?.env?.BASE_URL ??
      (document.querySelector('base')?.getAttribute('href') || '/');
    const candidateUrls = [`${baseUrl}users.json`, `${baseUrl}public/users.json`];
    const loadUsers = async () => {
      for (const url of candidateUrls) {
        try {
          const res = await fetch(url);
          if (!res.ok) continue;
          const contentType = res.headers.get('content-type') || '';
          const raw = await res.text();
          if (contentType && !contentType.includes('application/json')) {
            continue;
          }
          try {
            const parsed = JSON.parse(raw);
            const normalized = normalizeUsersDb(parsed);
            if (Object.keys(normalized).length > 0 || extractInvitationCode(parsed)) {
              return parsed;
            }
          } catch (e) {
            continue;
          }
        } catch (e) {
          // Try next candidate.
        }
      }
      throw new Error('Missing users.json');
    };
    loadUsers()
      .then((data) => {
        if (!active) return;
        const normalized = normalizeUsersDb(data);
        const merged = mergeUsersDb(normalized, storedDb);
        const nextInvitation = extractInvitationCode(data) ?? storedInvitation ?? '';
        setUsersDb(merged);
        setInvitationCode(nextInvitation);
        localStorage.setItem(USERS_DB_KEY, serializeUsersDb(merged, nextInvitation));
        setUsersLoaded(true);
      })
      .catch(() => {
        if (active) {
          setUsersDb(storedDb);
          setInvitationCode(storedInvitation ?? '');
          setUsersLoaded(true);
        }
      });
    return () => {
      active = false;
    };
  }, [isNormal, isModelConfigured, textProvider, hasTextUserKey]);

  useEffect(() => {
    if (!currentUser || currentUser.tier === 'guest') {
      setHasSave(false);
      setHasArenaSave(false);
      return;
    }
    const saved = localStorage.getItem(getSaveKey(currentUser.username));
    setHasSave(!!saved);
    const arenaSaved = localStorage.getItem(getArenaSaveKey(currentUser.username));
    setHasArenaSave(!!arenaSaved);
  }, [currentUser]);

  useEffect(() => {
    if (view !== 'playing' || !apRecovery) return;
    const interval = setInterval(() => {
      setGameState((prev) => {
        const now = Date.now();
        const synced = syncApState(prev.ap, prev.apLastUpdated, now, maxAp, apRecovery);
        if (synced.ap === prev.ap && synced.apLastUpdated === prev.apLastUpdated) {
          return prev;
        }
        return { ...prev, ap: synced.ap, apLastUpdated: synced.apLastUpdated };
      });
    }, 30000);
    return () => clearInterval(interval);
  }, [view, apRecovery, maxAp]);

  useEffect(() => {
    if (view !== 'creation' || !gameState.isThinking || creationStartTime === null) return;
    const interval = setInterval(() => {
      setCreationElapsed(Math.max(0, Math.floor((Date.now() - creationStartTime) / 1000)));
    }, 1000);
    return () => clearInterval(interval);
  }, [view, gameState.isThinking, creationStartTime]);

  useEffect(() => {
    if (view === 'creation') return;
    setCreationElapsed(0);
    setCreationStartTime(null);
    setCreationPhase('');
  }, [view]);

  useEffect(() => {
    if (!currentUser || currentUser.tier === 'guest') return;
    const existing = usersDb[currentUser.username];
    if (!existing) return;
    const nextRecord: UserRecord = {
      ...existing,
      ap: gameState.ap,
      apLastUpdated: gameState.apLastUpdated,
      settings: gameState.settings
    };
    if (
      existing.ap === nextRecord.ap &&
      existing.apLastUpdated === nextRecord.apLastUpdated &&
      JSON.stringify(existing.settings || {}) === JSON.stringify(nextRecord.settings || {})
    ) {
      return;
    }
    const nextDb = { ...usersDb, [currentUser.username]: nextRecord };
    setUsersDb(nextDb);
    localStorage.setItem(USERS_DB_KEY, serializeUsersDb(nextDb, invitationCode));
    setCurrentUser(prev => (prev ? { ...prev, ap: nextRecord.ap, apLastUpdated: nextRecord.apLastUpdated, settings: nextRecord.settings || prev.settings } : prev));
  }, [currentUser, gameState.ap, gameState.apLastUpdated, gameState.settings, usersDb, invitationCode]);

  useEffect(() => {
    setArenaState(prev => ({
      ...prev,
      settings: gameState.settings
    }));
  }, [gameState.settings]);

  useEffect(() => {
    if (!currentUser || !canManualSave) return;
    if (!gameState.settings.autoSaveEnabled) return;
    const currentMemory = gameState.compressedMemory || '';
    const currentRawOutput = gameState.rawOutputCache || '';
    const currentInventorySignature = gameState.player
      ? JSON.stringify(gameState.player.inventory || [])
      : '';
    const historyChanged = gameState.history.length > lastHistoryLength.current;
    const memoryChanged = currentMemory !== lastCompressedMemory.current;
    const inventoryChanged = currentInventorySignature !== lastInventorySignature.current;
    const rawOutputChanged = currentRawOutput !== lastRawOutputCache.current;
    if (!historyChanged && !memoryChanged && !inventoryChanged && !rawOutputChanged) {
      lastHistoryLength.current = gameState.history.length;
      return;
    }
    lastHistoryLength.current = gameState.history.length;
    lastCompressedMemory.current = currentMemory;
    lastInventorySignature.current = currentInventorySignature;
    lastRawOutputCache.current = currentRawOutput;
    const key = getSaveKey(currentUser.username);
    localStorage.setItem(key, JSON.stringify(gameState));
    setHasSave(true);
  }, [gameState, currentUser, canManualSave]);

  useEffect(() => {
    if (!isNormal || !currentUser) return;
    const hasContent =
      !!arenaState.focus.trim() ||
      arenaState.involvedParties.some(party => party.description.trim()) ||
      arenaState.history.length > 0;
    const key = getArenaSaveKey(currentUser.username);
    if (!hasContent) {
      localStorage.removeItem(key);
      setHasArenaSave(false);
      return;
    }
    localStorage.setItem(key, JSON.stringify(arenaState));
    setHasArenaSave(true);
  }, [arenaState, isNormal, currentUser]);

  useEffect(() => {
    if (!currentUser || !isNormal) return;
    if (isModelConfigured) {
      markUserOnboarded(currentUser.username);
    }
  }, [currentUser, isNormal, isModelConfigured]);

  useEffect(() => {
    if (!currentUser || !isNormal) return;
    const storedKey = loadUserApiKey(currentUser.username, textProvider, 'text');
    const currentKey = currentUser.textApiKey || '';
    if (storedKey !== currentKey) {
      setCurrentUser(prev => (prev ? { ...prev, textApiKey: storedKey || undefined } : prev));
    }
  }, [currentUser, isNormal, textProvider]);

  useEffect(() => {
    if (!currentUser || !isNormal) return;
    const storedKey = loadUserApiKey(currentUser.username, imageProvider, 'image');
    const currentKey = currentUser.imageApiKey || '';
    if (storedKey !== currentKey) {
      setCurrentUser(prev => (prev ? { ...prev, imageApiKey: storedKey || undefined } : prev));
    }
  }, [currentUser, isNormal, imageProvider]);

  useEffect(() => {
    if (!currentUser || !isNormal) return;
    const storedKey = loadUserProxyKey(currentUser.username, textProvider, 'text');
    const currentKey = currentUser.textProxyKey || '';
    if (storedKey !== currentKey) {
      setCurrentUser(prev => (prev ? { ...prev, textProxyKey: storedKey || undefined } : prev));
    }
  }, [currentUser, isNormal, textProvider]);

  useEffect(() => {
    if (!currentUser || !isNormal) return;
    const storedKey = loadUserProxyKey(currentUser.username, imageProvider, 'image');
    const currentKey = currentUser.imageProxyKey || '';
    if (storedKey !== currentKey) {
      setCurrentUser(prev => (prev ? { ...prev, imageProxyKey: storedKey || undefined } : prev));
    }
  }, [currentUser, isNormal, imageProvider]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const clamped = clampNumber(textScale, 0.8, 5);
    const html = document.documentElement;
    const previous = html.style.fontSize;
    html.style.fontSize = `${clamped * 100}%`;
    return () => {
      html.style.fontSize = previous;
    };
  }, [textScale]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.style.setProperty('--pip-color', interfaceColorCss);
    root.style.setProperty('--pip-color-rgb', interfaceColorRgb);
    root.style.setProperty('--pip-color-soft', interfaceColorSoftCss);
    root.style.setProperty('--pip-color-soft-rgb', interfaceColorSoftRgb);
  }, [interfaceColorCss, interfaceColorRgb, interfaceColorSoftCss, interfaceColorSoftRgb]);

  useEffect(() => {
    const handleResize = () => {
      setIsDesktop(window.innerWidth >= 768);
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (!draggingPanel) return;
    const handleMove = (event: PointerEvent) => {
      const delta = dragStartX.current - event.clientX;
      if (draggingPanel === 'stat') {
        const next = clampNumber(
          dragStartWidth.current + delta,
          STAT_PANEL_MIN,
          STAT_PANEL_MAX
        );
        setStatPanelWidth(next);
        return;
      }
      const next = clampNumber(
        dragStartWidth.current + delta,
        ARENA_PANEL_MIN,
        ARENA_PANEL_MAX
      );
      setArenaPanelWidth(next);
    };
    const handleUp = () => setDraggingPanel(null);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    return () => {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };
  }, [draggingPanel]);

  const saveGame = useCallback((notify = true) => {
    if (!currentUser || !canManualSave) return;
    try {
      if (gameState.isThinking) {
        alert(gameState.language === 'en'
          ? "Narration is still running. It's safer to wait for it to finish before closing or refreshing. If you leave now, the next load will reset the pending state."
          : "叙事仍在进行中。建议等待叙事完成后再关闭或刷新。如果你现在离开，下次加载会重置未完成状态。");
      }
      const savedSnapshot = buildSavedSnapshot(gameState);
      const savedHistory = markHistorySaved(gameState.history);
      const savedStatusTrack = gameState.status_track
        ? {
          ...gameState.status_track,
          status_change: markStatusChangesSaved(gameState.status_track.status_change)
        }
        : gameState.status_track;
      let nextState: GameState = {
        ...gameState,
        history: savedHistory,
        status_track: savedStatusTrack,
        savedSnapshot
      };
      setGameState(nextState);
      const data = JSON.stringify(nextState);
      const key = getSaveKey(currentUser.username);
      localStorage.setItem(key, data);
      setHasSave(true);
      if (notify) {
        alert(gameState.language === 'en' ? "Game Saved Successfully!" : "游戏保存成功！");
      }
    } catch (e) {
      console.error("Save failed", e);
      if (notify) {
        alert(gameState.language === 'en' 
          ? "Save failed! Local storage may be full." 
          : "保存失败！本地存储可能已满。");
      }
    }
  }, [gameState, currentUser, canManualSave]);

  const exportData = (format: 'log-md' | 'log-pdf' | 'save-json') => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (format === 'save-json') {
      const payload = buildSaveExportPayload(gameState, currentUser?.username);
      const content = JSON.stringify(payload, null, 2);
      downloadTextFile(content, `fallout-save-${timestamp}.json`, 'application/json;charset=utf-8');
      return;
    }
    if (!gameState.history.length) {
      alert(isZh ? '暂无终端记录可导出。' : 'No terminal history to export.');
      return;
    }
    if (format === 'log-md') {
      const content = buildExportMarkdown(gameState.history, gameState.language);
      downloadTextFile(content, `fallout-terminal-${timestamp}.md`, 'text/markdown;charset=utf-8');
      return;
    }
    const html = buildExportHtml(gameState.history, gameState.language);
    const printWindow = window.open('', '_blank', 'width=900,height=700');
    if (!printWindow) {
      alert(isZh ? '无法打开导出窗口，请检查浏览器拦截。' : 'Unable to open export window. Please check popup settings.');
      return;
    }
    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
    const triggerPrint = () => {
      printWindow.focus();
      printWindow.print();
    };
    printWindow.addEventListener('load', () => {
      setTimeout(triggerPrint, 200);
    });
    printWindow.onafterprint = () => {
      printWindow.close();
    };
  };

  const exportArenaData = (format: 'log-md' | 'log-pdf') => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (!arenaState.history.length) {
      alert(isZh ? '暂无斗兽场记录可导出。' : 'No arena history to export.');
      return;
    }
    if (format === 'log-md') {
      const content = buildExportMarkdown(arenaState.history, gameState.language);
      downloadTextFile(content, `fallout-arena-${timestamp}.md`, 'text/markdown;charset=utf-8');
      return;
    }
    const html = buildExportHtml(arenaState.history, gameState.language);
    const printWindow = window.open('', '_blank', 'width=900,height=700');
    if (!printWindow) {
      alert(isZh ? '无法打开导出窗口，请检查浏览器拦截。' : 'Unable to open export window. Please check popup settings.');
      return;
    }
    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
    const triggerPrint = () => {
      printWindow.focus();
      printWindow.print();
    };
    printWindow.addEventListener('load', () => {
      setTimeout(triggerPrint, 200);
    });
    printWindow.onafterprint = () => {
      printWindow.close();
    };
  };

  const readFileText = (file: File) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('File read failed.'));
    reader.readAsText(file);
  });

  const importSave = (targetUsername?: string, onSuccess?: () => void) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const raw = await readFileText(file);
        const parsed = JSON.parse(raw);
        const extracted = extractImportedSave(parsed);
        if (!extracted) {
          alert(isZh ? '导入失败：文件格式不正确。' : 'Import failed: invalid save format.');
          return;
        }
        const fallbackPrompt = isZh ? '请输入存档用户名：' : 'Enter username for this save:';
        const username = (targetUsername || extracted.username || prompt(fallbackPrompt) || '').trim();
        if (!username) {
          alert(isZh ? '导入失败：需要用户名。' : 'Import failed: username required.');
          return;
        }
        localStorage.setItem(getSaveKey(username), JSON.stringify(extracted.gameState));
        if (currentUser && currentUser.username === username) {
          setHasSave(true);
        }
        alert(isZh ? '存档导入成功。' : 'Save imported.');
        onSuccess?.();
      } catch (err) {
        console.error(err);
        alert(isZh ? '导入失败：无法读取存档。' : 'Import failed: unable to read save.');
      }
    };
    input.click();
  };

  const loadGame = useCallback(() => {
    if (!currentUser || isGuest || (isNormal && !isModelConfigured)) return;
    const saved = localStorage.getItem(getSaveKey(currentUser.username));
    if (saved) {
      const parsed = JSON.parse(saved);
      const savedSnapshotRaw = parsed?.savedSnapshot;
      const parsedPlayer = parsed?.player ? normalizeActor(parsed.player) : null;
      const knownNpcNormalization = normalizeKnownNpcList(parsed?.knownNpcs);
      const parsedKnownNpcs = knownNpcNormalization.cleaned;
      const rawStatusTrack = parsed?.status_track ?? parsed?.statusTrack;
      const initialStatusPlayer = rawStatusTrack?.initial_status?.player
        ? normalizeActor(rawStatusTrack.initial_status.player)
        : null;
      const statusKnownNpcNormalization = normalizeKnownNpcList(rawStatusTrack?.initial_status?.knownNpcs);
      const rawStatusChanges: StatusChangeEntry[] = Array.isArray(rawStatusTrack?.status_change)
        ? rawStatusTrack.status_change
        : [];
      const normalizedStatusChanges = filterUnsavedStatusChanges(
        normalizeStatusChangeSavedFlags(rawStatusChanges)
      );
      const normalizedStatusTrack: StatusTrack | null = initialStatusPlayer
        ? {
          initial_status: {
            player: initialStatusPlayer,
            quests: Array.isArray(rawStatusTrack.initial_status?.quests)
              ? rawStatusTrack.initial_status.quests
              : [],
            knownNpcs: statusKnownNpcNormalization.cleaned,
            location: typeof rawStatusTrack.initial_status?.location === 'string'
              ? rawStatusTrack.initial_status.location
              : parsed?.location || gameState.location,
            currentYear: typeof rawStatusTrack.initial_status?.currentYear === 'number'
              ? rawStatusTrack.initial_status.currentYear
              : (typeof parsed?.currentYear === 'number' ? parsed.currentYear : gameState.currentYear),
            currentTime: typeof rawStatusTrack.initial_status?.currentTime === 'string'
              ? rawStatusTrack.initial_status.currentTime
              : (typeof parsed?.currentTime === 'string' ? parsed.currentTime : gameState.currentTime)
          },
          status_change: normalizedStatusChanges
        }
        : null;
      const needsKnownNpcCleanup = knownNpcNormalization.fixed || statusKnownNpcNormalization.fixed;
      const legacyExtracted = Array.isArray(parsed?.history)
        ? extractLegacyCompressedMemory(parsed.history as HistoryEntry[])
        : { memoryText: '', cleanedHistory: parsed?.history || [] };
      const normalizedHistory = Array.isArray(legacyExtracted.cleanedHistory)
        ? legacyExtracted.cleanedHistory
        : [];
      const historyWithFlags = normalizeHistorySavedFlags(normalizedHistory);
      const filteredHistory = filterUnsavedHistory(historyWithFlags);
      const now = Date.now();
      const proxyEnabled = currentUser.settings.useProxy && currentUser.tier === 'normal';
      const hasKey = currentUser.tier === 'normal'
        ? (proxyEnabled ? !!currentUser.textProxyKey : !!currentUser.textApiKey)
        : false;
      const settings = normalizeSessionSettings(
        currentUser.settings || DEFAULT_SETTINGS,
        activeTier,
        hasKey
      );
      const nextSettings = applyDefaultUserPrompt(settings, parsed?.language || gameState.language);
      const compressionEnabled = typeof parsed?.compressionEnabled === 'boolean'
        ? parsed.compressionEnabled
        : true;
      const compressionTurnCounter = typeof parsed?.compressionTurnCounter === 'number'
        ? parsed.compressionTurnCounter
        : 0;
      let clampedAp = Math.min(maxAp, typeof currentUser.ap === 'number' ? currentUser.ap : maxAp);
      let apLastUpdated = typeof currentUser.apLastUpdated === 'number' && currentUser.apLastUpdated > 0
        ? currentUser.apLastUpdated
        : now;
      if (apRecovery) {
        const synced = syncApState(clampedAp, apLastUpdated, now, maxAp, apRecovery);
        clampedAp = synced.ap;
        apLastUpdated = synced.apLastUpdated;
      }
      let nextState: GameState = {
        ...gameState,
        ...parsed,
        player: parsedPlayer,
        knownNpcs: parsedKnownNpcs,
        settings: nextSettings,
        ap: clampedAp,
        apLastUpdated,
        turnCount: typeof parsed.turnCount === 'number' ? parsed.turnCount : 0,
        tokenUsage: normalizeTokenUsage(parsed?.tokenUsage),
        history: filteredHistory,
        compressedMemory: (typeof parsed?.compressedMemory === 'string' ? parsed.compressedMemory : legacyExtracted.memoryText) || '',
        rawOutputCache: typeof parsed?.rawOutputCache === 'string' ? parsed.rawOutputCache : '',
        status_track: normalizedStatusTrack,
        compressionTurnCounter,
        compressionEnabled,
        language: parsed?.language || gameState.language
      };
      nextState.isThinking = false;
      const normalizedSavedSnapshot = normalizeSavedSnapshot(savedSnapshotRaw, nextState);
      if (normalizedSavedSnapshot) {
        nextState = {
          ...nextState,
          ...normalizedSavedSnapshot,
          savedSnapshot: normalizedSavedSnapshot
        };
      } else {
        const legacySnapshot = buildSavedSnapshot(nextState);
        nextState = {
          ...nextState,
          history: markHistorySaved(nextState.history),
          status_track: nextState.status_track
            ? {
              ...nextState.status_track,
              status_change: markStatusChangesSaved(nextState.status_track.status_change)
            }
            : nextState.status_track,
          savedSnapshot: legacySnapshot
        };
      }
      const memoryCap = nextSettings.maxCompressedMemoryK ?? DEFAULT_SETTINGS.maxCompressedMemoryK;
      const normalizedMemory = nextState.compressedMemory
        ? clampCompressedMemory(nextState.compressedMemory, memoryCap, nextState.language)
        : '';
      nextState.compressedMemory = normalizedMemory;
      setGameState(nextState);
      const pendingAction = getPendingPlayerAction(nextState.history);
      if (pendingAction) {
        setLastAction({
          text: pendingAction.text,
          snapshot: {
            ...nextState,
            history: pendingAction.trimmedHistory,
            isThinking: false,
            turnCount: Math.max(0, (nextState.turnCount || 0) - 1)
          },
          status: 'pending'
        });
      } else {
        setLastAction(null);
      }
      setView('playing');

      if (needsKnownNpcCleanup) {
        setLegacyKnownNpcPrompt({ state: nextState });
      }

      if (!normalizedStatusTrack) {
        setLegacyInventoryPrompt({ state: nextState, reason: 'missing-status-track' });
      } else if (hasMissingInventoryCounts(parsed?.player?.inventory)) {
        setLegacyInventoryPrompt({ state: nextState, reason: 'missing-counts' });
      }

      const isLegacy = typeof parsed?.compressionTurnCounter !== 'number' || typeof parsed?.compressionEnabled !== 'boolean';
      if (isLegacy) {
        const rawLimit = Number.isFinite(nextSettings.maxHistoryTurns)
          ? Math.trunc(nextSettings.maxHistoryTurns)
          : DEFAULT_SETTINGS.maxHistoryTurns;
        const lockedLimit = isGuest ? getHistoryLimitForTier('guest') : rawLimit;
        if (lockedLimit !== -1) {
          const limit = Math.max(1, lockedLimit);
          const nonMemoryCount = nextState.history.filter(entry =>
            entry.meta !== 'memory' && !isErrorHistoryEntry(entry)
          ).length;
          if (nonMemoryCount > limit) {
            const reason: LegacyCompressionPrompt['reason'] = nextState.compressedMemory ? 'memory-no-counter' : 'no-memory';
            setLegacyCompressionPrompt({
              state: nextState,
              limit: nonMemoryCount,
              reason
            });
          }
        }
      }
    }
  }, [currentUser, isGuest, isNormal, isModelConfigured, activeTier, maxAp, apRecovery]);

  const applySession = (session: UserSession) => {
    setCurrentUser(session);
    setGameState(createInitialGameState(session.settings, session.ap, session.apLastUpdated, gameState.language));
    setArenaState(createInitialArenaState(session.settings, gameState.language));
    setHasSave(false);
    setHasArenaSave(false);
    lastHistoryLength.current = 0;
    lastCompressedMemory.current = '';
    lastInventorySignature.current = '';
    lastRawOutputCache.current = '';
    setLegacyInventoryPrompt(null);
    setInventoryRefreshError(null);
    setNarrationStage('idle');
    setStatusStage('idle');
    setImageStage('idle');
    setStatusManagerError(null);
    setArenaNarrationStage('idle');
    setArenaImageStage('idle');
    setArenaAvatarStage('idle');
    setShowGuestNotice(false);
    setSystemError(null);
    setLastAction(null);
    setIsCompressing(false);
    setCompressionError(null);
    setCompressionStatus(null);
    setLegacyCompressionPrompt(null);
    setArenaError(null);
  };

  const handleLogin = () => {
    const name = authName.trim();
    const passkey = authPasskey.trim();
    if (!name || !passkey) {
      setAuthError(gameState.language === 'en' ? 'Enter username and passkey.' : '请输入用户名和密码。');
      return;
    }
    const record = usersDb[name];
    if (!record || record.passkey !== passkey) {
      setAuthError(gameState.language === 'en' ? 'Invalid username or passkey.' : '用户名或密码错误。');
      return;
    }
    const tier = record.tier;
    const baseSettings = normalizeProviderSettings(record.settings || DEFAULT_SETTINGS);
    const textProvider = (baseSettings.textProvider || baseSettings.modelProvider || 'gemini') as ModelProvider;
    const imageProvider = (baseSettings.imageProvider || baseSettings.modelProvider || textProvider) as ModelProvider;
    const storedTextKey = tier === 'normal' ? loadUserApiKey(record.username, textProvider, 'text') : '';
    const storedImageKey = tier === 'normal' ? loadUserApiKey(record.username, imageProvider, 'image') : '';
    const storedTextProxyKey = tier === 'normal' ? loadUserProxyKey(record.username, textProvider, 'text') : '';
    const storedImageProxyKey = tier === 'normal' ? loadUserProxyKey(record.username, imageProvider, 'image') : '';
    const sessionTextApiKey = storedTextKey || undefined;
    const sessionImageApiKey = storedImageKey || undefined;
    const sessionTextProxyKey = storedTextProxyKey || undefined;
    const sessionImageProxyKey = storedImageProxyKey || undefined;
    const proxyEnabled = tier === 'normal' && !!baseSettings.useProxy;
    const hasTextKey = tier === 'normal' && (proxyEnabled ? !!sessionTextProxyKey : !!sessionTextApiKey);
    const hasImageKey = tier === 'normal' && (proxyEnabled ? !!sessionImageProxyKey : !!sessionImageApiKey);
    const settings = normalizeSessionSettings(baseSettings, tier, hasTextKey);
    const textProxyBase = normalizeProxyBaseUrl(
      settings.textProxyBaseUrl || settings.proxyBaseUrl || ''
    );
    const imageProxyBase = normalizeProxyBaseUrl(
      settings.imageProxyBaseUrl || settings.proxyBaseUrl || ''
    );
    const hasProxyBase = proxyEnabled ? (!!textProxyBase && (!!imageProxyBase || settings.imagesEnabled === false)) : true;
    const imagesEnabled = settings.imagesEnabled !== false;
    const textConfigured = !!settings.textModel?.trim() && !!settings.textProvider && hasTextKey;
    const imageConfigured = !imagesEnabled || (!!settings.imageModel?.trim() && !!settings.imageProvider && hasImageKey);
    const needsSetup = tier === 'normal' && (!isUserOnboarded(record.username) || !hasProxyBase || !textConfigured || !imageConfigured);
    const maxAllowedAp = getMaxApForTier(tier);
    let ap = Math.min(maxAllowedAp, typeof record.ap === 'number' ? record.ap : maxAllowedAp);
    let apLastUpdated = typeof record.apLastUpdated === 'number' && record.apLastUpdated > 0
      ? record.apLastUpdated
      : Date.now();
    const recovery = tier === 'normal' && hasTextKey ? null : getApRecoveryForTier(tier);
    if (recovery) {
      const synced = syncApState(ap, apLastUpdated, Date.now(), maxAllowedAp, recovery);
      ap = synced.ap;
      apLastUpdated = synced.apLastUpdated;
    }
    applySession({
      username: record.username,
      tier,
      ap,
      apLastUpdated,
      settings,
      textApiKey: sessionTextApiKey,
      imageApiKey: sessionImageApiKey,
      textProxyKey: sessionTextProxyKey,
      imageProxyKey: sessionImageProxyKey,
      isTemporary: false
    });
    setAuthError('');
    setAuthName('');
    setAuthPasskey('');
    setAuthConfirm('');
    setView('start');
    if (needsSetup) {
      setIsSettingsOpen(true);
    }
  };

  const handleRegister = () => {
    const name = authName.trim();
    const passkey = authPasskey.trim();
    const confirmation = authConfirm.trim();
    if (!name || !passkey) {
      setAuthError(gameState.language === 'en' ? 'Enter username and passkey.' : '请输入用户名和密码。');
      return;
    }
    if (name === RESERVED_ADMIN_USERNAME) {
      setAuthError(gameState.language === 'en' ? 'Username not available.' : '用户名不可用。');
      return;
    }
    if (passkey !== confirmation) {
      setAuthError(gameState.language === 'en' ? 'Passkeys do not match.' : '两次输入的密码不一致。');
      return;
    }
    if (usersDb[name]) {
      setAuthError(gameState.language === 'en' ? 'User already exists.' : '用户已存在。');
      return;
    }
    const now = Date.now();
    const newUser: UserRecord = {
      username: name,
      passkey,
      tier: 'normal',
      ap: NORMAL_MAX_AP,
      apLastUpdated: now,
      settings: DEFAULT_SETTINGS
    };
    const nextDb = { ...usersDb, [name]: newUser };
    setUsersDb(nextDb);
    localStorage.setItem(USERS_DB_KEY, serializeUsersDb(nextDb, invitationCode));
    applySession({
      username: name,
      tier: 'normal',
      ap: NORMAL_MAX_AP,
      apLastUpdated: now,
      settings: normalizeSessionSettings(DEFAULT_SETTINGS, 'normal', false),
      textApiKey: undefined,
      imageApiKey: undefined,
      textProxyKey: undefined,
      imageProxyKey: undefined,
      isTemporary: false
    });
    setAuthError('');
    setAuthName('');
    setAuthPasskey('');
    setAuthConfirm('');
    setView('start');
    setIsSettingsOpen(true);
  };

  const handleSkipLogin = () => {
    const remainingMs = getGuestCooldownRemainingMs();
    if (remainingMs > 0) {
      const minutesLeft = Math.ceil(remainingMs / 60000);
      setAuthError(isZh
        ? `临时用户冷却中，请 ${minutesLeft} 分钟后再试。`
        : `Guest cooldown active. Try again in ${minutesLeft} minute(s).`);
      return;
    }
    const now = Date.now();
    applySession({
      username: 'temporary',
      tier: 'guest',
      ap: GUEST_MAX_AP,
      apLastUpdated: now,
      settings: normalizeSessionSettings(DEFAULT_SETTINGS, 'guest', false),
      textApiKey: undefined,
      imageApiKey: undefined,
      textProxyKey: undefined,
      imageProxyKey: undefined,
      isTemporary: true
    });
    setGuestCooldownUntil(now + GUEST_COOLDOWN_MS);
    setView('start');
    setShowGuestNotice(true);
  };

  const openUsersEditor = () => {
    setUsersEditorText(serializeUsersDb(usersDb, invitationCode));
    setUsersEditorError('');
    setIsUsersEditorOpen(true);
  };

  const handleUsersEditorSave = () => {
    try {
      const parsed = JSON.parse(usersEditorText);
      const normalized = normalizeUsersDb(parsed);
      const nextInvitation = extractInvitationCode(parsed) ?? invitationCode;
      setUsersDb(normalized);
      setInvitationCode(nextInvitation);
      localStorage.setItem(USERS_DB_KEY, serializeUsersDb(normalized, nextInvitation));
      setUsersEditorText(serializeUsersDb(normalized, nextInvitation));
      setUsersEditorError('');
    } catch (e) {
      setUsersEditorError(isZh ? 'JSON 解析失败，请检查格式。' : 'Invalid JSON. Please check the format.');
    }
  };

  const handleUsersEditorDownload = () => {
    try {
      const blob = new Blob([usersEditorText], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'users.json';
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setUsersEditorError(isZh ? '下载失败。' : 'Download failed.');
    }
  };

  const handleKeySelection = async () => {
    if ((window as any).aistudio?.openSelectKey) {
      await (window as any).aistudio.openSelectKey();
    }
    setKeyAlert(false);
  };

  const pickEra = useCallback(async () => {
    if (isNormal && !isModelConfigured) {
      setIsSettingsOpen(true);
      return;
    }
    if (textProvider === 'gemini' && !useProxy && !hasTextUserKey && typeof (window as any).aistudio !== 'undefined') {
      const hasKey = await (window as any).aistudio.hasSelectedApiKey();
      if (!hasKey) {
        setKeyAlert(true);
      }
    }

    const { year, region, time } = rollEra();
    
    setGameState(prev => ({ 
      ...prev, 
      currentYear: year, 
      location: region,
      currentTime: time
    }));
    setView('creation');
  }, [isNormal, isModelConfigured, textProvider, useProxy, hasTextUserKey]);

  const handleCharacterCreation = async () => {
    if (isNormal && !isModelConfigured) {
      setIsSettingsOpen(true);
      return;
    }
    if (!charDescription.trim()) return;
    setGameState(prev => ({ ...prev, isThinking: true }));
    setCreationStartTime(Date.now());
    setCreationElapsed(0);
    setCreationPhase(getCreationPhaseText('request', isZh));
    try {
      const creation = await createPlayerCharacter(
        charDescription, 
        gameState.currentYear, 
        gameState.location, 
        gameState.language,
        { 
          tier: activeTier,
          apiKey: currentUser?.textApiKey,
          proxyApiKey: currentUser?.textProxyKey,
          proxyBaseUrl: textProxyBaseUrl,
          useProxy,
          textModel: effectiveTextModel,
          provider: textProvider,
          userSystemPrompt: gameState.settings.userSystemPrompt,
          onProgress: (message) => {
            const mapped = formatCreationProgress(message, isZh, isAdmin);
            if (mapped) setCreationPhase(mapped);
          }
        }
      );

      const { companions: initialCompanions, tokenUsage: creationUsage, ...player } = creation as PlayerCreationResult;
      const normalizedPlayer = normalizeActor(player as Actor);
      const seededCompanions = (initialCompanions ?? []).map(companion => normalizeActor({
        ...companion,
        ifCompanion: true
      }));

      const allowImages = imagesEnabled;
      const allowAvatars = imagesEnabled && !isGuest;
      if (allowImages) {
        setCreationPhase(getCreationPhaseText('image', isZh));
      }
      
      const introMsg = gameState.language === 'en' 
        ? `Simulation Initialized. Locating profile... Success. Welcome, ${player.name}.`
        : `模拟初始化。正在定位档案... 成功。欢迎，${player.name}。`;

      const startNarration = `${introMsg} ${player.lore}`;
      const avatarPromise = allowAvatars && seededCompanions.length > 0
        ? Promise.all(seededCompanions.map(companion => generateCompanionAvatar(companion, { tier: activeTier, apiKey: currentUser?.imageApiKey, proxyApiKey: currentUser?.imageProxyKey, proxyBaseUrl: imageProxyBaseUrl, useProxy, imageModel: effectiveImageModel, provider: imageProvider })))
        : Promise.resolve([]);
      const imagePromise = allowImages
        ? generateSceneImage(
          `The ${gameState.location} landscape during the year ${gameState.currentYear}, Fallout universe aesthetic`,
          { highQuality: gameState.settings.highQualityImages, tier: activeTier, apiKey: currentUser?.imageApiKey, proxyApiKey: currentUser?.imageProxyKey, proxyBaseUrl: imageProxyBaseUrl, useProxy, imageModel: effectiveImageModel, provider: imageProvider, textProvider, textApiKey: currentUser?.textApiKey, textProxyApiKey: currentUser?.textProxyKey, textModel: effectiveTextModel }
        )
        : Promise.resolve(undefined);
      const [imgData, avatarResults] = await Promise.all([imagePromise, avatarPromise]);

      let initialKnownNpcs = seededCompanions;
      if (avatarResults.length > 0) {
        const avatarByName = new Map<string, string>();
        avatarResults.forEach((result, index) => {
          const url = result?.url;
          if (url) {
            avatarByName.set(seededCompanions[index].name, url);
          }
        });
        if (avatarByName.size > 0) {
          initialKnownNpcs = initialKnownNpcs.map(npc => {
            const avatarUrl = avatarByName.get(npc.name);
            if (!avatarUrl) return npc;
            return { ...npc, avatarUrl };
          });
        }
      }

      setCreationPhase(getCreationPhaseText('finalize', isZh));
      const initialStatusTrack: StatusTrack = {
        initial_status: buildStatusSnapshot(
          normalizedPlayer,
          [],
          initialKnownNpcs,
          gameState.location,
          gameState.currentYear,
          gameState.currentTime
        ),
        status_change: []
      };

        setGameState(prev => {
          const nextState: GameState = {
            ...prev,
            player: normalizedPlayer,
            knownNpcs: initialKnownNpcs,
            isThinking: false,
            tokenUsage: mergeTokenUsage(prev.tokenUsage, creationUsage),
            compressionTurnCounter: 0,
            status_track: initialStatusTrack,
            history: [{ 
              sender: 'narrator', 
              text: startNarration, 
              imageUrl: imgData?.url,
              groundingSources: imgData?.sources,
              isSaved: false
            }]
          };
          return {
            ...nextState,
            savedSnapshot: buildSavedSnapshot(nextState)
          };
        });
      setSystemError(null);
      setLastAction(null);
      setIsCompressing(false);
      setCompressionError(null);
      setCompressionStatus(null);
      setView('playing');
      setCreationPhase('');
      setCreationStartTime(null);
      setCreationElapsed(0);
    } catch (err) {
      console.error("Vault-Tec Database Error:", err);
      cacheRawOutput(err);
      const errorMessage = appendJsonParseGuidance(
        err instanceof Error ? err.message : String(err),
        isZh
      );
      setCreationPhase(isZh ? `访问请求失败：${errorMessage}` : `Access request failed: ${errorMessage}`);
      setGameState(prev => ({ 
        ...prev, 
        isThinking: false,
          history: [...prev.history, { 
            sender: 'narrator', 
            text: gameState.language === 'en' 
              ? `VAULT-TEC ERROR: Connection timed out while constructing profile. Please try again.` 
              : `避难所科技错误：构建档案时连接超时。请重试。`,
            isSaved: false
          }]
      }));
    }
  };

  const openArenaSetup = () => {
    if (isNormal && !isModelConfigured) {
      setIsSettingsOpen(true);
      return;
    }
    setArenaState(prev => {
      const hasContent =
        !!prev.focus.trim() ||
        prev.involvedParties.some(party => party.description.trim()) ||
        prev.history.length > 0;
      if (hasContent) return prev;
      const base = createInitialArenaState(gameState.settings, gameState.language);
      if (!prev.userPromptCustom) return base;
      return {
        ...base,
        userPrompt: prev.userPrompt,
        userPromptCustom: true
      };
    });
    setArenaError(null);
    setArenaNarrationStage('idle');
    setArenaImageStage('idle');
    setArenaAvatarStage('idle');
    setView('arena_setup');
  };

  const updateArenaFocus = (value: string) => {
    setArenaState(prev => ({ ...prev, focus: value }));
  };

  const updateArenaMode = (mode: 'scenario' | 'wargame') => {
    setArenaState(prev => ({
      ...prev,
      mode,
      involvedParties: mode === 'scenario'
        ? prev.involvedParties.map(party => ({ ...party, forcePower: undefined, maxForcePower: undefined }))
        : prev.involvedParties
    }));
  };

  const updateArenaParty = (index: number, value: string) => {
    setArenaState(prev => {
      const next = [...prev.involvedParties];
      const current = next[index] || { description: '' };
      next[index] = { ...current, description: value };
      return { ...prev, involvedParties: next };
    });
  };

  const addArenaParty = () => {
    setArenaState(prev => {
      if (prev.involvedParties.length >= 10) return prev;
      return { ...prev, involvedParties: [...prev.involvedParties, { description: '' }] };
    });
  };

  const removeArenaParty = (index: number) => {
    setArenaState(prev => {
      if (prev.involvedParties.length <= 2) return prev;
      const next = prev.involvedParties.filter((_, idx) => idx !== index);
      return { ...prev, involvedParties: next };
    });
  };

  const loadArena = () => {
    if (!currentUser) return;
    const saved = localStorage.getItem(getArenaSaveKey(currentUser.username));
    if (!saved) return;
    try {
      const parsed = JSON.parse(saved);
      const normalized = normalizeArenaState(parsed, gameState.settings, gameState.language);
      const mergedSettings = applyDefaultUserPrompt(normalized.settings, gameState.language);
      setGameState(prev => ({
        ...prev,
        settings: mergedSettings,
        language: gameState.language
      }));
      setArenaState({ ...normalized, settings: mergedSettings });
      setArenaError(null);
      setArenaNarrationStage('idle');
      setArenaImageStage('idle');
      setArenaAvatarStage('idle');
      setView(normalized.history.length > 0 ? 'arena_play' : 'arena_setup');
    } catch (err) {
      console.error(err);
      alert(isZh ? '斗兽场存档读取失败。' : 'Failed to load arena save.');
    }
  };

  const runArenaSimulation = async (finish: boolean, resetHistory: boolean) => {
    if (isNormal && !isModelConfigured) {
      setIsSettingsOpen(true);
      return;
    }
    const focus = arenaState.focus.trim();
    const filteredParties = arenaState.involvedParties
      .map(party => ({ ...party, description: party.description.trim() }))
      .filter(party => party.description);
    const parties = filteredParties.map(party => party.description);
    if (!focus) {
      setArenaError(isZh ? '请先填写模拟焦点。' : 'Enter a focus question first.');
      return;
    }
    if (parties.length < 2) {
      setArenaError(isZh ? '请至少填写两个参战方。' : 'Provide at least two involved parties.');
      return;
    }
    const baseHistory: HistoryEntry[] = resetHistory ? [] : arenaState.history;
    const baseTokenUsage = resetHistory ? { sent: 0, received: 0, total: 0 } : arenaState.tokenUsage;
    const arenaMode = arenaState.mode;
    const phase = resetHistory ? 'briefing' : (arenaState.briefingComplete ? 'battle' : 'briefing');
    const baseParties = resetHistory
      ? filteredParties.map(party => ({
          ...party,
          forcePower: undefined,
          maxForcePower: undefined
        }))
      : filteredParties;
    setArenaError(null);
    setArenaState(prev => ({
      ...prev,
      focus,
      involvedParties: baseParties,
      history: baseHistory,
      finished: resetHistory ? false : prev.finished,
      isThinking: true,
      turnCount: resetHistory ? 0 : prev.turnCount,
      tokenUsage: baseTokenUsage,
      briefingComplete: resetHistory ? false : prev.briefingComplete
    }));
    setArenaNarrationStage('running');
    setArenaImageStage('pending');
    setArenaAvatarStage('pending');
    if (resetHistory) {
      setView('arena_play');
    }
    try {
      const trimmedHistory = buildNarratorHistory(baseHistory, historyLimit, '', false);
      const forcePowers = arenaMode === 'wargame'
        ? baseParties.map(party => (Number.isFinite(party.forcePower) ? party.forcePower as number : null))
        : undefined;
      const response = await getArenaNarration(
        focus,
        parties,
        trimmedHistory,
        gameState.language,
        {
          tier: activeTier,
          apiKey: currentUser?.textApiKey,
          proxyApiKey: currentUser?.textProxyKey,
          proxyBaseUrl: textProxyBaseUrl,
          useProxy,
          textModel: effectiveTextModel,
          provider: textProvider,
          userSystemPrompt: arenaState.userPrompt,
          finish,
          mode: arenaMode,
          phase,
          forcePowers
        }
      );
      setArenaNarrationStage('done');
      const nextHistory: HistoryEntry[] = [...baseHistory, { sender: 'narrator', text: response.storyText, imageUrl: undefined, isSaved: false }];
      const nextTurn = baseHistory.length === 0 ? 1 : arenaState.turnCount + 1;
      const updatedParties = arenaMode === 'wargame' && response.forcePowers
        ? baseParties.map((party, index) => {
            const nextPower = Number.isFinite(response.forcePowers?.[index])
              ? Math.max(0, Math.floor(response.forcePowers[index] as number))
              : party.forcePower;
            const prevMax = Number.isFinite(party.maxForcePower) ? party.maxForcePower : undefined;
            const nextMax = Number.isFinite(nextPower)
              ? (prevMax ? Math.max(prevMax, nextPower) : nextPower)
              : prevMax;
            return {
              ...party,
              forcePower: nextPower,
              maxForcePower: nextMax
            };
          })
        : baseParties;
      const remainingForces = arenaMode === 'wargame'
        ? updatedParties.filter(party => (party.forcePower ?? 0) > 0).length
        : null;
      const autoFinish = arenaMode === 'wargame' && phase === 'battle' && remainingForces !== null && remainingForces <= 1;

      const lockedImageTurns = isNormal && !hasTextAuthKey
        ? normalDefaultImageTurns
        : (isGuest ? guestFixedImageTurns : null);
      const imageEveryTurns = lockedImageTurns ?? Math.max(minImageTurns, Math.floor(arenaState.settings.imageEveryTurns || minImageTurns));
      const shouldGenerateImage = imagesEnabled && !isGuest && nextTurn % imageEveryTurns === 0;
      const imagePrompt = response.imagePrompt || response.storyText;

      const scenePromise = shouldGenerateImage
        ? generateSceneImage(imagePrompt, {
            highQuality: arenaState.settings.highQualityImages,
            tier: activeTier,
            apiKey: currentUser?.imageApiKey,
            proxyApiKey: currentUser?.imageProxyKey,
            proxyBaseUrl: imageProxyBaseUrl,
            useProxy,
            imageModel: effectiveImageModel,
            provider: imageProvider,
            textProvider,
            textApiKey: currentUser?.textApiKey,
            textProxyApiKey: currentUser?.textProxyKey,
            textModel: effectiveTextModel
          }).catch(err => {
            setArenaImageStage('error');
            throw err;
          })
        : Promise.resolve(undefined);

      type ArenaAvatarResult = { party: typeof updatedParties[number]; error?: string };
      const avatarPromises: Promise<ArenaAvatarResult>[] = imagesEnabled && !isGuest
        ? updatedParties.map(async (party, index) => {
            if (party.avatarUrl || !party.description.trim()) {
              return { party };
            }
            const avatar = await generateArenaAvatar(`Party ${index + 1}`, party.description, {
              highQuality: arenaState.settings.highQualityImages,
              tier: activeTier,
              apiKey: currentUser?.imageApiKey,
              proxyApiKey: currentUser?.imageProxyKey,
              proxyBaseUrl: imageProxyBaseUrl,
              useProxy,
              imageModel: effectiveImageModel,
              provider: imageProvider,
              textProvider,
              textApiKey: currentUser?.textApiKey,
              textProxyApiKey: currentUser?.textProxyKey,
              textModel: effectiveTextModel
            });
            if (avatar?.url) {
              return { party: { ...party, avatarUrl: avatar.url } };
            }
            return { party, error: avatar?.error || 'Avatar generation failed.' };
          })
        : updatedParties.map(party => Promise.resolve({ party }));

      setArenaImageStage(shouldGenerateImage ? 'running' : 'skipped');
      setArenaAvatarStage(imagesEnabled && !isGuest ? 'running' : 'skipped');

      let sceneResult: { url?: string; sources?: any[] } | undefined;
      try {
        sceneResult = await scenePromise;
        if (sceneResult?.url) {
          nextHistory[nextHistory.length - 1] = {
            ...nextHistory[nextHistory.length - 1],
            imageUrl: sceneResult.url,
            groundingSources: sceneResult.sources
          };
        }
        setArenaImageStage(shouldGenerateImage ? 'done' : 'skipped');
      } catch (err) {
        const message = appendJsonParseGuidance(
          err instanceof Error ? err.message : String(err),
          isZh
        );
        setArenaError(isZh ? `图像生成失败：${message}` : `Image generation failed: ${message}`);
        setArenaImageStage('error');
      }

      let avatarFailed = false;
      let nextParties: typeof updatedParties = updatedParties;
      try {
        const results = await Promise.all(avatarPromises);
        avatarFailed = results.some(result => !!result.error);
        nextParties = results.map(result => result.party);
        if (avatarFailed) {
          setArenaError(isZh ? '头像生成出现问题，请稍后再试。' : 'Avatar generation encountered issues. Try again later.');
        }
      } catch (err) {
        avatarFailed = true;
        const message = appendJsonParseGuidance(
          err instanceof Error ? err.message : String(err),
          isZh
        );
        setArenaError(isZh ? `头像生成失败：${message}` : `Avatar generation failed: ${message}`);
      }
      setArenaAvatarStage(avatarFailed ? 'error' : (imagesEnabled && !isGuest ? 'done' : 'skipped'));

      setArenaState(prev => ({
        ...prev,
        isThinking: false,
        history: nextHistory,
        turnCount: nextTurn,
        tokenUsage: mergeTokenUsage(baseTokenUsage, response.tokenUsage),
        involvedParties: nextParties,
        finished: finish || autoFinish ? true : prev.finished,
        briefingComplete: phase === 'briefing' ? true : prev.briefingComplete
      }));
    } catch (err) {
      console.error(err);
      setArenaState(prev => ({ ...prev, isThinking: false }));
      setArenaNarrationStage('error');
      setArenaImageStage('idle');
      setArenaAvatarStage('idle');
      const message = appendJsonParseGuidance(
        err instanceof Error ? err.message : String(err),
        isZh
      );
      setArenaError(isZh ? `斗兽场故障：${message}` : `Arena error: ${message}`);
    }
  };

  const handleAction = async (
    e?: React.FormEvent,
    overrideText?: string,
    overrideState?: GameState,
    options?: { reroll?: boolean }
  ) => {
    e?.preventDefault();
    const state = overrideState ?? gameState;
    const rawText = (overrideText ?? userInput).trim();
    if (!rawText || state.isThinking || !state.player) return;
    if (compressionLocked) return;
    if (isNormal && !isModelConfigured) {
      setIsSettingsOpen(true);
      return;
    }
    const isZhAction = state.language === 'zh';

    const actionSettings = state.settings;
    const useEventPipelineAction = actionSettings.pipelineMode === 'event';
    const useProxyAction = isNormal && !!actionSettings.useProxy;
    const textProxyBaseUrlAction = normalizeProxyBaseUrl(
      actionSettings.textProxyBaseUrl || actionSettings.proxyBaseUrl || ''
    );
    const imageProxyBaseUrlAction = normalizeProxyBaseUrl(
      actionSettings.imageProxyBaseUrl || actionSettings.proxyBaseUrl || ''
    );
    const hasTextAuthKeyAction = useProxyAction ? hasTextProxyKey : hasTextUserKey;
    const normalKeyUnlockedAction = isNormal && hasTextAuthKeyAction;
    const isKeyUnlockedAction = isAdmin || normalKeyUnlockedAction;
    const apUnlimitedAction = isKeyUnlockedAction;
    const maxApAction = isKeyUnlockedAction ? getMaxApForTier('admin') : getMaxApForTier(activeTier);
    const apRecoveryAction = isKeyUnlockedAction ? null : getApRecoveryForTier(activeTier);
    const minImageTurnsAction = isKeyUnlockedAction ? 1 : getMinImageTurnsForTier(activeTier);
    const rawHistoryLimit = Number.isFinite(actionSettings.maxHistoryTurns)
      ? Math.trunc(actionSettings.maxHistoryTurns)
      : DEFAULT_SETTINGS.maxHistoryTurns;
    const lockedHistoryLimit = isGuest ? getHistoryLimitForTier('guest') : rawHistoryLimit;
    const historyLimitAction = lockedHistoryLimit === -1 ? null : Math.max(1, lockedHistoryLimit);
    const imagesEnabledAction = actionSettings.imagesEnabled !== false;
    const textProviderAction: ModelProvider = isGuest || isAdmin
      ? 'gemini'
      : (actionSettings.textProvider || actionSettings.modelProvider || 'gemini');
    const imageProviderAction: ModelProvider = isGuest || isAdmin
      ? 'gemini'
      : (actionSettings.imageProvider || actionSettings.modelProvider || 'gemini');
    const effectiveTextModel = actionSettings.textModel?.trim() || undefined;
    const effectiveImageModel = actionSettings.imageModel?.trim() || undefined;
    const tokenUsageBase = options?.reroll ? gameState.tokenUsage : state.tokenUsage;

    const now = Date.now();
    let currentAp = state.ap;
    let currentApLastUpdated = state.apLastUpdated;

    if (!apUnlimitedAction && apRecoveryAction) {
      const synced = syncApState(currentAp, currentApLastUpdated, now, maxApAction, apRecoveryAction);
      currentAp = synced.ap;
      currentApLastUpdated = synced.apLastUpdated;

      if (currentAp <= 0) {
        const elapsed = Math.max(0, now - currentApLastUpdated);
        const remainingMs = apRecoveryAction.intervalMs - (elapsed % apRecoveryAction.intervalMs);
        const minutesLeft = Math.max(1, Math.ceil(remainingMs / 60000));
        const waitLabel = formatRecoveryInterval(minutesLeft, isZhAction);
        const apMessage = state.language === 'en'
          ? `ACTION POINTS DEPLETED. Please return after ${waitLabel}.`
          : `行动点已耗尽。请在 ${waitLabel} 后再试。`;
        setGameState(prev => ({
          ...prev,
          isThinking: false,
          ap: currentAp,
          apLastUpdated: currentApLastUpdated,
          history: [...prev.history, { sender: 'narrator', text: apMessage, isSaved: false }]
        }));
        return;
      }
    } else if (!apUnlimitedAction && currentAp <= 0) {
      const apMessage = state.language === 'en'
        ? `ACTION POINTS DEPLETED. Please return later.`
        : `行动点已耗尽。请稍后再试。`;
      setGameState(prev => ({
        ...prev,
        isThinking: false,
        ap: currentAp,
        apLastUpdated: currentApLastUpdated,
          history: [...prev.history, { sender: 'narrator', text: apMessage, isSaved: false }]
      }));
      return;
    }

    if (!options?.reroll) {
      setUserInput('');
    }
    setSystemError(null);
    setStatusManagerError(null);
    if (useEventPipelineAction) {
      setNarrationStage('pending');
      setStatusStage('running');
    } else {
      setNarrationStage('running');
      setStatusStage('pending');
    }
    setImageStage('pending');

    const baseHistory = !options?.reroll && lastAction?.status === 'error'
      ? stripFailedAction(state.history, lastAction.text)
      : state.history;
    if (!options?.reroll && lastAction?.status === 'error') {
      setLastAction(null);
    }

    const actionText = rawText;
      const updatedHistory: HistoryEntry[] = [...baseHistory, { sender: 'player', text: actionText, isSaved: false }];
    const useMemory = state.compressionEnabled !== false;
    const trimmedHistory = buildNarratorHistory(
      updatedHistory,
      historyLimitAction,
      state.compressedMemory,
      useMemory
    );
    const lockedImageTurns = isNormal && !hasTextAuthKeyAction
      ? normalDefaultImageTurns
      : (isGuest ? guestFixedImageTurns : null);
    const imageEveryTurns = lockedImageTurns ?? Math.max(minImageTurnsAction, Math.floor(actionSettings.imageEveryTurns || minImageTurnsAction));
    const nextTurn = state.turnCount + 1;
    const shouldGenerateImage = imagesEnabledAction && !isGuest && nextTurn % imageEveryTurns === 0;
    const nextAp = apUnlimitedAction ? currentAp : Math.max(0, currentAp - 1);
    const nextApLastUpdated = apRecoveryAction
      ? (currentAp >= maxApAction ? now : currentApLastUpdated)
      : currentApLastUpdated;

    setLastAction({
      text: actionText,
      snapshot: cloneGameState(state),
      status: 'pending'
    });

    setGameState({
      ...state,
      isThinking: true,
      history: updatedHistory,
      ap: currentAp,
      apLastUpdated: currentApLastUpdated,
      turnCount: nextTurn,
      tokenUsage: tokenUsageBase
    });

    try {
      if (useEventPipelineAction) {
        let eventOutcome: EventOutcome | null = null;
        let eventTokenUsage: TokenUsage | undefined;
        try {
          const eventKnownNpcs = state.knownNpcs.map(({ avatarUrl, ...rest }) => rest);
          const eventResult = await getEventOutcome(
            state.player,
            trimmedHistory,
            actionText,
            state.currentYear,
            state.location,
            state.currentTime,
            state.quests,
            eventKnownNpcs,
            state.language,
            {
              tier: activeTier,
              apiKey: currentUser?.textApiKey,
              proxyApiKey: currentUser?.textProxyKey,
              proxyBaseUrl: textProxyBaseUrlAction,
              useProxy: useProxyAction,
              textModel: effectiveTextModel,
              provider: textProviderAction,
              userSystemPrompt: actionSettings.userSystemPrompt
            }
          );
          eventOutcome = eventResult;
          eventTokenUsage = eventResult.tokenUsage;
          setStatusStage('done');
        } catch (eventErr) {
          setStatusStage('error');
          cacheRawOutput(eventErr);
          const detail = appendJsonParseGuidance(
            eventErr instanceof Error ? eventErr.message : String(eventErr),
            isZhAction
          );
          const statusErrorMessage = state.language === 'en'
            ? `VAULT-TEC ERROR: Event manager failed.\n[LOG] ${detail}`
            : `避难所科技错误：事件管理失败。\n[日志] ${detail}`;
          setStatusManagerError(statusErrorMessage);
          throw eventErr;
        }

        if (!eventOutcome) {
          throw new Error(isZhAction ? '事件管理返回为空。' : 'Event manager returned empty output.');
        }

        if (eventOutcome.ruleViolation) {
          setNarrationStage('skipped');
          setImageStage('skipped');
          setLastAction(prev => (prev ? { ...prev, status: 'resolved' } : prev));
          setGameState(prev => ({
            ...prev,
            isThinking: false,
            ap: currentAp,
            apLastUpdated: currentApLastUpdated,
            tokenUsage: mergeTokenUsage(prev.tokenUsage, eventTokenUsage),
              history: [...updatedHistory, {
                sender: 'narrator',
                text: `[RULE ERROR / 规则错误] ${eventOutcome.ruleViolation}`,
                isSaved: false
              }]
          }));
          return;
        }

        const eventOutcomeForNarration = { ...eventOutcome };
        delete (eventOutcomeForNarration as { tokenUsage?: TokenUsage }).tokenUsage;
        setNarrationStage('running');
        const narrationResponse: EventNarrationResponse = await getEventNarration(
          state.player,
          state.currentYear,
          state.location,
          eventOutcomeForNarration,
          state.language,
          {
            tier: activeTier,
            apiKey: currentUser?.textApiKey,
            proxyApiKey: currentUser?.textProxyKey,
            proxyBaseUrl: textProxyBaseUrlAction,
            useProxy: useProxyAction,
            textModel: effectiveTextModel,
            provider: textProviderAction,
            userSystemPrompt: actionSettings.userSystemPrompt
          }
        );
        const narratorTokenUsage = narrationResponse.tokenUsage;
        setNarrationStage('done');

        const newTime = new Date(state.currentTime);
        newTime.setMinutes(newTime.getMinutes() + (eventOutcome.timePassedMinutes || 0));

        const visualPrompt = narrationResponse.imagePrompt || eventOutcome.outcomeSummary || actionText;
        setImageStage(shouldGenerateImage ? 'running' : 'skipped');
        const sceneImagePromise = shouldGenerateImage
          ? generateSceneImage(visualPrompt, {
            highQuality: actionSettings.highQualityImages,
            tier: activeTier,
            apiKey: currentUser?.imageApiKey,
            proxyApiKey: currentUser?.imageProxyKey,
            proxyBaseUrl: imageProxyBaseUrlAction,
            useProxy: useProxyAction,
            imageModel: effectiveImageModel,
            provider: imageProviderAction,
            textProvider: textProviderAction,
            textApiKey: currentUser?.textApiKey,
            textProxyApiKey: currentUser?.textProxyKey,
            textModel: effectiveTextModel
          }).catch(err => {
            setImageStage('error');
            throw err;
          })
          : Promise.resolve(undefined);

        const eventStatusChange: StatusChange = {
          ...eventOutcomeForNarration
        };

        const questUpdates = eventStatusChange.questUpdates;
        const { merged: mergedQuests, completedNotes } = applyQuestUpdates(state.quests, questUpdates);
        let storyText = narrationResponse.storyText;
        if (completedNotes.length > 0) {
          storyText += `\n\n${completedNotes.join('\n\n')}`;
        }

        let nextKnownNpcs: Actor[] = state.knownNpcs.map(withCompanionFlag);
        const newNpcList = normalizeNewNpcList(eventStatusChange.newNpc);
        newNpcList.forEach(npc => {
          if (npc) {
            nextKnownNpcs = upsertNpc(nextKnownNpcs, npc);
          }
        });
        const companionUpdates = eventStatusChange.companionUpdates;
        nextKnownNpcs = applyCompanionUpdates(nextKnownNpcs, companionUpdates);

        const companionsNeedingAvatar = !imagesEnabledAction || isGuest
          ? []
          : nextKnownNpcs.filter(npc => npc.ifCompanion && !npc.avatarUrl);

        const avatarPromise = companionsNeedingAvatar.length > 0
          ? Promise.all(companionsNeedingAvatar.map(npc => generateCompanionAvatar(npc, {
            tier: activeTier,
            apiKey: currentUser?.imageApiKey,
            proxyApiKey: currentUser?.imageProxyKey,
            proxyBaseUrl: imageProxyBaseUrlAction,
            useProxy: useProxyAction,
            imageModel: effectiveImageModel,
            provider: imageProviderAction
          })))
          : Promise.resolve([]);
        const [imgData, avatarResults] = await Promise.all([sceneImagePromise, avatarPromise]);
        if (shouldGenerateImage) {
          setImageStage(imgData?.error ? 'error' : 'done');
        }
        const imageLog = shouldGenerateImage && imgData?.error
          ? (isZhAction ? `\n\n[图像日志] ${imgData.error}` : `\n\n[IMAGE LOG] ${imgData.error}`)
          : '';

        if (avatarResults.length > 0) {
          const avatarByName = new Map<string, string>();
          avatarResults.forEach((result, index) => {
            const url = result?.url;
            if (url) {
              avatarByName.set(companionsNeedingAvatar[index].name, url);
            }
          });
          if (avatarByName.size > 0) {
            nextKnownNpcs = nextKnownNpcs.map(npc => {
              const avatarUrl = avatarByName.get(npc.name);
              if (!avatarUrl) return npc;
              return { ...npc, avatarUrl };
            });
          }
        }
        nextKnownNpcs = nextKnownNpcs.map(npc => normalizeActor(npc));
        setSystemError(null);
        setLastAction(prev => (prev ? { ...prev, status: 'resolved' } : prev));

          const narratorEntry: HistoryEntry = {
            sender: 'narrator',
            text: `${storyText}${imageLog}`,
            imageUrl: imgData?.url,
            groundingSources: imgData?.sources,
            isSaved: false
          };
        const nextHistory = [...updatedHistory, narratorEntry];
        const baseStatusTrack: StatusTrack | null = state.status_track || (state.player
          ? {
            initial_status: buildStatusSnapshot(
              state.player,
              state.quests,
              state.knownNpcs,
              state.location,
              state.currentYear,
              state.currentTime
            ),
            status_change: []
          }
          : null);
        const nextStatusTrack = baseStatusTrack
          ? {
            ...baseStatusTrack,
            status_change: [
                ...baseStatusTrack.status_change,
                {
                  narration_index: countNarrations(nextHistory),
                  ...(eventStatusChange && typeof eventStatusChange === 'object' ? eventStatusChange : {}),
                  isSaved: false
                }
              ]
          }
          : null;
        const compressionActive = !!historyLimitAction && state.compressionEnabled !== false;
        const nextCounter = compressionActive ? (state.compressionTurnCounter || 0) + 1 : 0;
        const statusPlayer = eventStatusChange.playerChange
          ? applyPlayerChange(state.player, eventStatusChange.playerChange)
          : null;
        const nextLocation = typeof eventStatusChange.location === 'string' && eventStatusChange.location.trim()
          ? eventStatusChange.location.trim()
          : state.location;
        const nextYear = typeof eventStatusChange.currentYear === 'number' && Number.isFinite(eventStatusChange.currentYear)
          ? Math.trunc(eventStatusChange.currentYear)
          : state.currentYear;
        const nextTime = typeof eventStatusChange.currentTime === 'string' && eventStatusChange.currentTime.trim()
          ? eventStatusChange.currentTime.trim()
          : newTime.toISOString();
        const tokenDelta = mergeTokenUsage(normalizeTokenUsage(narratorTokenUsage), eventTokenUsage);
        const nextState: GameState = {
          ...state,
          isThinking: false,
          currentTime: nextTime,
          location: nextLocation,
          currentYear: nextYear,
          quests: mergedQuests,
          knownNpcs: nextKnownNpcs,
          ap: nextAp,
          apLastUpdated: nextApLastUpdated,
          turnCount: nextTurn,
          tokenUsage: mergeTokenUsage(state.tokenUsage, tokenDelta),
          player: statusPlayer ? statusPlayer : state.player,
          history: nextHistory,
          status_track: nextStatusTrack,
          compressionTurnCounter: nextCounter
        };
        setGameState(nextState);

        if (compressionActive && historyLimitAction && nextCounter >= historyLimitAction) {
          setLastAction(null);
          await runMemoryCompression(nextState, historyLimitAction);
        }
        return;
      }

      const response = await getNarrativeResponse(
        state.player,
        trimmedHistory,
        actionText,
        state.currentYear,
        state.location,
        state.quests,
        state.knownNpcs,
        state.language,
        {
          tier: activeTier,
          apiKey: currentUser?.textApiKey,
          proxyApiKey: currentUser?.textProxyKey,
          proxyBaseUrl: textProxyBaseUrlAction,
          useProxy: useProxyAction,
          textModel: effectiveTextModel,
          provider: textProviderAction,
          userSystemPrompt: actionSettings.userSystemPrompt
        }
      );

      const narratorTokenUsage = response.tokenUsage;
      setNarrationStage('done');
      if (response.ruleViolation) {
        setLastAction(prev => (prev ? { ...prev, status: 'resolved' } : prev));
        setGameState(prev => ({
          ...prev,
          isThinking: false,
          ap: currentAp,
          apLastUpdated: currentApLastUpdated,
          tokenUsage: mergeTokenUsage(prev.tokenUsage, narratorTokenUsage),
          history: [...updatedHistory, { 
            sender: 'narrator', 
            text: `[RULE ERROR / 规则错误] ${response.ruleViolation}`,
            isSaved: false
          }] 
        })); 
        return;
      }

      const newTime = new Date(state.currentTime);
      newTime.setMinutes(newTime.getMinutes() + response.timePassedMinutes);

      const visualPrompt = response.imagePrompt || actionText;
      setImageStage(shouldGenerateImage ? 'running' : 'skipped');
      const sceneImagePromise = shouldGenerateImage
        ? generateSceneImage(visualPrompt, {
          highQuality: actionSettings.highQualityImages,
          tier: activeTier,
          apiKey: currentUser?.imageApiKey,
          proxyApiKey: currentUser?.imageProxyKey,
          proxyBaseUrl: imageProxyBaseUrlAction,
          useProxy: useProxyAction,
          imageModel: effectiveImageModel,
          provider: imageProviderAction,
          textProvider: textProviderAction,
          textApiKey: currentUser?.textApiKey,
          textProxyApiKey: currentUser?.textProxyKey,
          textModel: effectiveTextModel
        }).catch(err => {
          setImageStage('error');
          throw err;
        })
        : Promise.resolve(undefined);

      let statusChange: StatusChange | null = null;
      let statusSucceeded = false;
      let statusTokenUsage: TokenUsage | undefined;
      try {
        setStatusStage('running');
        const statusKnownNpcs = state.knownNpcs.map(({ avatarUrl, ...rest }) => rest);
        const statusResult = await getStatusUpdate(
          state.player,
          state.quests,
          statusKnownNpcs,
          state.currentYear,
          state.location,
          state.currentTime,
          response.storyText,
          state.language,
          {
            tier: activeTier,
            apiKey: currentUser?.textApiKey,
            proxyApiKey: currentUser?.textProxyKey,
            proxyBaseUrl: textProxyBaseUrlAction,
            useProxy: useProxyAction,
            textModel: effectiveTextModel,
            provider: textProviderAction
          }
        );
        statusChange = statusResult.update || null;
        statusTokenUsage = statusResult.tokenUsage;
        setStatusStage('done');
        statusSucceeded = true;
      } catch (statusErr) {
        setStatusStage('error');
        cacheRawOutput(statusErr);
        const detail = appendJsonParseGuidance(
          statusErr instanceof Error ? statusErr.message : String(statusErr),
          isZhAction
        );
        const statusErrorMessage = state.language === 'en'
          ? `VAULT-TEC ERROR: Status manager failed.\n[LOG] ${detail}`
          : `避难所科技错误：状态管理失败。\n[日志] ${detail}`;
        setStatusManagerError(statusErrorMessage);
        console.error('Status manager error:', statusErr);
      }

      const questUpdates = statusChange?.questUpdates;
      const { merged: mergedQuests, completedNotes } = applyQuestUpdates(state.quests, questUpdates);
      let storyText = response.storyText;
      if (completedNotes.length > 0) {
        storyText += `\n\n${completedNotes.join('\n\n')}`;
      }

      let nextKnownNpcs: Actor[] = state.knownNpcs.map(withCompanionFlag);
      const newNpcList = normalizeNewNpcList(statusChange?.newNpc);
      newNpcList.forEach(npc => {
        if (npc) {
          nextKnownNpcs = upsertNpc(nextKnownNpcs, npc);
        }
      });
      const companionUpdates = statusChange?.companionUpdates;
      nextKnownNpcs = applyCompanionUpdates(nextKnownNpcs, companionUpdates);

      const companionsNeedingAvatar = !imagesEnabledAction || isGuest
        ? []
        : nextKnownNpcs.filter(npc => npc.ifCompanion && !npc.avatarUrl);

      const avatarPromise = companionsNeedingAvatar.length > 0
        ? Promise.all(companionsNeedingAvatar.map(npc => generateCompanionAvatar(npc, {
          tier: activeTier,
          apiKey: currentUser?.imageApiKey,
          proxyApiKey: currentUser?.imageProxyKey,
          proxyBaseUrl: imageProxyBaseUrlAction,
          useProxy: useProxyAction,
          imageModel: effectiveImageModel,
          provider: imageProviderAction
        })))
        : Promise.resolve([]);
      const [imgData, avatarResults] = await Promise.all([sceneImagePromise, avatarPromise]);
      if (shouldGenerateImage) {
        setImageStage(imgData?.error ? 'error' : 'done');
      }
      const imageLog = shouldGenerateImage && imgData?.error
        ? (isZhAction ? `\n\n[图像日志] ${imgData.error}` : `\n\n[IMAGE LOG] ${imgData.error}`)
        : '';

      if (avatarResults.length > 0) {
        const avatarByName = new Map<string, string>();
        avatarResults.forEach((result, index) => {
          const url = result?.url;
          if (url) {
            avatarByName.set(companionsNeedingAvatar[index].name, url);
          }
        });
        if (avatarByName.size > 0) {
          nextKnownNpcs = nextKnownNpcs.map(npc => {
            const avatarUrl = avatarByName.get(npc.name);
            if (!avatarUrl) return npc;
            return { ...npc, avatarUrl };
          });
        }
      }
      nextKnownNpcs = nextKnownNpcs.map(npc => normalizeActor(npc));
      setSystemError(null);
      setLastAction(prev => (prev ? { ...prev, status: 'resolved' } : prev));

      const narratorEntry: HistoryEntry = {
        sender: 'narrator',
        text: `${storyText}${imageLog}`,
        imageUrl: imgData?.url,
        groundingSources: imgData?.sources,
        isSaved: false
      };
      const nextHistory = [...updatedHistory, narratorEntry];
      const nextStatusTrack = statusSucceeded && state.status_track
        ? {
          ...state.status_track,
          status_change: [
              ...state.status_track.status_change,
              {
                narration_index: countNarrations(nextHistory),
                ...(statusChange && typeof statusChange === 'object' ? statusChange : {}),
                isSaved: false
              }
            ]
        }
        : state.status_track;
      const compressionActive = !!historyLimitAction && state.compressionEnabled !== false;
      const nextCounter = compressionActive ? (state.compressionTurnCounter || 0) + 1 : 0;
      const statusPlayer = statusChange?.playerChange
        ? applyPlayerChange(state.player, statusChange.playerChange)
        : null;
      const nextLocation = typeof statusChange?.location === 'string' && statusChange.location.trim()
        ? statusChange.location.trim()
        : state.location;
      const nextYear = typeof statusChange?.currentYear === 'number' && Number.isFinite(statusChange.currentYear)
        ? Math.trunc(statusChange.currentYear)
        : state.currentYear;
      const nextTime = typeof statusChange?.currentTime === 'string' && statusChange.currentTime.trim()
        ? statusChange.currentTime.trim()
        : newTime.toISOString();
      const tokenDelta = mergeTokenUsage(normalizeTokenUsage(narratorTokenUsage), statusTokenUsage);
      const nextState: GameState = {
        ...state,
        isThinking: false,
        currentTime: nextTime,
        location: nextLocation,
        currentYear: nextYear,
        quests: mergedQuests,
        knownNpcs: nextKnownNpcs,
        ap: nextAp,
        apLastUpdated: nextApLastUpdated,
        turnCount: nextTurn,
        tokenUsage: mergeTokenUsage(state.tokenUsage, tokenDelta),
        player: statusPlayer ? statusPlayer : state.player,
        history: nextHistory,
        status_track: nextStatusTrack,
        compressionTurnCounter: nextCounter
      };
      setGameState(nextState);

      if (compressionActive && historyLimitAction && nextCounter >= historyLimitAction) {
        setLastAction(null);
        await runMemoryCompression(nextState, historyLimitAction);
      }
    } catch (err) {
      console.error(err);
      cacheRawOutput(err);
      const errorDetail = appendJsonParseGuidance(
        err instanceof Error ? err.message : String(err),
        isZhAction
      );
      setNarrationStage('error');
      setStatusStage(prev => (prev === 'error' ? 'error' : 'idle'));
      setImageStage('idle');
      const errorLog = state.language === 'en'
        ? `[LOG] ${errorDetail}`
        : `[日志] ${errorDetail}`;
      const errorMessage = state.language === 'en'
        ? `VAULT-TEC ERROR: Narrative link unstable.\n${errorLog}`
        : `避难所科技错误：叙事链路不稳定。\n${errorLog}`;
      setSystemError(errorMessage);
      setLastAction(prev => (prev ? { ...prev, status: 'error' } : prev));
      setGameState(prev => ({ 
        ...prev, 
        isThinking: false,
        ap: currentAp,
        apLastUpdated: currentApLastUpdated,
        turnCount: state.turnCount,
        history: updatedHistory,
        compressionTurnCounter: state.compressionTurnCounter || 0
      }));
    }
  };

  const handleReroll = () => {
    if (!lastAction || gameState.isThinking) return;
    const rerollState: GameState = {
      ...lastAction.snapshot,
      settings: gameState.settings,
      language: gameState.language
    };
    handleAction(undefined, lastAction.text, rerollState, { reroll: true });
  };

  const rerollCreationParams = () => {
    if (gameState.isThinking) return;
    const { year, region, time } = rollEra();
    setGameState(prev => ({
      ...prev,
      currentYear: year,
      location: region,
      currentTime: time
    }));
  };

  const runMemoryCompression = async (state: GameState, limit: number) => {
    if (limit <= 0) return;
    const isZhCompression = state.language === 'zh';
    if (compressionStatusTimeout.current) {
      window.clearTimeout(compressionStatusTimeout.current);
      compressionStatusTimeout.current = null;
    }
    setIsCompressing(true);
    setCompressionError(null);
    setCompressionStatus(isZhCompression
      ? '叙事历史上限已到，正在进行记忆压缩...'
      : 'Narrator history limit hit. Performing memory compression...');
    try {
      const payload = buildCompressionPayload(state, limit);
      const maxMemoryK = state.settings.maxCompressedMemoryK || 25;
      const result = await compressMemory(payload, state.language, maxMemoryK, {
        tier: activeTier,
        apiKey: currentUser?.textApiKey,
        proxyApiKey: currentUser?.textProxyKey,
        proxyBaseUrl: normalizeProxyBaseUrl(
          state.settings.textProxyBaseUrl || state.settings.proxyBaseUrl || ''
        ),
        useProxy: isNormal && !!state.settings.useProxy,
        textModel: state.settings.textModel || undefined,
        provider: (state.settings.textProvider || state.settings.modelProvider || 'gemini') as ModelProvider
      });
      const memoryText = result.memory?.trim();
      if (!memoryText) {
        throw new Error(isZhCompression ? '记忆压缩返回内容为空。' : 'Compression returned empty memory.');
      }
      const safeMemory = clampCompressedMemory(memoryText, maxMemoryK, state.language);
      const nextHistory = state.history;
      setGameState(prev => ({
        ...prev,
        history: nextHistory,
        compressedMemory: safeMemory,
        compressionTurnCounter: 0,
        compressionEnabled: true,
        tokenUsage: mergeTokenUsage(prev.tokenUsage, result.tokenUsage)
      }));
      const successMessage = isZhCompression ? '记忆压缩完成。' : 'Memory compression complete.';
      setCompressionStatus(successMessage);
      compressionStatusTimeout.current = window.setTimeout(() => {
        setCompressionStatus(null);
        compressionStatusTimeout.current = null;
      }, 4000);
      setIsCompressing(false);
      setCompressionError(null);
    } catch (err) {
      cacheRawOutput(err);
      const detail = appendJsonParseGuidance(
        err instanceof Error ? err.message : String(err),
        isZhCompression
      );
      setCompressionStatus(null);
      setIsCompressing(false);
      setCompressionError(isZhCompression ? `记忆压缩失败：${detail}` : `Memory compression failed: ${detail}`);
    }
  };

  const retryMemoryCompression = () => {
    if (gameState.isThinking || isCompressing) return;
    const rawLimit = Number.isFinite(gameState.settings.maxHistoryTurns)
      ? Math.trunc(gameState.settings.maxHistoryTurns)
      : DEFAULT_SETTINGS.maxHistoryTurns;
    const lockedLimit = isGuest ? getHistoryLimitForTier('guest') : rawLimit;
    if (lockedLimit === -1) return;
    const limit = Math.max(1, lockedLimit);
    runMemoryCompression(gameState, limit);
  };

  const runManualCompression = () => {
    if (gameState.isThinking || isCompressing) return;
    const nonMemoryCount = gameState.history.filter(entry =>
      entry.meta !== 'memory' && !isErrorHistoryEntry(entry)
    ).length;
    const rawLimit = Number.isFinite(gameState.settings.maxHistoryTurns)
      ? Math.trunc(gameState.settings.maxHistoryTurns)
      : DEFAULT_SETTINGS.maxHistoryTurns;
    const lockedLimit = isGuest ? getHistoryLimitForTier('guest') : rawLimit;
    const historyLimit = lockedLimit === -1 ? null : Math.max(1, lockedLimit);
    const targetLimit = gameState.compressedMemory
      ? (historyLimit ?? nonMemoryCount)
      : nonMemoryCount;
    if (!targetLimit) return;
    setLastAction(null);
    const nextState = {
      ...gameState,
      compressionTurnCounter: 0,
      compressionEnabled: true
    };
    setGameState(nextState);
    runMemoryCompression(nextState, targetLimit);
  };

  const handleManualCompressionRequest = () => {
    if (compressionLocked) return;
    setIsManualCompressionConfirmOpen(true);
  };

  const handleManualCompressionConfirm = () => {
    setIsManualCompressionConfirmOpen(false);
    runManualCompression();
  };

  const handleLegacyCompressNow = () => {
    if (!legacyCompressionPrompt) return;
    const targetState = {
      ...legacyCompressionPrompt.state,
      compressionTurnCounter: 0,
      compressionEnabled: true
    };
    setLegacyCompressionPrompt(null);
    setCompressionError(null);
    setCompressionStatus(null);
    setGameState(targetState);
    runMemoryCompression(targetState, legacyCompressionPrompt.limit);
  };

  const handleLegacyCompressLater = () => {
    if (!legacyCompressionPrompt) return;
    const nextState = {
      ...legacyCompressionPrompt.state,
      compressionTurnCounter: 0,
      compressionEnabled: false
    };
    setLegacyCompressionPrompt(null);
    setCompressionError(null);
    setCompressionStatus(null);
    setGameState(nextState);
    setSystemError(isZh
      ? '已暂时跳过记忆压缩。你可以在顶部按钮中手动压缩记忆。'
      : 'Memory compression skipped for now. You can compress manually via the top button.');
  };

  const runInventoryRefresh = async (state: GameState) => {
    if (!state.player) return;
    setIsInventoryRefreshing(true);
    setInventoryRefreshError(null);
    try {
      const isZhRefresh = state.language === 'zh';
      const provider = (state.settings.textProvider || state.settings.modelProvider || 'gemini') as ModelProvider;
      const baseOptions = {
        tier: activeTier,
        apiKey: currentUser?.textApiKey,
        proxyApiKey: currentUser?.textProxyKey,
        proxyBaseUrl: normalizeProxyBaseUrl(
          state.settings.textProxyBaseUrl || state.settings.proxyBaseUrl || ''
        ),
        useProxy: isNormal && !!state.settings.useProxy,
        textModel: state.settings.textModel || undefined,
        provider
      };

      if (state.status_track) {
        setSystemError(isZhRefresh
          ? '正在根据状态轨迹重建库存...'
          : 'Rebuilding inventory from status track...');
        const rebuilt = rebuildInventoryFromStatusTrack(state.status_track);
        setSystemError(isZhRefresh
          ? '正在校验物品重量...'
          : 'Auditing item weights...');
        const audit = await auditInventoryWeights(rebuilt, state.language, baseOptions);
        const refreshed = mergeInventoryWeights(rebuilt, audit.inventory as InventoryItem[]);
        setGameState(prev => ({
          ...prev,
          player: prev.player ? { ...prev.player, inventory: refreshed } : prev.player,
          tokenUsage: mergeTokenUsage(prev.tokenUsage, audit.tokenUsage)
        }));
        setSystemError(isZhRefresh
          ? '库存刷新完成。'
          : 'Inventory refresh complete.');
        return;
      }

      setSystemError(isZhRefresh
        ? '旧存档库存恢复中，可能需要较长时间，且准确度可能受历史长度影响。'
        : 'Legacy inventory recovery in progress. This may take a while and accuracy may be limited by history length.');
      const narrationList = state.history
        .filter(entry => entry.sender === 'narrator')
        .map(entry => entry.text);
      const recovery = await recoverInventoryStatus(
        state.player.lore,
        narrationList,
        state.language,
        baseOptions
      );
      const recoveredInitialInventory = normalizeInventory(recovery.initialInventory as InventoryItem[]);
      const maxNarrations = narrationList.length;
        const recoveredChanges: StatusChangeEntry[] = Array.isArray(recovery.inventoryChanges)
          ? recovery.inventoryChanges.map((entry: any) => ({
            narration_index: Math.max(
              1,
              Math.min(
                maxNarrations,
                Math.trunc(entry?.narration_index ?? entry?.nrration_index ?? 1)
              )
            ),
            playerChange: {
              inventoryChange: entry?.inventoryChange
            },
            isSaved: false
          }))
          : [];
      const recoveredTrack: StatusTrack = {
        initial_status: buildStatusSnapshot(
          { ...state.player, inventory: recoveredInitialInventory },
          state.quests,
          state.knownNpcs,
          state.location,
          state.currentYear,
          state.currentTime
        ),
        status_change: recoveredChanges
      };
      const rebuilt = rebuildInventoryFromStatusTrack(recoveredTrack);
      setSystemError(isZhRefresh
        ? '正在校验物品重量...'
        : 'Auditing item weights...');
      const audit = await auditInventoryWeights(rebuilt, state.language, baseOptions);
      const refreshed = mergeInventoryWeights(rebuilt, audit.inventory as InventoryItem[]);
      const combinedUsage = mergeTokenUsage(
        normalizeTokenUsage(recovery.tokenUsage),
        audit.tokenUsage
      );
      setGameState(prev => ({
        ...prev,
        status_track: recoveredTrack,
        player: prev.player ? { ...prev.player, inventory: refreshed } : prev.player,
        tokenUsage: mergeTokenUsage(prev.tokenUsage, combinedUsage)
      }));
      setSystemError(isZhRefresh
        ? '库存恢复完成。'
        : 'Inventory recovery complete.');
    } catch (err) {
      cacheRawOutput(err);
      const detail = appendJsonParseGuidance(
        err instanceof Error ? err.message : String(err),
        isZhRefresh
      );
      setInventoryRefreshError(detail);
      setSystemError(state.language === 'zh'
        ? `库存刷新失败：${detail}`
        : `Inventory refresh failed: ${detail}`);
    } finally {
      setIsInventoryRefreshing(false);
    }
  };

  const handleInventoryRefresh = () => {
    if (gameState.isThinking || isInventoryRefreshing) return;
    if (isNormal && !isModelConfigured) {
      setIsSettingsOpen(true);
      return;
    }
    runInventoryRefresh(gameState);
  };

  const handleLegacyInventoryRefreshNow = () => {
    if (!legacyInventoryPrompt) return;
    setLegacyInventoryPrompt(null);
    runInventoryRefresh(legacyInventoryPrompt.state);
  };

  const handleLegacyInventoryRefreshLater = () => {
    if (!legacyInventoryPrompt) return;
    if (legacyInventoryPrompt.reason === 'missing-status-track' && legacyInventoryPrompt.state.player) {
      const snapshot = buildStatusSnapshot(
        legacyInventoryPrompt.state.player,
        legacyInventoryPrompt.state.quests,
        legacyInventoryPrompt.state.knownNpcs,
        legacyInventoryPrompt.state.location,
        legacyInventoryPrompt.state.currentYear,
        legacyInventoryPrompt.state.currentTime
      );
      setGameState(prev => ({
        ...prev,
        status_track: {
          initial_status: snapshot,
          status_change: []
        }
      }));
    }
    setLegacyInventoryPrompt(null);
    if (legacyInventoryPrompt.reason === 'missing-status-track') {
      setSystemError(isZh
        ? '已暂时跳过库存恢复。已以当前库存建立初始状态，从本回合起开始记录变更。'
        : 'Inventory recovery skipped. Current inventory is stored as the initial status and changes will be tracked from this turn onward.');
    } else {
      setSystemError(isZh
        ? '已暂时跳过库存刷新。你可以在状态面板中手动刷新库存。'
        : 'Inventory refresh skipped for now. You can refresh manually from the status panel.');
    }
  };

  const handleLegacyKnownNpcCleanupNow = () => {
    if (!legacyKnownNpcPrompt) return;
    if (currentUser) {
      try {
        localStorage.setItem(getSaveKey(currentUser.username), JSON.stringify(legacyKnownNpcPrompt.state));
      } catch {
        // Ignore storage errors.
      }
    }
    setLegacyKnownNpcPrompt(null);
    setSystemError(isZh ? '已清理旧存档的 NPC 列表。' : 'Save cleanup applied to known NPCs.');
  };

  const handleLegacyKnownNpcCleanupLater = () => {
    if (!legacyKnownNpcPrompt) return;
    setLegacyKnownNpcPrompt(null);
  };

  const handleRegenerateCompanionAvatar = async (npcName: string) => {
    const target = gameState.knownNpcs.find(npc => npc.ifCompanion && npc.name === npcName);
    if (!target) return;
    if (!imagesEnabled) {
      setSystemError(isZh ? '已关闭头像生成。请在设置中开启图像。' : 'Image generation is disabled. Enable it in settings.');
      return;
    }
    if (imageProvider === 'claude') {
      setSystemError(isZh ? 'Claude 不支持图像生成。' : 'Claude image generation is not supported.');
      return;
    }
    if (!effectiveImageModel) {
      setSystemError(isZh ? '未设置图像模型。请先在设置中选择。' : 'Missing image model. Select one in settings.');
      setIsSettingsOpen(true);
      return;
    }
    if (!isAdmin && !hasImageAuthKey) {
      setSystemError(isZh ? '缺少图像 API Key。请在设置中配置。' : 'Missing image API key. Configure it in settings.');
      setIsSettingsOpen(true);
      return;
    }
    setCompanionAvatarPending(prev => ({ ...prev, [npcName]: true }));
    try {
      const result = await generateCompanionAvatar(target, {
        tier: activeTier,
        apiKey: currentUser?.imageApiKey,
        proxyApiKey: currentUser?.imageProxyKey,
        proxyBaseUrl: imageProxyBaseUrl,
        useProxy,
        imageModel: effectiveImageModel,
        provider: imageProvider
      });
      if (result?.url) {
        setGameState(prev => ({
          ...prev,
          knownNpcs: prev.knownNpcs.map(npc =>
            npc.name === npcName ? { ...npc, avatarUrl: result.url } : npc
          )
        }));
        return;
      }
      const errorMessage = result?.error || (isZh ? '头像生成失败。' : 'Avatar generation failed.');
      setSystemError(errorMessage);
    } catch (err) {
      const detail = appendJsonParseGuidance(
        err instanceof Error ? err.message : String(err),
        isZh
      );
      setSystemError(isZh ? `头像生成失败：${detail}` : `Avatar generation failed: ${detail}`);
    } finally {
      setCompanionAvatarPending(prev => {
        const next = { ...prev };
        delete next[npcName];
        return next;
      });
    }
  };

  const cacheRawOutput = (err: unknown) => {
    const raw = getRawOutputFromError(err);
    if (!raw) return;
    setGameState(prev => ({ ...prev, rawOutputCache: raw }));
  };

  const runStatusRebuild = async (mode: 'track' | 'llm') => {
    if (!gameState.status_track || !gameState.player) {
      setSystemError(isZh ? '无法重建状态：缺少状态轨迹。' : 'Status rebuild unavailable: missing status track.');
      return;
    }
    if (mode === 'llm' && isNormal && !isModelConfigured) {
      setIsSettingsOpen(true);
      return;
    }
    setIsStatusRebuilding(true);
    setStatusManagerError(null);
    try {
      let nextTrack = gameState.status_track;
      let tokenDelta = normalizeTokenUsage(null);
      if (mode === 'llm') {
        const narrations = getNarrationEntries(gameState.history);
        const total = narrations.length;
        if (total === 0) {
          setSystemError(isZh ? '没有可重建的叙事回合。' : 'No narration turns available for rebuild.');
        } else {
          const baseOptions = {
            tier: activeTier,
            apiKey: currentUser?.textApiKey,
            proxyApiKey: currentUser?.textProxyKey,
            proxyBaseUrl: textProxyBaseUrl,
            useProxy,
            textModel: effectiveTextModel,
            provider: textProvider
          };
          let player = normalizeActor(nextTrack.initial_status.player);
          let quests = Array.isArray(nextTrack.initial_status.quests) ? nextTrack.initial_status.quests : [];
          let knownNpcs: Actor[] = normalizeKnownNpcList(nextTrack.initial_status.knownNpcs).cleaned.map(withCompanionFlag);
          let location = typeof nextTrack.initial_status.location === 'string'
            ? nextTrack.initial_status.location
            : gameState.location;
          let currentYear = typeof nextTrack.initial_status.currentYear === 'number'
            ? Math.trunc(nextTrack.initial_status.currentYear)
            : gameState.currentYear;
          let currentTime = typeof nextTrack.initial_status.currentTime === 'string'
            ? nextTrack.initial_status.currentTime
            : gameState.currentTime;
          const rebuiltChanges: StatusChangeEntry[] = [];
          for (let index = 0; index < narrations.length; index += 1) {
            const narrationIndex = index + 1;
            setSystemError(isZh
              ? `状态重建中 (${narrationIndex}/${total})...`
              : `Rebuilding status (${narrationIndex}/${total})...`);
            const statusKnownNpcs = knownNpcs.map(({ avatarUrl, ...rest }) => rest);
            const statusResult = await getStatusUpdate(
              player,
              quests,
              statusKnownNpcs,
              currentYear,
              location,
              currentTime,
              narrations[index].text,
              gameState.language,
              baseOptions
            );
            tokenDelta = mergeTokenUsage(tokenDelta, statusResult.tokenUsage);
            const update = statusResult.update || null;
            rebuiltChanges.push({
              narration_index: narrationIndex,
              ...(update && typeof update === 'object' ? update : {}),
              isSaved: false
            });
            if (update?.playerChange) {
              player = applyPlayerChange(player, update.playerChange);
            }
            if (update?.questUpdates) {
              const result = applyQuestUpdates(quests, update.questUpdates);
              quests = result.merged;
            }
            let nextKnownNpcs: Actor[] = knownNpcs.map(withCompanionFlag);
            const newNpcList = normalizeNewNpcList(update?.newNpc);
            newNpcList.forEach(npc => {
              if (npc) {
                nextKnownNpcs = upsertNpc(nextKnownNpcs, npc);
              }
            });
            nextKnownNpcs = applyCompanionUpdates(nextKnownNpcs, update?.companionUpdates);
            knownNpcs = nextKnownNpcs.map(npc => normalizeActor(npc));
            if (typeof update?.location === 'string' && update.location.trim()) {
              location = update.location.trim();
            }
            if (typeof update?.currentYear === 'number' && Number.isFinite(update.currentYear)) {
              currentYear = Math.trunc(update.currentYear);
            }
            if (typeof update?.currentTime === 'string' && update.currentTime.trim()) {
              currentTime = update.currentTime.trim();
            }
          }
          nextTrack = {
            ...nextTrack,
            status_change: rebuiltChanges
          };
        }
      }
      const rebuilt = rebuildStatusFromTrack(nextTrack);
      setGameState(prev => ({
        ...prev,
        player: rebuilt.player,
        quests: rebuilt.quests,
        knownNpcs: rebuilt.knownNpcs,
        location: rebuilt.location,
        currentYear: rebuilt.currentYear,
        currentTime: rebuilt.currentTime,
        status_track: nextTrack,
        tokenUsage: mode === 'llm' ? mergeTokenUsage(prev.tokenUsage, tokenDelta) : prev.tokenUsage
      }));
      setSystemError(isZh ? '状态重建完成。' : 'Status rebuild complete.');
    } catch (err) {
      cacheRawOutput(err);
      const detail = appendJsonParseGuidance(
        err instanceof Error ? err.message : String(err),
        isZh
      );
      setSystemError(isZh ? `状态重建失败：${detail}` : `Status rebuild failed: ${detail}`);
    } finally {
      setIsStatusRebuilding(false);
    }
  };

  const handleStatusRebuildRequest = () => {
    if (!gameState.status_track || !gameState.player) {
      setSystemError(isZh ? '无法重建状态：缺少状态轨迹。' : 'Status rebuild unavailable: missing status track.');
      return;
    }
    if (isStatusRebuilding) return;
    setStatusRebuildPrompt({ step: 'choose' });
  };

  const handleStatusRebuildQuick = () => {
    setStatusRebuildPrompt(null);
    runStatusRebuild('track');
  };

  const handleStatusRebuildLlmPrompt = () => {
    setStatusRebuildPrompt({ step: 'llm-confirm' });
  };

  const handleStatusRebuildLlmContinue = () => {
    setStatusRebuildPrompt(null);
    runStatusRebuild('llm');
  };

  const handleStatusRebuildLlmSettings = () => {
    setStatusRebuildPrompt(null);
    setIsSettingsOpen(true);
  };

  const handleStatusRebuildClose = () => {
    setStatusRebuildPrompt(null);
  };

  const handleStatusRebuildBack = () => {
    setStatusRebuildPrompt({ step: 'choose' });
  };

  const handleCopyRawOutput = async () => {
    const raw = gameState.rawOutputCache || '';
    if (!raw) return;
    try {
      await navigator.clipboard.writeText(raw);
      alert(isZh ? '原始输出已复制。' : 'Raw output copied.');
    } catch (err) {
      console.error(err);
      alert(isZh ? '复制失败，请手动复制。' : 'Copy failed. Please copy manually.');
    }
  };

  const toggleLanguage = (lang: Language) => {
    setGameState(prev => ({
      ...prev,
      language: lang,
      settings: applyDefaultUserPrompt(prev.settings, lang)
    }));
    setArenaState(prev => applyDefaultArenaPrompt({ ...prev }, lang));
  };

  const toggleAutoSave = () => {
    setGameState(prev => ({
      ...prev,
      settings: {
        ...prev.settings,
        autoSaveEnabled: !(prev.settings.autoSaveEnabled ?? false)
      }
    }));
  };

  const toggleHighQualityImages = () => {
    if (!imagesEnabled) return;
    setGameState(prev => ({
      ...prev,
      settings: {
        ...prev.settings,
        highQualityImages: !prev.settings.highQualityImages
      }
    }));
  };

  const toggleImageGeneration = () => {
    setGameState(prev => ({
      ...prev,
      settings: {
        ...prev.settings,
        imagesEnabled: prev.settings.imagesEnabled === false
      }
    }));
  };

  const updateTextProvider = (value: ModelProvider) => {
    if (!currentUser || !isNormal) return;
    setGameState(prev => ({
      ...prev,
      settings: {
        ...prev.settings,
        textProvider: value
      }
    }));
    const storedKey = loadUserApiKey(currentUser.username, value, 'text');
    const storedProxyKey = loadUserProxyKey(currentUser.username, value, 'text');
    setCurrentUser(prev => (prev ? { ...prev, textApiKey: storedKey || undefined, textProxyKey: storedProxyKey || undefined } : prev));
  };

  const updateImageProvider = (value: ModelProvider) => {
    if (!currentUser || !isNormal) return;
    setGameState(prev => ({
      ...prev,
      settings: {
        ...prev.settings,
        imageProvider: value
      }
    }));
    const storedKey = loadUserApiKey(currentUser.username, value, 'image');
    const storedProxyKey = loadUserProxyKey(currentUser.username, value, 'image');
    setCurrentUser(prev => (prev ? { ...prev, imageApiKey: storedKey || undefined, imageProxyKey: storedProxyKey || undefined } : prev));
  };

  const updateTextApiKey = (value: string) => {
    if (!currentUser || !isNormal) return;
    const trimmed = value.trim();
    persistUserApiKey(currentUser.username, textProvider, trimmed, 'text');
    setCurrentUser(prev => (prev ? { ...prev, textApiKey: trimmed || undefined } : prev));
  };

  const updateImageApiKey = (value: string) => {
    if (!currentUser || !isNormal) return;
    const trimmed = value.trim();
    persistUserApiKey(currentUser.username, imageProvider, trimmed, 'image');
    setCurrentUser(prev => (prev ? { ...prev, imageApiKey: trimmed || undefined } : prev));
  };

  const updateProxyEnabled = (checked: boolean) => {
    if (!isNormal) return;
    setGameState(prev => ({
      ...prev,
      settings: {
        ...prev.settings,
        useProxy: checked
      }
    }));
  };

  const updateProxyBaseUrl = (value: string) => {
    if (!isNormal) return;
    const normalized = normalizeProxyBaseUrl(value);
    setGameState(prev => ({
      ...prev,
      settings: {
        ...prev.settings,
        proxyBaseUrl: normalized
      }
    }));
  };

  const updateTextProxyBaseUrl = (value: string) => {
    if (!isNormal) return;
    const normalized = normalizeProxyBaseUrl(value);
    setGameState(prev => ({
      ...prev,
      settings: {
        ...prev.settings,
        textProxyBaseUrl: normalized
      }
    }));
  };

  const updateImageProxyBaseUrl = (value: string) => {
    if (!isNormal) return;
    const normalized = normalizeProxyBaseUrl(value);
    setGameState(prev => ({
      ...prev,
      settings: {
        ...prev.settings,
        imageProxyBaseUrl: normalized
      }
    }));
  };

  const updateTextProxyKey = (value: string) => {
    if (!currentUser || !isNormal) return;
    const trimmed = value.trim();
    persistUserProxyKey(currentUser.username, textProvider, trimmed, 'text');
    setCurrentUser(prev => (prev ? { ...prev, textProxyKey: trimmed || undefined } : prev));
  };

  const updateImageProxyKey = (value: string) => {
    if (!currentUser || !isNormal) return;
    const trimmed = value.trim();
    persistUserProxyKey(currentUser.username, imageProvider, trimmed, 'image');
    setCurrentUser(prev => (prev ? { ...prev, imageProxyKey: trimmed || undefined } : prev));
  };

  const updateTextModelName = (value: string) => {
    if (!isNormal) return;
    setGameState(prev => ({
      ...prev,
      settings: {
        ...prev.settings,
        textModel: value
      }
    }));
  };

  const updateImageModelName = (value: string) => {
    if (!isNormal) return;
    setGameState(prev => ({
      ...prev,
      settings: {
        ...prev.settings,
        imageModel: value
      }
    }));
  };

  const updateUserSystemPrompt = (value: string) => {
    setGameState(prev => ({
      ...prev,
      settings: {
        ...prev.settings,
        userSystemPrompt: value,
        userSystemPromptCustom: true
      }
    }));
  };

  const updateArenaSystemPrompt = (value: string) => {
    setArenaState(prev => ({
      ...prev,
      userPrompt: value,
      userPromptCustom: true
    }));
  };

  const handleReturnToMenu = () => {
    const message = isZh
      ? '返回菜单前请确认已保存进度。现在返回？'
      : 'Please make sure you saved your progress before returning. Return to menu now?';
    if (window.confirm(message)) {
      setIsSidebarOpen(false);
      setView('start');
    }
  };

  const startPanelResize = (panel: 'stat' | 'arena') => (event: React.PointerEvent) => {
    if (!isDesktop) return;
    setDraggingPanel(panel);
    dragStartX.current = event.clientX;
    dragStartWidth.current = panel === 'stat' ? statPanelWidth : arenaPanelWidth;
    event.preventDefault();
  };

  const updateCompressedMemoryLimit = (value: string) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.max(1, Math.floor(parsed));
    setGameState(prev => ({
      ...prev,
      settings: {
        ...prev.settings,
        maxCompressedMemoryK: clamped
      }
    }));
  };

  const updateTextScale = (value: string) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    const clamped = clampNumber(parsed, 0.8, 5);
    setGameState(prev => ({
      ...prev,
      settings: {
        ...prev.settings,
        textScale: clamped
      }
    }));
    setArenaState(prev => ({
      ...prev,
      settings: {
        ...prev.settings,
        textScale: clamped
      }
    }));
  };

  const updateInterfaceColorChannel = (channel: keyof InterfaceColor, value: string) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    const fallback = DEFAULT_INTERFACE_COLOR[channel];
    const clamped = clampColorChannel(parsed, fallback);
    setGameState(prev => {
      const base = normalizeInterfaceColor(prev.settings.interfaceColor, DEFAULT_INTERFACE_COLOR);
      const nextColor = { ...base, [channel]: clamped };
      return {
        ...prev,
        settings: {
          ...prev.settings,
          interfaceColor: nextColor
        }
      };
    });
  };

  const resetInterfaceColor = () => {
    setGameState(prev => ({
      ...prev,
      settings: {
        ...prev.settings,
        interfaceColor: { ...DEFAULT_INTERFACE_COLOR }
      }
    }));
  };

  const updateImageFrequency = (value: string) => {
    if (!imagesEnabled) return;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    if (!canAdjustImageFrequency) return;
    const clamped = Math.max(minImageTurns, Math.floor(parsed));
    setGameState(prev => ({
      ...prev,
      settings: {
        ...prev.settings,
        imageEveryTurns: clamped
      }
    }));
  };

  const updateHistoryLimit = (value: string) => {
    if (!currentUser || isGuest) return;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    const next = parsed <= -1 ? -1 : Math.max(1, Math.floor(parsed));
    setGameState(prev => ({
      ...prev,
      settings: {
        ...prev.settings,
        maxHistoryTurns: next
      }
    }));
  };

  const updatePipelineMode = (mode: PipelineMode) => {
    setGameState(prev => ({
      ...prev,
      settings: {
        ...prev.settings,
        pipelineMode: mode
      }
    }));
  };

  const displayLocation = localizeLocation(gameState.location, gameState.language);
  const displayYear = formatYear(gameState.currentYear, gameState.language);
  const usersEditorModal = isUsersEditorOpen && (
    <div className="fixed top-0 left-0 w-full h-full z-[3100] flex items-start justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="max-w-3xl w-full max-h-[90vh] overflow-y-auto pip-boy-border p-6 md:p-8 bg-black">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-2xl font-bold uppercase">USERS.JSON</h3>
          <button
            onClick={() => setIsUsersEditorOpen(false)}
            className="text-xs border border-[color:rgba(var(--pip-color-rgb),0.5)] px-2 py-1 hover:bg-[color:var(--pip-color)] hover:text-black transition-colors font-bold uppercase"
          >
            {isZh ? '关闭' : 'Close'}
          </button>
        </div>
        <div className="text-xs opacity-70 mb-3">
          {isZh
            ? '保存会更新本机用户注册表。使用下载按钮手动更新 public/users.json。'
            : 'Save updates the local registry in this browser. Use Download to update public/users.json manually.'}
        </div>
        <textarea
          value={usersEditorText}
          onChange={(e) => setUsersEditorText(e.target.value)}
          className="w-full h-64 md:h-72 bg-black border border-[color:rgba(var(--pip-color-rgb),0.5)] p-3 text-[color:var(--pip-color)] text-xs focus:outline-none font-mono"
        />
        {usersEditorError && (
          <div className="text-xs text-red-500 mt-2">{usersEditorError}</div>
        )}
        <div className="flex flex-wrap gap-2 mt-4">
          <button
            onClick={handleUsersEditorSave}
            className="px-4 py-2 border-2 border-[color:var(--pip-color)] hover:bg-[color:var(--pip-color)] hover:text-black font-bold uppercase text-xs"
          >
            {isZh ? '保存' : 'Save'}
          </button>
          <button
            onClick={handleUsersEditorDownload}
            className="px-4 py-2 border border-[color:rgba(var(--pip-color-rgb),0.5)] hover:bg-[color:var(--pip-color)] hover:text-black font-bold uppercase text-xs"
          >
            {isZh ? '下载' : 'Download'}
          </button>
          <button
            onClick={() => setUsersEditorText(serializeUsersDb(usersDb, invitationCode))}
            className="px-4 py-2 border border-[color:rgba(var(--pip-color-rgb),0.3)] hover:bg-[color:rgba(var(--pip-color-rgb),0.2)] font-bold uppercase text-xs"
          >
            {isZh ? '重载' : 'Reload'}
          </button>
        </div>
      </div>
    </div>
  );
  const settingsModal = isSettingsOpen && (
    <div className="fixed top-0 left-0 w-full h-full z-[3000] flex items-start justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="max-w-xl w-full max-h-[90vh] overflow-y-auto pip-boy-border p-6 md:p-8 bg-black">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-2xl font-bold uppercase">{isZh ? '设置' : 'Settings'}</h3>
          <button 
            onClick={() => setIsSettingsOpen(false)}
            className="text-xs border border-[color:rgba(var(--pip-color-rgb),0.5)] px-2 py-1 hover:bg-[color:var(--pip-color)] hover:text-black transition-colors font-bold uppercase"
          >
            {isZh ? '关闭' : 'Close'}
          </button>
        </div>
          <div className="space-y-6">
            {isNormal && (
              <div className="text-xs border border-[color:rgba(var(--pip-color-rgb),0.3)] p-3 bg-[color:rgba(var(--pip-color-rgb),0.05)]">
                {isZh
                  ? 'API Key 仅保存在本地浏览器，不会上传到服务器。'
                  : 'API keys are stored only in this browser and never uploaded to the server.'}
              </div>
            )}
          <div className="border border-[color:rgba(var(--pip-color-rgb),0.3)] p-4 bg-[color:rgba(var(--pip-color-rgb),0.05)]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-sm font-bold uppercase">
                  {isZh ? '图像生成' : 'Image generation'}
                </div>
                <div className="text-xs opacity-70 mt-1">
                  {isZh
                    ? '关闭后不会生成场景图像或同伴头像。'
                    : 'When off, no scene images or companion avatars will be generated.'}
                </div>
              </div>
              <button
                onClick={toggleImageGeneration}
                className={`text-xs px-3 py-1 border font-bold uppercase transition-colors ${
                  imagesEnabled
                    ? 'bg-[color:var(--pip-color)] text-black border-[color:var(--pip-color)]'
                    : 'border-[color:rgba(var(--pip-color-rgb),0.5)] text-[color:var(--pip-color)] hover:bg-[color:rgba(var(--pip-color-rgb),0.2)]'
                }`}
              >
                {imagesEnabled ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>

          <div className={`border border-[color:rgba(var(--pip-color-rgb),0.3)] p-4 bg-[color:rgba(var(--pip-color-rgb),0.05)] ${!imagesEnabled ? 'opacity-50' : ''}`}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-sm font-bold uppercase">
                  {isZh ? '高质量剧情一致图像生成' : 'High-quality lore-accurate image generation'}
                </div>
                <div className="text-xs opacity-70 mt-1">
                  {isZh
                    ? '开启可增强沉浸感，但会延长响应时间。'
                    : 'Turning this on improves immersion but causes a longer wait for responses.'}
                </div>
              </div>
              <button
                onClick={toggleHighQualityImages}
                disabled={!imagesEnabled}
                className={`text-xs px-3 py-1 border font-bold uppercase transition-colors ${
                  gameState.settings.highQualityImages
                    ? 'bg-[color:var(--pip-color)] text-black border-[color:var(--pip-color)]'
                    : 'border-[color:rgba(var(--pip-color-rgb),0.5)] text-[color:var(--pip-color)] hover:bg-[color:rgba(var(--pip-color-rgb),0.2)]'
                } ${!imagesEnabled ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                {gameState.settings.highQualityImages ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>

          <div className={`border border-[color:rgba(var(--pip-color-rgb),0.3)] p-4 bg-[color:rgba(var(--pip-color-rgb),0.05)] ${!imagesEnabled ? 'opacity-50' : ''}`}>
            <div className="text-sm font-bold uppercase">
              {isZh ? '图像频率' : 'Image frequency'}
            </div>
            <div className="text-xs opacity-70 mt-1">
              {isZh
                ? (!imagesEnabled
                  ? '图像生成已关闭。'
                  : (isGuest
                    ? '临时用户不生成回合图像，仅在创建角色时生成一张。'
                    : (isNormal && !hasTextAuthKey
                      ? `设置模型与 API 后可调整图像频率；当前固定为 ${normalDefaultImageTurns}。`
                      : '每 N 次交互生成一张图像，可自由调整。')))
                : (!imagesEnabled
                  ? 'Image generation is disabled.'
                  : (isGuest
                    ? 'Temporary users do not generate turn images; only the creation image is shown.'
                    : (isNormal && !hasTextAuthKey
                      ? `Configure provider/API to adjust image frequency; currently fixed at ${normalDefaultImageTurns}.`
                      : 'Generate images every N turns; adjustable.')))}
            </div>
            <div className="mt-3 flex items-center space-x-3">
              <input
                type="number"
                min={minImageTurns}
                value={gameState.settings.imageEveryTurns}
                onChange={(e) => updateImageFrequency(e.target.value)}
                disabled={!canAdjustImageFrequency || !imagesEnabled}
                className="w-20 bg-black border border-[color:rgba(var(--pip-color-rgb),0.5)] p-2 text-[color:var(--pip-color)] text-sm focus:outline-none disabled:opacity-40"
              />
              <span className="text-[10px] uppercase opacity-60">
                {isZh ? '回合' : 'turns'}
              </span>
            </div>
            {!isAdmin && (
              <div className="text-[10px] opacity-50 mt-2 uppercase">
                {isGuest
                  ? (isZh ? '临时用户不生成回合图像。' : 'Temporary users do not generate turn images.')
                  : (!imagesEnabled
                    ? (isZh ? '图像生成已关闭。' : 'Image generation is disabled.')
                    : (isNormal && !hasTextAuthKey
                      ? (isZh ? `完成模型配置后可调整，当前固定为 ${normalDefaultImageTurns}。` : `Adjustable after setup; currently fixed at ${normalDefaultImageTurns}.`)
                      : (isZh ? '普通用户已完成模型配置。' : 'Normal user setup complete.')))}
              </div>
            )}
          </div>

          <div className="border border-[color:rgba(var(--pip-color-rgb),0.3)] p-4 bg-[color:rgba(var(--pip-color-rgb),0.05)]">
            <div className="text-sm font-bold uppercase">
              {isZh ? '叙事历史上限' : 'Narrator history limit'}
            </div>
            <div className="text-xs opacity-70 mt-1">
              {isZh
                ? '发送给叙事模型的历史回合上限。设置为 -1 表示全部历史。注册用户默认 30，临时用户固定 20。'
                : 'Max turns sent to the narrator. Set to -1 to send all history. Registered default is 30; temporary users are fixed at 20.'}
            </div>
            <div className="mt-3 flex items-center space-x-3">
              <input
                type="number"
                min={-1}
                value={gameState.settings.maxHistoryTurns}
                onChange={(e) => updateHistoryLimit(e.target.value)}
                disabled={isGuest}
                className="w-20 bg-black border border-[color:rgba(var(--pip-color-rgb),0.5)] p-2 text-[color:var(--pip-color)] text-sm focus:outline-none disabled:opacity-40"
              />
              <span className="text-[10px] uppercase opacity-60">
                {isZh ? '回合' : 'turns'}
              </span>
            </div>
            {isGuest && (
              <div className="text-[10px] opacity-50 mt-2 uppercase">
                {isZh ? '临时用户固定为 20。' : 'Temporary users are fixed at 20.'}
              </div>
            )}
          </div>

          <div className="border border-[color:rgba(var(--pip-color-rgb),0.3)] p-4 bg-[color:rgba(var(--pip-color-rgb),0.05)]">
            <div className="text-sm font-bold uppercase">
              {isZh ? '叙事管线' : 'Narrative pipeline'}
            </div>
            <div className="text-xs opacity-70 mt-1">
              {isZh
                ? '旧版：叙事后再推断状态；新版：事件先定，再生成叙事（更一致但多一次调用）。'
                : 'Legacy: narrate first, then infer status. Event-first: determine outcomes first, then narrate (more consistent, extra call).'}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                onClick={() => updatePipelineMode('legacy')}
                className={`text-xs px-3 py-1 border font-bold uppercase transition-colors ${
                  gameState.settings.pipelineMode === 'legacy' || !gameState.settings.pipelineMode
                    ? 'bg-[color:var(--pip-color)] text-black border-[color:var(--pip-color)]'
                    : 'border-[color:rgba(var(--pip-color-rgb),0.5)] text-[color:var(--pip-color)] hover:bg-[color:rgba(var(--pip-color-rgb),0.2)]'
                }`}
              >
                {isZh ? '旧版' : 'Legacy'}
              </button>
              <button
                onClick={() => updatePipelineMode('event')}
                className={`text-xs px-3 py-1 border font-bold uppercase transition-colors ${
                  gameState.settings.pipelineMode === 'event'
                    ? 'bg-[color:var(--pip-color)] text-black border-[color:var(--pip-color)]'
                    : 'border-[color:rgba(var(--pip-color-rgb),0.5)] text-[color:var(--pip-color)] hover:bg-[color:rgba(var(--pip-color-rgb),0.2)]'
                }`}
              >
                {isZh ? '事件先定' : 'Event-first'}
              </button>
            </div>
            <div className="text-[10px] opacity-60 mt-2 uppercase">
              {isZh ? '仅影响后续回合；旧存档可直接使用。' : 'Affects new turns only; old saves still work.'}
            </div>
          </div>

          <div className="border border-[color:rgba(var(--pip-color-rgb),0.3)] p-4 bg-[color:rgba(var(--pip-color-rgb),0.05)]">
            <div className="text-sm font-bold uppercase">
              {isZh ? '压缩记忆上限 (K)' : 'Compressed memory cap (K)'}
            </div>
            <div className="text-xs opacity-70 mt-1">
              {isZh
                ? '压缩记忆的最大长度（单位 K token）。叙事历史越长，建议相应提高此上限，否则压缩记忆可能丢失重要细节；但上限越高、历史越长，响应越慢且成本更高。'
                : 'Maximum size of compressed memory in K tokens. Longer narrator history needs a larger cap or the summary may lose key details; higher caps and longer history increase latency and cost.'}
            </div>
            <div className="mt-3 flex items-center space-x-3">
              <input
                type="number"
                min={1}
                value={gameState.settings.maxCompressedMemoryK ?? 25}
                onChange={(e) => updateCompressedMemoryLimit(e.target.value)}
                className="w-20 bg-black border border-[color:rgba(var(--pip-color-rgb),0.5)] p-2 text-[color:var(--pip-color)] text-sm focus:outline-none"
              />
              <span className="text-[10px] uppercase opacity-60">
                K
              </span>
            </div>
          </div>

          <div className="border border-[color:rgba(var(--pip-color-rgb),0.3)] p-4 bg-[color:rgba(var(--pip-color-rgb),0.05)] space-y-4">
            <div>
              <div className="text-sm font-bold uppercase">
                {isZh ? '全局文字缩放' : 'Global text scale'}
              </div>
              <div className="text-xs opacity-70 mt-1">
                {isZh
                  ? '调整整体字体大小，适合不同设备与观看距离。'
                  : 'Adjust global font size for different devices and viewing distances.'}
              </div>
              <div className="mt-3 flex items-center gap-3">
                <input
                  type="range"
                  min={0.8}
                  max={5}
                  step={0.05}
                  value={textScale}
                  onChange={(e) => updateTextScale(e.target.value)}
                  className="flex-1 accent-[var(--pip-color)]"
                />
                <input
                  type="number"
                  min={0.8}
                  max={5}
                  step={0.05}
                  value={textScale.toFixed(2)}
                  onChange={(e) => updateTextScale(e.target.value)}
                  className="w-20 bg-black border border-[color:rgba(var(--pip-color-rgb),0.5)] p-2 text-[color:var(--pip-color)] text-sm focus:outline-none"
                />
              </div>
            </div>
          </div>

          <div className="border border-[color:rgba(var(--pip-color-rgb),0.3)] p-4 bg-[color:rgba(var(--pip-color-rgb),0.05)] space-y-4">
            <div>
              <div className="text-sm font-bold uppercase">
                {isZh ? '界面颜色' : 'Interface color'}
              </div>
              <div className="text-xs opacity-70 mt-1">
                {isZh ? '调整 Pip-Boy 磷光颜色。' : 'Adjust the Pip-Boy phosphor color.'}
              </div>
              <div className="mt-3 space-y-3">
                <div className="flex items-center gap-3">
                  <span className="text-[10px] uppercase opacity-60 w-6">R</span>
                  <input
                    type="range"
                    min={0}
                    max={255}
                    step={1}
                    value={interfaceColor.r}
                    onChange={(e) => updateInterfaceColorChannel('r', e.target.value)}
                    className="flex-1 accent-[var(--pip-color)]"
                  />
                  <input
                    type="number"
                    min={0}
                    max={255}
                    step={1}
                    value={interfaceColor.r}
                    onChange={(e) => updateInterfaceColorChannel('r', e.target.value)}
                    className="w-16 bg-black border border-[color:rgba(var(--pip-color-rgb),0.5)] p-2 text-[color:var(--pip-color)] text-sm focus:outline-none"
                  />
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-[10px] uppercase opacity-60 w-6">G</span>
                  <input
                    type="range"
                    min={0}
                    max={255}
                    step={1}
                    value={interfaceColor.g}
                    onChange={(e) => updateInterfaceColorChannel('g', e.target.value)}
                    className="flex-1 accent-[var(--pip-color)]"
                  />
                  <input
                    type="number"
                    min={0}
                    max={255}
                    step={1}
                    value={interfaceColor.g}
                    onChange={(e) => updateInterfaceColorChannel('g', e.target.value)}
                    className="w-16 bg-black border border-[color:rgba(var(--pip-color-rgb),0.5)] p-2 text-[color:var(--pip-color)] text-sm focus:outline-none"
                  />
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-[10px] uppercase opacity-60 w-6">B</span>
                  <input
                    type="range"
                    min={0}
                    max={255}
                    step={1}
                    value={interfaceColor.b}
                    onChange={(e) => updateInterfaceColorChannel('b', e.target.value)}
                    className="flex-1 accent-[var(--pip-color)]"
                  />
                  <input
                    type="number"
                    min={0}
                    max={255}
                    step={1}
                    value={interfaceColor.b}
                    onChange={(e) => updateInterfaceColorChannel('b', e.target.value)}
                    className="w-16 bg-black border border-[color:rgba(var(--pip-color-rgb),0.5)] p-2 text-[color:var(--pip-color)] text-sm focus:outline-none"
                  />
                </div>
              </div>
              <div className="mt-4 flex items-center gap-3">
                <div
                  className="w-10 h-10 border border-[color:rgba(var(--pip-color-rgb),0.5)]"
                  style={{ backgroundColor: interfaceColorCss }}
                />
                <div className="text-[10px] uppercase opacity-60">
                  {interfaceColor.r}, {interfaceColor.g}, {interfaceColor.b}
                </div>
                <button
                  onClick={resetInterfaceColor}
                  className="ml-auto px-3 py-1 border border-[color:rgba(var(--pip-color-rgb),0.5)] hover:bg-[color:var(--pip-color)] hover:text-black font-bold uppercase text-xs"
                >
                  {isZh ? '重置' : 'Reset'}
                </button>
              </div>
            </div>
          </div>

          <div className="border border-[color:rgba(var(--pip-color-rgb),0.3)] p-4 bg-[color:rgba(var(--pip-color-rgb),0.05)]">
            <div className="text-sm font-bold uppercase">
              {isZh ? '原始输出缓存' : 'Raw Output Cache'}
            </div>
            <div className="text-xs opacity-70 mt-1">
              {isZh
                ? '当模型输出无法解析时，会保留原始文本，方便排查。'
                : 'Stores the latest raw model output when parsing fails.'}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <button
                onClick={() => setIsRawOutputOpen(true)}
                disabled={!gameState.rawOutputCache}
                className="px-3 py-1 border border-[color:rgba(var(--pip-color-rgb),0.5)] hover:bg-[color:var(--pip-color)] hover:text-black font-bold uppercase text-xs disabled:opacity-40"
              >
                {isZh ? '查看' : 'View'}
              </button>
            </div>
          </div>

          {isNormal && (
            <div className="border border-[color:rgba(var(--pip-color-rgb),0.3)] p-4 bg-[color:rgba(var(--pip-color-rgb),0.05)] space-y-4">
              <div className="text-xs opacity-70">
                {isZh
                  ? '文本模型必须支持多模态输入（文本+图像）、函数调用与联网搜索。'
                  : 'Text models must be multimodal (text + image input), support function calling, and online search.'}
              </div>

              <div className="border border-[color:rgba(var(--pip-color-rgb),0.3)] p-3 bg-[color:rgba(var(--pip-color-rgb),0.05)] space-y-3">
                <div className="text-sm font-bold uppercase">
                  {isZh ? '文本模型' : 'Text Model'}
                </div>
                <div>
                  <div className="text-[11px] uppercase opacity-70">
                    {isZh ? '文本提供商' : 'Text Provider'}
                  </div>
                  <select
                    value={textProvider}
                    onChange={(e) => updateTextProvider(e.target.value as ModelProvider)}
                    className="mt-2 w-full bg-black border border-[color:rgba(var(--pip-color-rgb),0.5)] p-2 text-[color:var(--pip-color)] text-xs focus:outline-none"
                  >
                    {MODEL_PROVIDER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="text-[11px] uppercase opacity-70">
                    {isZh ? '文本 API Key' : 'Text API Key'}
                  </div>
                  <div className="text-[10px] opacity-60 mt-1">
                    {isZh ? '仅保存在本地浏览器，不会上传到服务器。' : 'Stored only in this browser and never uploaded.'}
                  </div>
                  <input
                    type="password"
                    value={currentUser?.textApiKey || ''}
                    onChange={(e) => updateTextApiKey(e.target.value)}
                    className="mt-2 w-full bg-black border border-[color:rgba(var(--pip-color-rgb),0.5)] p-2 text-[color:var(--pip-color)] text-xs focus:outline-none"
                    placeholder={isZh ? '粘贴文本 API Key' : 'Paste text API key'}
                  />
                </div>
                <div>
                  <div className="text-[11px] uppercase opacity-70">
                    {isZh ? '文本模型名称' : 'Text model name'}
                  </div>
                  <div className="text-[10px] opacity-60 mt-1">
                    {isZh ? '例如：gpt-4.1-mini 或 gemini-2.5-flash-lite' : 'Example: gpt-4.1-mini or gemini-2.5-flash-lite'}
                  </div>
                  <input
                    type="text"
                    value={gameState.settings.textModel || ''}
                    onChange={(e) => updateTextModelName(e.target.value)}
                    className="mt-2 w-full bg-black border border-[color:rgba(var(--pip-color-rgb),0.5)] p-2 text-[color:var(--pip-color)] text-xs focus:outline-none"
                    placeholder={isZh ? '输入文本模型名称' : 'Enter text model name'}
                  />
                </div>
              </div>

              <div className="border border-[color:rgba(var(--pip-color-rgb),0.3)] p-3 bg-[color:rgba(var(--pip-color-rgb),0.05)] space-y-3">
                <div className="text-sm font-bold uppercase">
                  {isZh ? '图像模型' : 'Image Model'}
                </div>
                <div>
                  <div className="text-[11px] uppercase opacity-70">
                    {isZh ? '图像提供商' : 'Image Provider'}
                  </div>
                  <select
                    value={imageProvider}
                    onChange={(e) => updateImageProvider(e.target.value as ModelProvider)}
                    className="mt-2 w-full bg-black border border-[color:rgba(var(--pip-color-rgb),0.5)] p-2 text-[color:var(--pip-color)] text-xs focus:outline-none"
                  >
                    {MODEL_PROVIDER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="text-[11px] uppercase opacity-70">
                    {isZh ? '图像 API Key' : 'Image API Key'}
                  </div>
                  <div className="text-[10px] opacity-60 mt-1">
                    {isZh ? '仅保存在本地浏览器，不会上传到服务器。' : 'Stored only in this browser and never uploaded.'}
                  </div>
                  <input
                    type="password"
                    value={currentUser?.imageApiKey || ''}
                    onChange={(e) => updateImageApiKey(e.target.value)}
                    className="mt-2 w-full bg-black border border-[color:rgba(var(--pip-color-rgb),0.5)] p-2 text-[color:var(--pip-color)] text-xs focus:outline-none"
                    placeholder={isZh ? '粘贴图像 API Key' : 'Paste image API key'}
                  />
                </div>
                <div>
                  <div className="text-[11px] uppercase opacity-70">
                    {isZh ? '图像模型名称' : 'Image model name'}
                  </div>
                  <div className="text-[10px] opacity-60 mt-1">
                    {isZh ? '例如：gpt-image-1 或 gemini-2.5-flash-image' : 'Example: gpt-image-1 or gemini-2.5-flash-image'}
                  </div>
                  <input
                    type="text"
                    value={gameState.settings.imageModel || ''}
                    onChange={(e) => updateImageModelName(e.target.value)}
                    className="mt-2 w-full bg-black border border-[color:rgba(var(--pip-color-rgb),0.5)] p-2 text-[color:var(--pip-color)] text-xs focus:outline-none"
                    placeholder={isZh ? '输入图像模型名称' : 'Enter image model name'}
                  />
                </div>
              </div>

              <div className="border border-[color:rgba(var(--pip-color-rgb),0.3)] p-3 bg-[color:rgba(var(--pip-color-rgb),0.05)] space-y-3">
                <label className="flex items-center gap-2 text-xs uppercase font-bold">
                  <input
                    type="checkbox"
                    checked={!!gameState.settings.useProxy}
                    onChange={(e) => updateProxyEnabled(e.target.checked)}
                    className="accent-[var(--pip-color)]"
                  />
                  {isZh ? '使用中转站（API Proxy）' : 'Use API Proxy'}
                </label>
                {gameState.settings.useProxy && (
                  <div className="space-y-3">
                    <div>
                      <div className="text-[11px] uppercase opacity-70">
                        {isZh ? '中转站 Base URL（文本）' : 'Proxy Base URL (Text)'}
                      </div>
                      <input
                        type="text"
                        value={gameState.settings.textProxyBaseUrl || gameState.settings.proxyBaseUrl || ''}
                        onChange={(e) => updateTextProxyBaseUrl(e.target.value)}
                        className="mt-2 w-full bg-black border border-[color:rgba(var(--pip-color-rgb),0.5)] p-2 text-[color:var(--pip-color)] text-xs focus:outline-none"
                        placeholder="https://example.com/v1"
                      />
                    </div>
                    <div>
                      <div className="text-[11px] uppercase opacity-70">
                        {isZh ? '中转站 Base URL（图像）' : 'Proxy Base URL (Image)'}
                      </div>
                      <input
                        type="text"
                        value={gameState.settings.imageProxyBaseUrl || gameState.settings.proxyBaseUrl || ''}
                        onChange={(e) => updateImageProxyBaseUrl(e.target.value)}
                        className="mt-2 w-full bg-black border border-[color:rgba(var(--pip-color-rgb),0.5)] p-2 text-[color:var(--pip-color)] text-xs focus:outline-none"
                        placeholder="https://example.com/v1"
                      />
                    </div>
                    <div>
                      <div className="text-[11px] uppercase opacity-70">
                        {isZh ? '中转站 API Key（文本）' : 'Proxy API Key (Text)'}
                      </div>
                      <input
                        type="password"
                        value={currentUser?.textProxyKey || ''}
                        onChange={(e) => updateTextProxyKey(e.target.value)}
                        className="mt-2 w-full bg-black border border-[color:rgba(var(--pip-color-rgb),0.5)] p-2 text-[color:var(--pip-color)] text-xs focus:outline-none"
                        placeholder={isZh ? '粘贴文本中转站 API Key' : 'Paste text proxy API key'}
                      />
                    </div>
                    <div>
                      <div className="text-[11px] uppercase opacity-70">
                        {isZh ? '中转站 API Key（图像）' : 'Proxy API Key (Image)'}
                      </div>
                      <input
                        type="password"
                        value={currentUser?.imageProxyKey || ''}
                        onChange={(e) => updateImageProxyKey(e.target.value)}
                        className="mt-2 w-full bg-black border border-[color:rgba(var(--pip-color-rgb),0.5)] p-2 text-[color:var(--pip-color)] text-xs focus:outline-none"
                        placeholder={isZh ? '粘贴图像中转站 API Key' : 'Paste image proxy API key'}
                      />
                    </div>
                    <div className="text-[11px] opacity-70">
                      {isZh
                        ? '关于中转站兼容性说明：本应用在使用中转站时，仍按所选模型的官方 API 协议发起请求。若请求失败，通常是中转站不支持该模型的原生接口或高级功能。此类兼容性问题由中转站服务本身导致，并非应用错误。'
                        : 'Proxy compatibility notice: requests are sent using the official API protocol of the selected provider. Failures usually mean the proxy does not support that native API or advanced features. Such compatibility issues are caused by the proxy service, not the app.'}
                    </div>
                  </div>
                )}
              </div>

              {!isModelConfigured && (
                <div className="text-[11px] text-yellow-300 uppercase">
                  {isZh
                    ? '需要填写文本提供商/API/模型；如启用图像生成，还需填写图像提供商/API/模型。'
                    : 'Provide text provider/API/model; if images are enabled, also provide image provider/API/model.'}
                </div>
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  );
  const helpModal = isHelpOpen && (
    <div className="fixed top-0 left-0 w-full h-full z-[3000] flex items-start justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="max-w-2xl w-full max-h-[90vh] overflow-y-auto pip-boy-border p-6 md:p-8 bg-black">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-2xl font-bold uppercase">{isZh ? '帮助' : 'HELP'}</h3>
          <button 
            onClick={() => setIsHelpOpen(false)}
            className="text-xs border border-[color:rgba(var(--pip-color-rgb),0.5)] px-2 py-1 hover:bg-[color:var(--pip-color)] hover:text-black transition-colors font-bold uppercase"
          >
            {isZh ? '关闭' : 'Close'}
          </button>
        </div>
        <div className="space-y-4 text-sm">
          <div className="border border-[color:rgba(var(--pip-color-rgb),0.2)] p-4 bg-[color:rgba(var(--pip-color-rgb),0.05)]">
            <div className="text-xs uppercase opacity-60 mb-2">{isZh ? '快速开始' : 'Quick Start'}</div>
            <div className="opacity-80">
              {isZh
                ? '注册用户需先在设置中填写文本提供商/API/模型；如启用图像生成，还需填写图像提供商/API/模型。完成后才能游玩。'
                : 'Registered users must configure text provider/API/model first; if images are enabled, also configure image provider/API/model before playing.'}
            </div>
            <div className="opacity-80 mt-2">
              {isZh
                ? '访客模式可直接体验，但开始后需等待 30 分钟冷却才能再次进入。'
                : 'Guest mode can start immediately, but has a 30-minute cooldown after entry.'}
            </div>
          </div>

          <div className="border border-[color:rgba(var(--pip-color-rgb),0.2)] p-4 bg-[color:rgba(var(--pip-color-rgb),0.05)]">
            <div className="text-xs uppercase opacity-60 mb-2">{isZh ? '模型与密钥' : 'Models & Keys'}</div>
            <div className="opacity-80">
              {isZh
                ? '文本模型需支持多模态输入、函数调用和联网搜索。API Key 仅保存在本地浏览器缓存，不上传服务器。'
                : 'Text models must support multimodal input, function calling, and online search. API keys stay in local browser storage and are never uploaded.'}
            </div>
            <div className="opacity-80 mt-2">
              {isZh
                ? '文本/图像提供商、模型与 API Key 完全分离，可分别配置。'
                : 'Text and image providers, models, and API keys are fully separated and can be configured independently.'}
            </div>
            <div className="opacity-80 mt-2">
              {isZh
                ? '使用中转站时，需要 Base URL 与独立的文本/图像中转站 Key；请求仍按官方原生协议发起。'
                : 'When using API Proxy, provide a Base URL and separate text/image proxy keys; requests still use native provider protocols.'}
            </div>
          </div>

          <div className="border border-[color:rgba(var(--pip-color-rgb),0.2)] p-4 bg-[color:rgba(var(--pip-color-rgb),0.05)]">
            <div className="text-xs uppercase opacity-60 mb-2">{isZh ? '行动点与限制' : 'AP & Limits'}</div>
            <div className="opacity-80">
              {isZh
                ? `每次行动消耗 1 AP，AP 为 0 时无法行动。访客 AP 上限 ${guestMaxAp}，无恢复，无手动保存。`
                : `Each action costs 1 AP; you cannot act at 0 AP. Guest AP cap is ${guestMaxAp}, no recovery, no manual saves.`}
            </div>
            <div className="opacity-80 mt-2">
              {isZh
                ? '普通用户配置文本模型后 AP 无限制，可手动保存，并可调整图像频率。'
                : 'Normal users unlock unlimited AP after text model setup, gain manual save, and can adjust image frequency.'}
            </div>
          </div>

          <div className="border border-[color:rgba(var(--pip-color-rgb),0.2)] p-4 bg-[color:rgba(var(--pip-color-rgb),0.05)]">
            <div className="text-xs uppercase opacity-60 mb-2">{isZh ? '叙事流程' : 'Narration Flow'}</div>
            <div className="opacity-80">
              {isZh
                ? '请描述行动意图，不要指定结果。系统会判定规则并返回叙事。'
                : 'Describe intent, not outcomes. The system enforces rules and returns narration.'}
            </div>
            <div className="opacity-80 mt-2">
              {isZh
                ? '重掷按钮可重试最后一次行动；角色创建界面也可重掷世界参数。'
                : 'The reroll button retries the last action; profile creation also supports rerolling world parameters.'}
            </div>
            <div className="opacity-80 mt-2">
              {isZh
                ? '进度栏会显示叙事/状态/图像的阶段状态（待命/处理中/完成/错误）。'
                : 'Stage status shows narration/status/image progress (IDLE/RUNNING/DONE/ERROR).'}
            </div>
          </div>

          <div className="border border-[color:rgba(var(--pip-color-rgb),0.2)] p-4 bg-[color:rgba(var(--pip-color-rgb),0.05)]">
            <div className="text-xs uppercase opacity-60 mb-2">{isZh ? '图像与头像' : 'Images & Avatars'}</div>
            <div className="opacity-80">
              {isZh
                ? '可关闭图像生成；关闭时高质量与图像频率不可调整。高质量图像会进行两阶段研究，响应更慢但更贴合世界观。'
                : 'You can disable image generation; when off, high-quality and frequency controls are locked. High-quality images use a two-stage research pass and are slower but more lore-accurate.'}
            </div>
            <div className="opacity-80 mt-2">
              {isZh
                ? '图像频率控制每隔多少回合生成图片；访客不生成回合图像，仅创建时可能生成。'
                : 'Image frequency controls how often images appear; guests do not generate turn images (only creation images).'}
            </div>
            <div className="opacity-80 mt-2">
              {isZh
                ? '同伴与斗兽场参战方会自动生成头像。'
                : 'Companions and arena parties generate avatars automatically.'}
            </div>
          </div>

          <div className="border border-[color:rgba(var(--pip-color-rgb),0.2)] p-4 bg-[color:rgba(var(--pip-color-rgb),0.05)]">
            <div className="text-xs uppercase opacity-60 mb-2">{isZh ? '状态与库存' : 'Status & Inventory'}</div>
            <div className="opacity-80">
              {isZh
                ? '状态管理器独立更新 SPECIAL、技能、物品、任务与同伴。'
                : 'A dedicated status manager updates SPECIAL, skills, inventory, quests, and companions.'}
            </div>
            <div className="opacity-80 mt-2">
              {isZh
                ? '物品包含数量与是否消耗标记；消耗品被使用会扣减数量。'
                : 'Items track counts and consumable flags; consumables are deducted when used.'}
            </div>
            <div className="opacity-80 mt-2">
              {isZh
                ? '库存刷新按钮用于修复旧存档的数量/重量问题（权重由 LLM 校验）。'
                : 'Inventory refresh fixes legacy saves with missing counts/weights (weights are LLM-checked).'}
            </div>
            <div className="opacity-80 mt-2">
              {isZh
                ? '状态栏底部会显示 Token 统计（发送/接收/总计）。'
                : 'Token tracking shows sent/received/total at the bottom of the status panel.'}
            </div>
            <div className="opacity-80 mt-2">
              {isZh
                ? '同伴栏会展示头像与基础信息，点击头像可展开完整资料。'
                : 'The companion tab shows avatars and basics; click an avatar to expand full details.'}
            </div>
          </div>

          <div className="border border-[color:rgba(var(--pip-color-rgb),0.2)] p-4 bg-[color:rgba(var(--pip-color-rgb),0.05)]">
            <div className="text-xs uppercase opacity-60 mb-2">{isZh ? '记忆压缩' : 'Memory Compression'}</div>
            <div className="opacity-80">
              {isZh
                ? '叙事历史上限控制每次发送给模型的回合数，设置为 -1 表示全部。到达上限会自动压缩记忆并暂时锁定输入。'
                : 'Narrator history limit controls how many turns are sent; set -1 to include all. Hitting the limit triggers auto-compression and locks input briefly.'}
            </div>
            <div className="opacity-80 mt-2">
              {isZh
                ? '可手动压缩（需确认），并可设置压缩记忆最大长度（K tokens）。旧存档会提示压缩。'
                : 'Manual compression is available (with confirmation), and you can set max compressed memory length (K tokens). Legacy saves prompt for compression.'}
            </div>
          </div>

          <div className="border border-[color:rgba(var(--pip-color-rgb),0.2)] p-4 bg-[color:rgba(var(--pip-color-rgb),0.05)]">
            <div className="text-xs uppercase opacity-60 mb-2">{isZh ? '保存与导出' : 'Saves & Export'}</div>
            <div className="opacity-80">
              {isZh
                ? '注册用户（已配置文本模型）可手动保存；其他情况下自动保存。'
                : 'Registered users with text model configured can manual-save; otherwise auto-save is used.'}
            </div>
            <div className="opacity-80 mt-2">
              {isZh
                ? '终端记录可导出为 Markdown/PDF；斗兽场同样支持导出。'
                : 'Terminal logs can be exported to Markdown/PDF; arena logs support the same.'}
            </div>
            <div className="opacity-80 mt-2">
              {isZh
                ? 'JSON 导出/导入是跨浏览器与设备迁移存档的唯一方式，可在登录与档案生成界面导入。'
                : 'JSON export/import is the only way to move saves across browsers/devices, and can be imported from the login or profile screens.'}
            </div>
            <div className="opacity-80 mt-2">
              {isZh
                ? '最新错误的原始输出会缓存，可在设置中查看并复制。'
                : 'Latest error raw output is cached and viewable/copiable in Settings.'}
            </div>
          </div>

          <div className="border border-[color:rgba(var(--pip-color-rgb),0.2)] p-4 bg-[color:rgba(var(--pip-color-rgb),0.05)]">
            <div className="text-xs uppercase opacity-60 mb-2">{isZh ? '废土斗兽场' : 'Wasteland Smash Arena'}</div>
            <div className="opacity-80">
              {isZh
                ? '提供情景演绎与战争推演两种模式；填写焦点问题与参战方（最多 10 个，可移除）。'
                : 'Two submodes: Scenario and War Game Sim. Provide a focus question and up to 10 parties (removable).'}
            </div>
            <div className="opacity-80 mt-2">
              {isZh
                ? '先生成简报，再点击继续模拟；战争推演会追踪兵力值并在只剩一方时自动结束。'
                : 'A briefing is generated first, then Continue Simulation advances. War Game tracks force power and auto-ends when one party remains.'}
            </div>
            <div className="opacity-80 mt-2">
              {isZh
                ? '右侧面板显示参战方、头像与兵力条；斗兽场使用同一套模型/代理/图像设置，并支持独立系统提示。'
                : 'Side panel lists parties, avatars, and force bars. Arena uses the same model/proxy/image settings and has its own system prompt.'}
            </div>
          </div>

          <div className="border border-[color:rgba(var(--pip-color-rgb),0.2)] p-4 bg-[color:rgba(var(--pip-color-rgb),0.05)]">
            <div className="text-xs uppercase opacity-60 mb-2">{isZh ? '其它' : 'Other'}</div>
            <div className="opacity-80">
              {isZh
                ? '支持中英文切换、用户系统提示、斗兽场系统提示，以及打赏二维码入口。'
                : 'Supports EN/中文 toggle, user system prompt, arena system prompt, and the tip/donate menu.'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
  const userPromptModal = isUserPromptOpen && (
    <div className="fixed top-0 left-0 w-full h-full z-[3000] flex items-start justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="max-w-xl w-full max-h-[90vh] overflow-y-auto pip-boy-border p-6 md:p-8 bg-black">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-2xl font-bold uppercase">{isZh ? '用户系统提示' : 'User System Prompt'}</h3>
          <button
            onClick={() => setIsUserPromptOpen(false)}
            className="text-xs border border-[color:rgba(var(--pip-color-rgb),0.5)] px-2 py-1 hover:bg-[color:var(--pip-color)] hover:text-black transition-colors font-bold uppercase"
          >
            {isZh ? '关闭' : 'Close'}
          </button>
        </div>
        <div className="text-xs opacity-70 mb-3">
          {isZh
            ? '用于控制模型行为，例如：要求每次给出 3 个可选行动、输出超过 2000 token，或将输出限制在 1000 token 内。'
            : 'Use this to control model behavior, e.g. always give 3 available actions, output more than 2000 tokens, or keep the output within 1000 tokens.'}
        </div>
        <div className="text-xs opacity-70 mb-4">
          <div className="uppercase tracking-widest opacity-60 mb-2">
            {isZh ? '建议结构' : 'Suggested structure'}
          </div>
          <div className="space-y-1">
            {isZh ? (
              <>
                <div>- 世界观约束：</div>
                <div>- 禁止或惩罚的显而易见解：</div>
                <div>- 鼓励使用的间接手段：</div>
                <div>- 结果必须满足的条件：</div>
              </>
            ) : (
              <>
                <div>- World rules:</div>
                <div>- Banned or penalized obvious solutions:</div>
                <div>- Indirect approaches to encourage:</div>
                <div>- Outcome requirements:</div>
              </>
            )}
          </div>
        </div>
        <textarea
          value={gameState.settings.userSystemPrompt || ''}
          onChange={(e) => updateUserSystemPrompt(e.target.value)}
          className="w-full h-40 md:h-48 bg-black border border-[color:rgba(var(--pip-color-rgb),0.5)] p-3 text-[color:var(--pip-color)] text-xs focus:outline-none"
          placeholder={isZh ? '输入用户系统提示...' : 'Enter user system prompt...'}
        />
      </div>
    </div>
  );
  const arenaPromptModal = isArenaPromptOpen && (
    <div className="fixed top-0 left-0 w-full h-full z-[3000] flex items-start justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="max-w-xl w-full max-h-[90vh] overflow-y-auto pip-boy-border p-6 md:p-8 bg-black">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-2xl font-bold uppercase">{isZh ? '斗兽场系统提示' : 'Arena System Prompt'}</h3>
          <button
            onClick={() => setIsArenaPromptOpen(false)}
            className="text-xs border border-[color:rgba(var(--pip-color-rgb),0.5)] px-2 py-1 hover:bg-[color:var(--pip-color)] hover:text-black transition-colors font-bold uppercase"
          >
            {isZh ? '关闭' : 'Close'}
          </button>
        </div>
        <div className="text-xs opacity-70 mb-3">
          {isZh
            ? '用于控制斗兽场模拟行为，例如要求更长输出、特定叙事风格或更多战术细节。'
            : 'Use this to control arena simulation behavior, e.g. longer output, specific narrative style, or more tactical detail.'}
        </div>
        <textarea
          value={arenaState.userPrompt || ''}
          onChange={(e) => updateArenaSystemPrompt(e.target.value)}
          className="w-full h-40 md:h-48 bg-black border border-[color:rgba(var(--pip-color-rgb),0.5)] p-3 text-[color:var(--pip-color)] text-xs focus:outline-none"
          placeholder={isZh ? '输入斗兽场系统提示...' : 'Enter arena system prompt...'}
        />
      </div>
    </div>
  );
  const legacyCompressionModal = legacyCompressionPrompt && (
    <div className="fixed top-0 left-0 w-full h-full z-[3200] flex items-start justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="max-w-md w-full max-h-[90vh] overflow-y-auto pip-boy-border p-6 bg-black">
        <h3 className="text-xl font-bold uppercase mb-3">
          {isZh ? '记忆压缩提示' : 'Memory Compression'}
        </h3>
        <div className="text-sm opacity-80 space-y-2">
          <div>
            {isZh
              ? '检测到旧存档的历史回合已超过当前叙事历史上限。'
              : 'This save has more turns than the current narrator history limit.'}
          </div>
          <div>
            {legacyCompressionPrompt.reason === 'no-memory'
              ? (isZh
                ? '当前没有压缩记忆。建议压缩全部历史以生成记忆（可能会丢失部分细节）。'
                : 'No compressed memory found. Compressing the full history is recommended (some detail may be lost).')
              : (isZh
                ? '检测到压缩记忆但没有计数器记录，建议压缩全部历史以重置计数器。'
                : 'Compressed memory exists but no counter was saved; compress the full history to reset it.')}
          </div>
        </div>
        <div className="mt-4 space-y-2">
          <button
            onClick={handleLegacyCompressNow}
            className="w-full border-2 border-[color:var(--pip-color)] py-2 hover:bg-[color:var(--pip-color)] hover:text-black transition-all font-bold uppercase"
          >
            {isZh ? '立即压缩' : 'Compress now'}
          </button>
          <button
            onClick={handleLegacyCompressLater}
            className="w-full text-xs border border-[color:rgba(var(--pip-color-rgb),0.4)] py-2 hover:bg-[color:rgba(var(--pip-color-rgb),0.2)] transition-all uppercase"
          >
            {isZh ? '稍后再说' : 'Not now'}
          </button>
        </div>
      </div>
    </div>
  );
  const manualCompressionModal = isManualCompressionConfirmOpen && (
    <div className="fixed top-0 left-0 w-full h-full z-[3200] flex items-start justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="max-w-md w-full max-h-[90vh] overflow-y-auto pip-boy-border p-6 bg-black">
        <h3 className="text-xl font-bold uppercase mb-3">
          {isZh ? '确认压缩记忆' : 'Confirm Compression'}
        </h3>
        <div className="text-sm opacity-80 space-y-2">
          <div>
            {isZh
              ? '手动压缩会覆盖已有压缩记忆，并可能丢失部分细节，且无法撤销。'
              : 'Manual compression overwrites existing compressed memory and may lose detail. This cannot be undone.'}
          </div>
          <div>
            {isZh ? '确定继续吗？' : 'Do you want to continue?'}
          </div>
        </div>
        <div className="mt-4 space-y-2">
          <button
            onClick={handleManualCompressionConfirm}
            className="w-full border-2 border-[color:var(--pip-color)] py-2 hover:bg-[color:var(--pip-color)] hover:text-black transition-all font-bold uppercase"
          >
            {isZh ? '确认压缩' : 'Confirm'}
          </button>
          <button
            onClick={() => setIsManualCompressionConfirmOpen(false)}
            className="w-full text-xs border border-[color:rgba(var(--pip-color-rgb),0.4)] py-2 hover:bg-[color:rgba(var(--pip-color-rgb),0.2)] transition-all uppercase"
          >
            {isZh ? '取消' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
  const rawOutputModal = isRawOutputOpen && (
    <div className="fixed top-0 left-0 w-full h-full z-[3200] flex items-start justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="max-w-xl w-full max-h-[90vh] overflow-y-auto pip-boy-border p-6 bg-black">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xl font-bold uppercase">{isZh ? '原始输出缓存' : 'Raw Output Cache'}</h3>
          <button
            onClick={() => setIsRawOutputOpen(false)}
            className="text-xs border border-[color:rgba(var(--pip-color-rgb),0.5)] px-2 py-1 hover:bg-[color:var(--pip-color)] hover:text-black transition-colors font-bold uppercase"
          >
            {isZh ? '关闭' : 'Close'}
          </button>
        </div>
        <div className="text-xs opacity-70 mb-3">
          {isZh
            ? '缓存最近一次模型输出的原始文本（仅在解析失败时记录）。'
            : 'Caches the latest raw model output when JSON parsing fails.'}
        </div>
        <textarea
          value={gameState.rawOutputCache || ''}
          readOnly
          className="w-full h-64 md:h-72 bg-black border border-[color:rgba(var(--pip-color-rgb),0.5)] p-3 text-[color:var(--pip-color)] text-xs focus:outline-none font-mono"
          placeholder={isZh ? '暂无缓存内容。' : 'No cached output.'}
        />
        <div className="flex flex-wrap gap-2 mt-4">
          <button
            onClick={handleCopyRawOutput}
            disabled={!gameState.rawOutputCache}
            className="px-4 py-2 border-2 border-[color:var(--pip-color)] hover:bg-[color:var(--pip-color)] hover:text-black font-bold uppercase text-xs disabled:opacity-40"
          >
            {isZh ? '复制' : 'Copy'}
          </button>
          <button
            onClick={() => setIsRawOutputOpen(false)}
            className="px-4 py-2 border border-[color:rgba(var(--pip-color-rgb),0.5)] hover:bg-[color:var(--pip-color)] hover:text-black font-bold uppercase text-xs"
          >
            {isZh ? '关闭' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  );
  const legacyInventoryModal = legacyInventoryPrompt && (
    <div className="fixed top-0 left-0 w-full h-full z-[3200] flex items-start justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="max-w-md w-full max-h-[90vh] overflow-y-auto pip-boy-border p-6 bg-black">
        <h3 className="text-xl font-bold uppercase mb-3">
          {isZh ? '库存刷新提示' : 'Inventory Refresh'}
        </h3>
        <div className="text-sm opacity-80 space-y-2">
          <div>
            {legacyInventoryPrompt.reason === 'missing-status-track'
              ? (isZh
                ? '检测到旧存档缺少状态轨迹记录。建议进行库存恢复以建立初始状态与变更索引。'
                : 'This save is missing status tracking data. Inventory recovery is recommended to rebuild initial status and change indices.')
              : (isZh
                ? '检测到旧存档的物品缺少数量信息。建议立即刷新库存以补全数量与消耗属性。'
                : 'This save has items missing count data. Refreshing inventory now is recommended.')}
          </div>
          <div>
            {isZh
              ? '若稍后再说，可在状态面板中使用“库存刷新”按钮。'
              : 'You can also refresh later using the Inventory Refresh button in the status panel.'}
          </div>
          {legacyInventoryPrompt.reason === 'missing-status-track' && (
            <div>
              {isZh
                ? '提示：历史过长可能导致恢复不完整，恢复过程中会进行多阶段计算。'
                : 'Note: long histories may reduce recovery accuracy. The recovery runs in multiple stages.'}
            </div>
          )}
        </div>
        <div className="mt-4 space-y-2">
          <button
            onClick={handleLegacyInventoryRefreshNow}
            className="w-full border-2 border-[color:var(--pip-color)] py-2 hover:bg-[color:var(--pip-color)] hover:text-black transition-all font-bold uppercase"
          >
            {isZh ? '立即刷新' : 'Refresh now'}
          </button>
          <button
            onClick={handleLegacyInventoryRefreshLater}
            className="w-full text-xs border border-[color:rgba(var(--pip-color-rgb),0.4)] py-2 hover:bg-[color:rgba(var(--pip-color-rgb),0.2)] transition-all uppercase"
          >
            {isZh ? '稍后再说' : 'Not now'}
          </button>
        </div>
      </div>
    </div>
  );
  const legacyKnownNpcModal = legacyKnownNpcPrompt && (
    <div className="fixed top-0 left-0 w-full h-full z-[3200] flex items-start justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="max-w-md w-full max-h-[90vh] overflow-y-auto pip-boy-border p-6 bg-black">
        <h3 className="text-xl font-bold uppercase mb-3">
          {isZh ? '存档清理提示' : 'Save Cleanup'}
        </h3>
        <div className="text-sm opacity-80 space-y-2">
          <div>
            {isZh
              ? '检测到旧存档的已知 NPC 列表结构异常，已在本次加载中自动修复。'
              : 'Malformed known NPC entries were detected and cleaned for this session.'}
          </div>
          <div>
            {isZh
              ? '是否覆盖存档以永久保存修复结果？'
              : 'Overwrite the save to apply the cleanup permanently?'}
          </div>
        </div>
        <div className="mt-4 space-y-2">
          <button
            onClick={handleLegacyKnownNpcCleanupNow}
            className="w-full border-2 border-[color:var(--pip-color)] py-2 hover:bg-[color:var(--pip-color)] hover:text-black transition-all font-bold uppercase"
          >
            {isZh ? '立即覆盖' : 'Overwrite now'}
          </button>
          <button
            onClick={handleLegacyKnownNpcCleanupLater}
            className="w-full text-xs border border-[color:rgba(var(--pip-color-rgb),0.4)] py-2 hover:bg-[color:rgba(var(--pip-color-rgb),0.2)] transition-all uppercase"
          >
            {isZh ? '稍后再说' : 'Not now'}
          </button>
        </div>
      </div>
    </div>
  );
  const statusRebuildModal = statusRebuildPrompt && (
    <div className="fixed top-0 left-0 w-full h-full z-[3200] flex items-start justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="max-w-md w-full max-h-[90vh] overflow-y-auto pip-boy-border p-6 bg-black">
        {statusRebuildPrompt.step === 'choose' ? (
          <>
            <h3 className="text-xl font-bold uppercase mb-3">
              {isZh ? '状态重建' : 'Status Rebuild'}
            </h3>
            <div className="text-sm opacity-80 space-y-2">
              <div>
                {isZh
                  ? '请选择重建方式：无 LLM 或使用 LLM 重新计算每回合状态变更。'
                  : 'Choose a rebuild mode: no LLM calls, or recalculate each narration with the LLM.'}
              </div>
            </div>
            <div className="mt-4 space-y-2">
              <button
                onClick={handleStatusRebuildQuick}
                className="w-full border-2 border-[color:var(--pip-color)] py-2 hover:bg-[color:var(--pip-color)] hover:text-black transition-all font-bold uppercase"
              >
                {isZh ? '无 LLM 重建' : 'Rebuild (no LLM)'}
              </button>
              <button
                onClick={handleStatusRebuildLlmPrompt}
                className="w-full border border-[color:rgba(var(--pip-color-rgb),0.6)] py-2 hover:bg-[color:var(--pip-color)] hover:text-black transition-all font-bold uppercase"
              >
                {isZh ? '使用 LLM 重建' : 'Rebuild with LLM'}
              </button>
              <button
                onClick={handleStatusRebuildClose}
                className="w-full text-xs border border-[color:rgba(var(--pip-color-rgb),0.4)] py-2 hover:bg-[color:rgba(var(--pip-color-rgb),0.2)] transition-all uppercase"
              >
                {isZh ? '取消' : 'Cancel'}
              </button>
            </div>
          </>
        ) : (
          <>
            <h3 className="text-xl font-bold uppercase mb-3">
              {isZh ? 'LLM 重建提示' : 'LLM Rebuild Warning'}
            </h3>
            <div className="text-sm opacity-80 space-y-2">
              <div>
                {isZh
                  ? `该操作将根据叙事回合调用 LLM ${statusRebuildNarrationCount} 次，建议先切换到更便宜的文本模型。`
                  : `This will call the LLM ${statusRebuildNarrationCount} times (one per narration turn). Consider switching to a cheaper text model first.`}
              </div>
              <div>
                {isZh
                  ? '可进入设置修改文本模型名称或 API 配置。'
                  : 'You can open settings to adjust the text model or API configuration.'}
              </div>
            </div>
            <div className="mt-4 space-y-2">
              <button
                onClick={handleStatusRebuildLlmContinue}
                className="w-full border-2 border-[color:var(--pip-color)] py-2 hover:bg-[color:var(--pip-color)] hover:text-black transition-all font-bold uppercase"
              >
                {isZh ? '继续重建' : 'Continue'}
              </button>
              <button
                onClick={handleStatusRebuildLlmSettings}
                className="w-full border border-[color:rgba(var(--pip-color-rgb),0.6)] py-2 hover:bg-[color:var(--pip-color)] hover:text-black transition-all font-bold uppercase"
              >
                {isZh ? '打开设置' : 'Open settings'}
              </button>
              <button
                onClick={handleStatusRebuildBack}
                className="w-full text-xs border border-[color:rgba(var(--pip-color-rgb),0.4)] py-2 hover:bg-[color:rgba(var(--pip-color-rgb),0.2)] transition-all uppercase"
              >
                {isZh ? '返回' : 'Back'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
  const tipModal = isTipOpen && (
    <div className="fixed top-0 left-0 w-full h-full z-[3000] flex items-start justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="max-w-xl w-full max-h-[90vh] overflow-y-auto pip-boy-border p-6 md:p-10 bg-black">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-2xl font-bold uppercase">{isZh ? '打赏' : 'Tip / Donate'}</h3>
          <button 
            onClick={() => setIsTipOpen(false)}
            className="text-xs border border-[color:rgba(var(--pip-color-rgb),0.5)] px-2 py-1 hover:bg-[color:var(--pip-color)] hover:text-black transition-colors font-bold uppercase"
          >
            {isZh ? '关闭' : 'Close'}
          </button>
        </div>
        <div className="text-sm opacity-80 mb-4">
          {isZh
            ? '感谢您游玩辐射：RPG模拟，本游戏将尽可能地保持开放和免费，于此同时，如果您对游玩体验感到满意，并决定赞助我本人，本人将感激不尽。支持与打赏将帮助支付访客模式的 API 与服务器成本。使用美元（USD）最方便，因为成本按美元计费。谢谢你的支持！如果你有需要联系我，请加qq群757944721'
            : 'Thanks for playing Fallout: RPG Simulation. The game will stay open and free as much as possible. If you enjoy the experience and decide to support me, I would be truly grateful. Your support helps cover guest API usage and server costs. USD is most convenient since costs are billed in USD. Thank you! If you want to contact me, please join QQ group 757944721. Or email me at hustphysicscheng@gmial.com'}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="border border-[color:rgba(var(--pip-color-rgb),0.3)] p-3 bg-[color:rgba(var(--pip-color-rgb),0.05)] text-center">
            <img
              src={wechatQr}
              alt="WeChat QR"
              className="w-full h-auto"
              style={{ filter: 'brightness(0.85) contrast(1.2) sepia(1) hue-rotate(70deg) saturate(2)' }}
            />
            <div className="text-xs mt-2">
              {isZh ? '微信 (人民币)' : 'WeChat (CNY)'}
            </div>
          </div>
          <div className="border border-[color:rgba(var(--pip-color-rgb),0.3)] p-3 bg-[color:rgba(var(--pip-color-rgb),0.05)] text-center">
            <img
              src={alipayQr}
              alt="Alipay QR"
              className="w-full h-auto"
              style={{ filter: 'brightness(0.85) contrast(1.2) sepia(1) hue-rotate(70deg) saturate(2)' }}
            />
            <div className="text-xs mt-2">
              {isZh ? '支付宝 (人民币)' : 'Alipay (CNY)'}
            </div>
          </div>
          <div className="border border-[color:rgba(var(--pip-color-rgb),0.3)] p-3 bg-[color:rgba(var(--pip-color-rgb),0.05)] text-center">
            <img
              src={venmoQr}
              alt="Venmo QR"
              className="w-full h-auto"
              style={{ filter: 'brightness(0.85) contrast(1.2) sepia(1) hue-rotate(70deg) saturate(2)' }}
            />
            <div className="text-xs mt-2">
              {isZh ? 'Venmo (美元)' : 'Venmo (USD)'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
  const guestNotice = showGuestNotice && (
    <div className="fixed top-0 left-0 w-full h-full z-[2500] flex items-start justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="max-w-md w-full max-h-[90vh] overflow-y-auto pip-boy-border p-6 bg-black">
        <h3 className="text-xl font-bold uppercase mb-3">
          {isZh ? '临时用户提示' : 'Temporary User Notice'}
        </h3>
        <div className="text-sm opacity-80 space-y-2">
          <div>{isZh ? '你正在以临时身份体验。' : 'You are playing as a temporary user.'}</div>
          <div>{isZh
            ? `限制：仅 gemini-2.5-flash-lite / gemini-2.5-flash-image，AP 上限 ${guestMaxAp}，不恢复，不保存，回合不生成图像（仅创建时有）。`
            : `Limits: gemini-2.5-flash-lite / gemini-2.5-flash-image only, AP max ${guestMaxAp}, no recovery, no saves, no turn images (creation image only).`}
          </div>
          <div>{isZh ? '临时用户开始游玩后需等待 30 分钟才能再次进入。' : 'Guest mode has a 30-minute cooldown after starting.'}</div>
        </div>
        <button
          onClick={() => setShowGuestNotice(false)}
          className="mt-4 w-full border-2 border-[color:var(--pip-color)] py-2 hover:bg-[color:var(--pip-color)] hover:text-black transition-all font-bold uppercase"
        >
          {isZh ? '了解' : 'Understood'}
        </button>
      </div>
    </div>
  );

  if (view === 'auth') {
    return (
      <div
        className={`flex flex-col items-center justify-center min-h-screen p-4 md:p-8 text-center ${VIEW_PADDING_CLASS}`}
        style={scaledRootStyle}
      >
        {usersEditorModal}
        {tipModal}
        <div className="max-w-xl w-full space-y-6 pip-boy-border p-6 md:p-10 bg-black/70 shadow-2xl relative">
          <div className="absolute top-4 right-4 flex space-x-2">
            <button onClick={() => toggleLanguage('en')} className={`px-2 py-1 text-xs border ${gameState.language === 'en' ? 'bg-[color:var(--pip-color)] text-black' : 'border-[color:var(--pip-color)]'}`}>EN</button>
            <button onClick={() => toggleLanguage('zh')} className={`px-2 py-1 text-xs border ${gameState.language === 'zh' ? 'bg-[color:var(--pip-color)] text-black' : 'border-[color:var(--pip-color)]'}`}>中文</button>
          </div>
          <h1 className="text-3xl md:text-4xl font-bold glow-text uppercase">
            {isZh ? '访问验证' : 'Access Verification'}
          </h1>
          <div className="text-base md:text-lg font-bold text-yellow-300 uppercase tracking-wide">
            {isZh
              ? '如果你为访问本网站支付过费用，你被诈骗了！本网站永远免费。\n 本网站只负责提供平台与AI调用框架，用户所接收到的任何信息均来自第三方AI模型，与本网站无关。'
              : 'If you paid to get this website, you got scammed! This website is always free to access.\n This website only provides the platform and AI calling framework; any information you receive comes from third-party AI models and is not affiliated with this website.'}
          </div>
          <p className="text-sm opacity-70">
            {isZh ? '登录或注册以保存设置与进度。' : 'Log in or register to keep settings and progress.'}
          </p>

          <div className="flex space-x-2 justify-center text-xs uppercase font-bold">
            <button
              onClick={() => {
                setAuthMode('login');
                setAuthError('');
              }}
              className={`px-3 py-1 border ${authMode === 'login' ? 'bg-[color:var(--pip-color)] text-black' : 'border-[color:rgba(var(--pip-color-rgb),0.5)] hover:bg-[color:rgba(var(--pip-color-rgb),0.2)]'}`}
            >
              {isZh ? '登录' : 'Login'}
            </button>
            <button
              onClick={() => {
                setAuthMode('register');
                setAuthError('');
              }}
              className={`px-3 py-1 border ${authMode === 'register' ? 'bg-[color:var(--pip-color)] text-black' : 'border-[color:rgba(var(--pip-color-rgb),0.5)] hover:bg-[color:rgba(var(--pip-color-rgb),0.2)]'}`}
            >
              {isZh ? '注册' : 'Register'}
            </button>
          </div>

          <div className="space-y-3 text-left">
            <input
              type="text"
              value={authName}
              onChange={(e) => setAuthName(e.target.value)}
              className="w-full bg-black border border-[color:rgba(var(--pip-color-rgb),0.5)] p-3 text-[color:var(--pip-color)] text-sm focus:outline-none"
              placeholder={isZh ? '用户名' : 'Username'}
            />
            <input
              type="password"
              value={authPasskey}
              onChange={(e) => setAuthPasskey(e.target.value)}
              className="w-full bg-black border border-[color:rgba(var(--pip-color-rgb),0.5)] p-3 text-[color:var(--pip-color)] text-sm focus:outline-none"
              placeholder={isZh ? '密码' : 'Passkey'}
            />
            {authMode === 'register' && (
              <>
                <input
                  type="password"
                  value={authConfirm}
                  onChange={(e) => setAuthConfirm(e.target.value)}
                  className="w-full bg-black border border-[color:rgba(var(--pip-color-rgb),0.5)] p-3 text-[color:var(--pip-color)] text-sm focus:outline-none"
                  placeholder={isZh ? '确认密码' : 'Confirm passkey'}
                />
              </>
            )}
          </div>

          {authError && <div className="text-xs text-red-500">{authError}</div>}

          <div className="space-y-3">
            <button
              onClick={authMode === 'login' ? handleLogin : handleRegister}
              disabled={!usersLoaded}
              className="w-full border-2 border-[color:var(--pip-color)] py-3 hover:bg-[color:var(--pip-color)] hover:text-black transition-all font-bold uppercase disabled:opacity-40"
            >
              {authMode === 'login' ? (isZh ? '登录' : 'Log In') : (isZh ? '注册' : 'Register')}
            </button>
            <button
              onClick={handleSkipLogin}
              className="w-full text-xs border border-[color:rgba(var(--pip-color-rgb),0.4)] py-2 hover:bg-[color:rgba(var(--pip-color-rgb),0.2)] transition-all uppercase"
            >
              {isZh ? '先试试？跳过登录' : 'Want to try first? Skip login'}
            </button>
            <button
              onClick={() => setIsTipOpen(true)}
              className="w-full text-xs border border-[color:rgba(var(--pip-color-rgb),0.5)] py-2 hover:bg-[color:var(--pip-color)] hover:text-black transition-all uppercase"
            >
              {isZh ? '打赏' : 'Tip/Donate'}
            </button>
            <button
              onClick={() => importSave()}
              className="w-full text-xs border border-[color:rgba(var(--pip-color-rgb),0.4)] py-2 hover:bg-[color:rgba(var(--pip-color-rgb),0.2)] transition-all uppercase"
            >
              {isZh ? '导入存档' : 'Import Save'}
            </button>
          </div>

          {!usersLoaded && (
            <div className="text-[10px] opacity-50">
              {isZh ? '正在加载用户列表...' : 'Loading user registry...'}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (view === 'start') {
    return (
      <div
        className={`flex flex-col items-center justify-center min-h-screen p-4 md:p-8 text-center ${VIEW_PADDING_CLASS}`}
        style={scaledRootStyle}
      >
        {guestNotice}
        {usersEditorModal}
        {settingsModal}
        {helpModal}
        {userPromptModal}
        {arenaPromptModal}
        <div className="max-w-3xl w-full space-y-6 md:space-y-8 pip-boy-border p-6 md:p-12 bg-black/60 shadow-2xl relative">
          <div className="absolute top-4 right-4 flex space-x-2">
            <button onClick={() => toggleLanguage('en')} className={`px-2 py-1 text-xs border ${gameState.language === 'en' ? 'bg-[color:var(--pip-color)] text-black' : 'border-[color:var(--pip-color)]'}`}>EN</button>
            <button onClick={() => toggleLanguage('zh')} className={`px-2 py-1 text-xs border ${gameState.language === 'zh' ? 'bg-[color:var(--pip-color)] text-black' : 'border-[color:var(--pip-color)]'}`}>中文</button>
            <button
              onClick={() => setIsSettingsOpen(true)}
              className="px-2 py-1 text-xs border border-[color:rgba(var(--pip-color-rgb),0.5)] hover:bg-[color:var(--pip-color)] hover:text-black transition-colors font-bold uppercase"
            >
              {isZh ? '设置' : 'SET'}
            </button>
            <button
              onClick={() => setIsHelpOpen(true)}
              className="px-2 py-1 text-xs border border-[color:rgba(var(--pip-color-rgb),0.5)] hover:bg-[color:var(--pip-color)] hover:text-black transition-colors font-bold uppercase"
            >
              {isZh ? '帮助' : 'HELP'}
            </button>
            <button
              onClick={() => setIsUserPromptOpen(true)}
              className="px-2 py-1 text-xs border border-[color:rgba(var(--pip-color-rgb),0.5)] hover:bg-[color:var(--pip-color)] hover:text-black transition-colors font-bold uppercase"
            >
              {isZh ? '提示' : 'PROMPT'}
            </button>
            {isAdmin && (
              <button
                onClick={openUsersEditor}
                className="px-2 py-1 text-xs border border-[color:rgba(var(--pip-color-rgb),0.5)] hover:bg-[color:var(--pip-color)] hover:text-black transition-colors font-bold uppercase"
              >
                {isZh ? '用户' : 'USERS'}
              </button>
            )}
          </div>
          <h1 className="text-5xl md:text-7xl font-bold glow-text tracking-tighter">FALLOUT</h1>
          <h2 className="text-xl md:text-3xl tracking-widest opacity-80 uppercase">
            {gameState.language === 'en' ? 'Wasteland Chronicles' : '废土编年史'}
          </h2>
          <p className="text-lg md:text-xl opacity-70 italic">
            {gameState.language === 'en' ? 'War. War never changes.' : '战争。战争从未改变。'}
          </p>
          <div className="space-y-4 pt-4 md:pt-8">
             <button 
              onClick={pickEra}
              disabled={!canPlay}
              className={`w-full text-xl md:text-2xl border-2 border-[color:var(--pip-color)] py-4 transition-all font-bold uppercase ${
                canPlay ? 'hover:bg-[color:var(--pip-color)] hover:text-black' : 'opacity-40 cursor-not-allowed'
              }`}
             >
              {gameState.language === 'en' ? 'Initialize New Simulation' : '初始化新模拟'}
             </button>
             <button 
              onClick={openArenaSetup}
              disabled={!canPlay}
              className={`w-full text-xl md:text-2xl border-2 border-[color:rgba(var(--pip-color-rgb),0.7)] py-4 transition-all font-bold uppercase bg-[color:rgba(var(--pip-color-rgb),0.05)] ${
                canPlay ? 'hover:bg-[color:var(--pip-color)] hover:text-black' : 'opacity-40 cursor-not-allowed'
              }`}
             >
              {gameState.language === 'en' ? 'Wasteland Smash Arena' : '废土斗兽场'}
             </button>
             {hasSave && (
               <button 
                onClick={loadGame}
                disabled={!canPlay}
                className={`w-full text-xl md:text-2xl border-2 border-[color:rgba(var(--pip-color-rgb),0.5)] py-4 transition-all font-bold uppercase bg-[color:rgba(var(--pip-color-rgb),0.1)] ${
                  canPlay ? 'hover:bg-[color:rgba(var(--pip-color-rgb),0.5)] hover:text-black' : 'opacity-40 cursor-not-allowed'
                }`}
               >
                {gameState.language === 'en' ? 'Continue Last Save' : '继续上次存档'}
               </button>
             )}
             {hasArenaSave && (
               <button 
                onClick={loadArena}
                disabled={!canPlay}
                className={`w-full text-xl md:text-2xl border-2 border-[color:rgba(var(--pip-color-rgb),0.4)] py-4 transition-all font-bold uppercase bg-[color:rgba(var(--pip-color-rgb),0.05)] ${
                  canPlay ? 'hover:bg-[color:rgba(var(--pip-color-rgb),0.4)] hover:text-black' : 'opacity-40 cursor-not-allowed'
                }`}
               >
                {gameState.language === 'en' ? 'Continue Arena Save' : '继续斗兽场存档'}
               </button>
             )}
             {!canPlay && isNormal && (
               <div className="text-xs opacity-70 uppercase">
                 {isZh
                   ? '请先在设置中填写文本提供商/API/模型；如启用图像生成，还需填写图像提供商/API/模型。'
                   : 'Configure text provider/API/model first; if images are enabled, also configure image provider/API/model.'}
               </div>
             )}
          </div>
        </div>
      </div>
    );
  }

  if (view === 'creation') {
    return (
      <div
        className={`flex flex-col items-center justify-center min-h-screen p-4 md:p-8 ${VIEW_PADDING_CLASS}`}
        style={scaledRootStyle}
      >
        {guestNotice}
        {usersEditorModal}
        {arenaPromptModal}
        {keyAlert && (
          <div className="fixed top-0 left-0 w-full h-full z-[2000] flex items-start justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto">
            <div className="max-w-md w-full max-h-[90vh] overflow-y-auto pip-boy-border p-8 bg-black">
              <h3 className="text-2xl font-bold mb-4">API KEY REQUIRED</h3>
              <p className="mb-6 opacity-80 leading-relaxed">
                For high-quality image generation and real-time visual referencing, you must select a paid API key.
                <br /><br />
                <a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" className="underline text-[color:var(--pip-color)]">Learn about billing</a>
              </p>
              <button 
                onClick={handleKeySelection}
                className="w-full py-3 bg-[color:var(--pip-color)] text-black font-bold uppercase hover:bg-white transition-colors"
              >
                SELECT API KEY
              </button>
              <button 
                onClick={() => setKeyAlert(false)}
                className="w-full mt-2 py-2 text-xs opacity-40 uppercase hover:opacity-100"
              >
                Continue without (Fallback to basic images)
              </button>
            </div>
          </div>
        )}
        <div className="max-w-4xl w-full pip-boy-border p-6 md:p-8 bg-black/80">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-3xl md:text-4xl font-bold glow-text uppercase">
              {gameState.language === 'en' ? 'Identity Reconstruction' : '身份重建'}
            </h2>
            <button
              onClick={() => setView('start')}
              disabled={gameState.isThinking}
              className="text-xs border border-[color:rgba(var(--pip-color-rgb),0.5)] px-3 py-1 hover:bg-[color:var(--pip-color)] hover:text-black transition-colors font-bold uppercase disabled:opacity-40"
            >
              {isZh ? '返回' : 'BACK'}
            </button>
          </div>
          <div className="mb-6 space-y-2 p-4 bg-[color:rgba(var(--pip-color-rgb),0.1)] border border-[color:rgba(var(--pip-color-rgb),0.2)]">
             <div className="text-lg md:text-xl">
               {gameState.language === 'en' ? 'PARAMS: ' : '参数 (PARAMS): '}
               {displayLocation} / {displayYear}
             </div>
          </div>
          <button
            onClick={rerollCreationParams}
            disabled={gameState.isThinking}
            className="mb-4 w-full text-xs md:text-sm border border-[color:rgba(var(--pip-color-rgb),0.5)] py-2 hover:bg-[color:rgba(var(--pip-color-rgb),0.2)] transition-all disabled:opacity-40"
          >
            {isZh ? '这个世界太可怕了，我要换一个世界生活' : 'This world is terrifying. I want another life somewhere else.'}
          </button>
          <p className="mb-4 text-base md:text-lg">
            {gameState.language === 'en' 
              ? 'Describe your origin, skills, and current state. The system will derive your profile.' 
              : '描述你的出身、技能和现状。系统将生成你的档案。'}
          </p>
          <textarea 
            value={charDescription}
            onChange={(e) => setCharDescription(e.target.value)}
            className="w-full h-40 md:h-48 bg-black border border-[color:var(--pip-color)] p-4 text-[color:var(--pip-color)] focus:outline-none text-lg md:text-xl"
            disabled={gameState.isThinking}
            placeholder={gameState.language === 'en' ? "I am a vault dweller who..." : "我是一名来自避难所的..."}
          />
          <button
            onClick={() => importSave(currentUser?.username, () => setView('start'))}
            disabled={gameState.isThinking}
            className="mt-3 w-full text-sm border border-[color:rgba(var(--pip-color-rgb),0.5)] py-2 hover:bg-[color:rgba(var(--pip-color-rgb),0.2)] transition-all uppercase disabled:opacity-40"
          >
            {isZh ? '导入存档' : 'Import Save'}
          </button>
          <button 
            onClick={handleCharacterCreation}
            disabled={gameState.isThinking || !charDescription.trim()}
            className="mt-6 w-full text-xl md:text-2xl border-2 border-[color:var(--pip-color)] py-4 hover:bg-[color:var(--pip-color)] hover:text-black transition-all font-bold uppercase disabled:opacity-50"
          >
            {gameState.isThinking 
              ? (gameState.language === 'en' ? 'Processing...' : '处理中...') 
              : (gameState.language === 'en' ? 'Generate Profile' : '生成档案')}
          </button>
          {(gameState.isThinking || creationPhase) && (
            <div className="mt-4 border border-[color:rgba(var(--pip-color-rgb),0.3)] p-3 bg-[color:rgba(var(--pip-color-rgb),0.05)] text-left">
              <div className="text-[10px] uppercase opacity-60 mb-1">{isZh ? '系统日志' : 'SYSTEM LOG'}</div>
              <div className="text-xs opacity-80">
                {creationPhase || (isZh ? '处理中...' : 'Working...')}
              </div>
              {gameState.isThinking && (
                <div className="text-[10px] opacity-50 mt-1">
                  {isZh ? `已用时 ${creationElapsed}s` : `Elapsed ${creationElapsed}s`}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (view === 'arena_setup') {
    return (
      <div
        className={`flex flex-col items-center justify-center min-h-screen p-4 md:p-8 ${VIEW_PADDING_CLASS}`}
        style={scaledRootStyle}
      >
        {guestNotice}
        {usersEditorModal}
        {settingsModal}
        {arenaPromptModal}
        <div className="max-w-4xl w-full max-h-[90vh] overflow-y-auto pip-boy-border p-6 md:p-8 bg-black/80 space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-2xl md:text-3xl font-bold glow-text uppercase">
              {isZh ? '废土斗兽场' : 'Wasteland Smash Arena'}
            </h2>
            <div className="flex items-center space-x-2">
              <button onClick={() => toggleLanguage('en')} className={`px-2 py-1 text-xs border ${gameState.language === 'en' ? 'bg-[color:var(--pip-color)] text-black' : 'border-[color:var(--pip-color)]'}`}>EN</button>
              <button onClick={() => toggleLanguage('zh')} className={`px-2 py-1 text-xs border ${gameState.language === 'zh' ? 'bg-[color:var(--pip-color)] text-black' : 'border-[color:var(--pip-color)]'}`}>中文</button>
              <button
                onClick={() => setIsSettingsOpen(true)}
                className="px-2 py-1 text-xs border border-[color:rgba(var(--pip-color-rgb),0.5)] hover:bg-[color:var(--pip-color)] hover:text-black transition-colors font-bold uppercase"
              >
                {isZh ? '设置' : 'SET'}
              </button>
              <button
                onClick={() => setIsArenaPromptOpen(true)}
                className="px-2 py-1 text-xs border border-[color:rgba(var(--pip-color-rgb),0.5)] hover:bg-[color:var(--pip-color)] hover:text-black transition-colors font-bold uppercase"
              >
                {isZh ? '提示' : 'PROMPT'}
              </button>
            </div>
          </div>
          <p className="text-sm md:text-base opacity-70 leading-relaxed">
            {isZh
              ? '填写战斗焦点与参战方。系统将查阅 Fallout 世界观，并按逻辑分多轮模拟战局。'
              : 'Provide a focus question and the involved parties. The system will consult Fallout lore and simulate the battle over multiple rounds.'}
          </p>

          <div className="space-y-2">
            <div className="text-xs uppercase opacity-60">{isZh ? '模式' : 'Mode'}</div>
            <div className="flex space-x-2 text-xs uppercase font-bold">
              <button
                onClick={() => updateArenaMode('scenario')}
                className={`px-3 py-2 border ${arenaState.mode === 'scenario' ? 'bg-[color:var(--pip-color)] text-black' : 'border-[color:rgba(var(--pip-color-rgb),0.5)] hover:bg-[color:rgba(var(--pip-color-rgb),0.2)]'}`}
              >
                {isZh ? '情景演绎' : 'Scenario'}
              </button>
              <button
                onClick={() => updateArenaMode('wargame')}
                className={`px-3 py-2 border ${arenaState.mode === 'wargame' ? 'bg-[color:var(--pip-color)] text-black' : 'border-[color:rgba(var(--pip-color-rgb),0.5)] hover:bg-[color:rgba(var(--pip-color-rgb),0.2)]'}`}
              >
                {isZh ? '战争推演' : 'War Game Sim'}
              </button>
            </div>
            <div className="text-xs opacity-70 leading-relaxed">
              {arenaState.mode === 'scenario'
                ? (isZh
                  ? '情景演绎更注重叙事与场景描写。'
                  : 'Scenario mode focuses on story and scene depiction.')
                : (isZh
                  ? '战争推演以专业口吻汇报战况，并追踪兵力值。'
                  : 'War Game Sim reports the battle in a professional tone and tracks force power.')}
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-xs uppercase opacity-60">{isZh ? '焦点问题' : 'Focus question'}</div>
            <textarea
              value={arenaState.focus}
              onChange={(e) => updateArenaFocus(e.target.value)}
              className="w-full h-20 md:h-24 bg-black border border-[color:rgba(var(--pip-color-rgb),0.5)] p-3 text-[color:var(--pip-color)] text-sm md:text-base focus:outline-none"
              placeholder={isZh ? '例如：弗兰克何瑞根不穿动力甲和拉尼厄斯打，胜率如何？' : 'e.g. Frank Horrigan without power armor vs Lanius — odds?'} 
            />
          </div>

          <div className="space-y-3">
            <div className="text-xs uppercase opacity-60">{isZh ? '参战方' : 'Involved parties'}</div>
            <div className="text-xs opacity-70">
              {isZh ? '填写单位、人数、阵营与背景。' : 'Describe unit type, numbers, faction, and background.'}
            </div>
            {arenaState.involvedParties.map((party, index) => (
              <div key={index} className="space-y-2">
                <textarea
                  value={party.description}
                  onChange={(e) => updateArenaParty(index, e.target.value)}
                  className="w-full h-16 md:h-20 bg-black border border-[color:rgba(var(--pip-color-rgb),0.5)] p-3 text-[color:var(--pip-color)] text-sm md:text-base focus:outline-none"
                  placeholder={isZh ? `参战方 ${index + 1}` : `Party ${index + 1}`}
                />
                <button
                  onClick={() => removeArenaParty(index)}
                  disabled={arenaState.involvedParties.length <= 2}
                  className="text-[10px] uppercase border border-[color:rgba(var(--pip-color-rgb),0.4)] px-2 py-1 hover:bg-[color:rgba(var(--pip-color-rgb),0.2)] transition-all disabled:opacity-40"
                >
                  {isZh ? '移除此方' : 'Remove party'}
                </button>
              </div>
            ))}
            <button
              onClick={addArenaParty}
              disabled={arenaState.involvedParties.length >= 10}
              className="text-xs border border-[color:rgba(var(--pip-color-rgb),0.5)] px-3 py-2 hover:bg-[color:rgba(var(--pip-color-rgb),0.2)] transition-all uppercase disabled:opacity-40"
            >
              {isZh ? '添加参战方' : 'Add involved party'}
            </button>
          </div>

          {arenaError && <div className="text-xs text-red-500">{arenaError}</div>}

          <div className="space-y-3 pt-2">
            <button
              onClick={() => runArenaSimulation(false, true)}
              disabled={arenaState.isThinking}
              className="w-full text-lg md:text-xl border-2 border-[color:var(--pip-color)] py-3 hover:bg-[color:var(--pip-color)] hover:text-black transition-all font-bold uppercase disabled:opacity-50"
            >
              {isZh ? '生成战斗简报' : 'Generate Battle Briefing'}
            </button>
            <button
              onClick={() => setView('start')}
              className="w-full text-xs border border-[color:rgba(var(--pip-color-rgb),0.4)] py-2 hover:bg-[color:rgba(var(--pip-color-rgb),0.2)] transition-all uppercase"
            >
              {isZh ? '返回菜单' : 'Back to Start Menu'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (view === 'arena_play') {
    return (
      <div className={`flex flex-col h-screen w-screen overflow-hidden relative ${VIEW_PADDING_CLASS}`} style={scaledRootStyle}>
        {guestNotice}
        {usersEditorModal}
        {settingsModal}
        {arenaPromptModal}
        <header className="p-3 md:p-4 border-b border-[color:rgba(var(--pip-color-rgb),0.3)] bg-black/60 flex justify-between items-center z-20">
          <div className="flex items-center space-x-2 md:space-x-4">
            <div className="w-8 h-8 md:w-10 md:h-10 border-2 border-[color:var(--pip-color)] flex items-center justify-center font-bold text-lg md:text-xl">13</div>
            <h1 className="text-lg md:text-2xl font-bold tracking-widest uppercase truncate max-w-[200px] md:max-w-none">
              {isZh ? '废土斗兽场' : 'Wasteland Smash Arena'}
            </h1>
          </div>
          <div className="flex items-center space-x-2">
            <button
              onClick={() => setView('arena_setup')}
              disabled={arenaState.isThinking}
              className="px-2 py-1 text-xs border border-[color:rgba(var(--pip-color-rgb),0.5)] hover:bg-[color:var(--pip-color)] hover:text-black transition-colors font-bold uppercase disabled:opacity-40"
            >
              {isZh ? '返回' : 'BACK'}
            </button>
            <button onClick={() => toggleLanguage('en')} className={`px-2 py-1 text-xs border ${gameState.language === 'en' ? 'bg-[color:var(--pip-color)] text-black' : 'border-[color:var(--pip-color)]'}`}>EN</button>
            <button onClick={() => toggleLanguage('zh')} className={`px-2 py-1 text-xs border ${gameState.language === 'zh' ? 'bg-[color:var(--pip-color)] text-black' : 'border-[color:var(--pip-color)]'}`}>中文</button>
            <button
              onClick={() => setIsSettingsOpen(true)}
              className="px-2 py-1 text-xs border border-[color:rgba(var(--pip-color-rgb),0.5)] hover:bg-[color:var(--pip-color)] hover:text-black transition-colors font-bold uppercase"
            >
              {isZh ? '设置' : 'SET'}
            </button>
            <button
              onClick={() => setIsArenaPromptOpen(true)}
              className="px-2 py-1 text-xs border border-[color:rgba(var(--pip-color-rgb),0.5)] hover:bg-[color:var(--pip-color)] hover:text-black transition-colors font-bold uppercase"
            >
              {isZh ? '提示' : 'PROMPT'}
            </button>
          </div>
        </header>

        <div className="p-3 md:p-4 border-b border-[color:rgba(var(--pip-color-rgb),0.2)] bg-black/50 space-y-2 text-sm max-h-[30vh] overflow-y-auto">
          <div className="uppercase opacity-60">{isZh ? '焦点' : 'Focus'}</div>
          <div className="opacity-90">{arenaState.focus}</div>
        </div>

        <div className="flex flex-1 min-h-0">
          <div className={`flex flex-col min-w-0 min-h-0 ${arenaNarrationFlexClass}`}>
            <Terminal
              history={arenaState.history}
              isThinking={arenaState.isThinking}
              language={gameState.language}
              forceScrollbar
              progressStages={[
                { label: isZh ? '叙事生成' : 'Narration', status: arenaNarrationStage },
                { label: isZh ? '图像生成' : 'Image', status: arenaImageStage },
                { label: isZh ? '头像生成' : 'Avatar', status: arenaAvatarStage }
              ]}
              stageStatusLabels={stageStatusLabels}
              systemError={arenaError}
              systemErrorLabel={isZh ? '> 系统日志' : '> SYSTEM LOG'}
            />
          </div>
          <aside
            className={`relative w-64 md:w-auto border-l border-[color:rgba(var(--pip-color-rgb),0.3)] bg-black/60 p-3 md:p-4 overflow-y-auto min-h-0 ${arenaSidebarFlexClass}`}
            style={isDesktop ? { width: arenaPanelWidth } : undefined}
          >
            <div
              onPointerDown={startPanelResize('arena')}
              className="hidden md:block absolute left-0 top-0 h-full w-2 cursor-col-resize z-10"
            >
              <div className="h-full w-px bg-[color:rgba(var(--pip-color-rgb),0.3)] mx-auto" />
            </div>
            <div
              style={isDesktop ? {
                transform: `scale(${arenaPanelScale})`,
                transformOrigin: 'top left',
                width: `${100 / arenaPanelScale}%`,
                height: `${100 / arenaPanelScale}%`
              } : undefined}
              className={isDesktop ? 'h-full' : undefined}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs uppercase opacity-60">
                  {isZh ? '参战方概览' : 'Involved Parties'}
                </div>
                <button
                  onClick={() => setArenaSidebarFolded(prev => !prev)}
                  className="md:hidden text-[10px] uppercase border border-[color:rgba(var(--pip-color-rgb),0.5)] px-2 py-1 hover:bg-[color:var(--pip-color)] hover:text-black transition-colors font-bold"
                >
                  {arenaSidebarFolded ? (isZh ? '展开' : 'EXPAND') : (isZh ? '折叠' : 'FOLD')}
                </button>
              </div>
              <div className="space-y-3">
                {arenaState.involvedParties.map((party, index) => {
                  const forcePower = Number.isFinite(party.forcePower) ? Math.max(0, Math.floor(party.forcePower as number)) : null;
                  const maxPower = Number.isFinite(party.maxForcePower)
                    ? Math.max(1, Math.floor(party.maxForcePower as number))
                    : (forcePower ?? 1);
                  const barWidth = forcePower === null ? 0 : Math.max(2, Math.round((forcePower / maxPower) * 100));
                  const isDefeated = arenaState.mode === 'wargame' && forcePower !== null && forcePower <= 0;
                  return (
                    <div key={index} className="border border-[color:rgba(var(--pip-color-rgb),0.2)] p-3 bg-black/40">
                      <div className={`flex ${isArenaSidebarFolded ? 'flex-col items-center gap-2' : 'items-start space-x-3'}`}>
                        <div className={`${isArenaSidebarFolded ? 'w-16 h-16' : 'w-14 h-14'} border border-[color:rgba(var(--pip-color-rgb),0.4)] bg-black/60 flex items-center justify-center text-[10px] uppercase`}>
                          {party.avatarUrl ? (
                            <img src={party.avatarUrl} alt={`party-${index}`} className="w-full h-full object-cover opacity-90" />
                          ) : (
                            <span>{isZh ? '暂无头像' : 'No avatar'}</span>
                          )}
                        </div>
                        {!isArenaSidebarFolded && (
                          <div className="flex-1">
                            <div className="text-sm font-bold uppercase">
                              {isZh ? `参战方 ${index + 1}` : `Party ${index + 1}`}
                            </div>
                            <div className="text-xs opacity-70 whitespace-pre-wrap">
                              {party.description}
                            </div>
                          </div>
                        )}
                      </div>
                      {arenaState.mode === 'wargame' && (
                        <div className="mt-2">
                          <div className="flex items-center justify-between text-xs font-bold">
                            <span>{isZh ? '兵力值' : 'Force Power'}</span>
                            <span className={`text-base ${isDefeated ? 'text-[#ff6b6b]' : 'text-[color:var(--pip-color)]'}`}>
                              {forcePower ?? 0}/{maxPower}
                            </span>
                          </div>
                          <div className="mt-1 h-2 w-full bg-black border border-[color:rgba(var(--pip-color-rgb),0.3)]">
                            <div
                              className={`h-full ${isDefeated ? 'bg-[#ff6b6b]' : 'bg-[color:var(--pip-color)]'}`}
                              style={{ width: `${barWidth}%` }}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="mt-4 p-2 border-t border-[color:rgba(var(--pip-color-rgb),0.2)] text-[9px] uppercase tracking-widest flex justify-between items-center bg-[color:rgba(var(--pip-color-rgb),0.05)]">
                <span>{isZh ? '令牌' : 'TOKENS'}</span>
                <span className="opacity-70">
                  {(isZh ? '发送' : 'SEND')} {arenaTokenUsage.sent.toLocaleString()} · {(isZh ? '接收' : 'RECV')} {arenaTokenUsage.received.toLocaleString()} · {(isZh ? '总计' : 'TOTAL')} {arenaTokenUsage.total.toLocaleString()}
                </span>
              </div>
            </div>
          </aside>
        </div>

        <div className="p-4 border-t border-[color:rgba(var(--pip-color-rgb),0.3)] bg-black/60 flex flex-row flex-nowrap gap-1 md:gap-2 items-center">
          {!arenaState.finished ? (
            <>
              <button
                onClick={() => runArenaSimulation(false, false)}
                disabled={arenaState.isThinking}
                className="flex-1 min-w-0 border-2 border-[color:var(--pip-color)] py-2 md:py-3 text-xs md:text-base font-bold uppercase whitespace-nowrap hover:bg-[color:var(--pip-color)] hover:text-black transition-all disabled:opacity-50"
              >
                {arenaState.briefingComplete
                  ? (isZh ? '继续模拟' : 'Continue Simulation')
                  : (isZh ? '开始战斗' : 'Begin Battle')}
              </button>
              <button
                onClick={() => runArenaSimulation(true, false)}
                disabled={arenaState.isThinking || !arenaState.briefingComplete}
                className="flex-1 min-w-0 border-2 border-[color:rgba(var(--pip-color-rgb),0.5)] py-2 md:py-3 text-xs md:text-base font-bold uppercase whitespace-nowrap hover:bg-[color:rgba(var(--pip-color-rgb),0.7)] hover:text-black transition-all disabled:opacity-50"
              >
                {isZh ? '结束战斗' : 'Finish the Battle'}
              </button>
            </>
          ) : (
            <button
              onClick={() => setView('arena_setup')}
              className="flex-1 min-w-0 border-2 border-[color:var(--pip-color)] py-2 md:py-3 text-xs md:text-base font-bold uppercase whitespace-nowrap hover:bg-[color:var(--pip-color)] hover:text-black transition-all"
            >
              {isZh ? '返回斗兽场' : 'Back to Arena Setup'}
            </button>
          )}
          <div className="relative flex-1 min-w-0">
            <button
              onClick={() => setShowArenaExportMenu(prev => !prev)}
              className="w-full text-xs border border-[color:rgba(var(--pip-color-rgb),0.5)] px-3 py-2 uppercase hover:bg-[color:var(--pip-color)] hover:text-black transition-all whitespace-nowrap"
            >
              {isZh ? '导出记录' : 'Export Log'}
            </button>
            {showArenaExportMenu && (
              <div className="absolute right-0 bottom-full mb-2 w-40 border border-[color:rgba(var(--pip-color-rgb),0.4)] bg-black/90 text-xs uppercase shadow-lg">
                <button
                  onClick={() => {
                    exportArenaData('log-md');
                    setShowArenaExportMenu(false);
                  }}
                  className="w-full text-left px-3 py-2 hover:bg-[color:rgba(var(--pip-color-rgb),0.2)]"
                >
                  {isZh ? '导出 Markdown' : 'Export .md'}
                </button>
                <button
                  onClick={() => {
                    exportArenaData('log-pdf');
                    setShowArenaExportMenu(false);
                  }}
                  className="w-full text-left px-3 py-2 hover:bg-[color:rgba(var(--pip-color-rgb),0.2)]"
                >
                  {isZh ? '导出 PDF' : 'Export PDF'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex flex-col md:flex-row h-screen w-screen overflow-hidden relative ${VIEW_PADDING_CLASS}`} style={scaledRootStyle}>
      {guestNotice}
      {usersEditorModal}
      {settingsModal}
      {rawOutputModal}
      {helpModal}
      {userPromptModal}
      {arenaPromptModal}
      {legacyCompressionModal}
      {legacyInventoryModal}
      {legacyKnownNpcModal}
      {statusRebuildModal}
      {manualCompressionModal}
      {/* Main Terminal Area */}
      <div className="flex-1 flex flex-col min-w-0 bg-black/40 h-full overflow-hidden">
        <header className="p-3 md:p-4 border-b border-[color:rgba(var(--pip-color-rgb),0.3)] bg-black/60 flex justify-between items-center z-20">
          <div className="flex items-center space-x-2 md:space-x-4">
             <div className="w-8 h-8 md:w-10 md:h-10 border-2 border-[color:var(--pip-color)] flex items-center justify-center font-bold text-lg md:text-xl">13</div>
             <h1 className="text-lg md:text-2xl font-bold tracking-widest uppercase truncate max-w-[150px] md:max-w-none">PIP-BOY 3000</h1>
          </div>
          <div className="flex items-center space-x-2">
            {isAdmin && (
              <button
                onClick={openUsersEditor}
                className="text-xs border border-[color:rgba(var(--pip-color-rgb),0.5)] px-3 py-1 hover:bg-[color:var(--pip-color)] hover:text-black transition-colors font-bold uppercase"
              >
                {isZh ? '用户' : 'USERS'}
              </button>
            )}
            <button
              onClick={handleReturnToMenu}
              className="text-xs border border-[color:rgba(var(--pip-color-rgb),0.5)] px-3 py-1 hover:bg-[color:var(--pip-color)] hover:text-black transition-colors font-bold uppercase"
            >
              {isZh ? '返回' : 'BACK'}
            </button>
            <button 
              onClick={() => setIsSettingsOpen(true)}
              className="text-xs border border-[color:rgba(var(--pip-color-rgb),0.5)] px-3 py-1 hover:bg-[color:var(--pip-color)] hover:text-black transition-colors font-bold uppercase"
            >
              {isZh ? '设置' : 'SET'}
            </button>
            <button
              onClick={handleManualCompressionRequest}
              disabled={compressionLocked}
              className="text-xs border border-[color:rgba(var(--pip-color-rgb),0.5)] px-3 py-1 hover:bg-[color:var(--pip-color)] hover:text-black transition-colors font-bold uppercase disabled:opacity-40"
            >
              {isZh ? '压缩' : 'MEMORY'}
            </button>
            <button 
              onClick={() => setIsHelpOpen(true)}
              className="text-xs border border-[color:rgba(var(--pip-color-rgb),0.5)] px-3 py-1 hover:bg-[color:var(--pip-color)] hover:text-black transition-colors font-bold uppercase"
            >
              {isZh ? '帮助' : 'HELP'}
            </button>
            <button
              onClick={() => setIsUserPromptOpen(true)}
              className="text-xs border border-[color:rgba(var(--pip-color-rgb),0.5)] px-3 py-1 hover:bg-[color:var(--pip-color)] hover:text-black transition-colors font-bold uppercase"
            >
              {isZh ? '提示' : 'PROMPT'}
            </button>
            <button 
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
              className="md:hidden border-2 border-[color:var(--pip-color)] px-3 py-1 font-bold text-sm uppercase hover:bg-[color:var(--pip-color)] hover:text-black transition-all"
            >
              {isSidebarOpen ? (gameState.language === 'en' ? 'CLOSE' : '关闭') : (gameState.language === 'en' ? 'STAT' : '状态')}
            </button>
            <div className="hidden md:block opacity-50 text-xs">Mk IV</div>
          </div>
        </header>

        <Terminal
          history={gameState.history}
          isThinking={gameState.isThinking}
          language={gameState.language}
          progressStages={progressStages}
          stageStatusLabels={stageStatusLabels}
          systemError={systemError}
          statusManagerError={statusManagerError}
          systemErrorLabel={isZh ? '> 系统日志' : '> SYSTEM LOG'}
          statusErrorLabel={isZh ? '> 状态日志' : '> STATUS LOG'}
          compressionStatus={compressionStatus}
          compressionError={compressionError}
          compressionLabel={isZh ? '> 系统日志' : '> SYSTEM LOG'}
          compressionRetryLabel={isZh ? '重试' : 'Retry'}
          onRetryCompression={retryMemoryCompression}
          onReroll={handleReroll}
          canReroll={canReroll}
          rerollLabel={isZh ? '重掷' : 'REROLL'}
        />

        <form onSubmit={handleAction} className="p-3 md:p-4 bg-black/80 border-t border-[color:rgba(var(--pip-color-rgb),0.3)] flex space-x-2 md:space-x-4">
          <input 
            type="text"
            value={userInput}
            onChange={(e) => setUserInput(e.target.value)}
            placeholder={gameState.language === 'en' ? "Your action..." : "你的行动..."}
            className="flex-1 bg-black border border-[color:rgba(var(--pip-color-rgb),0.5)] p-3 md:p-4 text-[color:var(--pip-color)] text-lg md:text-xl focus:outline-none"
            disabled={inputLocked}
            autoFocus
          />
          <button 
            type="submit"
            disabled={inputLocked || !userInput.trim()}
            className="px-4 md:px-8 border-2 border-[color:var(--pip-color)] hover:bg-[color:var(--pip-color)] hover:text-black font-bold uppercase transition-all whitespace-nowrap"
          >
            {gameState.language === 'en' ? 'EXE' : '执行'}
          </button>
        </form>
      </div>

      {/* Responsive StatBar */}
      {gameState.player && (
        <div
          className={`
            absolute md:static inset-0 z-40 md:z-auto
            transition-transform duration-300 ease-in-out
            ${isSidebarOpen ? 'translate-x-0' : 'translate-x-full md:translate-x-0'}
            w-full h-full bg-black/95 md:bg-transparent ${VIEW_PADDING_CLASS}
          `}
          style={isDesktop ? { width: statPanelWidth } : undefined}
        >
          <div
            onPointerDown={startPanelResize('stat')}
            className="hidden md:block absolute left-0 top-0 h-full w-2 cursor-col-resize z-10"
          >
            <div className="h-full w-px bg-[color:rgba(var(--pip-color-rgb),0.3)] mx-auto" />
          </div>
          <StatBar 
            player={gameState.player} 
            location={gameState.location} 
            year={gameState.currentYear}
            time={gameState.currentTime}
            quests={gameState.quests}
            knownNpcs={gameState.knownNpcs}
            language={gameState.language}
            ap={gameState.ap}
            maxAp={maxAp}
            apUnlimited={apUnlimited}
            showApRecovery={!!apRecovery}
            apRecovery={apRecovery}
            tokenUsage={gameState.tokenUsage}
            onLanguageToggle={toggleLanguage}
            autoSaveEnabled={gameState.settings.autoSaveEnabled ?? false}
            onToggleAutoSave={toggleAutoSave}
            onSave={saveGame}
            onExport={exportData}
            showSave={canManualSave}
            onRefreshInventory={handleInventoryRefresh}
            inventoryRefreshing={isInventoryRefreshing}
            onRebuildStatus={handleStatusRebuildRequest}
            statusRebuilding={isStatusRebuilding}
            canRebuildStatus={!!gameState.status_track && !gameState.isThinking}
            onRegenerateCompanionAvatar={handleRegenerateCompanionAvatar}
            companionAvatarPending={companionAvatarPending}
            canRegenerateCompanionAvatar={canRegenerateCompanionAvatar}
            onClose={() => setIsSidebarOpen(false)}
            panelScale={statPanelScale}
          />
        </div>
      )}
    </div>
  );
};

export default App;
