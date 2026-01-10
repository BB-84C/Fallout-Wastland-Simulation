
export enum SpecialAttr {
  Strength = 'Strength',
  Perception = 'Perception',
  Endurance = 'Endurance',
  Charisma = 'Charisma',
  Intelligence = 'Intelligence',
  Agility = 'Agility',
  Luck = 'Luck'
}

export interface SpecialSet {
  [SpecialAttr.Strength]: number;
  [SpecialAttr.Perception]: number;
  [SpecialAttr.Endurance]: number;
  [SpecialAttr.Charisma]: number;
  [SpecialAttr.Intelligence]: number;
  [SpecialAttr.Agility]: number;
  [SpecialAttr.Luck]: number;
}

export enum Skill {
  SmallGuns = 'Small Guns',
  BigGuns = 'Big Guns',
  EnergyWeapons = 'Energy Weapons',
  Unarmed = 'Unarmed',
  MeleeWeapons = 'Melee Weapons',
  Medicine = 'Medicine',
  Repair = 'Repair',
  Science = 'Science',
  Sneak = 'Sneak',
  Lockpick = 'Lockpick',
  Steal = 'Steal',
  Speech = 'Speech',
  Barter = 'Barter',
  Survival = 'Survival'
}

export type SkillSet = Partial<Record<Skill, number>>;

export interface Perk {
  name: string;
  description: string;
  rank: number;
}

export interface InventoryItem {
  name: string;
  type: 'Weapon' | 'Armor' | 'Aid' | 'Misc' | 'Currency';
  description: string;
  weight: number;
  value: number;
}

export interface Actor {
  name: string;
  age: number;
  gender: string;
  faction: string;
  special: SpecialSet;
  skills: SkillSet;
  perks: Perk[];
  inventory: InventoryItem[];
  lore: string;
  health: number;
  maxHealth: number;
  karma: number; // -100 to 100
  caps: number; // Bottle Caps currency
}

export type Language = 'en' | 'zh';

export interface Quest {
  id: string;
  name: string;
  objective: string;
  status: 'active' | 'completed' | 'failed';
  hiddenProgress: string; // Internal lore consistency for LLM
}

export interface GroundingSource {
  title: string;
  uri: string;
}

export interface HistoryEntry {
  sender: 'player' | 'narrator';
  text: string;
  imageUrl?: string;
  groundingSources?: GroundingSource[];
}

export interface GameState {
  player: Actor | null;
  currentYear: number;
  location: string;
  currentTime: string; // ISO string or formatted
  history: HistoryEntry[];
  knownNpcs: Actor[];
  quests: Quest[];
  isThinking: boolean;
  language: Language;
}

export interface NarratorResponse {
  storyText: string;
  ruleViolation: string | null;
  timePassedMinutes: number;
  questUpdates?: Quest[];
  newNpc?: Actor;
  updatedPlayer?: Actor; // For inventory/caps/health changes
  imagePrompt?: string;
}
