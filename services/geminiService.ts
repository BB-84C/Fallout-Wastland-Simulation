
import { GoogleGenAI, Type } from "@google/genai";
import { Actor, NarratorResponse, SpecialAttr, Skill, Language, Quest, GroundingSource, UserTier, PlayerCreationResult, TextModelId, ImageModelId, TokenUsage, StatusUpdate, InventoryItem, HistoryEntry } from "../types";

const actorSchema = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING },
    age: { type: Type.NUMBER },
    gender: { type: Type.STRING },
    faction: { type: Type.STRING },
    special: {
      type: Type.OBJECT,
      properties: {
        [SpecialAttr.Strength]: { type: Type.NUMBER },
        [SpecialAttr.Perception]: { type: Type.NUMBER },
        [SpecialAttr.Endurance]: { type: Type.NUMBER },
        [SpecialAttr.Charisma]: { type: Type.NUMBER },
        [SpecialAttr.Intelligence]: { type: Type.NUMBER },
        [SpecialAttr.Agility]: { type: Type.NUMBER },
        [SpecialAttr.Luck]: { type: Type.NUMBER },
      },
      required: Object.values(SpecialAttr)
    },
    skills: {
      type: Type.OBJECT,
      properties: Object.values(Skill).reduce((acc: Record<string, any>, skill) => ({ ...acc, [skill]: { type: Type.NUMBER } }), {})
    },
    perks: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          description: { type: Type.STRING },
          rank: { type: Type.NUMBER }
        }
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
  required: ["name", "age", "faction", "special", "skills", "lore", "health", "maxHealth", "caps"]
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
  required: actorSchema.required
};

const memorySchema = {
  type: Type.OBJECT,
  properties: {
    memory: { type: Type.STRING }
  },
  required: ["memory"]
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

const statusSchema = {
  type: Type.OBJECT,
  properties: {
    updatedPlayer: actorSchema,
    questUpdates: questSchema,
    companionUpdates: companionUpdatesSchema,
    newNpc: actorSchema,
    location: { type: Type.STRING },
    currentYear: { type: Type.NUMBER }
  }
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
    const repaired = sanitizeJsonText(trimmed);
    return JSON.parse(repaired);
  }
}

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
          5. PERK SYSTEM: Assign 1-2 starting perks.
          6. COMPANIONS: If the user specifies existing companions, include a 'companions' array with full NPC profiles and set ifCompanion=true.
          7. SKILLS: The skills object must include all skills with numeric values (do not omit any skill).
          8. FIELDS TO LOCALIZE: name, faction, lore, perks[].name, perks[].description, inventory[].name, inventory[].description, companions[].name, companions[].faction, companions[].lore, companions[].perks[].name, companions[].perks[].description, companions[].inventory[].name, companions[].inventory[].description.
          ${options?.userSystemPrompt?.trim() ? `9. USER DIRECTIVE: ${options.userSystemPrompt.trim()}` : ''}`;
  const prompt = `Create a Fallout character for the year ${year} in ${region} based on this input: "${userInput}". Ensure they have appropriate initial perks, inventory, and starting Bottle Caps (50-200 caps). If the user mentions starting companions, include them.`;

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
  `;
  const systemInstruction = `You are the Fallout Overseer. 
          1. SOURCE: Strictly source all lore, item stats, and location details from the Fallout Wiki in English.
          1.1. OUTPUT RULE: Never cite sources, URLs, or parenthetical provenance in player-facing narration. Keep the narration immersive.
          2. MANDATORY LANGUAGE: You MUST output all text presented to the player in ${targetLang}.
      3. STATUS CONTROL: Do NOT update quests, inventory, caps, perks, companions, location, or any player/NPC stats. A separate status manager handles all status updates.
      4. RULE GUARD: If player dictates narrative outcomes, return 'ruleViolation'.
      5. TRANSLATION: Use "Term (Original)" for unlocalized items.
      6. CONSISTENCY: Ensure current year (${year}) and location (${location}) lore is followed.
      ${options?.userSystemPrompt?.trim() ? `7. USER DIRECTIVE: ${options.userSystemPrompt.trim()}` : ''}`;

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

    LAST NARRATION:
    ${narration}

    TASK:
    Update status fields based on the narration. Return JSON with optional keys:
    updatedPlayer, questUpdates, companionUpdates, newNpc, location, currentYear.
    If no changes are needed, return {}.
  `;
  const systemInstruction = `You are the Vault-Tec Status Manager.
          1. PURPOSE: Update ONLY status data shown in the status bar (player stats, inventory, caps, quests, known NPCs/companions, location/year).
          2. INPUTS: Use the CURRENT STATUS and the LAST NARRATION only. Do NOT infer changes that are not explicitly stated or clearly implied by the narration.
          3. CONSISTENCY: Keep existing items, caps, perks, SPECIAL, skills, and quests unless the narration clearly changes them. Never invent trades or items.
          4. INVENTORY: Items include count (number) and isConsumable (boolean). If a consumable is used, decrement its count. Remove items with count <= 0. Do not change counts unless the narration implies use, loss, or gain.
          5. QUESTS: Return questUpdates entries only when a quest is created, advanced, completed, or failed. Do not delete quests.
          6. OUTPUT LANGUAGE: All text fields must be in ${targetLang}.
          7. RETURN FORMAT: Return JSON only. If nothing changes, return an empty object {}.
          8. LORE: Respect Fallout lore for year ${year} and location ${location}.`;

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
  const tokenUsage = normalizeTokenUsage({
    promptTokens: response.usageMetadata?.promptTokenCount,
    completionTokens: response.usageMetadata?.candidatesTokenCount,
    totalTokens: response.usageMetadata?.totalTokenCount
  }, `${systemInstruction}\n${prompt}`, response.text);
  if (parsed && typeof parsed === 'object') {
    (parsed as any).tokenUsage = tokenUsage;
    return parsed as StatusUpdate & { tokenUsage?: TokenUsage };
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
  const prompt = `SAVE STATE (JSON, no history):
${JSON.stringify(payload.saveState)}

EXISTING COMPRESSED MEMORY:
${payload.compressedMemory || 'None'}

RECENT HISTORY:
${historyText}

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
  options?: { tier?: UserTier; apiKey?: string; imageModel?: ImageModelId }
): Promise<{ url?: string; error?: string } | undefined> {
  const selectedImageModel = options?.imageModel || DEFAULT_IMAGE_MODEL;
  const { key: apiKey } = resolveApiKey(options?.apiKey);
  const prompt = `Fallout companion portrait. Name: ${npc.name}. Faction: ${npc.faction}. Gender: ${npc.gender}. Age: ${npc.age}. Style: Pip-Boy dossier headshot, gritty, realistic, neutral background.`;

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
