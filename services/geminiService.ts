
import { GoogleGenAI, Type } from "@google/genai";
import { Actor, NarratorResponse, SpecialAttr, Skill, Language, Quest, GroundingSource, UserTier, PlayerCreationResult, TextModelId, ImageModelId, TokenUsage, StatusUpdate, InventoryItem, HistoryEntry, EventOutcome, EventNarrationResponse } from "../types";

const ISO_DATE_TIME_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$";

const actorSchema = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING },
    age: { type: Type.NUMBER },
    gender: { type: Type.STRING },
    faction: { type: Type.STRING },
    appearance: { type: Type.STRING },
    special: {
      type: Type.OBJECT,
      properties: {
        [SpecialAttr.Strength]: { type: Type.NUMBER, minimum: 0, maximum: 10 },
        [SpecialAttr.Perception]: { type: Type.NUMBER, minimum: 0, maximum: 10 },
        [SpecialAttr.Endurance]: { type: Type.NUMBER, minimum: 0, maximum: 10 },
        [SpecialAttr.Charisma]: { type: Type.NUMBER, minimum: 0, maximum: 10 },
        [SpecialAttr.Intelligence]: { type: Type.NUMBER, minimum: 0, maximum: 10 },
        [SpecialAttr.Agility]: { type: Type.NUMBER, minimum: 0, maximum: 10 },
        [SpecialAttr.Luck]: { type: Type.NUMBER, minimum: 0, maximum: 10 },
      },
      required: Object.values(SpecialAttr)
    },
    skills: {
      type: Type.OBJECT,
      properties: Object.values(Skill).reduce((acc: Record<string, any>, skill) => ({ ...acc, [skill]: { type: Type.NUMBER, minimum: 0, maximum: 100 } }), {})
    },
    perks: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          description: { type: Type.STRING },
          rank: { type: Type.NUMBER }
        },
        required: ["name", "description", "rank"]
      }
    },
    ifCompanion: { type: Type.BOOLEAN },
    inventory: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          type: { type: Type.STRING },
          description: { type: Type.STRING },
          weight: { type: Type.NUMBER },
          value: { type: Type.NUMBER },
          count: { type: Type.NUMBER },
          isConsumable: { type: Type.BOOLEAN }
        },
        required: ["name", "type", "description", "weight", "value", "count", "isConsumable"]
      }
    },
    lore: { type: Type.STRING },
    health: { type: Type.NUMBER },
    maxHealth: { type: Type.NUMBER },
    karma: { type: Type.NUMBER },
    caps: { type: Type.NUMBER }
  },
  required: ["name", "age", "faction", "appearance", "special", "skills", "lore", "health", "maxHealth", "caps"]
};

const playerCreationSchema = {
  type: Type.OBJECT,
  properties: {
    ...actorSchema.properties,
    companions: {
      type: Type.ARRAY,
      items: actorSchema
    }
  },
  required: [...actorSchema.required, "companions"]
};

const memorySchema = {
  type: Type.OBJECT,
  properties: {
    memory: { type: Type.STRING }
  },
  required: ["memory"]
};

const arenaSchema = {
  type: Type.OBJECT,
  properties: {
    storyText: { type: Type.STRING },
    imagePrompt: { type: Type.STRING },
    forcePowers: {
      type: Type.ARRAY,
      items: { type: Type.NUMBER }
    }
  },
  required: ["storyText", "imagePrompt"]
};

const DEFAULT_TEXT_MODEL = 'gemini-2.5-flash-lite';
const DEFAULT_IMAGE_MODEL = 'gemini-2.5-flash-image';
const HARDCODED_GUEST_API_KEY = 'AIzaSyB71sniT0q7RrXq57S8899tfhSEq_u8jr4';

const estimateTokens = (text: string) => {
  if (!text) return 0;
  const cjkMatches = text.match(/[\u4E00-\u9FFF\u3400-\u4DBF]/g);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjkCount = Math.max(0, text.length - cjkCount);
  return cjkCount + Math.ceil(nonCjkCount / 4);
};

const normalizeTokenUsage = (
  usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined,
  inputText: string,
  outputText: string
): TokenUsage => {
  const promptTokens = usage?.promptTokens ?? 0;
  const completionTokens = usage?.completionTokens ?? 0;
  const totalTokens = usage?.totalTokens ?? 0;
  if (promptTokens > 0 || completionTokens > 0 || totalTokens > 0) {
    const total = totalTokens || promptTokens + completionTokens;
    return {
      sent: Math.max(0, Math.floor(promptTokens)),
      received: Math.max(0, Math.floor(completionTokens)),
      total: Math.max(0, Math.floor(total))
    };
  }
  const estimatedPrompt = estimateTokens(inputText);
  const estimatedCompletion = estimateTokens(outputText);
  return {
    sent: estimatedPrompt,
    received: estimatedCompletion,
    total: estimatedPrompt + estimatedCompletion
  };
};

const questSchema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      id: { type: Type.STRING },
      name: { type: Type.STRING },
      objective: { type: Type.STRING },
      status: { type: Type.STRING, enum: ["active", "completed", "failed"] },
      hiddenProgress: { type: Type.STRING }
    },
    required: ["id", "name", "objective", "status", "hiddenProgress"]
  }
};

const companionUpdatesSchema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      name: { type: Type.STRING },
      ifCompanion: { type: Type.BOOLEAN },
      reason: { type: Type.STRING }
    },
    required: ["name", "ifCompanion"]
  }
};

const perkSchema = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING },
    description: { type: Type.STRING },
    rank: { type: Type.NUMBER }
  },
  required: ["name", "description", "rank"]
};

const deltaSpecialSchema = {
  type: Type.OBJECT,
  properties: {
    [SpecialAttr.Strength]: { type: Type.NUMBER, minimum: -5, maximum: 5 },
    [SpecialAttr.Perception]: { type: Type.NUMBER, minimum: -5, maximum: 5 },
    [SpecialAttr.Endurance]: { type: Type.NUMBER, minimum: -5, maximum: 5 },
    [SpecialAttr.Charisma]: { type: Type.NUMBER, minimum: -5, maximum: 5 },
    [SpecialAttr.Intelligence]: { type: Type.NUMBER, minimum: -5, maximum: 5 },
    [SpecialAttr.Agility]: { type: Type.NUMBER, minimum: -5, maximum: 5 },
    [SpecialAttr.Luck]: { type: Type.NUMBER, minimum: -5, maximum: 5 }
  }
};

const deltaSkillsSchema = {
  type: Type.OBJECT,
  properties: Object.values(Skill).reduce(
    (acc: Record<string, any>, skill) => ({ ...acc, [skill]: { type: Type.NUMBER, minimum: -50, maximum: 50 } }),
    {}
  )
};

const boundedSpecialSchema = {
  type: Type.OBJECT,
  properties: {
    [SpecialAttr.Strength]: { type: Type.NUMBER, minimum: 0, maximum: 10 },
    [SpecialAttr.Perception]: { type: Type.NUMBER, minimum: 0, maximum: 10 },
    [SpecialAttr.Endurance]: { type: Type.NUMBER, minimum: 0, maximum: 10 },
    [SpecialAttr.Charisma]: { type: Type.NUMBER, minimum: 0, maximum: 10 },
    [SpecialAttr.Intelligence]: { type: Type.NUMBER, minimum: 0, maximum: 10 },
    [SpecialAttr.Agility]: { type: Type.NUMBER, minimum: 0, maximum: 10 },
    [SpecialAttr.Luck]: { type: Type.NUMBER, minimum: 0, maximum: 10 }
  }
};

const boundedSkillsSchema = {
  type: Type.OBJECT,
  properties: Object.values(Skill).reduce(
    (acc: Record<string, any>, skill) => ({ ...acc, [skill]: { type: Type.NUMBER, minimum: 0, maximum: 100 } }),
    {}
  )
};

const inventoryChangeSchema = {
  type: Type.OBJECT,
  properties: {
    add: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          type: { type: Type.STRING },
          description: { type: Type.STRING },
          weight: { type: Type.NUMBER },
          value: { type: Type.NUMBER },
          count: { type: Type.NUMBER },
          isConsumable: { type: Type.BOOLEAN }
        },
        required: ["name", "type", "description", "weight", "value", "count", "isConsumable"]
      }
    },
    remove: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          count: { type: Type.NUMBER }
        },
        required: ["name"]
      }
    }
  }
};

const knownNpcUpdateSchema = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING },
    appearance: { type: Type.STRING },
    lore: { type: Type.STRING },
    age: { type: Type.NUMBER },
    gender: { type: Type.STRING },
    faction: { type: Type.STRING },
    health: { type: Type.NUMBER },
    maxHealth: { type: Type.NUMBER },
    karma: { type: Type.NUMBER },
    caps: { type: Type.NUMBER },
    special: boundedSpecialSchema,
    skills: boundedSkillsSchema,
    inventoryChange: inventoryChangeSchema,
    perksAdd: { type: Type.ARRAY, items: perkSchema },
    perksRemove: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { name: { type: Type.STRING } },
        required: ["name"]
      }
    }
  },
  required: ["name"]
};

const playerChangeSchema = {
  type: Type.OBJECT,
  properties: {
    health: { type: Type.NUMBER },
    maxHealth: { type: Type.NUMBER },
    karma: { type: Type.NUMBER },
    caps: { type: Type.NUMBER },
    special: deltaSpecialSchema,
    skills: deltaSkillsSchema,
    perksAdd: { type: Type.ARRAY, items: perkSchema },
    perksRemove: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { name: { type: Type.STRING } },
        required: ["name"]
      }
    },
    inventoryChange: inventoryChangeSchema
  }
};

const statusSchema = {
  type: Type.OBJECT,
  properties: {
    playerChange: playerChangeSchema,
    questUpdates: questSchema,
    companionUpdates: companionUpdatesSchema,
    newNpc: {
      type: Type.ARRAY,
      items: actorSchema
    },
    knownNpcsUpdates: {
      type: Type.ARRAY,
      items: knownNpcUpdateSchema
    },
    timePassedMinutes: { type: Type.NUMBER },
    location: { type: Type.STRING },
    currentYear: { type: Type.NUMBER },
    currentTime: {
      type: Type.STRING,
      description: "ISO 8601 UTC date-time, e.g. 2281-07-15T17:05:00.000Z",
      pattern: ISO_DATE_TIME_PATTERN
    }
  },
  required: [
    "playerChange",
    "questUpdates",
    "companionUpdates",
    "newNpc",
    "knownNpcsUpdates",
    "timePassedMinutes",
    "location",
    "currentYear",
    "currentTime"
  ]
};

const eventSchema = {
  type: Type.OBJECT,
  properties: {
    outcomeSummary: { type: Type.STRING },
    ruleViolation: { type: Type.STRING }
  },
  required: ["outcomeSummary", "ruleViolation"]
};

const inventoryItemSchema = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING },
    type: { type: Type.STRING },
    description: { type: Type.STRING },
    weight: { type: Type.NUMBER },
    value: { type: Type.NUMBER },
    count: { type: Type.NUMBER },
    isConsumable: { type: Type.BOOLEAN }
  },
  required: ["name", "type", "description", "weight", "value", "count", "isConsumable"]
};

const inventoryRefreshSchema = {
  type: Type.OBJECT,
  properties: {
    inventory: {
      type: Type.ARRAY,
      items: inventoryItemSchema
    }
  },
  required: ["inventory"]
};

const inventoryRecoverySchema = {
  type: Type.OBJECT,
  properties: {
    initialInventory: {
      type: Type.ARRAY,
      items: inventoryItemSchema
    },
    inventoryChanges: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          narration_index: { type: Type.NUMBER },
          inventoryChange: inventoryChangeSchema
        },
        required: ["narration_index", "inventoryChange"]
      }
    }
  },
  required: ["initialInventory", "inventoryChanges"]
};

const resolveApiKey = (overrideKey?: string) => {
  if (overrideKey) {
    return { key: overrideKey, source: 'user' };
  }
  if (HARDCODED_GUEST_API_KEY) {
    return { key: HARDCODED_GUEST_API_KEY, source: 'hardcoded' };
  }
  const viteKey = (import.meta as any)?.env?.VITE_API_KEY;
  const envKey = typeof process !== 'undefined' ? (process as any)?.env?.API_KEY : undefined;
  if (viteKey) {
    return { key: viteKey as string, source: 'VITE_API_KEY' };
  }
  if (envKey) {
    return { key: envKey as string, source: 'process.env.API_KEY' };
  }
  return { key: undefined, source: 'missing' };
};

const describeApiKey = (key?: string) => {
  if (!key) return 'missing';
  const last4 = key.slice(-4);
  return `len=${key.length}, last4=${last4}`;
};

/**
 * Resizes image to 640p height and compresses to JPEG to stay under 400KB.
 */
async function compressImage(base64: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const targetHeight = 640;
      const h = img.height || 1;
      const w = img.width || 1;
      const scale = targetHeight / h;
      
      canvas.width = w * scale;
      canvas.height = targetHeight;
      
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(base64);
        return;
      }

      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => resolve(base64);
    img.src = base64;
  });
}

/**
 * Resize image to a fixed square avatar size.
 */
async function resizeImageToSquare(base64: string, size: number): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const w = img.width || 1;
      const h = img.height || 1;
      const scale = Math.max(size / w, size / h);
      const drawW = w * scale;
      const drawH = h * scale;
      const dx = (size - drawW) / 2;
      const dy = (size - drawH) / 2;

      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(base64);
        return;
      }

      ctx.drawImage(img, dx, dy, drawW, drawH);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => resolve(base64);
    img.src = base64;
  });
}

const sanitizeJsonText = (text: string) => {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/```(?:json)?/gi, '').replace(/```/g, '');
  cleaned = cleaned.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  cleaned = cleaned.replace(/[\u0000-\u001F]+/g, ' ');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    cleaned = cleaned.slice(start, end + 1);
  }
  cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
  cleaned = cleaned.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
  let fixed = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < cleaned.length; i += 1) {
    const char = cleaned[i];
    if (!inString) {
      if (char === '"') {
        inString = true;
      }
      fixed += char;
      continue;
    }
    if (escaped) {
      escaped = false;
      fixed += char;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      fixed += char;
      continue;
    }
    if (char === '"') {
      const remainder = cleaned.slice(i + 1);
      const nextNonSpace = remainder.match(/\S/);
      const nextChar = nextNonSpace ? nextNonSpace[0] : '';
      if (nextChar && ![':', ',', '}', ']'].includes(nextChar)) {
        fixed += '\\"';
        continue;
      }
      inString = false;
      fixed += char;
      continue;
    }
    fixed += char;
  }
  cleaned = fixed;
  return cleaned;
};

function safeJsonParse(text: string): any {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        // fall through to sanitize pass
      }
    }
    try {
      const repaired = sanitizeJsonText(trimmed);
      return JSON.parse(repaired);
    } catch (finalError) {
      const error = finalError instanceof Error ? finalError : new Error(String(finalError));
      (error as { rawOutput?: string }).rawOutput = text;
      throw error;
    }
  }
}

const normalizeInventoryChangeCarrier = (raw: any) => {
  if (!raw || typeof raw !== 'object') return raw;
  if (!raw.inventoryChange || typeof raw.inventoryChange !== 'object') return raw;
  const playerChange = raw.playerChange && typeof raw.playerChange === 'object' ? raw.playerChange : {};
  const nextPlayerChange = playerChange.inventoryChange
    ? playerChange
    : { ...playerChange, inventoryChange: raw.inventoryChange };
  const { inventoryChange: _inventoryChange, ...rest } = raw;
  return { ...rest, playerChange: nextPlayerChange };
};

const normalizeRuleViolationFlag = (value: unknown) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const lowered = trimmed.toLowerCase();
  if (lowered === 'false' || lowered === 'null') return null;
  return value;
};

export async function createPlayerCharacter(
  userInput: string,
  year: number,
  region: string,
  lang: Language,
  options?: { tier?: UserTier; onProgress?: (message: string) => void; apiKey?: string; textModel?: TextModelId; userSystemPrompt?: string }
): Promise<PlayerCreationResult> {
  const selectedTextModel = options?.textModel || DEFAULT_TEXT_MODEL;
  const { key: apiKey, source } = resolveApiKey(options?.apiKey);
  const emit = (message: string) => options?.onProgress?.(message);
  const ai = new GoogleGenAI({ apiKey: apiKey || '' });
  const targetLang = lang === 'zh' ? 'Chinese' : 'English';
  const systemInstruction = `You are the Vault-Tec Identity Reconstruction System.
      1. INTERNAL PROCESSING: Always research and use the Fallout Wiki in English for lore accuracy.
      2. MANDATORY LANGUAGE: All text fields in the final JSON MUST be in ${targetLang}.
      3. TRANSLATION RULE: Use official Fallout localizations for ${targetLang}. If an official term does not exist, translate it manually and append the original English in parentheses.
      4. ECONOMY: Assign 50-200 starting caps in the 'caps' field.
          5. PERK SYSTEM: Assign 1-2 starting perks. Each perk MUST include name, rank, and a non-empty description.
          6. COMPANIONS: Always include a 'companions' array (empty if none). If the user specifies existing companions, include full NPC profiles and set ifCompanion=true for each.
          7. SKILLS: The skills object must include all skills with numeric values (do not omit any skill).
      8. FIELDS TO LOCALIZE: name, faction, appearance, lore, perks[].name, perks[].description, inventory[].name, inventory[].description, companions[].name, companions[].faction, companions[].appearance, companions[].lore, companions[].perks[].name, companions[].perks[].description, companions[].inventory[].name, companions[].inventory[].description.
          ${options?.userSystemPrompt?.trim() ? `9. USER DIRECTIVE: ${options.userSystemPrompt.trim()}` : ''}`;
  const prompt = `Create a Fallout character for the year ${year} in ${region} based on this input: "${userInput}". Ensure they have appropriate initial perks, inventory, and starting Bottle Caps (50-200 caps). Include a short appearance description for the player and any companions. If the user mentions starting companions, include them.`;

  emit(`API key: ${source} (${describeApiKey(apiKey)})`);
  emit(`Requesting character profile from ${selectedTextModel}...`);
  const response = await ai.models.generateContent({
    model: selectedTextModel,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: playerCreationSchema,
      systemInstruction
        },
      });
  
  if (!response.text) throw new Error("No response from Vault-Tec database.");
  emit(`Response received (${response.text.length} chars). Parsing JSON...`);
  try {
    const parsed = safeJsonParse(response.text);
    const tokenUsage = normalizeTokenUsage({
      promptTokens: response.usageMetadata?.promptTokenCount,
      completionTokens: response.usageMetadata?.candidatesTokenCount,
      totalTokens: response.usageMetadata?.totalTokenCount
    }, `${systemInstruction}\n${prompt}`, response.text);
    if (parsed && typeof parsed === 'object') {
      parsed.tokenUsage = tokenUsage;
    }
    emit('Character JSON parsed successfully.');
    return parsed;
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    const preview = response.text.slice(0, 400).replace(/\s+/g, ' ').trim();
    emit(`JSON parse failed: ${errorMessage}`);
    emit(`Response preview: ${preview}`);
    throw e;
  }
}

export async function getNarrativeResponse(
  player: Actor,
  history: any[],
  userInput: string,
  year: number,
  location: string,
  quests: Quest[],
  knownNpcs: Actor[],
  lang: Language,
  options?: { tier?: UserTier; apiKey?: string; textModel?: TextModelId; userSystemPrompt?: string }
): Promise<NarratorResponse> {
  const { key: apiKey } = resolveApiKey(options?.apiKey);
  const ai = new GoogleGenAI({ apiKey: apiKey || '' });
  const targetLang = lang === 'zh' ? 'Chinese' : 'English';
  const context = history.map(h => `${h.sender.toUpperCase()}: ${h.text}`).join('\n');
  const selectedTextModel = options?.textModel || DEFAULT_TEXT_MODEL;

  const prompt = `
    Environment Year: ${year}
    Environment Location: ${location}
    Current Player Profile: ${JSON.stringify(player)}
    Existing Quests: ${JSON.stringify(quests)}
    Known NPCs: ${JSON.stringify(knownNpcs)}
    Interaction Context:
    ${context}
    Player's current intent/action: "${userInput}"

    TASK:
    1. Determine the outcome of the action.
    2. Narrate the outcome as a DM of a Fallout RPG, focusing on vivid descriptions, character dialogues, and environmental details.
    3. Only return ruleViolation when the player explicitly dictates outcomes or facts; otherwise set ruleViolation to "false". Missing tools/items or unmet conditions should be described in the narrative, not flagged as a rule violation.
    4. If the player notes that prior narration missed/forgot plot or lore, comply and correct the continuity in your response.
  `;
  const systemInstruction = `You are the Fallout Overseer. 
          1. SOURCE: Strictly source all lore, item stats, and location details from the Fallout Wiki in English.
          1.1. OUTPUT RULE: Never cite sources, URLs, or parenthetical provenance in player-facing narration. Keep the narration immersive.
          2. MANDATORY LANGUAGE: You MUST output all text presented to the player in ${targetLang}.
      3. STATUS CONTROL: Do NOT update quests, inventory, caps, perks, companions, location, or any player/NPC stats. A separate status manager handles all status updates.
      4. RULE GUARD: Only set ruleViolation when the player explicitly dictates outcomes or facts (e.g., "I succeed and get the item," "the guard is dead because I say so"). If they only state intent/attempts, do NOT set ruleViolation, even if the attempt fails or goes badly. If the action fails due to missing tools/items or unmet conditions, describe that in storyText/outcomeSummary instead of using ruleViolation. If no violation, set ruleViolation to "false".
      5. CONTINUITY CORRECTION: If the player says prior narration missed/forgot plot or lore, comply and correct the continuity in the response.
      6. TRANSLATION: Use "Term (Original)" for unlocalized items.
      7. CONSISTENCY: Ensure current year (${year}) and location (${location}) lore is followed.
      ${options?.userSystemPrompt?.trim() ? `8. USER DIRECTIVE: ${options.userSystemPrompt.trim()}` : ''}`;

  const response = await ai.models.generateContent({
    model: selectedTextModel,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          storyText: { type: Type.STRING },
          ruleViolation: { type: Type.STRING },
          timePassedMinutes: { type: Type.NUMBER },
          imagePrompt: { type: Type.STRING }
        },
        required: ["storyText", "timePassedMinutes", "imagePrompt"]
      },
          systemInstruction
    },
  });

  if (!response.text) throw new Error("Connection to the Wasteland lost.");
  const parsed = safeJsonParse(response.text);
  if (parsed && typeof parsed === 'object') {
    const normalizedRuleViolation = normalizeRuleViolationFlag((parsed as any).ruleViolation);
    if (normalizedRuleViolation === null) {
      (parsed as any).ruleViolation = null;
    }
  }
  const tokenUsage = normalizeTokenUsage({
    promptTokens: response.usageMetadata?.promptTokenCount,
    completionTokens: response.usageMetadata?.candidatesTokenCount,
    totalTokens: response.usageMetadata?.totalTokenCount
  }, `${systemInstruction}\n${prompt}`, response.text);
  if (parsed && typeof parsed === 'object') {
    parsed.tokenUsage = tokenUsage;
  }
  return parsed;
}

export async function getEventOutcome(
  player: Actor,
  history: any[],
  userInput: string,
  year: number,
  location: string,
  currentTime: string,
  quests: Quest[],
  knownNpcs: Actor[],
  lang: Language,
  options?: { tier?: UserTier; apiKey?: string; textModel?: TextModelId; userSystemPrompt?: string }
): Promise<EventOutcome> {
  const { key: apiKey } = resolveApiKey(options?.apiKey);
  const ai = new GoogleGenAI({ apiKey: apiKey || '' });
  const targetLang = lang === 'zh' ? 'Chinese' : 'English';
  const context = history.map(h => `${h.sender.toUpperCase()}: ${h.text}`).join('\n');
  const selectedTextModel = options?.textModel || DEFAULT_TEXT_MODEL;

  const prompt = `
    Environment Year: ${year}
    Environment Location: ${location}
    Current Time: ${currentTime}
    Current Player Status: ${JSON.stringify(player)}
    Existing Quests: ${JSON.stringify(quests)}
    Known NPCs: ${JSON.stringify(knownNpcs)}
    Interaction Context:
    ${context}
    Player's current intent/action: "${userInput}"

    TASK:
    1. Determine the outcome of the action.
    2. Summarize the concrete outcome in outcomeSummary (concise, causal, no decorative language).
    3. Avoid assuming the player is the protagonist, unless the user specified or the player background says so.
    4. You are encouraged to create new events for the player that fit within the Fallout universe to enhance the story.
    5. You are not encouraged to force bind the existed wiki events/quest to the player. Only do that occasionally if it fits well.
    6. If the player's action includes using an item that is not in their inventory, don't return a rule violation. Instead, set the outcome where the player realizes they don't have the item.
    7. Only return ruleViolation when the player explicitly dictates outcomes or facts; otherwise set ruleViolation to "false". If required tools/items are missing, narrate the failure or workaround instead of flagging ruleViolation.
    8. If the player notes that prior narration missed/forgot plot or lore, comply and correct the continuity in your outcomeSummary.
    Return strict JSON with keys: outcomeSummary, ruleViolation.
  `;
  const systemInstruction = `You are the Vault-Tec Event Manager.
          1. SOURCE: Strictly source all lore, item stats, and location details from the Fallout Wiki in English.
          1.1. OUTPUT RULE: Never cite sources, URLs, or parenthetical provenance in player-facing text.
          2. MANDATORY LANGUAGE: You MUST output all text fields in ${targetLang}.
          3. PURPOSE: Determine the concrete outcome summary and ruleViolation only. Status changes are handled by a separate manager.
          4. RULE GUARD: Only set ruleViolation when the player explicitly dictates outcomes or facts. Do NOT use ruleViolation for unlucky/partial results or missing tools/items; handle those in outcomeSummary. If no violation, set ruleViolation to "false".
          5. CONTINUITY CORRECTION: If the player says prior narration missed/forgot plot or lore, comply and correct the continuity in the outcomeSummary (do not flag ruleViolation).
          6. CONSISTENCY: Ensure current year (${year}) and location (${location}) lore is followed.
          ${options?.userSystemPrompt?.trim() ? `7. USER DIRECTIVE: ${options.userSystemPrompt.trim()}` : ''}`;

  const response = await ai.models.generateContent({
    model: selectedTextModel,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: eventSchema,
      systemInstruction
    }
  });

  if (!response.text) throw new Error("Connection to the Wasteland lost.");
    const parsed = safeJsonParse(response.text);
    const normalized = normalizeInventoryChangeCarrier(parsed);
    if (normalized && typeof normalized === 'object') {
      const normalizedRuleViolation = normalizeRuleViolationFlag((normalized as any).ruleViolation);
      if (normalizedRuleViolation === null) {
        (normalized as any).ruleViolation = null;
      }
    }
    const tokenUsage = normalizeTokenUsage({
      promptTokens: response.usageMetadata?.promptTokenCount,
      completionTokens: response.usageMetadata?.candidatesTokenCount,
      totalTokens: response.usageMetadata?.totalTokenCount
    }, `${systemInstruction}\n${prompt}`, response.text);
    if (normalized && typeof normalized === 'object') {
      (normalized as any).tokenUsage = tokenUsage;
      return normalized as EventOutcome;
    }
    return { outcomeSummary: '', ruleViolation: null, tokenUsage } as EventOutcome;
  }

export async function getEventNarration(
  player: Actor,
  knownNpcs: Array<Omit<Actor, "inventory">>,
  quests: Quest[],
  year: number,
  location: string,
  currentTime: string,
  eventOutcome: EventOutcome,
  lang: Language,
  options?: { tier?: UserTier; apiKey?: string; textModel?: TextModelId; userSystemPrompt?: string }
): Promise<EventNarrationResponse> {
  const { key: apiKey } = resolveApiKey(options?.apiKey);
  const ai = new GoogleGenAI({ apiKey: apiKey || '' });
  const targetLang = lang === 'zh' ? 'Chinese' : 'English';
  const selectedTextModel = options?.textModel || DEFAULT_TEXT_MODEL;

  const prompt = `
    Environment Year: ${year}
    Environment Location: ${location}
    Current Time: ${currentTime}
    Current Player Profile: ${JSON.stringify(player)}
    Known NPCs (inventory omitted): ${JSON.stringify(knownNpcs)}
    Current Quests (completed omitted): ${JSON.stringify(quests)}

    EVENT_OUTCOME:
    ${JSON.stringify(eventOutcome)}

    TASK:
    1. Narrate the outcome strictly based on EVENT_OUTCOME. Do NOT add new outcomes or state changes.
    2. Focus on vivid descriptions, character dialogues, and environmental details that align with the event.
    Return JSON with keys: storyText, imagePrompt.
  `;
  const systemInstruction = `You are the Fallout Overseer.
          1. SOURCE: Strictly source all lore, item stats, and location details from the Fallout Wiki in English.
          1.1. OUTPUT RULE: Never cite sources, URLs, or parenthetical provenance in player-facing narration. Keep the narration immersive.
          2. MANDATORY LANGUAGE: You MUST output all text presented to the player in ${targetLang}.
          3. EVENT LOCK: Narrate ONLY what is contained in EVENT_OUTCOME. Do NOT invent or alter outcomes, items, NPCs, quests, or stats.
          4. TRANSLATION: Use "Term (Original)" for unlocalized items.
          5. CONSISTENCY: Ensure current year (${year}) and location (${location}) lore is followed.
          ${options?.userSystemPrompt?.trim() ? `6. USER DIRECTIVE: ${options.userSystemPrompt.trim()}` : ''}`;

  const response = await ai.models.generateContent({
    model: selectedTextModel,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          storyText: { type: Type.STRING },
          imagePrompt: { type: Type.STRING }
        },
        required: ["storyText", "imagePrompt"]
      },
      systemInstruction
    }
  });

  if (!response.text) throw new Error("Connection to the Wasteland lost.");
  const parsed = safeJsonParse(response.text);
  const tokenUsage = normalizeTokenUsage({
    promptTokens: response.usageMetadata?.promptTokenCount,
    completionTokens: response.usageMetadata?.candidatesTokenCount,
    totalTokens: response.usageMetadata?.totalTokenCount
  }, `${systemInstruction}\n${prompt}`, response.text);
  if (parsed && typeof parsed === 'object') {
    (parsed as any).tokenUsage = tokenUsage;
    return parsed as EventNarrationResponse;
  }
  return { storyText: '', imagePrompt: '', tokenUsage };
}

export async function getArenaNarration(
  focus: string,
  involvedParties: string[],
  history: HistoryEntry[],
  lang: Language,
  options?: {
    tier?: UserTier;
    apiKey?: string;
    textModel?: TextModelId;
    userSystemPrompt?: string;
    finish?: boolean;
    mode?: 'scenario' | 'wargame';
    phase?: 'briefing' | 'battle';
    forcePowers?: Array<number | null>;
  }
): Promise<{ storyText: string; tokenUsage?: TokenUsage; forcePowers?: number[]; imagePrompt?: string }> {
  const { key: apiKey } = resolveApiKey(options?.apiKey);
  const ai = new GoogleGenAI({ apiKey: apiKey || '' });
  const targetLang = lang === 'zh' ? 'Chinese' : 'English';
  const selectedTextModel = options?.textModel || DEFAULT_TEXT_MODEL;
  const finish = !!options?.finish;
  const mode = options?.mode === 'wargame' ? 'wargame' : 'scenario';
  const phase = options?.phase === 'battle' ? 'battle' : 'briefing';

  const prompt = `
FOCUS QUESTION:
${focus}

INVOLVED PARTIES:
${involvedParties.map((party, index) => `[${index + 1}] ${party}`).join("\n")}

${mode === 'wargame' ? `CURRENT FORCE POWER:
${(options?.forcePowers || []).map((value, index) => `[${index + 1}] ${value === null || value === undefined ? 'UNKNOWN' : value}`).join("\n")}` : ''}

SIMULATION HISTORY:
${history.map(entry => `${entry.sender.toUpperCase()}: ${entry.text}`).join("\n")}

FINISH: ${finish ? "true" : "false"}
PHASE: ${phase}

TASK:
${mode === 'wargame'
  ? `If PHASE is briefing, provide a concise situation briefing only (no combat actions or damage). If CURRENT FORCE POWER is provided, return the same values unchanged; otherwise set initial forcePowers for each party (integer). If PHASE is battle, continue the battle as a war game report. Update forcePowers for each party (integer). If a party is a single unit, set forcePowers to that unit's HP. If a party is down to 0, mark them as defeated but keep narrating until FINISH or only one party remains.
Return JSON with keys: storyText, forcePowers, imagePrompt. imagePrompt is REQUIRED.`
  : `If PHASE is briefing, provide a concise situation briefing only (no combat actions or damage). If PHASE is battle, continue the battle simulation with tactics, setbacks, and momentum shifts. If FINISH is true, conclude the battle with a decisive outcome and aftermath.
Return JSON with keys: storyText, imagePrompt. imagePrompt is REQUIRED.`}`;

const systemInstruction = `You are the Wasteland Smash Arena simulator.
1. LORE: Always consult the Fallout Wiki in English when possible. If a party is not in the wiki, infer from established Fallout lore.
2. OUTPUT RULE: Never cite sources, URLs, or provenance in player-facing narration.
3. LANGUAGE: Output must be in ${targetLang}.
4. STRUCTURE: Do NOT conclude the battle unless FINISH is true. Continue the simulation round-by-round.
5. FAIRNESS: Follow Fallout logic and make outcomes believable; avoid deterministic instant victories.
6. MODE: ${mode === 'wargame'
  ? 'War Game Sim: use a professional, concise tone, reporting actions, tactics, and damage. Always update forcePowers for each party.'
  : 'Scenario: focus on story, atmosphere, and vivid scene depiction.'}
7. FORCE POWERS FORMAT (War Game only): forcePowers MUST be a JSON array of integers with the same length and order as INVOLVED PARTIES. Do NOT output an object/map.
8. IMAGE PROMPT: Always include imagePrompt as a concise, vivid visual description for a single scene.
9. BRIEFING: If PHASE is briefing, do NOT describe any attacks, damage, or exchanges. Only describe parties, location, time, surroundings, and the reason for conflict.
${options?.userSystemPrompt?.trim() ? `10. USER DIRECTIVE: ${options.userSystemPrompt.trim()}` : ''}`;

  const response = await ai.models.generateContent({
    model: selectedTextModel,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: arenaSchema,
      systemInstruction
    }
  });

  if (!response.text) throw new Error("Connection to the Wasteland lost.");
  const parsed = safeJsonParse(response.text);
  const tokenUsage = normalizeTokenUsage({
    promptTokens: response.usageMetadata?.promptTokenCount,
    completionTokens: response.usageMetadata?.candidatesTokenCount,
    totalTokens: response.usageMetadata?.totalTokenCount
  }, `${systemInstruction}\n${prompt}`, response.text);
  if (parsed && typeof parsed === 'object') {
    const storyText = typeof (parsed as any).storyText === 'string' ? (parsed as any).storyText : '';
    if (!storyText.trim()) {
      throw new Error('Invalid arena response.');
    }
    const imagePrompt = typeof (parsed as any).imagePrompt === 'string' ? (parsed as any).imagePrompt : '';
    if (!imagePrompt.trim()) {
      throw new Error('Invalid arena response.');
    }
    const forcePowers = Array.isArray((parsed as any).forcePowers)
      ? (parsed as any).forcePowers.map((value: any) => Number(value))
      : undefined;
    if (mode === 'wargame' && (!forcePowers || forcePowers.length !== involvedParties.length)) {
      throw new Error('Invalid force power output.');
    }
    (parsed as any).tokenUsage = tokenUsage;
    return { storyText, tokenUsage, forcePowers, imagePrompt };
  }
  throw new Error('Invalid arena response.');
}

export async function getStatusUpdate(
  player: Actor,
  quests: Quest[],
  knownNpcs: Actor[],
  year: number,
  location: string,
  currentTime: string,
  narration: string,
  lang: Language,
  options?: { tier?: UserTier; apiKey?: string; textModel?: TextModelId }
): Promise<StatusUpdate & { tokenUsage?: TokenUsage }> {
  const { key: apiKey } = resolveApiKey(options?.apiKey);
  const ai = new GoogleGenAI({ apiKey: apiKey || '' });
  const targetLang = lang === 'zh' ? 'Chinese' : 'English';
  const selectedTextModel = options?.textModel || DEFAULT_TEXT_MODEL;

  const prompt = `
    Environment Year: ${year}
    Environment Location: ${location}
    Current Time: ${currentTime}
    Current Player Status: ${JSON.stringify(player)}
    Current Quests: ${JSON.stringify(quests)}
    Known NPCs: ${JSON.stringify(knownNpcs)}

    INPUT TEXT:
    ${narration}

    TASK:
    Update status fields based on the input text. Return JSON with keys:
    playerChange, questUpdates, companionUpdates, newNpc (array), knownNpcsUpdates (array), timePassedMinutes, location, currentYear, currentTime.
    playerChange should contain only changed fields; for unchanged values use 0/false/empty lists or objects, including inventoryChange with add/remove lists.
    All numeric playerChange fields must be deltas (positive or negative), not final totals. special and skills are per-stat deltas.
    Each newNpc entry MUST include appearance (short physical description).
    Use knownNpcsUpdates to modify existing known NPCs (e.g., mark as dead). Use newNpc only for newly discovered NPCs.
    You are encouraged to use playerChange.perksAdd/perksRemove to add/remove player perks to reflect a consequence of an event. You are also encouraged to use knownNpcsUpdates.perksAdd/perksRemove to add/remove NPC/companion perks to reflect a consequence of an event. Use knownNpcsUpdates.inventoryChange.add/remove to update NPC/companion inventory (do not output full inventories).
    currentTime MUST be full ISO 8601 UTC, e.g. 2281-07-15T17:05:00.000Z.
    If no changes are needed, use empty string/0/false (or []/{} for lists/objects). timePassedMinutes should be 0 if no time passes.
  `;
  const systemInstruction = `You are the Vault-Tec Status Manager.
          1. PURPOSE: Emit ONLY status changes shown in the status bar (player stats, inventory, caps, quests, known NPCs/companions, location/year/time, timePassedMinutes).
          2. INPUTS: Use the CURRENT STATUS and the INPUT TEXT only (event outcome summary or narration). Do NOT infer changes that are not explicitly stated or clearly implied by the text.
          3. CONSISTENCY: Keep existing items, caps, perks, SPECIAL, skills, and quests unless the narration clearly changes them. Never invent trades or items.
          4. INVENTORY CHANGE: Use inventoryChange.add/remove only. add items with full details; remove uses name + count. Do NOT output full inventory lists.
          5. PLAYER CHANGE: All numeric playerChange fields are DELTAS (positive or negative), not final totals. special and skills are per-stat deltas.
          6. QUESTS: Return questUpdates entries only when a quest is created, advanced, completed, or failed. Do not delete quests.
          7. OUTPUT LANGUAGE: All text fields must be in ${targetLang}.
          8. NEW NPCS: For newNpc entries, include a short physical appearance description in the appearance field.
          9. KNOWN NPC UPDATES: Use knownNpcsUpdates to modify existing known NPCs (e.g., mark as dead). Do not add new NPCs there. Use perksAdd/perksRemove to add/remove NPC/companion perks; avoid replacing the full perks array unless you must fully redefine it. Use inventoryChange.add/remove to update NPC/companion inventory; do NOT output full inventory lists.
          10. PERKS: Use playerChange.perksAdd/perksRemove to add/remove player perks.
          11. RETURN FORMAT: Return JSON only with all keys. If nothing changes, use empty string/0/false (or []/{} for lists/objects). timePassedMinutes should be 0 if no time passes.
          12. TIME FORMAT: currentTime MUST be full ISO 8601 UTC, e.g. 2281-07-15T17:05:00.000Z. Do NOT return time-only like "16:17".
          13. LORE: Respect Fallout lore for year ${year} and location ${location}.`;

  const response = await ai.models.generateContent({
    model: selectedTextModel,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: statusSchema,
      systemInstruction
    }
  });

  if (!response.text) throw new Error("Connection to the Wasteland lost.");
    const parsed = safeJsonParse(response.text);
    const normalized = normalizeInventoryChangeCarrier(parsed);
    const tokenUsage = normalizeTokenUsage({
      promptTokens: response.usageMetadata?.promptTokenCount,
      completionTokens: response.usageMetadata?.candidatesTokenCount,
      totalTokens: response.usageMetadata?.totalTokenCount
    }, `${systemInstruction}\n${prompt}`, response.text);
    if (normalized && typeof normalized === 'object') {
      (normalized as any).tokenUsage = tokenUsage;
      return normalized as StatusUpdate & { tokenUsage?: TokenUsage };
    }
    return { tokenUsage } as StatusUpdate & { tokenUsage?: TokenUsage };
  }

export async function refreshInventory(
  inventory: InventoryItem[],
  lang: Language,
  options?: { tier?: UserTier; apiKey?: string; textModel?: TextModelId }
): Promise<{ inventory: InventoryItem[] } & { tokenUsage?: TokenUsage }> {
  const { key: apiKey } = resolveApiKey(options?.apiKey);
  const ai = new GoogleGenAI({ apiKey: apiKey || '' });
  const targetLang = lang === 'zh' ? 'Chinese' : 'English';
  const selectedTextModel = options?.textModel || DEFAULT_TEXT_MODEL;

  const prompt = `
    Current Inventory (JSON):
    ${JSON.stringify(inventory)}

    TASK:
    Return JSON with key inventory containing the rectified items.
  `;
  const systemInstruction = `You are the Vault-Tec Inventory Auditor.
          1. PURPOSE: Clean and rectify the player's inventory data only.
          2. WEIGHT FIX: If an item's weight is 0 lb, verify via Fallout Wiki and correct it. If the item truly weighs 0 (e.g. bottle caps), keep 0.
          3. COUNT FIX: If count is missing or invalid, assign a reasonable count based on item type and description. Default to 1 if unsure.
          4. CONSUMABLE FLAG: Set isConsumable=true for items that are eaten/used up (Aid/food/chems/drinks, stimpaks, etc.). Set false otherwise.
          5. CONSISTENCY: Do not rename items or change their type/description unless clearly wrong. Keep value unless obviously invalid.
          6. OUTPUT LANGUAGE: All text fields must be in ${targetLang}.
          7. RETURN FORMAT: Return JSON only with key inventory.`;

  const response = await ai.models.generateContent({
    model: selectedTextModel,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: inventoryRefreshSchema,
      systemInstruction
    }
  });

  if (!response.text) throw new Error("Connection to the Wasteland lost.");
  const parsed = safeJsonParse(response.text);
  const tokenUsage = normalizeTokenUsage({
    promptTokens: response.usageMetadata?.promptTokenCount,
    completionTokens: response.usageMetadata?.candidatesTokenCount,
    totalTokens: response.usageMetadata?.totalTokenCount
  }, `${systemInstruction}\n${prompt}`, response.text);
  const items = parsed && typeof parsed === 'object' && Array.isArray(parsed.inventory) ? parsed.inventory : [];
  return { inventory: items, tokenUsage };
}

export async function auditInventoryWeights(
  inventory: InventoryItem[],
  lang: Language,
  options?: { tier?: UserTier; apiKey?: string; textModel?: TextModelId }
): Promise<{ inventory: InventoryItem[] } & { tokenUsage?: TokenUsage }> {
  const { key: apiKey } = resolveApiKey(options?.apiKey);
  const ai = new GoogleGenAI({ apiKey: apiKey || '' });
  const targetLang = lang === 'zh' ? 'Chinese' : 'English';
  const selectedTextModel = options?.textModel || DEFAULT_TEXT_MODEL;

  const prompt = `
    Current Inventory (JSON):
    ${JSON.stringify(inventory)}

    TASK:
    Return JSON with key inventory containing the same items, with weight corrected if needed.
  `;
  const systemInstruction = `You are the Vault-Tec Inventory Auditor.
          1. PURPOSE: Only verify and correct item WEIGHT values.
          2. WEIGHT RULE: If weight is 0 lb, verify via Fallout Wiki and correct it. If the item truly weighs 0 (e.g. bottle caps), keep 0.
          3. DO NOT change name, type, description, value, count, or isConsumable.
          4. OUTPUT LANGUAGE: All text fields must be in ${targetLang}.
          5. RETURN FORMAT: Return JSON only with key inventory.`;

  const response = await ai.models.generateContent({
    model: selectedTextModel,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: inventoryRefreshSchema,
      systemInstruction
    }
  });

  if (!response.text) throw new Error("Connection to the Wasteland lost.");
  const parsed = safeJsonParse(response.text);
  const tokenUsage = normalizeTokenUsage({
    promptTokens: response.usageMetadata?.promptTokenCount,
    completionTokens: response.usageMetadata?.candidatesTokenCount,
    totalTokens: response.usageMetadata?.totalTokenCount
  }, `${systemInstruction}\n${prompt}`, response.text);
  const items = parsed && typeof parsed === 'object' && Array.isArray(parsed.inventory) ? parsed.inventory : [];
  return { inventory: items, tokenUsage };
}

export async function recoverInventoryStatus(
  lore: string,
  narrations: string[],
  lang: Language,
  options?: { tier?: UserTier; apiKey?: string; textModel?: TextModelId }
): Promise<{ initialInventory: InventoryItem[]; inventoryChanges: { narration_index: number; inventoryChange: any }[] } & { tokenUsage?: TokenUsage }> {
  const { key: apiKey } = resolveApiKey(options?.apiKey);
  const ai = new GoogleGenAI({ apiKey: apiKey || '' });
  const targetLang = lang === 'zh' ? 'Chinese' : 'English';
  const selectedTextModel = options?.textModel || DEFAULT_TEXT_MODEL;

  const prompt = `
    PLAYER LORE:
    ${lore}

    NARRATIONS (1-based):
    ${narrations.map((text, index) => `[${index + 1}] ${text}`).join('\n')}

    TASK:
    Return JSON with initialInventory and inventoryChanges (narration_index + inventoryChange).
  `;
  const systemInstruction = `You are the Vault-Tec Inventory Recovery System.
          1. PURPOSE: Reconstruct the inventory timeline for an old save.
          2. INPUTS: Use player lore and the full narration list. Do NOT use player actions.
          3. OUTPUTS:
            - initialInventory: the player's starting inventory based on lore.
            - inventoryChanges: list of inventoryChange entries keyed by narration_index (1-based, narrator entries only).
          4. inventoryChange must use add/remove only. add items with full details; remove uses name + count.
          5. Do NOT invent items unless narration clearly implies gain or loss.
          6. OUTPUT LANGUAGE: All text fields must be in ${targetLang}.
          7. RETURN FORMAT: Return JSON only.`;

  const response = await ai.models.generateContent({
    model: selectedTextModel,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: inventoryRecoverySchema,
      systemInstruction
    }
  });

  if (!response.text) throw new Error("Connection to the Wasteland lost.");
  const parsed = safeJsonParse(response.text);
  const tokenUsage = normalizeTokenUsage({
    promptTokens: response.usageMetadata?.promptTokenCount,
    completionTokens: response.usageMetadata?.candidatesTokenCount,
    totalTokens: response.usageMetadata?.totalTokenCount
  }, `${systemInstruction}\n${prompt}`, response.text);
  const initialInventory = parsed && typeof parsed === 'object' && Array.isArray(parsed.initialInventory) ? parsed.initialInventory : [];
  const inventoryChanges = parsed && typeof parsed === 'object' && Array.isArray(parsed.inventoryChanges) ? parsed.inventoryChanges : [];
  return { initialInventory, inventoryChanges, tokenUsage };
}

const removeBase64Images = (text: string) => {
  return text.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[BASE64_IMAGE_REMOVED]');
};

export async function compressMemory(
  payload: { saveState: any; compressedMemory: string; recentHistory: HistoryEntry[] },
  lang: Language,
  maxMemoryK: number,
  options?: { tier?: UserTier; apiKey?: string; textModel?: TextModelId }
): Promise<{ memory: string; tokenUsage?: TokenUsage }> {
  const selectedTextModel = options?.textModel || DEFAULT_TEXT_MODEL;
  const { key: apiKey } = resolveApiKey(options?.apiKey);
  const ai = new GoogleGenAI({ apiKey: apiKey || '' });
  const targetLang = lang === 'zh' ? 'Chinese' : 'English';
  
  const historyText = payload.recentHistory
    .map(entry => `${entry.sender?.toUpperCase?.() || 'NARRATOR'}: ${entry.text}`)
    .join('\n');
  
  const safeHistoryText = removeBase64Images(historyText);
  const safeSaveState = removeBase64Images(JSON.stringify(payload.saveState));
  const safeCompressedMemory = removeBase64Images(payload.compressedMemory || 'None');

  const prompt = `SAVE STATE (JSON, no history):
${safeSaveState}

EXISTING COMPRESSED MEMORY:
${safeCompressedMemory}

RECENT HISTORY:
${safeHistoryText}

Return JSON: {"memory": "..."} only.`;
  const systemInstruction = `You are the Vault-Tec Memory Compression System.
1. Summarize the narrative memory for long-term continuity.
2. Keep the memory at or under ${maxMemoryK}K tokens.
3. Output language must be ${targetLang}.
4. Return JSON with key "memory" only.`;

  const response = await ai.models.generateContent({
    model: selectedTextModel,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: memorySchema,
      systemInstruction
    }
  });

  if (!response.text) throw new Error("No response from compression service.");
  const parsed = safeJsonParse(response.text);
  const memory = typeof parsed?.memory === 'string' ? parsed.memory.trim() : '';
  const tokenUsage = normalizeTokenUsage({
    promptTokens: response.usageMetadata?.promptTokenCount,
    completionTokens: response.usageMetadata?.candidatesTokenCount,
    totalTokens: response.usageMetadata?.totalTokenCount
  }, `${systemInstruction}\n${prompt}`, response.text);
  if (!memory) {
    throw new Error("Compression returned empty memory.");
  }
  return { memory, tokenUsage };
}

export async function generateCompanionAvatar(
  npc: Actor,
  options?: { tier?: UserTier; apiKey?: string; imageModel?: ImageModelId; imageUserSystemPrompt?: string }
): Promise<{ url?: string; error?: string } | undefined> {
  const selectedImageModel = options?.imageModel || DEFAULT_IMAGE_MODEL;
  const { key: apiKey } = resolveApiKey(options?.apiKey);
  const appearance = npc.appearance?.trim() || npc.lore?.trim();
  const appearanceLine = appearance ? `Appearance: ${appearance}.` : '';
  const guidanceLine = options?.imageUserSystemPrompt?.trim();
  const guidanceBlock = guidanceLine ? `\nUser guidance: ${guidanceLine}` : '';
  const prompt = `Fallout companion portrait. Name: ${npc.name}. Faction: ${npc.faction}. Gender: ${npc.gender}. Age: ${npc.age}. ${appearanceLine} Style: Pip-Boy dossier headshot, gritty, realistic, neutral background.${guidanceBlock}`;

  try {
    const imageAi = new GoogleGenAI({ apiKey: apiKey || '' });
    const response = await imageAi.models.generateContent({
      model: selectedImageModel,
      contents: {
        parts: [{ text: prompt }],
      },
      config: {
        imageConfig: { aspectRatio: "1:1" }
      },
    });

    if ((response as any)?.error) {
      return { error: (response as any).error };
    }

    if (response.candidates?.[0]?.content?.parts) {
      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData) {
          const rawBase64 = `data:image/png;base64,${part.inlineData.data}`;
          const resized = await resizeImageToSquare(rawBase64, 100);
          return { url: resized };
        }
      }
    }
    return { error: "No image data returned from the model." };
  } catch (e) {
    console.error("Companion avatar generation failed:", e);
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Two-stage generation (optional):
 * Stage 1: Research visual details with a text model and Google Search.
 * Stage 2: Generate the image with an image model based on research findings.
 */
export async function generateSceneImage(
  prompt: string,
  options?: { highQuality?: boolean; tier?: UserTier; apiKey?: string; imageModel?: ImageModelId; textModel?: TextModelId }
): Promise<{url?: string, sources?: GroundingSource[], error?: string} | undefined> {
  const useHighQuality = options?.highQuality !== false;
  const selectedTextModel = options?.textModel || DEFAULT_TEXT_MODEL;
  const selectedImageModel = options?.imageModel || DEFAULT_IMAGE_MODEL;
  const { key: apiKey } = resolveApiKey(options?.apiKey);

  try {
    let detailedDescription = prompt;
    let groundingSources: GroundingSource[] = [];

    if (useHighQuality) {
      // STAGE 1: Visual Research using Search Grounding
      // We explicitly extract keywords and use Search to "see" what things look like.
      const researchResponse = await (async () => {
        const researchAi = new GoogleGenAI({ apiKey: apiKey || '' });
        try {
          return await researchAi.models.generateContent({
            model: selectedTextModel,
            contents: `Research visual references for this Fallout scene: "${prompt}".
            1. Extract 3-5 keywords related to Fallout lore, items, or environment.
            2. Search for these keywords + "Fallout" on Google to identify high-quality visual benchmarks (e.g. from Fallout 4 or New Vegas).
            3. Based on your search results, describe the exact textures, lighting (e.g. dawn over the Mojave, fluorescent flickering in a vault), and key props.
            4. Format your final response as a detailed scene description for a concept artist.`,
            config: {
              tools: [{ googleSearch: {} }]
            }
          });
        } catch {
          return undefined;
        }
      })();

      if (researchResponse) {
        detailedDescription = researchResponse.text || prompt;

        // Extract search grounding sources to display in the UI as per SDK rules.
        groundingSources = researchResponse.candidates?.[0]?.groundingMetadata?.groundingChunks
          ?.filter((chunk: any) => chunk.web)
          ?.map((chunk: any) => ({
            title: chunk.web.title,
            uri: chunk.web.uri
          })) || [];
      }
    }

    // STAGE 2: Image generation
    const imageAi = new GoogleGenAI({ apiKey: apiKey || '' });
    const imageResponse = await imageAi.models.generateContent({
      model: selectedImageModel,
      contents: {
        parts: [{ text: `Cinematic Fallout Concept Art. Environment: ${detailedDescription}. Atmosphere: Desolate, atmospheric, detailed. Style: Digital art, 4k, hyper-realistic wasteland aesthetic.` }],
      },
      config: { 
        imageConfig: { aspectRatio: "16:9" }
      },
    });

    if ((imageResponse as any)?.error) {
      return { error: (imageResponse as any).error };
    }

    if (imageResponse.candidates?.[0]?.content?.parts) {
      for (const part of imageResponse.candidates[0].content.parts) {
        if (part.inlineData) {
          const rawBase64 = `data:image/png;base64,${part.inlineData.data}`;
          const compressed = await compressImage(rawBase64);
          return { url: compressed, sources: groundingSources };
        }
      }
    }
    return { error: "No image data returned from the model." };
  } catch (e) {
    console.error("Image generation failed:", e);
    return { error: e instanceof Error ? e.message : String(e) };
  }
  return undefined;
}
