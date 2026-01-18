
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

export interface InterfaceColor {
  r: number;
  g: number;
  b: number;
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

export interface InventoryChange {
  add?: InventoryItem[];
  remove?: { name: string; count?: number }[];
}

export interface PlayerChange {
  health?: number; // delta change (positive or negative)
  maxHealth?: number; // delta change (positive or negative)
  karma?: number; // delta change (positive or negative)
  caps?: number; // delta change (positive or negative)
  special?: Partial<SpecialSet>; // delta change per attribute
  skills?: Partial<SkillSet>; // delta change per skill
  perksAdd?: Perk[];
  perksRemove?: { name: string }[];
  inventoryChange?: InventoryChange;
}

export interface StatusChange {
  outcomeSummary?: string;
  ruleViolation?: string | null;
  timePassedMinutes?: number;
  playerChange?: PlayerChange;
  questUpdates?: Quest[];
  companionUpdates?: CompanionUpdate[];
  newNpc?: Actor[];
  location?: string;
  currentYear?: number;
  currentTime?: string;
}

export interface StatusChangeEntry extends StatusChange {
  narration_index: number;
  isSaved?: boolean;
}

export interface StatusSnapshot {
  player: Actor;
  quests: Quest[];
  knownNpcs: Actor[];
  location: string;
  currentYear: number;
  currentTime: string;
}

export interface StatusTrack {
  initial_status: StatusSnapshot;
  status_change: StatusChangeEntry[];
}

export interface Actor {
  name: string;
  age: number;
  gender: string;
  faction: string;
  appearance?: string;
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

export type PipelineMode = 'legacy' | 'event';

export interface GameSettings {
  highQualityImages: boolean;
  imagesEnabled?: boolean;
  imageEveryTurns: number;
  maxHistoryTurns: number;
  useProxy?: boolean;
  proxyBaseUrl?: string;
  textProxyBaseUrl?: string;
  imageProxyBaseUrl?: string;
  modelProvider?: ModelProvider;
  textProvider?: ModelProvider;
  imageProvider?: ModelProvider;
  textModel?: TextModelId;
  imageModel?: ImageModelId;
  userSystemPrompt?: string;
  userSystemPromptCustom?: boolean;
  maxCompressedMemoryK?: number;
  textScale?: number;
  pipelineMode?: PipelineMode;
  interfaceColor?: InterfaceColor;
  autoSaveEnabled?: boolean;
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

export type StatusUpdate = StatusChange;

export interface HistoryEntry {
  sender: 'player' | 'narrator';
  text: string;
  imageUrl?: string;
  groundingSources?: GroundingSource[];
  meta?: 'memory';
  isSaved?: boolean;
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
  rawOutputCache?: string;
  status_track?: StatusTrack | null;
  savedSnapshot?: SavedStatusSnapshot;
  compressionTurnCounter: number;
  compressionEnabled: boolean;
}

export interface SavedStatusSnapshot {
  compressedMemory?: string;
  compressionTurnCounter?: number;
  currentTime?: string;
  currentYear?: number;
  knownNpcs?: Actor[];
  location?: string;
  player?: Actor | null;
  quests?: Quest[];
  tokenUsage?: TokenUsage;
  turnCount?: number;
}

export interface NarratorResponse {
  storyText: string;
  ruleViolation: string | null;
  timePassedMinutes: number;
  tokenUsage?: TokenUsage;
  imagePrompt?: string;
}

export interface EventOutcome {
  outcomeSummary: string;
  ruleViolation?: string | null;
  timePassedMinutes: number;
  playerChange?: PlayerChange;
  questUpdates?: Quest[];
  companionUpdates?: CompanionUpdate[];
  newNpc?: Actor[];
  location?: string;
  currentYear?: number;
  currentTime?: string;
  tokenUsage?: TokenUsage;
}

export interface EventNarrationResponse {
  storyText: string;
  imagePrompt?: string;
  tokenUsage?: TokenUsage;
}

export type ArenaMode = 'scenario' | 'wargame';

export interface ArenaParty {
  description: string;
  forcePower?: number;
  maxForcePower?: number;
  avatarUrl?: string;
}

export interface ArenaState {
  mode: ArenaMode;
  focus: string;
  involvedParties: ArenaParty[];
  history: HistoryEntry[];
  isThinking: boolean;
  settings: GameSettings;
  turnCount: number;
  tokenUsage: TokenUsage;
  finished: boolean;
  briefingComplete: boolean;
  userPrompt: string;
  userPromptCustom?: boolean;
}
