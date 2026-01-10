
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { GameState, Actor, Language, Quest, HistoryEntry, GameSettings } from './types';
import { FALLOUT_ERA_STARTS } from './constants';
import Terminal from './components/Terminal';
import StatBar from './components/StatBar';
import { createPlayerCharacter, getNarrativeResponse, generateSceneImage } from './services/geminiService';

const SAVE_KEY = 'fallout_wasteland_save';
const AP_LIMIT = 100;
const RECOVERY_RATE = 6; // AP per 30 mins
const MS_PER_30_MINS = 30 * 60 * 1000;
const MS_PER_AP = MS_PER_30_MINS / RECOVERY_RATE;

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
    ap: 100,
    lastApUpdateTime: new Date().toISOString(),
    isAdmin: false,
    settings: {
      highQualityImage: true,
      imageFrequency: 3
    }
  });

  const [userInput, setUserInput] = useState('');
  const [charDescription, setCharDescription] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showAdminLogin, setShowAdminLogin] = useState(false);
  const [adminPassword, setAdminPassword] = useState('');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [turnCount, setTurnCount] = useState(0);
  const [hasSave, setHasSave] = useState(false);

  // Sync AP based on real world time
  useEffect(() => {
    const timer = setInterval(() => {
      setGameState(prev => {
        if (prev.isAdmin || prev.ap >= AP_LIMIT) return prev;
        const now = Date.now();
        const last = new Date(prev.lastApUpdateTime).getTime();
        const elapsed = now - last;
        const recovered = Math.floor(elapsed / MS_PER_AP);
        if (recovered > 0) {
          return {
            ...prev,
            ap: Math.min(AP_LIMIT, prev.ap + recovered),
            lastApUpdateTime: new Date(last + (recovered * MS_PER_AP)).toISOString()
          };
        }
        return prev;
      });
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem(SAVE_KEY);
    if (saved) {
      setHasSave(true);
    }
  }, []);

  const loadGame = useCallback(() => {
    const saved = localStorage.getItem(SAVE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setGameState(parsed);
        setView('playing');
      } catch (e) {
        console.error("Failed to load save", e);
      }
    }
  }, []);

  const saveGame = useCallback(() => {
    localStorage.setItem(SAVE_KEY, JSON.stringify(gameState));
    setHasSave(true);
    alert(gameState.language === 'en' ? "Simulation state saved." : "模拟状态已保存。");
  }, [gameState]);

  const handleAdminLogin = async () => {
    try {
      const res = await fetch('admin_config.json');
      const config = await res.json();
      if (adminPassword === config.adminPassword) {
        setGameState(prev => ({ ...prev, isAdmin: true, ap: 100 }));
        setShowAdminLogin(false);
        setAdminPassword('');
        alert("ADMIN ACCESS GRANTED");
      } else {
        alert("INVALID CREDENTIALS");
      }
    } catch (e) {
      console.error("Admin check failed", e);
    }
  };

  const pickEra = useCallback(() => {
    const era = FALLOUT_ERA_STARTS[Math.floor(Math.random() * FALLOUT_ERA_STARTS.length)];
    const date = new Date(Date.UTC(era.year, 6, 15, 10, 0, 0));
    setGameState(prev => ({ 
      ...prev, 
      currentYear: era.year, 
      location: era.region,
      currentTime: date.toISOString()
    }));
    setView('creation');
  }, []);

  const handleAction = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!userInput.trim() || gameState.isThinking || !gameState.player) return;

    // Check AP
    if (!gameState.isAdmin && gameState.ap <= 0) {
      const now = Date.now();
      const last = new Date(gameState.lastApUpdateTime).getTime();
      const nextApTime = last + MS_PER_AP;
      const waitMins = Math.ceil((nextApTime - now) / 60000);
      
      setGameState(prev => ({
        ...prev,
        history: [...prev.history, { 
          sender: 'narrator', 
          text: prev.language === 'en' 
            ? `SYSTEM ERROR: Insufficient Action Points. Critical exhaustion detected. Regeneration required. Return in ${waitMins} minute(s).`
            : `系统错误：行动力（AP）不足。检测到严重疲劳。需要恢复。请在 ${waitMins} 分钟后返回。`
        }]
      }));
      return;
    }

    const currentTurn = turnCount + 1;
    setTurnCount(currentTurn);
    const actionText = userInput;
    setUserInput('');
    const updatedHistory: HistoryEntry[] = [...gameState.history, { sender: 'player', text: actionText }];

    setGameState(prev => ({
      ...prev,
      isThinking: true,
      history: updatedHistory,
      ap: prev.isAdmin ? prev.ap : Math.max(0, prev.ap - 1)
    }));

    try {
      const response = await getNarrativeResponse(gameState.player, updatedHistory, actionText, gameState.currentYear, gameState.location, gameState.quests, gameState.language);
      
      let imgData = undefined;
      // Frequency check
      if (currentTurn % gameState.settings.imageFrequency === 0) {
        imgData = await generateSceneImage(response.imagePrompt || actionText, gameState.settings.highQualityImage);
      }

      setGameState(prev => ({
        ...prev,
        isThinking: false,
        currentTime: new Date(new Date(prev.currentTime).getTime() + (response.timePassedMinutes * 60000)).toISOString(),
        quests: response.questUpdates || prev.quests,
        player: response.updatedPlayer || prev.player,
        history: [...updatedHistory, { 
          sender: 'narrator', 
          text: response.storyText, 
          imageUrl: imgData?.url, 
          groundingSources: imgData?.sources 
        }]
      }));
    } catch (err) {
      setGameState(prev => ({ ...prev, isThinking: false }));
    }
  };

  const toggleLanguage = (lang: Language) => {
    setGameState(prev => ({ ...prev, language: lang }));
  };

  if (view === 'start') {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen text-center p-8 bg-[#0c0c0c]">
        <div className="max-w-3xl w-full pip-boy-border p-12 bg-black/80 space-y-8 relative">
           <div className="flex space-x-2 absolute top-4 right-4 z-50">
              <button onClick={() => toggleLanguage('en')} className={`px-2 py-1 text-xs border ${gameState.language === 'en' ? 'bg-[#1aff1a] text-black' : 'border-[#1aff1a]'}`}>EN</button>
              <button onClick={() => toggleLanguage('zh')} className={`px-2 py-1 text-xs border ${gameState.language === 'zh' ? 'bg-[#1aff1a] text-black' : 'border-[#1aff1a]'}`}>中文</button>
              <button onClick={() => setShowHelp(true)} className="border border-[#1aff1a] px-3 py-1 font-bold text-xs">HELP</button>
              <button onClick={() => setShowSettings(true)} className="border border-[#1aff1a] px-3 py-1 font-bold text-xs">SETTINGS</button>
           </div>
           <h1 className="text-7xl font-bold glow-text tracking-tighter">FALLOUT</h1>
           <h2 className="text-2xl tracking-widest opacity-80 uppercase">
             {gameState.language === 'en' ? 'Wasteland Chronicles' : '废土编年史'}
           </h2>
           <div className="space-y-4 pt-8">
            <button 
              onClick={pickEra} 
              className="w-full text-2xl border-2 border-[#1aff1a] py-4 hover:bg-[#1aff1a] hover:text-black font-bold uppercase transition-all"
            >
              {gameState.language === 'en' ? 'Initialize Simulation' : '初始化模拟'}
            </button>
            {hasSave && (
              <button 
                onClick={loadGame}
                className="w-full text-2xl border-2 border-[#1aff1a]/50 py-4 hover:bg-[#1aff1a]/50 hover:text-black transition-all font-bold uppercase bg-[#1aff1a]/10"
              >
                {gameState.language === 'en' ? 'Continue Last Save' : '继续上次存档'}
              </button>
            )}
           </div>
        </div>
        <RenderModals 
          showSettings={showSettings} setShowSettings={setShowSettings}
          showHelp={showHelp} setShowHelp={setShowHelp}
          showAdminLogin={showAdminLogin} setShowAdminLogin={setShowAdminLogin}
          adminPassword={adminPassword} setAdminPassword={setAdminPassword} handleAdminLogin={handleAdminLogin}
          gameState={gameState} setGameState={setGameState}
        />
      </div>
    );
  }

  if (view === 'creation') {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-8 bg-[#0c0c0c]">
        <div className="max-w-4xl w-full pip-boy-border p-8 bg-black/80">
          <h2 className="text-4xl font-bold mb-4 glow-text uppercase">
            {gameState.language === 'en' ? 'IDENTITY RECONSTRUCTION' : '身份重建'}
          </h2>
          <textarea 
            value={charDescription} 
            onChange={e => setCharDescription(e.target.value)} 
            className="w-full h-40 bg-black border border-[#1aff1a] p-4 text-[#1aff1a] focus:outline-none text-xl" 
            placeholder={gameState.language === 'en' ? "Describe your origin..." : "描述你的出身..."} 
          />
          <button 
            onClick={async () => {
              setGameState(p => ({ ...p, isThinking: true }));
              try {
                const actor = await createPlayerCharacter(charDescription, gameState.currentYear, gameState.location, gameState.language);
                setGameState(p => ({ ...p, player: actor, isThinking: false, history: [{ sender: 'narrator', text: actor.lore }] }));
                setView('playing');
              } catch(e) {
                setGameState(p => ({ ...p, isThinking: false }));
                alert("Vault-Tec error: Character construction failed.");
              }
            }} 
            className="mt-6 w-full text-2xl border-2 border-[#1aff1a] py-4 font-bold uppercase hover:bg-[#1aff1a] hover:text-black"
          >
            {gameState.language === 'en' ? 'CONSTRUCT PROFILE' : '生成档案'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col md:flex-row h-screen w-screen overflow-hidden bg-[#0c0c0c]">
      <div className="flex-1 flex flex-col min-w-0">
        <header className="p-4 border-b border-[#1aff1a]/30 bg-black/60 flex justify-between items-center">
          <h1 className="text-2xl font-bold tracking-widest uppercase">PIP-BOY 3000</h1>
          <div className="flex space-x-2">
            <button onClick={() => setShowHelp(true)} className="border border-[#1aff1a] px-3 py-1 font-bold text-xs">HELP</button>
            <button onClick={() => setShowSettings(true)} className="border border-[#1aff1a] px-3 py-1 font-bold text-xs">SETTINGS</button>
            <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="md:hidden border border-[#1aff1a] px-3 py-1 font-bold text-xs">STAT</button>
          </div>
        </header>
        <Terminal history={gameState.history} isThinking={gameState.isThinking} />
        <form onSubmit={handleAction} className="p-4 bg-black/80 border-t border-[#1aff1a]/30 flex space-x-4">
          <input type="text" value={userInput} onChange={e => setUserInput(e.target.value)} placeholder={gameState.language === 'en' ? "Action..." : "行动..."} className="flex-1 bg-black border border-[#1aff1a]/50 p-4 text-[#1aff1a] text-xl focus:outline-none" disabled={gameState.isThinking} />
          <button type="submit" disabled={gameState.isThinking || !userInput.trim()} className="px-8 border-2 border-[#1aff1a] hover:bg-[#1aff1a] hover:text-black font-bold uppercase">EXE</button>
        </form>
      </div>
      {gameState.player && (
        <div className={`${isSidebarOpen ? 'fixed inset-0 z-50 block' : 'hidden md:block'} md:w-80 h-full`}>
          <StatBar 
            player={gameState.player} ap={gameState.ap} isAdmin={gameState.isAdmin}
            location={gameState.location} year={gameState.currentYear} time={gameState.currentTime}
            quests={gameState.quests} language={gameState.language}
            onLanguageToggle={toggleLanguage}
            onSave={saveGame} onClose={() => setIsSidebarOpen(false)}
          />
        </div>
      )}
      <RenderModals 
          showSettings={showSettings} setShowSettings={setShowSettings}
          showHelp={showHelp} setShowHelp={setShowHelp}
          showAdminLogin={showAdminLogin} setShowAdminLogin={setShowAdminLogin}
          adminPassword={adminPassword} setAdminPassword={setAdminPassword} handleAdminLogin={handleAdminLogin}
          gameState={gameState} setGameState={setGameState}
        />
    </div>
  );
};

const RenderModals: React.FC<any> = ({ 
  showSettings, setShowSettings, showHelp, setShowHelp, showAdminLogin, setShowAdminLogin,
  adminPassword, setAdminPassword, handleAdminLogin, gameState, setGameState
}) => {
  if (showSettings) return (
    <div className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center p-4 overflow-y-auto">
      <div className="max-w-lg w-full pip-boy-border bg-black p-8 space-y-6">
        <h3 className="text-3xl font-bold border-b border-[#1aff1a] pb-2">SYSTEM CONFIGURATION</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-lg">Lore-Accurate Images</span>
            <button 
              onClick={() => setGameState((p: GameState) => ({ ...p, settings: { ...p.settings, highQualityImage: !p.settings.highQualityImage }}))}
              className={`px-4 py-1 border border-[#1aff1a] ${gameState.settings.highQualityImage ? 'bg-[#1aff1a] text-black' : ''}`}
            >
              {gameState.settings.highQualityImage ? 'ON' : 'OFF'}
            </button>
          </div>
          <p className="text-xs opacity-50 italic">Turning this on enables multi-stage research via Gemini 3 Pro. Improved immersion, but significantly increases wait time.</p>
          <div className="flex items-center justify-between">
            <span className="text-lg">Image Frequency</span>
            <input 
              type="number" min="1" max="10" 
              value={gameState.settings.imageFrequency} 
              onChange={e => setGameState((p: GameState) => ({ ...p, settings: { ...p.settings, imageFrequency: parseInt(e.target.value) || 1 }}))}
              className="bg-black border border-[#1aff1a] text-center w-16"
            />
          </div>
          <p className="text-xs opacity-50 italic">Generates visual output every X player actions. Default: 3.</p>
        </div>
        <div className="pt-6 flex flex-col space-y-2">
          {!gameState.isAdmin && (
            <button onClick={() => {setShowSettings(false); setShowAdminLogin(true);}} className="text-xs border border-[#1aff1a]/30 py-2 hover:bg-[#1aff1a]/10">ADMIN LOGIN</button>
          )}
          <button onClick={() => setShowSettings(false)} className="w-full border-2 border-[#1aff1a] py-3 font-bold hover:bg-[#1aff1a] hover:text-black">CLOSE</button>
        </div>
      </div>
    </div>
  );

  if (showHelp) return (
    <div className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center p-4 overflow-y-auto">
      <div className="max-w-lg w-full pip-boy-border bg-black p-8 space-y-4">
        <h3 className="text-3xl font-bold border-b border-[#1aff1a] pb-2">V.T.I. MANUAL</h3>
        <div className="space-y-4 text-sm opacity-80 h-96 overflow-y-auto pr-2 no-scrollbar">
          <section>
            <h4 className="font-bold text-[#1aff1a]">ACTION POINTS (AP)</h4>
            <p>Your ability to interact with the wasteland is governed by AP. Every command costs 1 AP. Capacity is 100.</p>
          </section>
          <section>
            <h4 className="font-bold text-[#1aff1a]">RECOVERY</h4>
            <p>AP recovers at 6 points every 30 real-world minutes (1 point every 5 mins). If exhausted, you must wait for background regeneration.</p>
          </section>
          <section>
            <h4 className="font-bold text-[#1aff1a]">IMAGES & LORE</h4>
            <p>Settings allow for multi-stage 'Grounded Research' which uses Google Search to find lore-accurate visual details before generating concept art.</p>
          </section>
          <section>
            <h4 className="font-bold text-[#1aff1a]">ADMIN MODE</h4>
            <p>Authorized personnel bypass AP limitations. Misuse of admin credentials is a violation of Vault-Tec policy.</p>
          </section>
        </div>
        <button onClick={() => setShowHelp(false)} className="w-full border-2 border-[#1aff1a] py-3 font-bold hover:bg-[#1aff1a] hover:text-black">DISMISS</button>
      </div>
    </div>
  );

  if (showAdminLogin) return (
    <div className="fixed inset-0 z-[101] bg-black/95 flex items-center justify-center p-4">
      <div className="max-w-xs w-full pip-boy-border bg-black p-8 space-y-4">
        <h3 className="text-xl font-bold text-center">OVERRIDE LOGIN</h3>
        <input 
          type="password" placeholder="PIN" 
          value={adminPassword} onChange={e => setAdminPassword(e.target.value)}
          className="w-full bg-black border border-[#1aff1a] p-2 text-center text-xl focus:outline-none"
        />
        <button onClick={handleAdminLogin} className="w-full bg-[#1aff1a] text-black font-bold py-2">AUTHENTICATE</button>
        <button onClick={() => setShowAdminLogin(false)} className="w-full text-xs opacity-50 py-1">CANCEL</button>
      </div>
    </div>
  );

  return null;
};

export default App;
