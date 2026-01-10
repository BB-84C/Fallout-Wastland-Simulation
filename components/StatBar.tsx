
import React from 'react';
import { Actor, Language, Quest } from '../types';

interface StatBarProps {
  player: Actor;
  location: string;
  year: number;
  time: string;
  quests: Quest[];
  language: Language;
  onLanguageToggle: (lang: Language) => void;
  onSave: () => void;
}

const StatBar: React.FC<StatBarProps> = ({ 
  player, 
  location, 
  year, 
  time, 
  quests, 
  language, 
  onLanguageToggle,
  onSave
}) => {
  const dateStr = new Date(time).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  return (
    <div className="w-80 h-full border-l border-[#1aff1a]/30 bg-black/60 p-4 overflow-y-auto space-y-6 flex flex-col">
      <div className="border-b border-[#1aff1a]/30 pb-4 space-y-2">
        <div className="flex justify-between items-center mb-2">
          <button 
            onClick={() => onLanguageToggle(language === 'en' ? 'zh' : 'en')}
            className="text-[10px] border border-[#1aff1a]/50 px-2 py-0.5 hover:bg-[#1aff1a] hover:text-black transition-colors"
          >
            {language === 'en' ? 'ENGLISH / 中文' : '中文 / ENGLISH'}
          </button>
          <button 
            onClick={onSave}
            className="text-[10px] border border-[#1aff1a]/50 px-2 py-0.5 bg-[#1aff1a]/10 hover:bg-[#1aff1a] hover:text-black transition-colors font-bold"
          >
            {language === 'en' ? 'SAVE GAME' : '保存游戏'}
          </button>
        </div>
        
        <h2 className="text-3xl font-bold glow-text uppercase leading-none">{player.name}</h2>
        <div className="text-sm opacity-70">
          <div>{location}</div>
          <div className="text-[#1aff1a]/90 font-bold">{dateStr}</div>
        </div>

        <div className="mt-4">
           <div className="text-[10px] uppercase opacity-50 mb-1">Condition (HP)</div>
           <div className="w-full bg-[#1aff1a]/10 h-2 border border-[#1aff1a]/30">
              <div 
                className="bg-[#1aff1a] h-full shadow-[0_0_10px_#1aff1a]" 
                style={{ width: `${(player.health / player.maxHealth) * 100}%` }}
              ></div>
           </div>
           <div className="text-right text-[10px] mt-1">{player.health} / {player.maxHealth}</div>
        </div>
      </div>

      <section>
        <h3 className="text-lg font-bold border-b border-[#1aff1a]/20 mb-2 uppercase tracking-widest text-[#1aff1a]/80">
          {language === 'en' ? 'S.P.E.C.I.A.L.' : '属性'}
        </h3>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {Object.entries(player.special).map(([key, val]) => (
            <div key={key} className="flex items-center text-xl">
              <span className="opacity-70 mr-1">{key.charAt(0)}:</span>
              <span className="font-bold">{val}</span>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3 className="text-lg font-bold border-b border-[#1aff1a]/20 mb-2 uppercase tracking-widest text-[#1aff1a]/80">
          {language === 'en' ? 'PERKS' : '额外能力'}
        </h3>
        <div className="space-y-3 max-h-64 overflow-y-auto pr-1">
          {player.perks.length === 0 && <div className="text-xs opacity-40">None</div>}
          {player.perks.map((perk, idx) => (
            <div key={idx} className="group relative border border-[#1aff1a]/20 p-2 bg-[#1aff1a]/5 hover:bg-[#1aff1a]/10 transition-colors">
              <div className="text-base font-bold text-[#1aff1a] mb-1">{perk.name}</div>
              <div className="text-xs opacity-80 leading-tight">
                {perk.description}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3 className="text-lg font-bold border-b border-[#1aff1a]/20 mb-2 uppercase tracking-widest text-[#1aff1a]/80">
          {language === 'en' ? 'DATA - QUESTS' : '数据 - 任务'}
        </h3>
        <div className="space-y-3 max-h-48 overflow-y-auto pr-1">
          {quests.length === 0 && <div className="text-sm opacity-40">{language === 'en' ? 'No active quests' : '没有进行中的任务'}</div>}
          {quests.filter(q => q.status === 'active').map(q => (
            <div key={q.id} className="text-sm border-l-2 border-[#1aff1a] pl-2 py-1 bg-[#1aff1a]/5">
              <div className="font-bold text-[#1aff1a] uppercase text-xs">{q.name}</div>
              <div className="opacity-70 text-[11px] leading-tight">Objective: {q.objective}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="flex-1">
        <h3 className="text-lg font-bold border-b border-[#1aff1a]/20 mb-2 uppercase tracking-widest text-[#1aff1a]/80">
          {language === 'en' ? 'INV' : '物品栏'}
        </h3>
        <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
          {player.inventory.map((item, idx) => (
            <div key={idx} className="text-xs p-1 border border-[#1aff1a]/5 flex justify-between">
              <span>{item.name}</span>
              <span className="opacity-40">{item.weight}lbs</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};

export default StatBar;
