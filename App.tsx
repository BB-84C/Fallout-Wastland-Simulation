
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { GameState, Actor, Language, Quest, HistoryEntry, GameSettings, UserRecord, UserTier, CompanionUpdate, PlayerCreationResult, ModelProvider, SpecialAttr, Skill, SkillSet, SpecialSet } from './types';
import { DEFAULT_SPECIAL, FALLOUT_ERA_STARTS } from './constants';
import { formatYear, localizeLocation } from './localization';
import Terminal from './components/Terminal';
import StatBar from './components/StatBar';
import { createPlayerCharacter, getNarrativeResponse, generateSceneImage, generateCompanionAvatar } from './services/modelService';
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
const USERS_DB_KEY = 'fallout_users_db';
const USER_API_KEY_PREFIX = 'fallout_user_api_key';
const USER_ONBOARD_PREFIX = 'fallout_user_onboarded';
const RESERVED_ADMIN_USERNAME = 'admin';
const GUEST_COOLDOWN_KEY = 'fallout_guest_cooldown_until';
const GUEST_COOLDOWN_MS = 30 * 60 * 1000;
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
const getUserApiKeyKey = (username: string, provider: ModelProvider) =>
  `${USER_API_KEY_PREFIX}_${username}_${provider}`;
const getUserOnboardKey = (username: string) => `${USER_ONBOARD_PREFIX}_${username}`;

const loadUserApiKey = (username: string, provider: ModelProvider) => {
  try {
    return localStorage.getItem(getUserApiKeyKey(username, provider)) || '';
  } catch {
    return '';
  }
};

const persistUserApiKey = (username: string, provider: ModelProvider, key: string) => {
  try {
    const trimmed = key.trim();
    if (!trimmed) {
      localStorage.removeItem(getUserApiKeyKey(username, provider));
      return;
    }
    localStorage.setItem(getUserApiKeyKey(username, provider), trimmed);
  } catch {
    // Ignore storage errors.
  }
};

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

const normalizeSessionSettings = (settings: GameSettings, tier: UserTier, hasKey: boolean) => {
  const minTurnsOverride = tier === 'normal' && hasKey ? 1 : undefined;
  const normalized = normalizeSettingsForTier(settings, tier, minTurnsOverride);
  const lockedImages = lockImageTurnsForTier(normalized, tier, hasKey);
  return lockHistoryTurnsForTier(lockedImages, tier);
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
    const detail = message.replace('JSON parse failed:', '').trim();
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
): GameState => ({
  player: null,
  currentYear: 2281,
  location: 'Mojave Wasteland',
  currentTime: new Date(Date.UTC(2281, 9, 23, 10, 0, 0)).toISOString(),
  history: [],
  knownNpcs: [],
  quests: [],
  isThinking: false,
  language,
  settings,
  ap,
  apLastUpdated,
  turnCount: 0,
});

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
    special: nextSpecial,
    skills: normalizeSkills(actor.skills, nextSpecial, true),
    perks: Array.isArray(actor.perks) ? actor.perks : [],
    inventory: Array.isArray(actor.inventory) ? actor.inventory : []
  };
};

const mergeActor = (base: Actor, update: Actor): Actor => {
  const nextSpecial = update.special ? normalizeSpecial(update.special) : base.special;
  const updateSkills = update.skills ? normalizeSkills(update.skills, nextSpecial, false) : {};
  return {
    ...base,
    ...update,
    special: nextSpecial,
    skills: update.skills ? { ...base.skills, ...updateSkills } : base.skills,
    perks: Array.isArray(update.perks) ? update.perks : base.perks,
    inventory: Array.isArray(update.inventory) ? update.inventory : base.inventory
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

type UserSession = {
  username: string;
  tier: UserTier;
  ap: number;
  apLastUpdated: number;
  settings: GameSettings;
  apiKey?: string;
  isTemporary: boolean;
};

const App: React.FC = () => {
  const [view, setView] = useState<'auth' | 'start' | 'creation' | 'playing'>('auth');
  const [gameState, setGameState] = useState<GameState>(
    createInitialGameState(DEFAULT_SETTINGS, NORMAL_MAX_AP, Date.now(), 'en')
  );
  const [userInput, setUserInput] = useState('');
  const [charDescription, setCharDescription] = useState('');
  const [hasSave, setHasSave] = useState(false);
  const [keyAlert, setKeyAlert] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [isTipOpen, setIsTipOpen] = useState(false);
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
  const lastHistoryLength = useRef(0);

  const activeTier: UserTier = currentUser?.tier ?? 'guest';
  const isAdmin = activeTier === 'admin';
  const isNormal = activeTier === 'normal';
  const isGuest = activeTier === 'guest';
  const hasUserKey = !!currentUser?.apiKey;
  const normalKeyUnlocked = isNormal && hasUserKey;
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
  const activeProvider: ModelProvider = isGuest || isAdmin
    ? 'gemini'
    : (gameState.settings.modelProvider || 'gemini');
  const selectedTextModel = gameState.settings.textModel?.trim() || undefined;
  const selectedImageModel = gameState.settings.imageModel?.trim() || undefined;
  const effectiveTextModel = selectedTextModel;
  const effectiveImageModel = selectedImageModel;
  const canManualSave = isAdmin || normalKeyUnlocked;
  const canAdjustImageFrequency = isAdmin || normalKeyUnlocked;
  const isModelConfigured = isNormal
    ? !!activeProvider && !!hasUserKey && !!selectedTextModel && !!selectedImageModel
    : true;
  const canPlay = isGuest || isAdmin || isModelConfigured;

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
  }, [isNormal, isModelConfigured, activeProvider, hasUserKey]);

  useEffect(() => {
    if (!currentUser || currentUser.tier === 'guest') {
      setHasSave(false);
      return;
    }
    const saved = localStorage.getItem(getSaveKey(currentUser.username));
    setHasSave(!!saved);
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
    if (!isNormal || !currentUser) return;
    if (gameState.history.length <= lastHistoryLength.current) {
      lastHistoryLength.current = gameState.history.length;
      return;
    }
    lastHistoryLength.current = gameState.history.length;
    const key = getSaveKey(currentUser.username);
    localStorage.setItem(key, JSON.stringify(gameState));
    setHasSave(true);
  }, [gameState, isNormal, currentUser]);

  useEffect(() => {
    if (!currentUser || !isNormal) return;
    if (isModelConfigured) {
      markUserOnboarded(currentUser.username);
    }
  }, [currentUser, isNormal, isModelConfigured]);

  useEffect(() => {
    if (!currentUser || !isNormal) return;
    const storedKey = loadUserApiKey(currentUser.username, activeProvider);
    const currentKey = currentUser.apiKey || '';
    if (storedKey !== currentKey) {
      setCurrentUser(prev => (prev ? { ...prev, apiKey: storedKey || undefined } : prev));
    }
  }, [currentUser, isNormal, activeProvider]);

  const saveGame = useCallback((notify = true) => {
    if (!currentUser || !canManualSave) return;
    try {
      const data = JSON.stringify(gameState);
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

  const loadGame = useCallback(() => {
    if (!currentUser || isGuest || (isNormal && !isModelConfigured)) return;
    const saved = localStorage.getItem(getSaveKey(currentUser.username));
    if (saved) {
      const parsed = JSON.parse(saved);
      const parsedPlayer = parsed?.player ? normalizeActor(parsed.player) : null;
      const parsedKnownNpcs = Array.isArray(parsed?.knownNpcs)
        ? parsed.knownNpcs.map((npc: Actor) => normalizeActor(npc))
        : [];
      const now = Date.now();
      const hasKey = currentUser.tier === 'normal' && !!currentUser.apiKey;
      const settings = normalizeSessionSettings(
        currentUser.settings || DEFAULT_SETTINGS,
        activeTier,
        hasKey
      );
      let clampedAp = Math.min(maxAp, typeof currentUser.ap === 'number' ? currentUser.ap : maxAp);
      let apLastUpdated = typeof currentUser.apLastUpdated === 'number' && currentUser.apLastUpdated > 0
        ? currentUser.apLastUpdated
        : now;
      if (apRecovery) {
        const synced = syncApState(clampedAp, apLastUpdated, now, maxAp, apRecovery);
        clampedAp = synced.ap;
        apLastUpdated = synced.apLastUpdated;
      }
      setGameState(prev => ({
        ...prev,
        ...parsed,
        player: parsedPlayer,
        knownNpcs: parsedKnownNpcs,
        settings,
        ap: clampedAp,
        apLastUpdated,
        turnCount: typeof parsed.turnCount === 'number' ? parsed.turnCount : 0,
      }));
      setView('playing');
    }
  }, [currentUser, isGuest, isNormal, isModelConfigured, activeTier, maxAp, apRecovery]);

  const applySession = (session: UserSession) => {
    setCurrentUser(session);
    setGameState(createInitialGameState(session.settings, session.ap, session.apLastUpdated, gameState.language));
    setHasSave(false);
    lastHistoryLength.current = 0;
    setShowGuestNotice(false);
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
    const baseSettings = record.settings || DEFAULT_SETTINGS;
    const provider = (baseSettings.modelProvider ?? 'gemini') as ModelProvider;
    const storedApiKey = tier === 'normal' ? loadUserApiKey(record.username, provider) : '';
    const sessionApiKey = storedApiKey || undefined;
    const hasKey = tier === 'normal' && !!sessionApiKey;
    const settings = normalizeSessionSettings(baseSettings, tier, hasKey);
    const hasModels = !!settings.textModel?.trim() && !!settings.imageModel?.trim() && !!settings.modelProvider;
    const needsSetup = tier === 'normal' && (!isUserOnboarded(record.username) || !hasKey || !hasModels);
    const maxAllowedAp = getMaxApForTier(tier);
    let ap = Math.min(maxAllowedAp, typeof record.ap === 'number' ? record.ap : maxAllowedAp);
    let apLastUpdated = typeof record.apLastUpdated === 'number' && record.apLastUpdated > 0
      ? record.apLastUpdated
      : Date.now();
    const recovery = tier === 'normal' && hasKey ? null : getApRecoveryForTier(tier);
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
      apiKey: sessionApiKey,
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
      apiKey: undefined,
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
      apiKey: undefined,
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
    if (activeProvider === 'gemini' && !hasUserKey && typeof (window as any).aistudio !== 'undefined') {
      const hasKey = await (window as any).aistudio.hasSelectedApiKey();
      if (!hasKey) {
        setKeyAlert(true);
      }
    }

    const era = FALLOUT_ERA_STARTS[Math.floor(Math.random() * FALLOUT_ERA_STARTS.length)];
    const randomHour = Math.floor(Math.random() * 12) + 6;
    const date = new Date(Date.UTC(era.year, 6, 15, randomHour, 0, 0));
    const initialTime = date.toISOString();
    
    setGameState(prev => ({ 
      ...prev, 
      currentYear: era.year, 
      location: era.region,
      currentTime: initialTime
    }));
    setView('creation');
  }, []);

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
          apiKey: currentUser?.apiKey,
          textModel: effectiveTextModel,
          provider: activeProvider,
          onProgress: (message) => {
            const mapped = formatCreationProgress(message, isZh, isAdmin);
            if (mapped) setCreationPhase(mapped);
          }
        }
      );

      const { companions: initialCompanions, ...player } = creation as PlayerCreationResult;
      const normalizedPlayer = normalizeActor(player as Actor);
      const seededCompanions = (initialCompanions ?? []).map(companion => normalizeActor({
        ...companion,
        ifCompanion: true
      }));

      setCreationPhase(getCreationPhaseText('image', isZh));
      
      const introMsg = gameState.language === 'en' 
        ? `Simulation Initialized. Locating profile... Success. Welcome, ${player.name}.`
        : `模拟初始化。正在定位档案... 成功。欢迎，${player.name}。`;

      const startNarration = `${introMsg} ${player.lore}`;
      const avatarPromise = !isGuest && seededCompanions.length > 0
        ? Promise.all(seededCompanions.map(companion => generateCompanionAvatar(companion, { tier: activeTier, apiKey: currentUser?.apiKey, imageModel: effectiveImageModel, provider: activeProvider })))
        : Promise.resolve([]);
      const [imgData, avatarResults] = await Promise.all([
        generateSceneImage(
          `The ${gameState.location} landscape during the year ${gameState.currentYear}, Fallout universe aesthetic`,
          { highQuality: gameState.settings.highQualityImages, tier: activeTier, apiKey: currentUser?.apiKey, imageModel: effectiveImageModel, textModel: effectiveTextModel, provider: activeProvider }
        ),
        avatarPromise
      ]);

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
      
      setGameState(prev => ({
        ...prev,
        player: normalizedPlayer,
        knownNpcs: initialKnownNpcs,
        isThinking: false,
        history: [{ 
          sender: 'narrator', 
          text: startNarration, 
          imageUrl: imgData?.url,
          groundingSources: imgData?.sources
        }]
      }));
      setView('playing');
      setCreationPhase('');
      setCreationStartTime(null);
      setCreationElapsed(0);
    } catch (err) {
      console.error("Vault-Tec Database Error:", err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setCreationPhase(isZh ? `访问请求失败：${errorMessage}` : `Access request failed: ${errorMessage}`);
      setGameState(prev => ({ 
        ...prev, 
        isThinking: false,
        history: [...prev.history, { 
          sender: 'narrator', 
          text: gameState.language === 'en' 
            ? `VAULT-TEC ERROR: Connection timed out while constructing profile. Please try again.` 
            : `避难所科技错误：构建档案时连接超时。请重试。` 
        }]
      }));
    }
  };

  const handleAction = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!userInput.trim() || gameState.isThinking || !gameState.player) return;
    if (isNormal && !isModelConfigured) {
      setIsSettingsOpen(true);
      return;
    }

    const now = Date.now();
    let currentAp = gameState.ap;
    let currentApLastUpdated = gameState.apLastUpdated;

    if (!apUnlimited && apRecovery) {
      const synced = syncApState(currentAp, currentApLastUpdated, now, maxAp, apRecovery);
      currentAp = synced.ap;
      currentApLastUpdated = synced.apLastUpdated;

      if (currentAp <= 0) {
        const elapsed = Math.max(0, now - currentApLastUpdated);
        const remainingMs = apRecovery.intervalMs - (elapsed % apRecovery.intervalMs);
        const minutesLeft = Math.max(1, Math.ceil(remainingMs / 60000));
        const waitLabel = formatRecoveryInterval(minutesLeft, isZh);
        const apMessage = gameState.language === 'en'
          ? `ACTION POINTS DEPLETED. Please return after ${waitLabel}.`
          : `行动点已耗尽。请在 ${waitLabel} 后再试。`;
        setGameState(prev => ({
          ...prev,
          isThinking: false,
          ap: currentAp,
          apLastUpdated: currentApLastUpdated,
          history: [...prev.history, { sender: 'narrator', text: apMessage }]
        }));
        return;
      }
    } else if (!apUnlimited && currentAp <= 0) {
      const apMessage = gameState.language === 'en'
        ? `ACTION POINTS DEPLETED. Please return later.`
        : `行动点已耗尽。请稍后再试。`;
      setGameState(prev => ({
        ...prev,
        isThinking: false,
        ap: currentAp,
        apLastUpdated: currentApLastUpdated,
        history: [...prev.history, { sender: 'narrator', text: apMessage }]
      }));
      return;
    }

    const actionText = userInput;
    setUserInput('');

    const updatedHistory: HistoryEntry[] = [...gameState.history, { sender: 'player', text: actionText }];
    const trimmedHistory = historyLimit ? updatedHistory.slice(-historyLimit) : updatedHistory;
    const lockedImageTurns = isNormal && !hasUserKey
      ? normalDefaultImageTurns
      : (isGuest ? guestFixedImageTurns : null);
    const imageEveryTurns = lockedImageTurns ?? Math.max(minImageTurns, Math.floor(gameState.settings.imageEveryTurns || minImageTurns));
    const nextTurn = gameState.turnCount + 1;
    const shouldGenerateImage = !isGuest && nextTurn % imageEveryTurns === 0;
    const nextAp = apUnlimited ? currentAp : Math.max(0, currentAp - 1);
    const nextApLastUpdated = apRecovery
      ? (currentAp >= maxAp ? now : currentApLastUpdated)
      : currentApLastUpdated;

    setGameState(prev => ({
      ...prev,
      isThinking: true,
      history: updatedHistory,
      ap: currentAp,
      apLastUpdated: currentApLastUpdated,
      turnCount: nextTurn
    }));

    try {
      const response = await getNarrativeResponse(
        gameState.player,
        trimmedHistory,
        actionText,
        gameState.currentYear,
        gameState.location,
        gameState.quests,
        gameState.knownNpcs,
        gameState.language,
        { tier: activeTier, apiKey: currentUser?.apiKey, textModel: effectiveTextModel, provider: activeProvider }
      );

      if (response.ruleViolation) {
        setGameState(prev => ({
          ...prev,
          isThinking: false,
          ap: currentAp,
          apLastUpdated: currentApLastUpdated,
          history: [...updatedHistory, { 
            sender: 'narrator', 
            text: `[RULE ERROR / 规则错误] ${response.ruleViolation}` 
          }]
        }));
        return;
      }

      const newTime = new Date(gameState.currentTime);
      newTime.setMinutes(newTime.getMinutes() + response.timePassedMinutes);

      const mergedQuests = [...gameState.quests];
      if (response.questUpdates) {
        response.questUpdates.forEach(update => {
          const normalized = normalizeQuestUpdate(update);
          if (!normalized) return;
          const index = mergedQuests.findIndex(q => q.id === normalized.id || q.name === normalized.name);
          if (index > -1) {
            const oldQuest = mergedQuests[index];
            if (normalized.status === 'completed' && oldQuest.status === 'active') {
              response.storyText += `\n\n[QUEST FINISHED: ${normalized.name}]\n${normalized.hiddenProgress}`;
            }
            mergedQuests[index] = {
              ...oldQuest,
              ...normalized,
              name: normalized.name || oldQuest.name,
              objective: normalized.objective || oldQuest.objective,
              hiddenProgress: normalized.hiddenProgress || oldQuest.hiddenProgress
            };
          } else {
            mergedQuests.push(normalized);
          }
        });
      }

      let nextKnownNpcs = gameState.knownNpcs.map(npc => ({
        ...npc,
        ifCompanion: npc.ifCompanion ?? false
      }));
      if (response.newNpc) {
        nextKnownNpcs = upsertNpc(nextKnownNpcs, response.newNpc);
      }
      nextKnownNpcs = applyCompanionUpdates(nextKnownNpcs, response.companionUpdates);

      const companionsNeedingAvatar = isGuest
        ? []
        : nextKnownNpcs.filter(npc => npc.ifCompanion && !npc.avatarUrl);

      // Generate images based on the configured frequency.
      const visualPrompt = response.imagePrompt || actionText;
      const imagePromise = shouldGenerateImage
        ? generateSceneImage(visualPrompt, { highQuality: gameState.settings.highQualityImages, tier: activeTier, apiKey: currentUser?.apiKey, imageModel: effectiveImageModel, textModel: effectiveTextModel, provider: activeProvider })
        : Promise.resolve(undefined);
      const avatarPromise = companionsNeedingAvatar.length > 0
        ? Promise.all(companionsNeedingAvatar.map(npc => generateCompanionAvatar(npc, { tier: activeTier, apiKey: currentUser?.apiKey, imageModel: effectiveImageModel, provider: activeProvider })))
        : Promise.resolve([]);
      const [imgData, avatarResults] = await Promise.all([imagePromise, avatarPromise]);
      const imageLog = shouldGenerateImage && imgData?.error
        ? (isZh ? `\n\n[图像日志] ${imgData.error}` : `\n\n[IMAGE LOG] ${imgData.error}`)
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

      setGameState(prev => ({
        ...prev,
        isThinking: false,
        currentTime: newTime.toISOString(),
        quests: mergedQuests,
        knownNpcs: nextKnownNpcs,
        ap: nextAp,
        apLastUpdated: nextApLastUpdated,
        player: response.updatedPlayer
          ? (prev.player ? mergeActor(prev.player, response.updatedPlayer) : normalizeActor(response.updatedPlayer))
          : prev.player, 
        history: [...updatedHistory, { 
          sender: 'narrator', 
          text: `${response.storyText}${imageLog}`, 
          imageUrl: imgData?.url,
          groundingSources: imgData?.sources
        }]
      }));
    } catch (err) {
      console.error(err);
      const errorDetail = err instanceof Error ? err.message : String(err);
      const errorLog = gameState.language === 'en'
        ? `\n\n[LOG] ${errorDetail}`
        : `\n\n[日志] ${errorDetail}`;
      setGameState(prev => ({ 
        ...prev, 
        isThinking: false,
        ap: currentAp,
        apLastUpdated: currentApLastUpdated,
        history: [...updatedHistory, { 
          sender: 'narrator', 
          text: gameState.language === 'en' 
            ? `VAULT-TEC ERROR: Narrative link unstable.${errorLog}` 
            : `避难所科技错误：叙事链路不稳定。${errorLog}` 
        }]
      }))
    }
  };

  const toggleLanguage = (lang: Language) => {
    setGameState(prev => ({ ...prev, language: lang }));
  };

  const toggleHighQualityImages = () => {
    setGameState(prev => ({
      ...prev,
      settings: {
        ...prev.settings,
        highQualityImages: !prev.settings.highQualityImages
      }
    }));
  };

  const updateModelProvider = (value: ModelProvider) => {
    if (!currentUser || !isNormal) return;
    setGameState(prev => ({
      ...prev,
      settings: {
        ...prev.settings,
        modelProvider: value
      }
    }));
    const storedKey = loadUserApiKey(currentUser.username, value);
    setCurrentUser(prev => (prev ? { ...prev, apiKey: storedKey || undefined } : prev));
  };

  const updateModelApiKey = (value: string) => {
    if (!currentUser || !isNormal) return;
    const trimmed = value.trim();
    persistUserApiKey(currentUser.username, activeProvider, trimmed);
    setCurrentUser(prev => (prev ? { ...prev, apiKey: trimmed || undefined } : prev));
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

  const updateImageFrequency = (value: string) => {
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

  const isZh = gameState.language === 'zh';
  const displayLocation = localizeLocation(gameState.location, gameState.language);
  const displayYear = formatYear(gameState.currentYear, gameState.language);
  const usersEditorModal = isUsersEditorOpen && (
    <div className="fixed top-0 left-0 w-full h-full z-[3100] flex items-start justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="max-w-3xl w-full max-h-[90vh] overflow-y-auto pip-boy-border p-6 md:p-8 bg-black">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-2xl font-bold uppercase">USERS.JSON</h3>
          <button
            onClick={() => setIsUsersEditorOpen(false)}
            className="text-xs border border-[#1aff1a]/50 px-2 py-1 hover:bg-[#1aff1a] hover:text-black transition-colors font-bold uppercase"
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
          className="w-full h-64 md:h-72 bg-black border border-[#1aff1a]/50 p-3 text-[#1aff1a] text-xs focus:outline-none font-mono"
        />
        {usersEditorError && (
          <div className="text-xs text-red-500 mt-2">{usersEditorError}</div>
        )}
        <div className="flex flex-wrap gap-2 mt-4">
          <button
            onClick={handleUsersEditorSave}
            className="px-4 py-2 border-2 border-[#1aff1a] hover:bg-[#1aff1a] hover:text-black font-bold uppercase text-xs"
          >
            {isZh ? '保存' : 'Save'}
          </button>
          <button
            onClick={handleUsersEditorDownload}
            className="px-4 py-2 border border-[#1aff1a]/50 hover:bg-[#1aff1a] hover:text-black font-bold uppercase text-xs"
          >
            {isZh ? '下载' : 'Download'}
          </button>
          <button
            onClick={() => setUsersEditorText(serializeUsersDb(usersDb, invitationCode))}
            className="px-4 py-2 border border-[#1aff1a]/30 hover:bg-[#1aff1a]/20 font-bold uppercase text-xs"
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
            className="text-xs border border-[#1aff1a]/50 px-2 py-1 hover:bg-[#1aff1a] hover:text-black transition-colors font-bold uppercase"
          >
            {isZh ? '关闭' : 'Close'}
          </button>
        </div>
          <div className="space-y-6">
            {isNormal && (
              <div className="text-xs border border-[#1aff1a]/30 p-3 bg-[#1aff1a]/5">
                {isZh
                  ? 'API Key 仅保存在本地浏览器，不会上传到服务器。'
                  : 'API keys are stored only in this browser and never uploaded to the server.'}
              </div>
            )}
          <div className="border border-[#1aff1a]/30 p-4 bg-[#1aff1a]/5">
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
                className={`text-xs px-3 py-1 border font-bold uppercase transition-colors ${
                  gameState.settings.highQualityImages
                    ? 'bg-[#1aff1a] text-black border-[#1aff1a]'
                    : 'border-[#1aff1a]/50 text-[#1aff1a] hover:bg-[#1aff1a]/20'
                }`}
              >
                {gameState.settings.highQualityImages ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>

          <div className="border border-[#1aff1a]/30 p-4 bg-[#1aff1a]/5">
            <div className="text-sm font-bold uppercase">
              {isZh ? '图像频率' : 'Image frequency'}
            </div>
            <div className="text-xs opacity-70 mt-1">
              {isZh
                ? (isGuest
                  ? '临时用户不生成回合图像，仅在创建角色时生成一张。'
                  : (isNormal && !hasUserKey
                    ? `设置模型与 API 后可调整图像频率；当前固定为 ${normalDefaultImageTurns}。`
                    : '每 N 次交互生成一张图像，可自由调整。'))
                : (isGuest
                  ? 'Temporary users do not generate turn images; only the creation image is shown.'
                  : (isNormal && !hasUserKey
                    ? `Configure provider/API to adjust image frequency; currently fixed at ${normalDefaultImageTurns}.`
                    : 'Generate images every N turns; adjustable.'))}
            </div>
            <div className="mt-3 flex items-center space-x-3">
              <input
                type="number"
                min={minImageTurns}
                value={gameState.settings.imageEveryTurns}
                onChange={(e) => updateImageFrequency(e.target.value)}
                disabled={!canAdjustImageFrequency}
                className="w-20 bg-black border border-[#1aff1a]/50 p-2 text-[#1aff1a] text-sm focus:outline-none disabled:opacity-40"
              />
              <span className="text-[10px] uppercase opacity-60">
                {isZh ? '回合' : 'turns'}
              </span>
            </div>
            {!isAdmin && (
              <div className="text-[10px] opacity-50 mt-2 uppercase">
                {isGuest
                  ? (isZh ? '临时用户不生成回合图像。' : 'Temporary users do not generate turn images.')
                  : (isNormal && !hasUserKey
                    ? (isZh ? `完成模型配置后可调整，当前固定为 ${normalDefaultImageTurns}。` : `Adjustable after setup; currently fixed at ${normalDefaultImageTurns}.`)
                    : (isZh ? '普通用户已完成模型配置。' : 'Normal user setup complete.'))}
              </div>
            )}
          </div>

          <div className="border border-[#1aff1a]/30 p-4 bg-[#1aff1a]/5">
            <div className="text-sm font-bold uppercase">
              {isZh ? '叙事历史上限' : 'Narrator history limit'}
            </div>
            <div className="text-xs opacity-70 mt-1">
              {isZh
                ? '发送给叙事模型的历史回合上限。设置为 -1 表示全部历史。注册用户默认 100，临时用户固定 20。'
                : 'Max turns sent to the narrator. Set to -1 to send all history. Registered default is 100; temporary users are fixed at 20.'}
            </div>
            <div className="mt-3 flex items-center space-x-3">
              <input
                type="number"
                min={-1}
                value={gameState.settings.maxHistoryTurns}
                onChange={(e) => updateHistoryLimit(e.target.value)}
                disabled={isGuest}
                className="w-20 bg-black border border-[#1aff1a]/50 p-2 text-[#1aff1a] text-sm focus:outline-none disabled:opacity-40"
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

          {isNormal && (
            <div className="border border-[#1aff1a]/30 p-4 bg-[#1aff1a]/5 space-y-4">
              <div>
                <div className="text-sm font-bold uppercase">
                  {isZh ? '模型提供商' : 'Model Provider'}
                </div>
                <div className="text-xs opacity-70 mt-1">
                  {isZh
                    ? '文本模型必须支持多模态输入（文本+图像）、函数调用与联网搜索。'
                    : 'Text models must be multimodal (text + image input), support function calling, and online search.'}
                </div>
                <select
                  value={activeProvider}
                  onChange={(e) => updateModelProvider(e.target.value as ModelProvider)}
                  className="mt-3 w-full bg-black border border-[#1aff1a]/50 p-2 text-[#1aff1a] text-xs focus:outline-none"
                >
                  {MODEL_PROVIDER_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div className="text-sm font-bold uppercase">
                  {isZh ? 'API Key' : 'API Key'}
                </div>
                <div className="text-xs opacity-70 mt-1">
                  {isZh ? '仅保存在本地浏览器，不会上传到服务器。' : 'Stored only in this browser and never uploaded.'}
                </div>
                <input
                  type="password"
                  value={currentUser?.apiKey || ''}
                  onChange={(e) => updateModelApiKey(e.target.value)}
                  className="mt-3 w-full bg-black border border-[#1aff1a]/50 p-2 text-[#1aff1a] text-xs focus:outline-none"
                  placeholder={isZh ? '粘贴 API Key' : 'Paste API key'}
                />
              </div>

              <div>
                <div className="text-sm font-bold uppercase">
                  {isZh ? '文本模型名称' : 'Text model name'}
                </div>
                <div className="text-xs opacity-70 mt-1">
                  {isZh ? '例如：gpt-4.1-mini 或 gemini-2.5-flash-lite' : 'Example: gpt-4.1-mini or gemini-2.5-flash-lite'}
                </div>
                <input
                  type="text"
                  value={gameState.settings.textModel || ''}
                  onChange={(e) => updateTextModelName(e.target.value)}
                  className="mt-3 w-full bg-black border border-[#1aff1a]/50 p-2 text-[#1aff1a] text-xs focus:outline-none"
                  placeholder={isZh ? '输入文本模型名称' : 'Enter text model name'}
                />
              </div>

              <div>
                <div className="text-sm font-bold uppercase">
                  {isZh ? '图像模型名称' : 'Image model name'}
                </div>
                <div className="text-xs opacity-70 mt-1">
                  {isZh ? '例如：gpt-image-1 或 gemini-2.5-flash-image' : 'Example: gpt-image-1 or gemini-2.5-flash-image'}
                </div>
                <input
                  type="text"
                  value={gameState.settings.imageModel || ''}
                  onChange={(e) => updateImageModelName(e.target.value)}
                  className="mt-3 w-full bg-black border border-[#1aff1a]/50 p-2 text-[#1aff1a] text-xs focus:outline-none"
                  placeholder={isZh ? '输入图像模型名称' : 'Enter image model name'}
                />
              </div>

              {!isModelConfigured && (
                <div className="text-[11px] text-yellow-300 uppercase">
                  {isZh ? '需要填写提供商、API Key、文本模型和图像模型后才能开始游戏。' : 'Provide provider, API key, text model, and image model to play.'}
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
            className="text-xs border border-[#1aff1a]/50 px-2 py-1 hover:bg-[#1aff1a] hover:text-black transition-colors font-bold uppercase"
          >
            {isZh ? '关闭' : 'Close'}
          </button>
        </div>
        <div className="space-y-4 text-sm">
          <div className="border border-[#1aff1a]/20 p-4 bg-[#1aff1a]/5">
            <div className="text-xs uppercase opacity-60 mb-2">{isZh ? '行动点 (AP)' : 'Action Points (AP)'}</div>
            <div className="opacity-80">
              {isZh
                ? `AP 上限随用户等级变化（注册用户完成配置后无限制，临时 ${guestMaxAp}）。每次行动消耗 1 点，AP 为 0 时无法行动。`
                : `AP cap depends on tier (Registered users unlimited after setup, Temporary ${guestMaxAp}). Each action costs 1 AP. You cannot act when AP reaches 0.`}
            </div>
            <div className="opacity-80 mt-2">
              {isZh
                ? '普通用户使用自有 API，AP 不受限制；临时用户不恢复 AP。'
                : 'Normal users play with their own API key and have unlimited AP; temporary users do not recover AP.'}
            </div>
          </div>

          <div className="border border-[#1aff1a]/20 p-4 bg-[#1aff1a]/5">
            <div className="text-xs uppercase opacity-60 mb-2">{isZh ? '规则' : 'Rules'}</div>
            <div className="opacity-80">
              {isZh
                ? '请描述行动意图，不要指定结果。系统会根据规则判定，并可能返回规则错误提示。'
                : 'Describe actions, not outcomes. The system enforces rules and may return a rule error if you dictate results.'}
            </div>
          </div>

          <div className="border border-[#1aff1a]/20 p-4 bg-[#1aff1a]/5">
            <div className="text-xs uppercase opacity-60 mb-2">{isZh ? '设置' : 'Settings'}</div>
            <div className="opacity-80">
              {isZh
                ? '高质量图像会进行两阶段研究，画面更贴合世界观，但响应更慢。'
                : 'High-quality images run a two-stage research pass for better immersion, but take longer to respond.'}
            </div>
            <div className="opacity-80 mt-2">
              {isZh
                ? '图像频率控制每隔多少回合生成图片。普通用户完成模型配置后可调整；临时用户不生成回合图像。'
                : 'Image frequency controls how often images appear (every N turns). Normal users can adjust it after setup; temporary users do not generate turn images.'}
            </div>
            <div className="opacity-80 mt-2">
              {isZh
                ? '叙事历史上限控制每次发送给模型的历史回合数，设置为 -1 表示全部。'
                : 'Narrator history limit controls how many turns are sent to the model; set -1 to include all history.'}
            </div>
          </div>

          <div className="border border-[#1aff1a]/20 p-4 bg-[#1aff1a]/5">
            <div className="text-xs uppercase opacity-60 mb-2">{isZh ? '用户等级' : 'User Tiers'}</div>
            <div className="opacity-80">
              {isZh
                ? `临时用户：AP 上限 ${guestMaxAp}，无恢复，无保存，仅创建时生成图像，模型固定为 gemini-2.5-flash-lite / gemini-2.5-flash-image。`
                : `Temporary: AP max ${guestMaxAp}, no recovery, no saves, only creation image, models fixed to gemini-2.5-flash-lite / gemini-2.5-flash-image.`}
            </div>
            <div className="opacity-80 mt-2">
              {isZh
                ? '普通用户：必须在设置中填写模型提供商、API Key、文本模型与图像模型后才能开始游戏；完成后 AP 无限制、图像频率可调、支持手动保存。'
                : 'Normal: configure provider/API key plus text and image model names in Settings before playing; after setup AP is unlimited, image frequency is adjustable, and manual saves are enabled.'}
            </div>
          </div>
        </div>
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
            className="text-xs border border-[#1aff1a]/50 px-2 py-1 hover:bg-[#1aff1a] hover:text-black transition-colors font-bold uppercase"
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
          <div className="border border-[#1aff1a]/30 p-3 bg-[#1aff1a]/5 text-center">
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
          <div className="border border-[#1aff1a]/30 p-3 bg-[#1aff1a]/5 text-center">
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
          <div className="border border-[#1aff1a]/30 p-3 bg-[#1aff1a]/5 text-center">
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
          className="mt-4 w-full border-2 border-[#1aff1a] py-2 hover:bg-[#1aff1a] hover:text-black transition-all font-bold uppercase"
        >
          {isZh ? '了解' : 'Understood'}
        </button>
      </div>
    </div>
  );

  if (view === 'auth') {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-4 md:p-8 text-center">
        {usersEditorModal}
        {tipModal}
        <div className="max-w-xl w-full space-y-6 pip-boy-border p-6 md:p-10 bg-black/70 shadow-2xl relative">
          <div className="absolute top-4 right-4 flex space-x-2">
            <button onClick={() => toggleLanguage('en')} className={`px-2 py-1 text-xs border ${gameState.language === 'en' ? 'bg-[#1aff1a] text-black' : 'border-[#1aff1a]'}`}>EN</button>
            <button onClick={() => toggleLanguage('zh')} className={`px-2 py-1 text-xs border ${gameState.language === 'zh' ? 'bg-[#1aff1a] text-black' : 'border-[#1aff1a]'}`}>中文</button>
          </div>
          <h1 className="text-3xl md:text-4xl font-bold glow-text uppercase">
            {isZh ? '访问验证' : 'Access Verification'}
          </h1>
          <p className="text-sm opacity-70">
            {isZh ? '登录或注册以保存设置与进度。' : 'Log in or register to keep settings and progress.'}
          </p>

          <div className="flex space-x-2 justify-center text-xs uppercase font-bold">
            <button
              onClick={() => {
                setAuthMode('login');
                setAuthError('');
              }}
              className={`px-3 py-1 border ${authMode === 'login' ? 'bg-[#1aff1a] text-black' : 'border-[#1aff1a]/50 hover:bg-[#1aff1a]/20'}`}
            >
              {isZh ? '登录' : 'Login'}
            </button>
            <button
              onClick={() => {
                setAuthMode('register');
                setAuthError('');
              }}
              className={`px-3 py-1 border ${authMode === 'register' ? 'bg-[#1aff1a] text-black' : 'border-[#1aff1a]/50 hover:bg-[#1aff1a]/20'}`}
            >
              {isZh ? '注册' : 'Register'}
            </button>
          </div>

          <div className="space-y-3 text-left">
            <input
              type="text"
              value={authName}
              onChange={(e) => setAuthName(e.target.value)}
              className="w-full bg-black border border-[#1aff1a]/50 p-3 text-[#1aff1a] text-sm focus:outline-none"
              placeholder={isZh ? '用户名' : 'Username'}
            />
            <input
              type="password"
              value={authPasskey}
              onChange={(e) => setAuthPasskey(e.target.value)}
              className="w-full bg-black border border-[#1aff1a]/50 p-3 text-[#1aff1a] text-sm focus:outline-none"
              placeholder={isZh ? '密码' : 'Passkey'}
            />
            {authMode === 'register' && (
              <>
                <input
                  type="password"
                  value={authConfirm}
                  onChange={(e) => setAuthConfirm(e.target.value)}
                  className="w-full bg-black border border-[#1aff1a]/50 p-3 text-[#1aff1a] text-sm focus:outline-none"
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
              className="w-full border-2 border-[#1aff1a] py-3 hover:bg-[#1aff1a] hover:text-black transition-all font-bold uppercase disabled:opacity-40"
            >
              {authMode === 'login' ? (isZh ? '登录' : 'Log In') : (isZh ? '注册' : 'Register')}
            </button>
            <button
              onClick={handleSkipLogin}
              className="w-full text-xs border border-[#1aff1a]/40 py-2 hover:bg-[#1aff1a]/20 transition-all uppercase"
            >
              {isZh ? '先试试？跳过登录' : 'Want to try first? Skip login'}
            </button>
            <button
              onClick={() => setIsTipOpen(true)}
              className="w-full text-xs border border-[#1aff1a]/50 py-2 hover:bg-[#1aff1a] hover:text-black transition-all uppercase"
            >
              {isZh ? '打赏' : 'Tip/Donate'}
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
      <div className="flex flex-col items-center justify-center min-h-screen p-4 md:p-8 text-center">
        {guestNotice}
        {usersEditorModal}
        {settingsModal}
        {helpModal}
        <div className="max-w-3xl w-full space-y-6 md:space-y-8 pip-boy-border p-6 md:p-12 bg-black/60 shadow-2xl relative">
          <div className="absolute top-4 right-4 flex space-x-2">
            <button onClick={() => toggleLanguage('en')} className={`px-2 py-1 text-xs border ${gameState.language === 'en' ? 'bg-[#1aff1a] text-black' : 'border-[#1aff1a]'}`}>EN</button>
            <button onClick={() => toggleLanguage('zh')} className={`px-2 py-1 text-xs border ${gameState.language === 'zh' ? 'bg-[#1aff1a] text-black' : 'border-[#1aff1a]'}`}>中文</button>
            <button
              onClick={() => setIsSettingsOpen(true)}
              className="px-2 py-1 text-xs border border-[#1aff1a]/50 hover:bg-[#1aff1a] hover:text-black transition-colors font-bold uppercase"
            >
              {isZh ? '设置' : 'SET'}
            </button>
            <button
              onClick={() => setIsHelpOpen(true)}
              className="px-2 py-1 text-xs border border-[#1aff1a]/50 hover:bg-[#1aff1a] hover:text-black transition-colors font-bold uppercase"
            >
              {isZh ? '帮助' : 'HELP'}
            </button>
            {isAdmin && (
              <button
                onClick={openUsersEditor}
                className="px-2 py-1 text-xs border border-[#1aff1a]/50 hover:bg-[#1aff1a] hover:text-black transition-colors font-bold uppercase"
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
              className={`w-full text-xl md:text-2xl border-2 border-[#1aff1a] py-4 transition-all font-bold uppercase ${
                canPlay ? 'hover:bg-[#1aff1a] hover:text-black' : 'opacity-40 cursor-not-allowed'
              }`}
             >
              {gameState.language === 'en' ? 'Initialize New Simulation' : '初始化新模拟'}
             </button>
             {hasSave && (
               <button 
                onClick={loadGame}
                disabled={!canPlay}
                className={`w-full text-xl md:text-2xl border-2 border-[#1aff1a]/50 py-4 transition-all font-bold uppercase bg-[#1aff1a]/10 ${
                  canPlay ? 'hover:bg-[#1aff1a]/50 hover:text-black' : 'opacity-40 cursor-not-allowed'
                }`}
               >
                {gameState.language === 'en' ? 'Continue Last Save' : '继续上次存档'}
               </button>
             )}
             {!canPlay && isNormal && (
               <div className="text-xs opacity-70 uppercase">
                 {isZh ? '请先在设置中填写模型提供商与 API 信息。' : 'Complete provider/API settings in Settings before playing.'}
               </div>
             )}
          </div>
        </div>
      </div>
    );
  }

  if (view === 'creation') {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-4 md:p-8">
        {guestNotice}
        {usersEditorModal}
        {keyAlert && (
          <div className="fixed top-0 left-0 w-full h-full z-[2000] flex items-start justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto">
            <div className="max-w-md w-full max-h-[90vh] overflow-y-auto pip-boy-border p-8 bg-black">
              <h3 className="text-2xl font-bold mb-4">API KEY REQUIRED</h3>
              <p className="mb-6 opacity-80 leading-relaxed">
                For high-quality image generation and real-time visual referencing, you must select a paid API key.
                <br /><br />
                <a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" className="underline text-[#1aff1a]">Learn about billing</a>
              </p>
              <button 
                onClick={handleKeySelection}
                className="w-full py-3 bg-[#1aff1a] text-black font-bold uppercase hover:bg-white transition-colors"
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
          <h2 className="text-3xl md:text-4xl font-bold mb-4 glow-text uppercase">
            {gameState.language === 'en' ? 'Identity Reconstruction' : '身份重建'}
          </h2>
          <div className="mb-6 space-y-2 p-4 bg-[#1aff1a]/10 border border-[#1aff1a]/20">
             <div className="text-lg md:text-xl">
               {gameState.language === 'en' ? 'PARAMS: ' : '参数 (PARAMS): '}
               {displayLocation} / {displayYear}
             </div>
          </div>
          <p className="mb-4 text-base md:text-lg">
            {gameState.language === 'en' 
              ? 'Describe your origin, skills, and current state. The system will derive your profile.' 
              : '描述你的出身、技能和现状。系统将生成你的档案。'}
          </p>
          <textarea 
            value={charDescription}
            onChange={(e) => setCharDescription(e.target.value)}
            className="w-full h-40 md:h-48 bg-black border border-[#1aff1a] p-4 text-[#1aff1a] focus:outline-none text-lg md:text-xl"
            disabled={gameState.isThinking}
            placeholder={gameState.language === 'en' ? "I am a vault dweller who..." : "我是一名来自避难所的..."}
          />
          <button 
            onClick={handleCharacterCreation}
            disabled={gameState.isThinking || !charDescription.trim()}
            className="mt-6 w-full text-xl md:text-2xl border-2 border-[#1aff1a] py-4 hover:bg-[#1aff1a] hover:text-black transition-all font-bold uppercase disabled:opacity-50"
          >
            {gameState.isThinking 
              ? (gameState.language === 'en' ? 'Processing...' : '处理中...') 
              : (gameState.language === 'en' ? 'Generate Profile' : '生成档案')}
          </button>
          {(gameState.isThinking || creationPhase) && (
            <div className="mt-4 border border-[#1aff1a]/30 p-3 bg-[#1aff1a]/5 text-left">
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

  return (
    <div className="flex flex-col md:flex-row h-screen w-screen overflow-hidden relative">
      {guestNotice}
      {usersEditorModal}
      {settingsModal}
      {helpModal}
      {/* Main Terminal Area */}
      <div className="flex-1 flex flex-col min-w-0 bg-black/40 h-full overflow-hidden">
        <header className="p-3 md:p-4 border-b border-[#1aff1a]/30 bg-black/60 flex justify-between items-center z-20">
          <div className="flex items-center space-x-2 md:space-x-4">
             <div className="w-8 h-8 md:w-10 md:h-10 border-2 border-[#1aff1a] flex items-center justify-center font-bold text-lg md:text-xl">13</div>
             <h1 className="text-lg md:text-2xl font-bold tracking-widest uppercase truncate max-w-[150px] md:max-w-none">PIP-BOY 3000</h1>
          </div>
          <div className="flex items-center space-x-2">
            {isAdmin && (
              <button
                onClick={openUsersEditor}
                className="text-[10px] border border-[#1aff1a]/50 px-2 py-0.5 hover:bg-[#1aff1a] hover:text-black transition-colors font-bold uppercase"
              >
                {isZh ? '用户' : 'USERS'}
              </button>
            )}
            <button 
              onClick={() => setIsSettingsOpen(true)}
              className="text-[10px] border border-[#1aff1a]/50 px-2 py-0.5 hover:bg-[#1aff1a] hover:text-black transition-colors font-bold uppercase"
            >
              {isZh ? '设置' : 'SET'}
            </button>
            <button 
              onClick={() => setIsHelpOpen(true)}
              className="text-[10px] border border-[#1aff1a]/50 px-2 py-0.5 hover:bg-[#1aff1a] hover:text-black transition-colors font-bold uppercase"
            >
              {isZh ? '帮助' : 'HELP'}
            </button>
            <button 
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
              className="md:hidden border-2 border-[#1aff1a] px-3 py-1 font-bold text-sm uppercase hover:bg-[#1aff1a] hover:text-black transition-all"
            >
              {isSidebarOpen ? (gameState.language === 'en' ? 'CLOSE' : '关闭') : (gameState.language === 'en' ? 'STAT' : '状态')}
            </button>
            <div className="hidden md:block opacity-50 text-xs">Mk IV</div>
          </div>
        </header>

        <Terminal history={gameState.history} isThinking={gameState.isThinking} />

        <form onSubmit={handleAction} className="p-3 md:p-4 bg-black/80 border-t border-[#1aff1a]/30 flex space-x-2 md:space-x-4">
          <input 
            type="text"
            value={userInput}
            onChange={(e) => setUserInput(e.target.value)}
            placeholder={gameState.language === 'en' ? "Your action..." : "你的行动..."}
            className="flex-1 bg-black border border-[#1aff1a]/50 p-3 md:p-4 text-[#1aff1a] text-lg md:text-xl focus:outline-none"
            disabled={gameState.isThinking}
            autoFocus
          />
          <button 
            type="submit"
            disabled={gameState.isThinking || !userInput.trim()}
            className="px-4 md:px-8 border-2 border-[#1aff1a] hover:bg-[#1aff1a] hover:text-black font-bold uppercase transition-all whitespace-nowrap"
          >
            {gameState.language === 'en' ? 'EXE' : '执行'}
          </button>
        </form>
      </div>

      {/* Responsive StatBar */}
      {gameState.player && (
        <div className={`
          absolute md:static inset-0 z-40 md:z-auto
          transition-transform duration-300 ease-in-out
          ${isSidebarOpen ? 'translate-x-0' : 'translate-x-full md:translate-x-0'}
          w-full md:w-80 h-full bg-black/95 md:bg-transparent
        `}>
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
            onLanguageToggle={toggleLanguage}
            onSave={saveGame}
            showSave={canManualSave}
            onClose={() => setIsSidebarOpen(false)}
          />
        </div>
      )}
    </div>
  );
};

export default App;
