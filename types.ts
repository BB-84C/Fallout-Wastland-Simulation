
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
  count: number;
  isConsumable: boolean;
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
  ifCompanion?: boolean;
  avatarUrl?: string;
}

export interface PlayerCreationResult extends Actor {
  companions?: Actor[];
  tokenUsage?: TokenUsage;
}

export type Language = 'en' | 'zh';

export type TextModelId = string;

export type ImageModelId = string;

export type ModelProvider = 'openai' | 'gemini' | 'claude' | 'doubao';

export interface GameSettings {
  highQualityImages: boolean;
  imagesEnabled?: boolean;
  imageEveryTurns: number;
  maxHistoryTurns: number;
  useProxy?: boolean;
  proxyBaseUrl?: string;
  modelProvider?: ModelProvider;
  textProvider?: ModelProvider;
  imageProvider?: ModelProvider;
  textModel?: TextModelId;
  imageModel?: ImageModelId;
  userSystemPrompt?: string;
  userSystemPromptCustom?: boolean;
  maxCompressedMemoryK?: number;
}

export type UserTier = 'admin' | 'normal' | 'guest';

export interface UserRecord {
  username: string;
  passkey: string;
  tier: 'admin' | 'normal';
  ap: number;
  apLastUpdated: number;
  settings?: GameSettings;
}

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

export interface CompanionUpdate {
  name: string;
  ifCompanion: boolean;
  reason?: string;
}

export interface StatusUpdate {
  updatedPlayer?: Actor;
  questUpdates?: Quest[];
  companionUpdates?: CompanionUpdate[];
  newNpc?: Actor;
  location?: string;
  currentYear?: number;
}

export interface HistoryEntry {
  sender: 'player' | 'narrator';
  text: string;
  imageUrl?: string;
  groundingSources?: GroundingSource[];
  meta?: 'memory';
}

export interface TokenUsage {
  sent: number;
  received: number;
  total: number;
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
  settings: GameSettings;
  ap: number;
  apLastUpdated: number;
  turnCount: number;
  tokenUsage: TokenUsage;
  compressedMemory?: string;
  compressionTurnCounter: number;
  compressionEnabled: boolean;
}

export interface NarratorResponse {
  storyText: string;
  ruleViolation: string | null;
  timePassedMinutes: number;
  tokenUsage?: TokenUsage;
  imagePrompt?: string;
}
