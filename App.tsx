
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { GameState, Actor, Language, Quest, HistoryEntry, GameSettings, UserRecord, UserTier } from './types';
import { FALLOUT_ERA_STARTS } from './constants';
import Terminal from './components/Terminal';
import StatBar from './components/StatBar';
import { createPlayerCharacter, getNarrativeResponse, generateSceneImage } from './services/geminiService';

const SAVE_KEY_PREFIX = 'fallout_wasteland_save';
const USERS_DB_KEY = 'fallout_users_db';
const ADMIN_MAX_AP = 100;
const NORMAL_MAX_AP = 60;
const GUEST_MAX_AP = 30;
const AP_RECOVERY_INTERVAL_MS = 30 * 60 * 1000;
const AP_RECOVERY_AMOUNT = 6;
const DEFAULT_SETTINGS: GameSettings = {
  highQualityImages: true,
  imageEveryTurns: 3
};

const syncApState = (ap: number, apLastUpdated: number, now: number, maxAp: number) => {
  if (ap >= maxAp) return { ap, apLastUpdated };
  const elapsed = Math.max(0, now - apLastUpdated);
  if (elapsed < AP_RECOVERY_INTERVAL_MS) return { ap, apLastUpdated };
  const intervals = Math.floor(elapsed / AP_RECOVERY_INTERVAL_MS);
  const recovered = intervals * AP_RECOVERY_AMOUNT;
  const nextAp = Math.min(maxAp, ap + recovered);
  const nextLastUpdated = apLastUpdated + intervals * AP_RECOVERY_INTERVAL_MS;
  return { ap: nextAp, apLastUpdated: nextLastUpdated };
};

const getSaveKey = (username: string) => `${SAVE_KEY_PREFIX}_${username}`;

const getMaxApForTier = (tier: UserTier) => {
  if (tier === 'admin') return ADMIN_MAX_AP;
  if (tier === 'normal') return NORMAL_MAX_AP;
  return GUEST_MAX_AP;
};

const getMinImageTurnsForTier = (tier: UserTier) => {
  if (tier === 'admin') return 1;
  if (tier === 'normal') return 5;
  return 3;
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

const normalizeSettingsForTier = (settings: GameSettings, tier: UserTier) => {
  const minTurns = getMinImageTurnsForTier(tier);
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    imageEveryTurns: Math.max(minTurns, Math.floor(settings.imageEveryTurns || DEFAULT_SETTINGS.imageEveryTurns))
  };
};

const createInitialGameState = (settings: GameSettings, ap: number, apLastUpdated: number): GameState => ({
  player: null,
  currentYear: 2281,
  location: 'Mojave Wasteland',
  currentTime: new Date(Date.UTC(2281, 9, 23, 10, 0, 0)).toISOString(),
  history: [],
  knownNpcs: [],
  quests: [],
  isThinking: false,
  language: 'en',
  settings,
  ap,
  apLastUpdated,
  turnCount: 0,
});

const normalizeUsersDb = (data: any): Record<string, UserRecord> => {
  if (!data) return {};
  if (Array.isArray(data)) {
    return data.reduce((acc, user) => {
      if (user?.username) acc[user.username] = user;
      return acc;
    }, {} as Record<string, UserRecord>);
  }
  if (Array.isArray(data.users)) {
    return data.users.reduce((acc: Record<string, UserRecord>, user: UserRecord) => {
      if (user?.username) acc[user.username] = user;
      return acc;
    }, {});
  }
  if (data.users && typeof data.users === 'object') {
    return data.users as Record<string, UserRecord>;
  }
  if (typeof data === 'object') {
    const entries = Object.entries(data);
    if (
      entries.length > 0 &&
      entries.every(([, value]) => value && typeof value === 'object' && 'username' in value)
    ) {
      return data as Record<string, UserRecord>;
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

type UserSession = {
  username: string;
  tier: UserTier;
  ap: number;
  apLastUpdated: number;
  settings: GameSettings;
  isTemporary: boolean;
};

const App: React.FC = () => {
  const [view, setView] = useState<'auth' | 'start' | 'creation' | 'playing'>('auth');
  const [gameState, setGameState] = useState<GameState>(
    createInitialGameState(DEFAULT_SETTINGS, ADMIN_MAX_AP, Date.now())
  );
  const [userInput, setUserInput] = useState('');
  const [charDescription, setCharDescription] = useState('');
  const [hasSave, setHasSave] = useState(false);
  const [keyAlert, setKeyAlert] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [usersDb, setUsersDb] = useState<Record<string, UserRecord>>({});
  const [usersLoaded, setUsersLoaded] = useState(false);
  const [currentUser, setCurrentUser] = useState<UserSession | null>(null);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authName, setAuthName] = useState('');
  const [authPasskey, setAuthPasskey] = useState('');
  const [authConfirm, setAuthConfirm] = useState('');
  const [authInvitation, setAuthInvitation] = useState('');
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
  const maxAp = getMaxApForTier(activeTier);
  const minImageTurns = getMinImageTurnsForTier(activeTier);

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
  }, []);

  useEffect(() => {
    if (!currentUser || currentUser.tier === 'guest') {
      setHasSave(false);
      return;
    }
    const saved = localStorage.getItem(getSaveKey(currentUser.username));
    setHasSave(!!saved);
  }, [currentUser]);

  useEffect(() => {
    if (view !== 'playing' || !isNormal) return;
    const interval = setInterval(() => {
      setGameState((prev) => {
        const now = Date.now();
        const synced = syncApState(prev.ap, prev.apLastUpdated, now, maxAp);
        if (synced.ap === prev.ap && synced.apLastUpdated === prev.apLastUpdated) {
          return prev;
        }
        return { ...prev, ap: synced.ap, apLastUpdated: synced.apLastUpdated };
      });
    }, 30000);
    return () => clearInterval(interval);
  }, [view, isNormal, maxAp]);

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

  const saveGame = useCallback((notify = true) => {
    if (!currentUser || isGuest) return;
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
  }, [gameState, currentUser, isGuest]);

  const loadGame = useCallback(() => {
    if (!currentUser || isGuest) return;
    const saved = localStorage.getItem(getSaveKey(currentUser.username));
    if (saved) {
      const parsed = JSON.parse(saved);
      const now = Date.now();
      const settings = normalizeSettingsForTier(currentUser.settings || DEFAULT_SETTINGS, activeTier);
      let clampedAp = Math.min(maxAp, typeof currentUser.ap === 'number' ? currentUser.ap : maxAp);
      let apLastUpdated = typeof currentUser.apLastUpdated === 'number' && currentUser.apLastUpdated > 0
        ? currentUser.apLastUpdated
        : now;
      if (isNormal) {
        const synced = syncApState(clampedAp, apLastUpdated, now, maxAp);
        clampedAp = synced.ap;
        apLastUpdated = synced.apLastUpdated;
      }
      setGameState(prev => ({
        ...prev,
        ...parsed,
        settings,
        ap: clampedAp,
        apLastUpdated,
        turnCount: typeof parsed.turnCount === 'number' ? parsed.turnCount : 0,
      }));
      setView('playing');
    }
  }, [currentUser, isGuest, activeTier, maxAp, isNormal]);

  const applySession = (session: UserSession) => {
    setCurrentUser(session);
    setGameState(createInitialGameState(session.settings, session.ap, session.apLastUpdated));
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
    const settings = normalizeSettingsForTier(record.settings || DEFAULT_SETTINGS, tier);
    const maxAllowedAp = getMaxApForTier(tier);
    let ap = Math.min(maxAllowedAp, typeof record.ap === 'number' ? record.ap : maxAllowedAp);
    let apLastUpdated = typeof record.apLastUpdated === 'number' && record.apLastUpdated > 0
      ? record.apLastUpdated
      : Date.now();
    if (tier === 'normal') {
      const synced = syncApState(ap, apLastUpdated, Date.now(), maxAllowedAp);
      ap = synced.ap;
      apLastUpdated = synced.apLastUpdated;
    }
    applySession({
      username: record.username,
      tier,
      ap,
      apLastUpdated,
      settings,
      isTemporary: false
    });
    setAuthError('');
    setAuthName('');
    setAuthPasskey('');
    setAuthConfirm('');
    setAuthInvitation('');
    setView('start');
  };

  const handleRegister = () => {
    const name = authName.trim();
    const passkey = authPasskey.trim();
    const confirmation = authConfirm.trim();
    const invite = authInvitation.trim();
    if (!name || !passkey) {
      setAuthError(gameState.language === 'en' ? 'Enter username and passkey.' : '请输入用户名和密码。');
      return;
    }
    if (passkey !== confirmation) {
      setAuthError(gameState.language === 'en' ? 'Passkeys do not match.' : '两次输入的密码不一致。');
      return;
    }
    const normalizedInvite = invite.trim();
    const normalizedCode = invitationCode.trim();
    if (!normalizedCode) {
      setAuthError(gameState.language === 'en' ? 'Invitation code not loaded. Please reload.' : '邀请码未加载，请刷新页面。');
      return;
    }
    if (normalizedInvite !== normalizedCode) {
      setAuthError(gameState.language === 'en' ? 'Invalid invitation code.' : '邀请码无效。');
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
      settings: normalizeSettingsForTier(DEFAULT_SETTINGS, 'normal'),
      isTemporary: false
    });
    setAuthError('');
    setAuthName('');
    setAuthPasskey('');
    setAuthConfirm('');
    setAuthInvitation('');
    setView('start');
  };

  const handleSkipLogin = () => {
    const now = Date.now();
    applySession({
      username: 'temporary',
      tier: 'guest',
      ap: GUEST_MAX_AP,
      apLastUpdated: now,
      settings: normalizeSettingsForTier(DEFAULT_SETTINGS, 'guest'),
      isTemporary: true
    });
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
    if (typeof (window as any).aistudio !== 'undefined') {
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
    if (!charDescription.trim()) return;
    setGameState(prev => ({ ...prev, isThinking: true }));
    setCreationStartTime(Date.now());
    setCreationElapsed(0);
    setCreationPhase(getCreationPhaseText('request', isZh));
    try {
      const actor = await createPlayerCharacter(
        charDescription, 
        gameState.currentYear, 
        gameState.location, 
        gameState.language,
        { 
          tier: activeTier,
          onProgress: (message) => {
            const mapped = formatCreationProgress(message, isZh, isAdmin);
            if (mapped) setCreationPhase(mapped);
          }
        }
      );

      setCreationPhase(getCreationPhaseText('image', isZh));
      
      const introMsg = gameState.language === 'en' 
        ? `Simulation Initialized. Locating profile... Success. Welcome, ${actor.name}.`
        : `模拟初始化。正在定位档案... 成功。欢迎，${actor.name}。`;

      const startNarration = `${introMsg} ${actor.lore}`;
      const imgData = await generateSceneImage(
        `The ${gameState.location} landscape during the year ${gameState.currentYear}, Fallout universe aesthetic`,
        { highQuality: gameState.settings.highQualityImages, tier: activeTier }
      );

      setCreationPhase(getCreationPhaseText('finalize', isZh));
      
      setGameState(prev => ({
        ...prev,
        player: actor,
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

    const now = Date.now();
    let currentAp = gameState.ap;
    let currentApLastUpdated = gameState.apLastUpdated;

    if (isNormal) {
      const synced = syncApState(currentAp, currentApLastUpdated, now, maxAp);
      currentAp = synced.ap;
      currentApLastUpdated = synced.apLastUpdated;

      if (currentAp <= 0) {
        const elapsed = Math.max(0, now - currentApLastUpdated);
        const remainingMs = AP_RECOVERY_INTERVAL_MS - (elapsed % AP_RECOVERY_INTERVAL_MS);
        const minutesLeft = Math.max(1, Math.ceil(remainingMs / 60000));
        const apMessage = gameState.language === 'en'
          ? `ACTION POINTS DEPLETED. Please return after ${minutesLeft} minutes.`
          : `行动点已耗尽。请在 ${minutesLeft} 分钟后再试。`;
        setGameState(prev => ({
          ...prev,
          isThinking: false,
          ap: currentAp,
          apLastUpdated: currentApLastUpdated,
          history: [...prev.history, { sender: 'narrator', text: apMessage }]
        }));
        return;
      }
    } else if (isGuest && currentAp <= 0) {
      const apMessage = gameState.language === 'en'
        ? `TEMPORARY ACCESS ENDED. Start a new character or log in to continue.`
        : `临时权限已结束。请登录或新建角色继续。`;
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
    const imageEveryTurns = Math.max(minImageTurns, Math.floor(gameState.settings.imageEveryTurns || minImageTurns));
    const nextTurn = gameState.turnCount + 1;
    const shouldGenerateImage = nextTurn % imageEveryTurns === 0;
    const nextAp = isAdmin ? currentAp : Math.max(0, currentAp - 1);
    const nextApLastUpdated = isNormal
      ? (currentAp >= maxAp ? now : currentApLastUpdated)
      : currentApLastUpdated;

    setGameState(prev => ({
      ...prev,
      isThinking: true,
      history: updatedHistory,
      ap: nextAp,
      apLastUpdated: nextApLastUpdated,
      turnCount: nextTurn
    }));

    try {
      const response = await getNarrativeResponse(
        gameState.player,
        updatedHistory,
        actionText,
        gameState.currentYear,
        gameState.location,
        gameState.quests,
        gameState.language,
        { tier: activeTier }
      );

      if (response.ruleViolation) {
        setGameState(prev => ({
          ...prev,
          isThinking: false,
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
          const index = mergedQuests.findIndex(q => q.id === update.id || q.name === update.name);
          if (index > -1) {
            const oldQuest = mergedQuests[index];
            if (update.status === 'completed' && oldQuest.status === 'active') {
              response.storyText += `\n\n[QUEST FINISHED: ${update.name}]\n${update.hiddenProgress}`;
            }
            mergedQuests[index] = update;
          } else {
            mergedQuests.push(update);
          }
        });
      }

      // Generate images based on the configured frequency.
      const visualPrompt = response.imagePrompt || actionText;
      const imgData = shouldGenerateImage
        ? await generateSceneImage(visualPrompt, { highQuality: gameState.settings.highQualityImages, tier: activeTier })
        : undefined;
      const imageLog = shouldGenerateImage && imgData?.error
        ? (isZh ? `\n\n[图像日志] ${imgData.error}` : `\n\n[IMAGE LOG] ${imgData.error}`)
        : '';

      setGameState(prev => ({
        ...prev,
        isThinking: false,
        currentTime: newTime.toISOString(),
        quests: mergedQuests,
        knownNpcs: response.newNpc ? [...prev.knownNpcs, response.newNpc] : prev.knownNpcs,
        player: response.updatedPlayer || prev.player, 
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

  const updateImageFrequency = (value: string) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    if (isGuest) return;
    const clamped = Math.max(minImageTurns, Math.floor(parsed));
    setGameState(prev => ({
      ...prev,
      settings: {
        ...prev.settings,
        imageEveryTurns: clamped
      }
    }));
  };

  const isZh = gameState.language === 'zh';
  const usersEditorModal = isUsersEditorOpen && (
    <div className="fixed top-0 left-0 w-full h-full z-[3100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="max-w-3xl w-full pip-boy-border p-6 md:p-8 bg-black">
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
  const guestNotice = showGuestNotice && (
    <div className="fixed top-0 left-0 w-full h-full z-[2500] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="max-w-md w-full pip-boy-border p-6 bg-black">
        <h3 className="text-xl font-bold uppercase mb-3">
          {isZh ? '临时用户提示' : 'Temporary User Notice'}
        </h3>
        <div className="text-sm opacity-80 space-y-2">
          <div>{isZh ? '你正在以临时身份体验。' : 'You are playing as a temporary user.'}</div>
          <div>{isZh ? '限制：仅最低模型、AP 上限 30 且不恢复。' : 'Limits: minimum models only, AP max 30 with no recovery.'}</div>
          <div>{isZh ? '不会保存进度，需要新建角色继续。' : 'Progress is not saved; start a new character to continue.'}</div>
          <div>{isZh ? '无法调整图像频率。' : 'Image frequency cannot be adjusted.'}</div>
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

          <div className="text-[11px] border border-[#1aff1a]/30 p-3 bg-[#1aff1a]/5 text-left">
            {isZh
              ? '需要注册请联系：hustphysicscheng@gmail.com 或加入 QQ 群 757944721。'
              : 'To register, contact: hustphysicscheng@gmail.com or join QQ group 757944721.'}
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
                <input
                  type="text"
                  value={authInvitation}
                  onChange={(e) => setAuthInvitation(e.target.value)}
                  className="w-full bg-black border border-[#1aff1a]/50 p-3 text-[#1aff1a] text-sm focus:outline-none"
                  placeholder={isZh ? '邀请码' : 'Invitation code'}
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
        <div className="max-w-3xl w-full space-y-6 md:space-y-8 pip-boy-border p-6 md:p-12 bg-black/60 shadow-2xl relative">
          <div className="absolute top-4 right-4 flex space-x-2">
            <button onClick={() => toggleLanguage('en')} className={`px-2 py-1 text-xs border ${gameState.language === 'en' ? 'bg-[#1aff1a] text-black' : 'border-[#1aff1a]'}`}>EN</button>
            <button onClick={() => toggleLanguage('zh')} className={`px-2 py-1 text-xs border ${gameState.language === 'zh' ? 'bg-[#1aff1a] text-black' : 'border-[#1aff1a]'}`}>中文</button>
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
              className="w-full text-xl md:text-2xl border-2 border-[#1aff1a] py-4 hover:bg-[#1aff1a] hover:text-black transition-all font-bold uppercase"
             >
              {gameState.language === 'en' ? 'Initialize New Simulation' : '初始化新模拟'}
             </button>
             {hasSave && (
               <button 
                onClick={loadGame}
                className="w-full text-xl md:text-2xl border-2 border-[#1aff1a]/50 py-4 hover:bg-[#1aff1a]/50 hover:text-black transition-all font-bold uppercase bg-[#1aff1a]/10"
               >
                {gameState.language === 'en' ? 'Continue Last Save' : '继续上次存档'}
               </button>
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
          <div className="fixed top-0 left-0 w-full h-full z-[2000] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
            <div className="max-w-md w-full pip-boy-border p-8 bg-black">
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
               {gameState.location} / {gameState.currentYear}
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
      {isSettingsOpen && (
        <div className="fixed top-0 left-0 w-full h-full z-[3000] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="max-w-xl w-full pip-boy-border p-6 md:p-8 bg-black">
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
                    ? '每 N 次交互生成一张图像，默认 3。'
                    : 'Generate images every N turns of interaction. Default is 3.'}
                </div>
                <div className="mt-3 flex items-center space-x-3">
                  <input
                    type="number"
                    min={minImageTurns}
                    value={gameState.settings.imageEveryTurns}
                    onChange={(e) => updateImageFrequency(e.target.value)}
                    disabled={isGuest}
                    className="w-20 bg-black border border-[#1aff1a]/50 p-2 text-[#1aff1a] text-sm focus:outline-none disabled:opacity-40"
                  />
                  <span className="text-[10px] uppercase opacity-60">
                    {isZh ? '回合' : 'turns'}
                  </span>
                </div>
                {!isAdmin && (
                  <div className="text-[10px] opacity-50 mt-2 uppercase">
                    {isGuest
                      ? (isZh ? '临时用户无法修改。' : 'Temporary users cannot change this.')
                      : (isZh ? '普通用户最小值为 5。' : 'Normal users minimum is 5.')}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {isHelpOpen && (
        <div className="fixed top-0 left-0 w-full h-full z-[3000] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="max-w-2xl w-full pip-boy-border p-6 md:p-8 bg-black">
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
                    ? 'AP 上限随用户等级变化（管理员无限制，普通 60，临时 30）。每次行动消耗 1 点，AP 为 0 时无法行动。'
                    : 'AP cap depends on tier (Admin unlimited, Normal 60, Temporary 30). Each action costs 1 AP. You cannot act when AP reaches 0.'}
                </div>
                <div className="opacity-80 mt-2">
                  {isZh
                    ? '普通用户 AP 每 30 分钟恢复 6 点，使用本机时间计算。耗尽时会提示剩余等待分钟数。'
                    : 'Normal users recover +6 AP every 30 minutes using your device clock. When depleted, the terminal shows minutes remaining.'}
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
                    ? '图像频率控制每隔多少回合生成图片，默认 5。'
                    : 'Image frequency controls how often images appear (every N turns). Default is 5.'}
                </div>
              </div>

              <div className="border border-[#1aff1a]/20 p-4 bg-[#1aff1a]/5">
                <div className="text-xs uppercase opacity-60 mb-2">{isZh ? '用户等级' : 'User Tiers'}</div>
                <div className="opacity-80">
                  {isZh
                    ? '临时用户：AP 上限 30、不恢复、无保存、不可改图像频率。'
                    : 'Temporary: AP max 30, no recovery, no saves, cannot change image frequency.'}
                </div>
                <div className="opacity-80 mt-2">
                  {isZh
                    ? '普通用户：AP 上限 60，可恢复；图像频率最小 3；自动保存。'
                    : 'Normal: AP max 60 with recovery; image frequency minimum 3; auto-saving enabled.'}
                </div>
                <div className="opacity-80 mt-2">
                  {isZh
                    ? '管理员：无限制设置与模型，AP 不受限制，保留手动保存。'
                    : 'Admin: unrestricted settings/models with unlimited AP and manual saves.'}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
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
            language={gameState.language}
            ap={gameState.ap}
            maxAp={maxAp}
            isAdmin={isAdmin}
            showApRecovery={isNormal}
            onLanguageToggle={toggleLanguage}
            onSave={saveGame}
            showSave={isAdmin}
            onClose={() => setIsSidebarOpen(false)}
          />
        </div>
      )}
    </div>
  );
};

export default App;
