
import React, { useState } from 'react';
import { Actor, Language, Quest, SpecialAttr, Skill, TokenUsage } from '../types';
import { localizeLocation } from '../localization';
import type { ApRecoveryConfig } from '../tierSettings';

interface StatBarProps {
  player: Actor;
  location: string;
  year: number;
  time: string;
  quests: Quest[];
  knownNpcs: Actor[];
  language: Language;
  ap: number;
  maxAp: number;
  apUnlimited: boolean;
  showApRecovery: boolean;
  apRecovery?: ApRecoveryConfig | null;
  tokenUsage: TokenUsage;
  onLanguageToggle: (lang: Language) => void;
  onSave: () => void;
  onExport: (format: 'log-md' | 'log-pdf' | 'save-json') => void;
  showSave: boolean;
  onRefreshInventory: () => void;
  inventoryRefreshing: boolean;
  onRebuildStatus: () => void;
  statusRebuilding: boolean;
  canRebuildStatus: boolean;
  onClose: () => void;
  panelScale?: number;
}

type Tab = 'STAT' | 'SPEC' | 'SKIL' | 'PERK' | 'COMP' | 'DATA' | 'INV';

const skillLocalizations: Record<Language, Record<Skill, string>> = {
  en: {
    [Skill.SmallGuns]: 'Small Guns',
    [Skill.BigGuns]: 'Big Guns',
    [Skill.EnergyWeapons]: 'Energy Weapons',
    [Skill.Unarmed]: 'Unarmed',
    [Skill.MeleeWeapons]: 'Melee Weapons',
    [Skill.Medicine]: 'Medicine',
    [Skill.Repair]: 'Repair',
    [Skill.Science]: 'Science',
    [Skill.Sneak]: 'Sneak',
    [Skill.Lockpick]: 'Lockpick',
    [Skill.Steal]: 'Steal',
    [Skill.Speech]: 'Speech',
    [Skill.Barter]: 'Barter',
    [Skill.Survival]: 'Survival',
  },
  zh: {
    [Skill.SmallGuns]: '轻型枪械',
    [Skill.BigGuns]: '重型枪械',
    [Skill.EnergyWeapons]: '能量武器',
    [Skill.Unarmed]: '徒手',
    [Skill.MeleeWeapons]: '近战武器',
    [Skill.Medicine]: '医药',
    [Skill.Repair]: '修理',
    [Skill.Science]: '科学',
    [Skill.Sneak]: '潜行',
    [Skill.Lockpick]: '开锁',
    [Skill.Steal]: '盗窃',
    [Skill.Speech]: '口才',
    [Skill.Barter]: '交易',
    [Skill.Survival]: '生存',
  }
};

const specialLocalizations: Record<Language, Record<SpecialAttr, string>> = {
  en: {
    [SpecialAttr.Strength]: 'Strength',
    [SpecialAttr.Perception]: 'Perception',
    [SpecialAttr.Endurance]: 'Endurance',
    [SpecialAttr.Charisma]: 'Charisma',
    [SpecialAttr.Intelligence]: 'Intelligence',
    [SpecialAttr.Agility]: 'Agility',
    [SpecialAttr.Luck]: 'Luck'
  },
  zh: {
    [SpecialAttr.Strength]: '力量',
    [SpecialAttr.Perception]: '感知',
    [SpecialAttr.Endurance]: '耐力',
    [SpecialAttr.Charisma]: '魅力',
    [SpecialAttr.Intelligence]: '智力',
    [SpecialAttr.Agility]: '敏捷',
    [SpecialAttr.Luck]: '幸运'
  }
};

const StatBar: React.FC<StatBarProps> = ({ 
  player, 
  location, 
  year, 
  time, 
  quests, 
  knownNpcs,
  language, 
  ap,
  maxAp,
  apUnlimited,
  showApRecovery,
  apRecovery,
  tokenUsage,
  onLanguageToggle,
  onSave,
  onExport,
  showSave,
  onRefreshInventory,
  inventoryRefreshing,
  onRebuildStatus,
  statusRebuilding,
  canRebuildStatus,
  onClose,
  panelScale
}) => {
  const [activeTab, setActiveTab] = useState<Tab>('STAT');
  const [expandedCompanion, setExpandedCompanion] = useState<string | null>(null);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const isInventoryTab = activeTab === 'INV';

  const dateStr = new Date(time).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
  const companions = knownNpcs.filter(npc => npc.ifCompanion);
  const displayLocation = localizeLocation(location, language);
  const apRecoveryMinutes = apRecovery ? Math.round(apRecovery.intervalMs / 60000) : 0;
  const apRecoveryLabel = apRecoveryMinutes % 60 === 0
    ? `${apRecoveryMinutes / 60} hr`
    : `${apRecoveryMinutes} min`;

  const renderTabContent = () => {
    switch (activeTab) {
      case 'STAT':
        return (
          <div className="space-y-6 animate-in fade-in duration-300">
            <div>
              <h3 className="text-xs uppercase opacity-50 mb-2 tracking-widest">{language === 'en' ? 'Condition' : '状态'}</h3>
              <div className="space-y-4">
                <div>
                  <div className="flex justify-between text-[0.625rem] uppercase mb-1">
                    <span>HP</span>
                    <span>{player.health} / {player.maxHealth}</span>
                  </div>
                  <div className="w-full bg-[#1aff1a]/10 h-3 border border-[#1aff1a]/30">
                    <div 
                      className="bg-[#1aff1a] h-full shadow-[0_0_10px_#1aff1a] transition-all duration-500" 
                      style={{ width: `${(player.health / player.maxHealth) * 100}%` }}
                    ></div>
                  </div>
                </div>

                <div>
                  <div className="flex justify-between text-[0.625rem] uppercase mb-1">
                    <span>AP</span>
                    <span>{apUnlimited ? '∞' : `${ap} / ${maxAp}`}</span>
                  </div>
                  <div className="w-full bg-[#1aff1a]/10 h-3 border border-[#1aff1a]/30">
                    <div 
                      className="bg-[#1aff1a] h-full shadow-[0_0_10px_#1aff1a] transition-all duration-500" 
                      style={{ width: `${apUnlimited ? 100 : Math.max(0, Math.min(100, (ap / maxAp) * 100))}%` }}
                    ></div>
                  </div>
                  {showApRecovery && apRecovery && (
                    <div className="text-[0.5625rem] opacity-50 mt-1 uppercase tracking-widest">
                      +{apRecovery.amount} / {apRecoveryLabel}
                    </div>
                  )}
                </div>
                
                <div className="border border-[#1aff1a]/30 p-3 bg-[#1aff1a]/5 space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="text-xs uppercase font-bold opacity-70">{language === 'en' ? 'Caps' : '瓶盖'}</span>
                    <span className="text-xl font-bold text-[#1aff1a] glow-text">{player.caps} ₵</span>
                  </div>
                  <div className="flex justify-between items-center pt-2 border-t border-[#1aff1a]/20">
                    <span className="text-xs uppercase font-bold opacity-70">{language === 'en' ? 'Karma' : '因果'}</span>
                    <span className={`text-sm font-bold ${player.karma >= 0 ? 'text-[#1aff1a]' : 'text-red-500'}`}>
                      {player.karma > 50 ? (language === 'en' ? 'Saint' : '圣人') : 
                       player.karma > 20 ? (language === 'en' ? 'Good' : '善良') : 
                       player.karma > -20 ? (language === 'en' ? 'Neutral' : '中立') : 
                       player.karma > -50 ? (language === 'en' ? 'Evil' : '邪恶') : (language === 'en' ? 'Devil' : '恶魔')}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div className="text-xs space-y-1 opacity-80 pt-4 border-t border-[#1aff1a]/10">
              <div className="flex justify-between"><span>LOC:</span> <span className="text-right">{displayLocation}</span></div>
              <div className="flex justify-between"><span>DATE:</span> <span className="text-right">{dateStr}</span></div>
              <div className="flex justify-between"><span>FACT:</span> <span className="text-right">{player.faction}</span></div>
            </div>
          </div>
        );

      case 'SPEC':
        return (
          <div className="space-y-2 animate-in slide-in-from-right-4 duration-300">
            {Object.entries(player.special).map(([key, val]) => (
              <div key={key} className="flex justify-between items-center border-b border-[#1aff1a]/10 py-2 hover:bg-[#1aff1a]/5 px-1">
                <span className="text-sm font-bold tracking-widest">
                  {language === 'zh'
                    ? `${key.toUpperCase()} ${specialLocalizations.zh[key as SpecialAttr] || ''}`.trim()
                    : key.toUpperCase()}
                </span>
                <span className="text-xl font-bold glow-text">{val}</span>
              </div>
            ))}
          </div>
        );

      case 'SKIL':
        return (
          <div className="space-y-1 animate-in slide-in-from-right-4 duration-300">
            {Object.values(Skill).map((skill) => (
              <div key={skill} className="flex justify-between items-center border-b border-[#1aff1a]/5 py-1.5 px-1 hover:bg-[#1aff1a]/5">
                <span className="text-xs opacity-90">{skillLocalizations[language][skill]}</span>
                <span className="text-sm font-bold">{(player.skills as any)[skill] || 0}</span>
              </div>
            ))}
          </div>
        );

      case 'PERK':
        return (
          <div className="space-y-3 animate-in slide-in-from-right-4 duration-300">
            {player.perks.length === 0 && <div className="text-center py-10 opacity-30 italic">{language === 'en' ? 'No perks earned' : '暂无额外能力'}</div>}
            {player.perks.map((perk, idx) => (
              <div key={idx} className="border border-[#1aff1a]/20 p-2 bg-[#1aff1a]/5">
                <div className="text-sm font-bold text-[#1aff1a] mb-1 uppercase">{perk.name}</div>
                <div className="text-[0.6875rem] opacity-70 leading-tight">{perk.description}</div>
              </div>
            ))}
          </div>
        );

      case 'COMP':
        return (
          <div className="space-y-3 animate-in slide-in-from-right-4 duration-300">
            {companions.length === 0 && (
              <div className="text-center py-10 opacity-30 italic">
                {language === 'en' ? 'No companions' : '暂无同伴'}
              </div>
            )}
            {companions.map((companion) => {
              const isExpanded = expandedCompanion === companion.name;
              return (
                <div key={companion.name} className="border border-[#1aff1a]/20 p-2 bg-[#1aff1a]/5">
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => setExpandedCompanion(isExpanded ? null : companion.name)}
                      className="shrink-0 border border-[#1aff1a]/20 bg-black/30"
                      aria-label={language === 'en' ? 'Toggle companion details' : '展开同伴详情'}
                    >
                      {companion.avatarUrl ? (
                        <img
                          src={companion.avatarUrl}
                          alt={`${companion.name} avatar`}
                          className="w-[100px] h-[100px] object-cover"
                          width={100}
                          height={100}
                        />
                      ) : (
                        <div className="w-[100px] h-[100px] flex items-center justify-center text-[0.5625rem] uppercase opacity-60">
                          {language === 'en' ? 'No Avatar' : '暂无头像'}
                        </div>
                      )}
                    </button>
                    <div className="flex-1">
                      <div className="text-sm font-bold text-[#1aff1a] mb-1 uppercase">{companion.name}</div>
                      <div className="text-[0.6875rem] opacity-70">{companion.faction}</div>
                      <div className="text-[0.625rem] opacity-50">
                        {language === 'en' ? 'Age' : '年龄'} {companion.age} · {companion.gender}
                      </div>
                      <div className="text-[0.5625rem] uppercase opacity-40 mt-2">
                        {language === 'en' ? 'Tap avatar for dossier' : '点击头像展开档案'}
                      </div>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="mt-3 space-y-3 text-[0.6875rem]">
                      <div>
                        <div className="text-[0.625rem] uppercase opacity-60 mb-1">{language === 'en' ? 'Lore' : '背景'}</div>
                        <div className="opacity-80 leading-tight">{companion.lore}</div>
                      </div>
                      <div>
                        <div className="text-[0.625rem] uppercase opacity-60 mb-1">SPECIAL</div>
                        <div className="grid grid-cols-2 gap-1">
                          {Object.entries(companion.special).map(([key, val]) => (
                            <div key={key} className="flex justify-between border-b border-[#1aff1a]/10">
                              <span className="opacity-70">{key}</span>
                              <span className="font-bold">{val}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div>
                        <div className="text-[0.625rem] uppercase opacity-60 mb-1">{language === 'en' ? 'Skills' : '技能'}</div>
                        <div className="grid grid-cols-2 gap-1">
                          {Object.values(Skill).map((skill) => (
                            <div key={skill} className="flex justify-between border-b border-[#1aff1a]/10">
                              <span className="opacity-70">{skillLocalizations[language][skill]}</span>
                              <span className="font-bold">{(companion.skills as any)[skill] || 0}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div>
                        <div className="text-[0.625rem] uppercase opacity-60 mb-1">{language === 'en' ? 'Perks' : '能力'}</div>
                        {companion.perks.length === 0 ? (
                          <div className="opacity-40 italic">{language === 'en' ? 'None' : '暂无'}</div>
                        ) : (
                          <div className="space-y-1">
                            {companion.perks.map((perk, idx) => (
                              <div key={`${perk.name}-${idx}`} className="text-[0.625rem]">
                                <span className="font-bold uppercase">{perk.name}</span>
                                <span className="opacity-70"> — {perk.description}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                      <div>
                        <div className="text-[0.625rem] uppercase opacity-60 mb-1">{language === 'en' ? 'Inventory' : '物品'}</div>
                        {companion.inventory.length === 0 ? (
                          <div className="opacity-40 italic">{language === 'en' ? 'Empty' : '空'}</div>
                        ) : (
                          <div className="space-y-1">
                            {companion.inventory.map((item, idx) => (
                              <div key={`${item.name}-${idx}`} className="text-[0.625rem]">
                                <span className="font-bold">
                                  {item.name} {item.count > 1 ? `x${item.count}` : ''}
                                </span>
                                <span className="opacity-70"> · {item.type} · {(item.weight * item.count).toFixed(1)} lb</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );

      case 'DATA':
        return (
          <div className="space-y-4 animate-in slide-in-from-right-4 duration-300">
             <div>
                <h4 className="text-[0.625rem] uppercase opacity-50 mb-2">{language === 'en' ? 'Active Quests' : '进行中的任务'}</h4>
                <div className="space-y-2">
                  {quests.filter(q => q.status === 'active').length === 0 && <div className="text-xs opacity-30 italic px-2">--- {language === 'en' ? 'Empty' : '空'} ---</div>}
                  {quests.filter(q => q.status === 'active').map(q => (
                    <div key={q.id} className="text-sm border-l-2 border-[#1aff1a] pl-2 py-2 bg-[#1aff1a]/5">
                      <div className="font-bold text-[#1aff1a] uppercase text-xs mb-1">{q.name}</div>
                      <div className="opacity-70 text-[0.6875rem]">{q.objective}</div>
                    </div>
                  ))}
                </div>
             </div>
             {quests.filter(q => q.status !== 'active').length > 0 && (
               <div className="pt-4 border-t border-[#1aff1a]/10">
                  <h4 className="text-[0.625rem] uppercase opacity-50 mb-2">{language === 'en' ? 'Completed' : '已完成'}</h4>
                  <div className="space-y-1">
                    {quests.filter(q => q.status !== 'active').map(q => (
                      <div key={q.id} className="text-[0.6875rem] opacity-40 line-through px-2">
                        {q.name}
                      </div>
                    ))}
                  </div>
               </div>
             )}
          </div>
        );

      case 'INV':
        return (
          <div className="flex flex-col h-full min-h-0 animate-in slide-in-from-right-4 duration-300">
            <div className="flex justify-between text-[0.625rem] uppercase opacity-40 px-1 mb-2">
              <span>{language === 'en' ? 'Item' : '物品'}</span>
              <span>{language === 'en' ? 'Weight' : '重量'}</span>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto pr-1">
              {player.inventory.map((item, idx) => (
                <div key={idx} className="text-xs p-1.5 border-b border-[#1aff1a]/5 flex justify-between hover:bg-[#1aff1a]/5 group">
                  <div className="flex flex-col truncate pr-2">
                    <span className="font-bold group-hover:text-white transition-colors">
                      {item.name} {item.count > 1 ? `x${item.count}` : ''}
                    </span>
                    <span className="text-[0.5625rem] opacity-50 truncate">{item.type}</span>
                  </div>
                  <span className="opacity-40 whitespace-nowrap self-center">
                    {(item.weight * item.count).toFixed(1)} lb
                  </span>
                </div>
              ))}
            </div>
            <div className="pt-4 text-[0.625rem] opacity-50 text-right">
               {language === 'en' ? 'Total Weight: ' : '总重: '}
               {player.inventory.reduce((acc, curr) => acc + curr.weight * curr.count, 0).toFixed(1)} / {player.special.Strength * 10 + 50} lb
            </div>
          </div>
        );
    }
  };

  const tabs: {id: Tab; label: string}[] = [
    { id: 'STAT', label: language === 'en' ? 'STAT' : '状态' },
    { id: 'SPEC', label: 'SPECIAL' },
    { id: 'SKIL', label: language === 'en' ? 'SKIL' : '技能' },
    { id: 'PERK', label: language === 'en' ? 'PERK' : '能力' },
    { id: 'COMP', label: language === 'en' ? 'COMP' : '同伴' },
    { id: 'DATA', label: language === 'en' ? 'DATA' : '数据' },
    { id: 'INV', label: language === 'en' ? 'INV' : '背包' }
  ];

  const clampedScale = Math.min(1.2, Math.max(0.85, panelScale ?? 1));

  return (
    <div className="w-full h-full border-l border-[#1aff1a]/30 bg-black/80 p-0 overflow-hidden flex flex-col no-scrollbar">
      <div
        style={{
          transform: `scale(${clampedScale})`,
          transformOrigin: 'top left',
          width: `${100 / clampedScale}%`,
          height: `${100 / clampedScale}%`
        }}
        className="h-full min-h-0 flex flex-col"
      >
        {/* Top Utility Header */}
        <div className="p-3 border-b border-[#1aff1a]/30 space-y-3 bg-black">
          <div className="flex justify-between items-center">
            <button 
              onClick={onClose}
              className="md:hidden text-[0.625rem] border border-[#1aff1a]/50 px-2 py-0.5 bg-[#1aff1a]/20 hover:bg-[#1aff1a] hover:text-black transition-colors font-bold uppercase"
            >
              {language === 'en' ? 'RETURN' : '返回'}
            </button>
            <div className="flex space-x-2">
              <button 
                onClick={() => onLanguageToggle(language === 'en' ? 'zh' : 'en')}
                className="text-[0.625rem] border border-[#1aff1a]/50 px-2 py-0.5 hover:bg-[#1aff1a] hover:text-black transition-colors"
              >
                {language === 'en' ? 'EN / 中' : '中 / EN'}
              </button>
              {showSave && (
                <button 
                  onClick={onSave}
                  className="text-[0.625rem] border border-[#1aff1a]/50 px-2 py-0.5 bg-[#1aff1a]/10 hover:bg-[#1aff1a] hover:text-black transition-colors font-bold"
                >
                  {language === 'en' ? 'SAVE' : '保存'}
                </button>
              )}
              <button
                onClick={onRefreshInventory}
                disabled={inventoryRefreshing}
                className="text-[0.625rem] border border-[#1aff1a]/50 px-2 py-0.5 bg-[#1aff1a]/10 hover:bg-[#1aff1a] hover:text-black transition-colors font-bold disabled:opacity-40"
              >
                {inventoryRefreshing
                  ? (language === 'en' ? 'REFRESH...' : '刷新中...')
                  : (language === 'en' ? 'INV REFRESH' : '库存刷新')}
              </button>
              <button
                onClick={onRebuildStatus}
                disabled={!canRebuildStatus || statusRebuilding}
                className="text-[0.625rem] border border-[#1aff1a]/50 px-2 py-0.5 bg-[#1aff1a]/10 hover:bg-[#1aff1a] hover:text-black transition-colors font-bold disabled:opacity-40"
              >
                {statusRebuilding
                  ? (language === 'en' ? 'REBUILD...' : '重建中...')
                  : (language === 'en' ? 'STAT REBUILD' : '状态重建')}
              </button>
              <div className="relative">
                <button 
                  onClick={() => setShowExportMenu(prev => !prev)}
                  className="text-[0.625rem] border border-[#1aff1a]/50 px-2 py-0.5 hover:bg-[#1aff1a] hover:text-black transition-colors font-bold"
                >
                  {language === 'en' ? 'EXPORT' : '导出'}
                </button>
                {showExportMenu && (
                  <div className="absolute right-0 mt-1 w-24 border border-[#1aff1a]/40 bg-black/95 z-10">
                    <button
                      onClick={() => { onExport('log-md'); setShowExportMenu(false); }}
                      className="w-full text-[0.625rem] px-2 py-1 uppercase hover:bg-[#1aff1a] hover:text-black transition-colors"
                    >
                      {language === 'en' ? 'LOG MD' : '终端 MD'}
                    </button>
                    <button
                      onClick={() => { onExport('log-pdf'); setShowExportMenu(false); }}
                      className="w-full text-[0.625rem] px-2 py-1 uppercase hover:bg-[#1aff1a] hover:text-black transition-colors"
                    >
                      {language === 'en' ? 'LOG PDF' : '终端 PDF'}
                    </button>
                    <button
                      onClick={() => { onExport('save-json'); setShowExportMenu(false); }}
                      className="w-full text-[0.625rem] px-2 py-1 uppercase hover:bg-[#1aff1a] hover:text-black transition-colors"
                    >
                      {language === 'en' ? 'SAVE JSON' : '存档 JSON'}
                    </button>
                    <div className="px-2 py-1 text-[0.5625rem] opacity-60">
                      {language === 'en'
                        ? 'JSON export is the only way to transfer saves between browsers/devices.'
                        : '导出 JSON 是跨浏览器/设备转移存档的唯一方式。'}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
          
          <div className="space-y-0.5">
            <h2 className="text-xl font-bold glow-text uppercase leading-none truncate">{player.name}</h2>
            <div className="text-[0.625rem] opacity-60 uppercase tracking-tighter">Pip-Boy 3000 Interface v4.0.2</div>
          </div>
        </div>

        {/* Sub-Menu Tabs */}
        <div className="flex border-b border-[#1aff1a]/30 bg-[#1aff1a]/5">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 py-2 text-[0.625rem] font-bold transition-all border-r last:border-r-0 border-[#1aff1a]/20 ${
                activeTab === tab.id 
                  ? 'bg-[#1aff1a] text-black shadow-[inset_0_0_8px_rgba(0,0,0,0.5)]' 
                  : 'text-[#1aff1a]/60 hover:text-[#1aff1a] hover:bg-[#1aff1a]/10'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content Area */}
        <div
          className={`flex-1 min-h-0 p-4 ${isInventoryTab ? 'overflow-hidden' : 'overflow-y-auto no-scrollbar'}`}
        >
          {renderTabContent()}
        </div>

        <div className="p-2 border-t border-[#1aff1a]/20 text-[0.5625rem] uppercase tracking-widest flex justify-between items-center bg-[#1aff1a]/5">
          <span>{language === 'en' ? 'TOKENS' : '令牌'}</span>
          <span className="opacity-70">
            {(language === 'en' ? 'SEND' : '发送')} {tokenUsage.sent.toLocaleString()} · {(language === 'en' ? 'RECV' : '接收')} {tokenUsage.received.toLocaleString()} · {(language === 'en' ? 'TOTAL' : '总计')} {tokenUsage.total.toLocaleString()}
          </span>
        </div>

        {/* Bottom Footer Info */}
        <div className="p-2 bg-[#1aff1a]/5 border-t border-[#1aff1a]/20 text-[0.5625rem] flex justify-between opacity-50 uppercase tracking-widest">
          <span>Vault-Tec Industries</span>
          <span>{displayLocation.split(' ')[0]}</span>
        </div>
      </div>
    </div>
  );
};

export default StatBar;

