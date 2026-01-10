
import React, { useState } from 'react';
import { Actor, Language, Quest, Skill } from '../types';

interface StatBarProps {
  player: Actor;
  ap: number;
  isAdmin: boolean;
  location: string;
  year: number;
  time: string;
  quests: Quest[];
  language: Language;
  onLanguageToggle: (lang: Language) => void;
  onSave: () => void;
  onClose: () => void;
}

type Tab = 'STAT' | 'SPEC' | 'SKIL' | 'PERK' | 'DATA' | 'INV';

const skillLocalizations: Record<Language, Record<string, string>> = {
  en: {
    'Small Guns': 'Small Guns', 'Big Guns': 'Big Guns', 'Energy Weapons': 'Energy Weapons', 'Unarmed': 'Unarmed', 'Melee Weapons': 'Melee Weapons', 'Medicine': 'Medicine', 'Repair': 'Repair', 'Science': 'Science', 'Sneak': 'Sneak', 'Lockpick': 'Lockpick', 'Steal': 'Steal', 'Speech': 'Speech', 'Barter': 'Barter', 'Survival': 'Survival'
  },
  zh: {
    'Small Guns': '轻型枪械', 'Big Guns': '重型枪械', 'Energy Weapons': '能量武器', 'Unarmed': '徒手', 'Melee Weapons': '近战武器', 'Medicine': '医药', 'Repair': '修理', 'Science': '科学', 'Sneak': '潜行', 'Lockpick': '开锁', 'Steal': '盗窃', 'Speech': '口才', 'Barter': '交易', 'Survival': '生存'
  }
};

const StatBar: React.FC<StatBarProps> = ({ 
  player, ap, isAdmin, location, year, time, quests, language, onLanguageToggle, onSave, onClose
}) => {
  const [activeTab, setActiveTab] = useState<Tab>('STAT');
  const dateStr = new Date(time).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });

  const renderTabContent = () => {
    switch (activeTab) {
      case 'STAT':
        return (
          <div className="space-y-6">
            <div className="space-y-4">
              <div>
                <div className="flex justify-between text-[10px] uppercase mb-1">
                  <span>HP</span> <span>{player.health} / {player.maxHealth}</span>
                </div>
                <div className="w-full bg-[#1aff1a]/10 h-3 border border-[#1aff1a]/30">
                  <div className="bg-[#1aff1a] h-full" style={{ width: `${(player.health / player.maxHealth) * 100}%` }}></div>
                </div>
              </div>
              <div>
                <div className="flex justify-between text-[10px] uppercase mb-1">
                  <span>AP</span> <span>{isAdmin ? '∞' : ap} / 100</span>
                </div>
                <div className="w-full bg-[#1aff1a]/10 h-3 border border-[#1aff1a]/30">
                  <div className="bg-[#1aff1a] h-full shadow-[0_0_8px_#1aff1a]" style={{ width: `${isAdmin ? 100 : ap}%` }}></div>
                </div>
              </div>
              <div className="border border-[#1aff1a]/30 p-3 bg-[#1aff1a]/5 flex justify-between">
                <span className="text-xs uppercase font-bold opacity-70">Caps</span>
                <span className="text-xl font-bold text-[#1aff1a]">{player.caps} ₵</span>
              </div>
            </div>
            <div className="text-xs space-y-1 opacity-80 pt-4 border-t border-[#1aff1a]/10">
              <div className="flex justify-between"><span>LOC:</span> <span className="text-right truncate ml-2">{location}</span></div>
              <div className="flex justify-between"><span>DATE:</span> <span className="text-right">{dateStr}</span></div>
            </div>
          </div>
        );
      case 'SPEC':
        return <div className="space-y-2">{Object.entries(player.special).map(([k, v]) => <div key={k} className="flex justify-between border-b border-[#1aff1a]/10 py-2"><span>{k.toUpperCase()}</span><span>{v}</span></div>)}</div>;
      case 'SKIL':
        return <div className="space-y-1">{Object.entries(player.skills).map(([k, v]) => <div key={k} className="flex justify-between border-b border-[#1aff1a]/5 py-1.5 px-1"><span>{skillLocalizations[language][k] || k}</span><span>{v}</span></div>)}</div>;
      case 'PERK':
        return <div className="space-y-3">{player.perks.map((p, i) => <div key={i} className="border border-[#1aff1a]/20 p-2 bg-[#1aff1a]/5"><div className="text-sm font-bold text-[#1aff1a] mb-1">{p.name}</div><div className="text-[11px] opacity-70">{p.description}</div></div>)}</div>;
      case 'DATA':
        return <div className="space-y-4">{quests.filter(q => q.status === 'active').map(q => <div key={q.id} className="text-sm border-l-2 border-[#1aff1a] pl-2 py-2 bg-[#1aff1a]/5 font-bold">{q.name}</div>)}</div>;
      case 'INV':
        return <div className="space-y-1">{player.inventory.map((item, idx) => <div key={idx} className="text-xs p-1.5 border-b border-[#1aff1a]/5 flex justify-between"><span>{item.name}</span><span>{item.weight} lb</span></div>)}</div>;
      default: return null;
    }
  };

  return (
    <div className="w-full md:w-80 h-full border-l border-[#1aff1a]/30 bg-black/90 p-0 flex flex-col no-scrollbar">
      <div className="p-3 border-b border-[#1aff1a]/30 space-y-3">
        <div className="flex justify-between">
          <button onClick={onClose} className="md:hidden text-[10px] border border-[#1aff1a]/50 px-2 py-0.5">RETURN</button>
          <div className="flex space-x-2">
            <button onClick={() => onLanguageToggle(language === 'en' ? 'zh' : 'en')} className="text-[10px] border border-[#1aff1a]/50 px-2">LANG</button>
            <button onClick={onSave} className="text-[10px] border border-[#1aff1a]/50 px-2 bg-[#1aff1a]/10 font-bold">SAVE</button>
          </div>
        </div>
        <h2 className="text-xl font-bold glow-text truncate uppercase">{player.name}</h2>
      </div>
      <div className="flex border-b border-[#1aff1a]/30">
        {(['STAT', 'SPEC', 'SKIL', 'PERK', 'DATA', 'INV'] as Tab[]).map(t => (
          <button key={t} onClick={() => setActiveTab(t)} className={`flex-1 py-2 text-[10px] ${activeTab === t ? 'bg-[#1aff1a] text-black' : 'text-[#1aff1a]/60 hover:bg-[#1aff1a]/10'}`}>{t}</button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-4 no-scrollbar">{renderTabContent()}</div>
    </div>
  );
};

export default StatBar;
