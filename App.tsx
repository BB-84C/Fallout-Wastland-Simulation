
import React, { useState, useCallback, useEffect } from 'react';
import { GameState, Actor, Language, Quest, HistoryEntry, GameSettings } from './types';
import { FALLOUT_ERA_STARTS } from './constants';
import Terminal from './components/Terminal';
import StatBar from './components/StatBar';
import { createPlayerCharacter, getNarrativeResponse, generateSceneImage } from './services/geminiService';

const SAVE_KEY = 'fallout_wasteland_save';
const MAX_AP = 100;
const AP_RECOVERY_INTERVAL_MS = 30 * 60 * 1000;
const AP_RECOVERY_AMOUNT = 6;
const DEFAULT_SETTINGS: GameSettings = {
  highQualityImages: true,
  imageEveryTurns: 3
};
const ADMIN_PASSWORD_FALLBACK = '114514';

const syncApState = (ap: number, apLastUpdated: number, now: number) => {
  if (ap >= MAX_AP) return { ap, apLastUpdated };
  const elapsed = Math.max(0, now - apLastUpdated);
  if (elapsed < AP_RECOVERY_INTERVAL_MS) return { ap, apLastUpdated };
  const intervals = Math.floor(elapsed / AP_RECOVERY_INTERVAL_MS);
  const recovered = intervals * AP_RECOVERY_AMOUNT;
  const nextAp = Math.min(MAX_AP, ap + recovered);
  const nextLastUpdated = apLastUpdated + intervals * AP_RECOVERY_INTERVAL_MS;
  return { ap: nextAp, apLastUpdated: nextLastUpdated };
};

const App: React.FC = () => {
  const [view, setView] = useState<'start' | 'creation' | 'playing'>('start');
  const [gameState, setGameState] = useState<GameState>({
    player: null,
    currentYear: 2281,
    location: 'Mojave Wasteland',
    currentTime: new Date(Date.UTC(2281, 9, 23, 10, 0, 0)).toISOString(),
    history: [],
    knownNpcs: [],
    quests: [],
    isThinking: false,
    language: 'en',
    settings: DEFAULT_SETTINGS,
    ap: MAX_AP,
    apLastUpdated: Date.now(),
    turnCount: 0,
  });
  const [userInput, setUserInput] = useState('');
  const [charDescription, setCharDescription] = useState('');
  const [hasSave, setHasSave] = useState(false);
  const [keyAlert, setKeyAlert] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [isAdminOpen, setIsAdminOpen] = useState(false);
  const [adminPassword, setAdminPassword] = useState(ADMIN_PASSWORD_FALLBACK);
  const [adminInput, setAdminInput] = useState('');
  const [adminError, setAdminError] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(SAVE_KEY);
    if (saved) setHasSave(true);
  }, []);

  useEffect(() => {
    let active = true;
    fetch('/admin.json')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('Missing admin.json'))))
      .then((data) => {
        if (active && data?.password) {
          setAdminPassword(String(data.password));
        }
      })
      .catch(() => {
        if (active) setAdminPassword(ADMIN_PASSWORD_FALLBACK);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (view !== 'playing' || isAdmin) return;
    const interval = setInterval(() => {
      setGameState((prev) => {
        const now = Date.now();
        const synced = syncApState(prev.ap, prev.apLastUpdated, now);
        if (synced.ap === prev.ap && synced.apLastUpdated === prev.apLastUpdated) {
          return prev;
        }
        return { ...prev, ap: synced.ap, apLastUpdated: synced.apLastUpdated };
      });
    }, 30000);
    return () => clearInterval(interval);
  }, [view, isAdmin]);

  const saveGame = useCallback(() => {
    try {
      const data = JSON.stringify(gameState);
      localStorage.setItem(SAVE_KEY, data);
      setHasSave(true);
      alert(gameState.language === 'en' ? "Game Saved Successfully!" : "游戏保存成功！");
    } catch (e) {
      console.error("Save failed", e);
      alert(gameState.language === 'en' 
        ? "Save failed! Local storage may be full." 
        : "保存失败！本地存储可能已满。");
    }
  }, [gameState]);

  const loadGame = useCallback(() => {
    const saved = localStorage.getItem(SAVE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      const now = Date.now();
      const settings = { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) };
      setGameState(prev => ({
        ...prev,
        ...parsed,
        settings,
        ap: typeof parsed.ap === 'number' ? parsed.ap : MAX_AP,
        apLastUpdated: typeof parsed.apLastUpdated === 'number' ? parsed.apLastUpdated : now,
        turnCount: typeof parsed.turnCount === 'number' ? parsed.turnCount : 0,
      }));
      setView('playing');
    }
  }, []);

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
    try {
      const actor = await createPlayerCharacter(
        charDescription, 
        gameState.currentYear, 
        gameState.location, 
        gameState.language
      );
      
      const introMsg = gameState.language === 'en' 
        ? `Simulation Initialized. Locating profile... Success. Welcome, ${actor.name}.`
        : `模拟初始化。正在定位档案... 成功。欢迎，${actor.name}。`;

      const startNarration = `${introMsg} ${actor.lore}`;
      const imgData = await generateSceneImage(
        `The ${gameState.location} landscape during the year ${gameState.currentYear}, Fallout universe aesthetic`,
        { highQuality: gameState.settings.highQualityImages }
      );
      
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
    } catch (err) {
      console.error("Vault-Tec Database Error:", err);
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

    if (!isAdmin) {
      const synced = syncApState(currentAp, currentApLastUpdated, now);
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
    }

    const actionText = userInput;
    setUserInput('');

    const updatedHistory: HistoryEntry[] = [...gameState.history, { sender: 'player', text: actionText }];
    const imageEveryTurns = Math.max(1, Math.floor(gameState.settings.imageEveryTurns || 1));
    const nextTurn = gameState.turnCount + 1;
    const shouldGenerateImage = nextTurn % imageEveryTurns === 0;
    const nextAp = isAdmin ? currentAp : Math.max(0, currentAp - 1);
    const nextApLastUpdated = isAdmin
      ? currentApLastUpdated
      : (currentAp >= MAX_AP ? now : currentApLastUpdated);

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
        gameState.language
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
        ? await generateSceneImage(visualPrompt, { highQuality: gameState.settings.highQualityImages })
        : undefined;

      setGameState(prev => ({
        ...prev,
        isThinking: false,
        currentTime: newTime.toISOString(),
        quests: mergedQuests,
        knownNpcs: response.newNpc ? [...prev.knownNpcs, response.newNpc] : prev.knownNpcs,
        player: response.updatedPlayer || prev.player, 
        history: [...updatedHistory, { 
          sender: 'narrator', 
          text: response.storyText, 
          imageUrl: imgData?.url,
          groundingSources: imgData?.sources
        }]
      }));
    } catch (err) {
      console.error(err);
      setGameState(prev => ({ 
        ...prev, 
        isThinking: false,
        history: [...updatedHistory, { 
          sender: 'narrator', 
          text: gameState.language === 'en' 
            ? `VAULT-TEC ERROR: Narrative link unstable.` 
            : `避难所科技错误：叙事链路不稳定。` 
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
    const clamped = Math.max(1, Math.floor(parsed));
    setGameState(prev => ({
      ...prev,
      settings: {
        ...prev.settings,
        imageEveryTurns: clamped
      }
    }));
  };

  const handleAdminLogin = () => {
    if (adminInput.trim() === adminPassword) {
      setIsAdmin(true);
      setAdminError('');
      setAdminInput('');
      setIsAdminOpen(false);
      return;
    }
    setAdminError(gameState.language === 'en' ? 'Invalid password.' : '密码错误。');
  };

  const handleAdminLogout = () => {
    setIsAdmin(false);
    setIsAdminOpen(false);
  };

  const isZh = gameState.language === 'zh';

  if (view === 'start') {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-4 md:p-8 text-center">
        <div className="max-w-3xl w-full space-y-6 md:space-y-8 pip-boy-border p-6 md:p-12 bg-black/60 shadow-2xl relative">
          <div className="absolute top-4 right-4 flex space-x-2">
            <button onClick={() => toggleLanguage('en')} className={`px-2 py-1 text-xs border ${gameState.language === 'en' ? 'bg-[#1aff1a] text-black' : 'border-[#1aff1a]'}`}>EN</button>
            <button onClick={() => toggleLanguage('zh')} className={`px-2 py-1 text-xs border ${gameState.language === 'zh' ? 'bg-[#1aff1a] text-black' : 'border-[#1aff1a]'}`}>中文</button>
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
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col md:flex-row h-screen w-screen overflow-hidden relative">
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
                    min={1}
                    value={gameState.settings.imageEveryTurns}
                    onChange={(e) => updateImageFrequency(e.target.value)}
                    className="w-20 bg-black border border-[#1aff1a]/50 p-2 text-[#1aff1a] text-sm focus:outline-none"
                  />
                  <span className="text-[10px] uppercase opacity-60">
                    {isZh ? '回合' : 'turns'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {isAdminOpen && (
        <div className="fixed top-0 left-0 w-full h-full z-[3000] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="max-w-sm w-full pip-boy-border p-6 bg-black">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-2xl font-bold uppercase">{isZh ? '管理员' : 'Admin'}</h3>
              <button 
                onClick={() => setIsAdminOpen(false)}
                className="text-xs border border-[#1aff1a]/50 px-2 py-1 hover:bg-[#1aff1a] hover:text-black transition-colors font-bold uppercase"
              >
                {isZh ? '关闭' : 'Close'}
              </button>
            </div>
            {isAdmin ? (
              <div className="space-y-4">
                <div className="text-sm opacity-70">
                  {isZh ? '管理员模式已启用，行动点不受限制。' : 'Admin mode enabled. Action Points are unlimited.'}
                </div>
                <button
                  onClick={handleAdminLogout}
                  className="w-full border-2 border-[#1aff1a] py-2 hover:bg-[#1aff1a] hover:text-black transition-all font-bold uppercase"
                >
                  {isZh ? '退出管理员' : 'Log Out'}
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="text-sm opacity-70">
                  {isZh ? '请输入管理员密码以解除行动点限制。' : 'Enter the admin password to unlock unlimited Action Points.'}
                </div>
                <input
                  type="password"
                  value={adminInput}
                  onChange={(e) => setAdminInput(e.target.value)}
                  className="w-full bg-black border border-[#1aff1a]/50 p-3 text-[#1aff1a] text-sm focus:outline-none"
                  placeholder={isZh ? '密码' : 'Password'}
                />
                {adminError && <div className="text-xs text-red-500">{adminError}</div>}
                <button
                  onClick={handleAdminLogin}
                  className="w-full border-2 border-[#1aff1a] py-2 hover:bg-[#1aff1a] hover:text-black transition-all font-bold uppercase"
                >
                  {isZh ? '登录' : 'Log In'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {isHelpOpen && (
        <div className="fixed top-0 left-0 w-full h-full z-[3000] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="max-w-2xl w-full pip-boy-border p-6 md:p-8 bg-black">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-2xl font-bold uppercase">HLEP</h3>
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
                    ? '初始 100 AP，每次行动消耗 1 点。AP 为 0 时无法行动。'
                    : 'Start with 100 AP. Each action costs 1 AP. You cannot act when AP reaches 0.'}
                </div>
                <div className="opacity-80 mt-2">
                  {isZh
                    ? 'AP 每 30 分钟恢复 6 点，使用本机时间计算。耗尽时会提示剩余等待分钟数。'
                    : 'AP recovers +6 every 30 minutes using your device clock. When depleted, the terminal shows minutes remaining.'}
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
                    ? '图像频率控制每隔多少回合生成图片，默认 3。'
                    : 'Image frequency controls how often images appear (every N turns). Default is 3.'}
                </div>
              </div>

              <div className="border border-[#1aff1a]/20 p-4 bg-[#1aff1a]/5">
                <div className="text-xs uppercase opacity-60 mb-2">{isZh ? '管理员模式' : 'Admin Mode'}</div>
                <div className="opacity-80">
                  {isZh
                    ? '使用 ADMIN 按钮登录后可解除 AP 限制。'
                    : 'Use the ADMIN button to log in and remove AP limits.'}
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
            <button 
              onClick={() => {
                setAdminError('');
                setAdminInput('');
                setIsAdminOpen(true);
              }}
              className={`text-[10px] border px-2 py-0.5 transition-colors font-bold uppercase ${
                isAdmin ? 'bg-[#1aff1a] text-black border-[#1aff1a]' : 'border-[#1aff1a]/50 hover:bg-[#1aff1a] hover:text-black'
              }`}
            >
              {isAdmin ? (isZh ? '管理员 ON' : 'ADMIN ON') : (isZh ? '管理员' : 'ADMIN')}
            </button>
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
              HLEP
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
            maxAp={MAX_AP}
            isAdmin={isAdmin}
            onLanguageToggle={toggleLanguage}
            onSave={saveGame}
            onClose={() => setIsSidebarOpen(false)}
          />
        </div>
      )}
    </div>
  );
};

export default App;
