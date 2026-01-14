import { GoogleGenAI, Type } from "@google/genai";
import { Actor, NarratorResponse, Language, Quest, GroundingSource, UserTier, PlayerCreationResult, TextModelId, ImageModelId, ModelProvider, SpecialAttr, Skill, TokenUsage, HistoryEntry, StatusUpdate, InventoryItem } from "../types";
import {
  createPlayerCharacter as createGeminiPlayer,
  getNarrativeResponse as getGeminiNarration,
  generateSceneImage as generateGeminiScene,
  generateCompanionAvatar as generateGeminiAvatar,
  compressMemory as compressGeminiMemory,
  getStatusUpdate as getGeminiStatusUpdate,
  refreshInventory as refreshGeminiInventory
} from "./geminiService";

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const CLAUDE_BASE_URL = "https://api.anthropic.com/v1";
const DOUBAO_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";

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

const actorSchemaHint = `Return JSON with keys:
name, age, gender, faction, special, skills, perks, inventory, lore, health, maxHealth, karma, caps, ifCompanion (optional), avatarUrl (optional).
Inventory items must include count (number) and isConsumable (boolean).
Skills must include numeric values for: Small Guns, Big Guns, Energy Weapons, Unarmed, Melee Weapons, Medicine, Repair, Science, Sneak, Lockpick, Steal, Speech, Barter, Survival.`;

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
        [SpecialAttr.Luck]: { type: Type.NUMBER }
      },
      required: Object.values(SpecialAttr)
    },
    skills: {
      type: Type.OBJECT,
      properties: Object.values(Skill).reduce(
        (acc: Record<string, any>, skill) => ({ ...acc, [skill]: { type: Type.NUMBER } }),
        {}
      )
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

const memorySchema = {
  type: Type.OBJECT,
  properties: {
    memory: { type: Type.STRING }
  },
  required: ["memory"]
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

const buildCharacterSystem = (targetLang: string, userSystemPrompt?: string) => `You are the Vault-Tec Identity Reconstruction System.
1. INTERNAL PROCESSING: Always research and use the Fallout Wiki in English for lore accuracy.
2. MANDATORY LANGUAGE: All text fields in the final JSON MUST be in ${targetLang}.
3. TRANSLATION RULE: Use official Fallout localizations for ${targetLang}. If an official term does not exist, translate it manually and append the original English in parentheses.
4. ECONOMY: Assign 50-200 starting caps in the 'caps' field.
5. PERK SYSTEM: Assign 1-2 starting perks. And 1 perk particularly relevant to the character background.
6. COMPANIONS: If the user specifies existing companions, include a 'companions' array with full NPC (even animals or any creatures) profiles and set ifCompanion=true.
7. SKILLS: The skills object must include all skills with numeric values (do not omit any skill).
8. FIELDS TO LOCALIZE: name, faction, lore, perks[].name, perks[].description, inventory[].name, inventory[].description, companions[].name, companions[].faction, companions[].lore, companions[].perks[].name, companions[].perks[].description, companions[].inventory[].name, companions[].inventory[].description.
${userSystemPrompt && userSystemPrompt.trim() ? `9. USER DIRECTIVE: ${userSystemPrompt.trim()}` : ''}
${actorSchemaHint}`;

const buildNarratorSystem = (targetLang: string, year: number, location: string, userSystemPrompt?: string) => `You are the Fallout Overseer.
1. SOURCE: Strictly source all lore, item stats, and location details from the Fallout Wiki in English.
1.1. OUTPUT RULE: Never cite sources, URLs, or parenthetical provenance in player-facing narration. Keep the narration immersive.
2. MANDATORY LANGUAGE: You MUST output all text presented to the player in ${targetLang}.
3. STATUS CONTROL: Do NOT update quests, inventory, caps, perks, companions, location, or any player/NPC stats. A separate status manager handles all status updates.
4. RULE GUARD: Player can only dictates what they think and what action will take. If player dictates narrative outcomes or facts/result of their will-do action, return 'ruleViolation'.
5. TRANSLATION: Use "Term (Original)" for unlocalized items.
6. CONSISTENCY: Ensure current year (${year}) and location (${location}) lore is followed.
${userSystemPrompt && userSystemPrompt.trim() ? `7. USER DIRECTIVE: ${userSystemPrompt.trim()}` : ''}`;

const buildStatusSystem = (targetLang: string, year: number, location: string) => `You are the Vault-Tec Status Manager.
1. PURPOSE: Update ONLY status data shown in the status bar (player stats, inventory, caps, quests, known NPCs/companions, location/year).
2. INPUTS: Use the CURRENT STATUS and the LAST NARRATION only. Do NOT infer changes that are not explicitly stated or clearly implied by the narration.
3. CONSISTENCY: Keep existing items, caps, perks, SPECIAL, skills, and quests unless the narration clearly changes them. Never invent trades or items.
4. INVENTORY: Items include count (number) and isConsumable (boolean). If a consumable is used, decrement its count. Remove items with count <= 0. Do not change counts unless the narration implies use, loss, or gain.
5. QUESTS: Return questUpdates entries only when a quest is created, advanced, completed, or failed. Do not delete quests.
6. OUTPUT LANGUAGE: All text fields must be in ${targetLang}.
7. RETURN FORMAT: Return JSON only. If nothing changes, return an empty object {}.
8. LORE: Respect Fallout lore for year ${year} and location ${location}.`;

const buildNarratorPrompt = (
  player: Actor,
  history: any[],
  userInput: string,
  year: number,
  location: string,
  quests: Quest[],
  knownNpcs: Actor[]
) => `
Environment Year: ${year}
Environment Location: ${location}
Current Player Profile: ${JSON.stringify(player)}
Existing Quests: ${JSON.stringify(quests)}
Known NPCs: ${JSON.stringify(knownNpcs)}
Interaction Context:
${history.map(h => `${h.sender.toUpperCase()}: ${h.text}`).join("\n")}
Player's current intent/action: "${userInput}"

TASK:
1. Determine the outcome of the action.
2. Narrate the outcome as a DM of a Fallout RPG, focusing on vivid descriptions, character dialogues, and environmental details.
3. Avoid assuming the player is the protagonist, unless the user specified or the player background says so.
4. You are encouraged to create new events for the player that fit within the Fallout universe to enhance the story.
5. You are not encouraged to force bind the existed wiki events/quest to the player. Only do that occasionally if it fits well.
6. If the player's action includes using an item that is not in their inventory, don't return a rule violation. Instead, narrate how the player realizes they don't have the item.
Return strict JSON with keys: storyText, ruleViolation, timePassedMinutes, imagePrompt.`;

const buildStatusPrompt = (
  player: Actor,
  quests: Quest[],
  knownNpcs: Actor[],
  year: number,
  location: string,
  currentTime: string,
  narration: string
) => `
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
If no changes are needed, return {}.`;

const buildInventoryRefreshSystem = (targetLang: string) => `You are the Vault-Tec Inventory Auditor.
1. PURPOSE: Clean and rectify the player's inventory data only.
2. WEIGHT FIX: If an item's weight is 0 lb, verify via Fallout Wiki and correct it. If the item truly weighs 0 (e.g. bottle caps), keep 0.
3. COUNT FIX: If count is missing or invalid, assign a reasonable count based on item type and description. Default to 1 if unsure.
4. CONSUMABLE FLAG: Set isConsumable=true for items that are eaten/used up (Aid/food/chems/drinks, stimpaks, etc.). Set false otherwise.
5. CONSISTENCY: Do not rename items or change their type/description unless clearly wrong. Keep value unless obviously invalid.
6. OUTPUT LANGUAGE: All text fields must be in ${targetLang}.
7. RETURN FORMAT: Return JSON only with key inventory.`;

const buildInventoryRefreshPrompt = (inventory: InventoryItem[]) => `
Current Inventory (JSON):
${JSON.stringify(inventory)}

TASK:
Return JSON with key inventory containing the rectified items.`;

const normalizeProvider = (provider?: ModelProvider): ModelProvider =>
  provider && ["openai", "gemini", "claude", "doubao"].includes(provider) ? provider : "gemini";

const requireApiKey = (apiKey: string | undefined, provider: ModelProvider) => {
  if (!apiKey) {
    throw new Error(`Missing API key for ${provider}.`);
  }
  return apiKey;
};

const normalizeBaseUrl = (value?: string) => {
  const trimmed = value?.trim() || "";
  if (!trimmed) return "";
  return trimmed.replace(/\/+$/, "");
};

const resolveBaseUrl = (provider: ModelProvider, baseUrl?: string) => {
  const normalized = normalizeBaseUrl(baseUrl);
  if (normalized) return normalized;
  switch (provider) {
    case "openai":
      return OPENAI_BASE_URL;
    case "claude":
      return CLAUDE_BASE_URL;
    case "doubao":
      return DOUBAO_BASE_URL;
    case "gemini":
    default:
      return "";
  }
};

const formatHttpError = async (res: Response, fallback: string) => {
  const text = await res.text();
  if (text) {
    return `${fallback} (HTTP ${res.status}): ${text}`;
  }
  return `${fallback} (HTTP ${res.status}).`;
};

const sanitizeJsonText = (text: string) => {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/```(?:json)?/gi, "").replace(/```/g, "");
  cleaned = cleaned.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  cleaned = cleaned.replace(/[\u0000-\u001F]+/g, " ");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    cleaned = cleaned.slice(start, end + 1);
  }
  cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");
  cleaned = cleaned.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
  let fixed = "";
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
    if (char === "\\") {
      escaped = true;
      fixed += char;
      continue;
    }
    if (char === '"') {
      const remainder = cleaned.slice(i + 1);
      const nextNonSpace = remainder.match(/\S/);
      const nextChar = nextNonSpace ? nextNonSpace[0] : "";
      if (nextChar && ![":", ",", "}", "]"].includes(nextChar)) {
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

const parseNarrator = (raw: any, fallbackPrompt: string): NarratorResponse => {
  const storyText = typeof raw?.storyText === "string" ? raw.storyText : "";
  const timePassedMinutes = typeof raw?.timePassedMinutes === "number" ? raw.timePassedMinutes : 0;
  return {
    storyText,
    ruleViolation: raw?.ruleViolation ?? null,
    timePassedMinutes,
    imagePrompt: raw?.imagePrompt || fallbackPrompt
  };
};

const buildImagePrompt = (prompt: string, highQuality: boolean) => {
  if (!highQuality) return prompt;
  return `Cinematic Fallout concept art. ${prompt}. Atmosphere: desolate, atmospheric, detailed. Style: digital art, 4k, hyper-realistic wasteland aesthetic.`;
};

async function compressImage(base64: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const targetHeight = 640;
      const h = img.height || 1;
      const w = img.width || 1;
      const scale = targetHeight / h;
      canvas.width = w * scale;
      canvas.height = targetHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(base64);
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.8));
    };
    img.onerror = () => resolve(base64);
    img.src = base64;
  });
}

async function resizeImageToSquare(base64: string, size: number): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const w = img.width || 1;
      const h = img.height || 1;
      const scale = Math.max(size / w, size / h);
      const drawW = w * scale;
      const drawH = h * scale;
      const dx = (size - drawW) / 2;
      const dy = (size - drawH) / 2;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(base64);
        return;
      }
      ctx.drawImage(img, dx, dy, drawW, drawH);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => resolve(base64);
    img.src = base64;
  });
}

const callOpenAiJson = async (apiKey: string, baseUrl: string, model: string, system: string, prompt: string) => {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt }
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: 2048
    })
  });
  if (!res.ok) {
    throw new Error(await formatHttpError(res, "OpenAI request failed"));
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || "";
  const usage = data?.usage;
  const tokenUsage = normalizeTokenUsage({
    promptTokens: usage?.prompt_tokens,
    completionTokens: usage?.completion_tokens,
    totalTokens: usage?.total_tokens
  }, `${system}\n${prompt}`, content);
  return { content, tokenUsage };
};

const callClaudeJson = async (apiKey: string, baseUrl: string, model: string, system: string, prompt: string) => {
  const res = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content: prompt }]
    })
  });
  if (!res.ok) {
    throw new Error(await formatHttpError(res, "Claude request failed"));
  }
  const data = await res.json();
  const content = data?.content?.find((part: any) => part?.text)?.text;
  const usage = data?.usage;
  const tokenUsage = normalizeTokenUsage({
    promptTokens: usage?.input_tokens,
    completionTokens: usage?.output_tokens,
    totalTokens: usage?.input_tokens && usage?.output_tokens ? usage.input_tokens + usage.output_tokens : undefined
  }, `${system}\n${prompt}`, content || "");
  return { content: content || "", tokenUsage };
};

const callDoubaoJson = async (apiKey: string, baseUrl: string, model: string, system: string, prompt: string) => {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt }
      ],
      response_format: { type: "json_object" },
      max_tokens: 2048
    })
  });
  if (!res.ok) {
    throw new Error(await formatHttpError(res, "Doubao request failed"));
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || "";
  const usage = data?.usage;
  const tokenUsage = normalizeTokenUsage({
    promptTokens: usage?.prompt_tokens,
    completionTokens: usage?.completion_tokens,
    totalTokens: usage?.total_tokens
  }, `${system}\n${prompt}`, content);
  return { content, tokenUsage };
};

const fetchImageAsBase64 = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch image (${res.status}).`);
  }
  const blob = await res.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Failed to read image data."));
    reader.readAsDataURL(blob);
  });
};

const generateOpenAiImage = async (apiKey: string, baseUrl: string, model: string, prompt: string) => {
  const requestBody = {
    model,
    prompt,
    size: "1024x1024",
    response_format: "b64_json"
  };
  let res = await fetch(`${baseUrl}/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(requestBody)
  });
  if (!res.ok) {
    const text = await res.text();
    if (text.includes("Unknown parameter: 'response_format'")) {
      const { response_format: _omit, ...retryBody } = requestBody;
      res = await fetch(`${baseUrl}/images/generations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(retryBody)
      });
      if (!res.ok) {
        throw new Error(await formatHttpError(res, "OpenAI image request failed"));
      }
    } else {
      const message = text
        ? `OpenAI image request failed (HTTP ${res.status}): ${text}`
        : `OpenAI image request failed (HTTP ${res.status}).`;
      throw new Error(message);
    }
  }
  const data = await res.json();
  const b64 = data?.data?.[0]?.b64_json as string | undefined;
  if (b64) return b64;
  const url = data?.data?.[0]?.url as string | undefined;
  if (url) {
    const dataUrl = await fetchImageAsBase64(url);
    return dataUrl.replace(/^data:image\/png;base64,/, "").replace(/^data:image\/jpeg;base64,/, "");
  }
  return undefined;
};

const generateDoubaoImage = async (apiKey: string, baseUrl: string, model: string, prompt: string) => {
  const res = await fetch(`${baseUrl}/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      prompt,
      size: "2048x2048",
      response_format: "b64_json"
    })
  });
  if (!res.ok) {
    throw new Error(await formatHttpError(res, "Doubao image request failed"));
  }
  const data = await res.json();
  return data?.data?.[0]?.b64_json as string | undefined;
};

export async function createPlayerCharacter(
  userInput: string,
  year: number,
  region: string,
  lang: Language,
  options?: { tier?: UserTier; onProgress?: (message: string) => void; apiKey?: string; proxyApiKey?: string; proxyBaseUrl?: string; useProxy?: boolean; textModel?: TextModelId; provider?: ModelProvider; userSystemPrompt?: string }
): Promise<PlayerCreationResult> {
  const provider = normalizeProvider(options?.provider);
  const useProxy = !!options?.useProxy;
  if (provider === "gemini") {
    if (options?.tier === "guest") {
      return createGeminiPlayer(userInput, year, region, lang, {
        tier: options?.tier,
        onProgress: options?.onProgress,
        apiKey: options?.apiKey,
        textModel: options?.textModel,
        userSystemPrompt: options?.userSystemPrompt
      });
    }
    const proxyBaseUrl = normalizeBaseUrl(options?.proxyBaseUrl);
    if (useProxy && !proxyBaseUrl) {
      throw new Error("Missing proxy base URL.");
    }
    const apiKey = requireApiKey(useProxy ? options?.proxyApiKey : options?.apiKey, provider);
    const model = options?.textModel || "";
    if (!model) {
      throw new Error("Missing text model name.");
    }
    const emit = (message: string) => options?.onProgress?.(message);
    const targetLang = lang === "zh" ? "Chinese" : "English";
    const system = buildCharacterSystem(targetLang, options?.userSystemPrompt);
    const prompt = `Create a Fallout character for the year ${year} in ${region} based on this input: "${userInput}". Ensure they have appropriate initial perks, inventory, and starting Bottle Caps (50-200 caps). If the user mentions starting companions, include them.`;
    const ai = new GoogleGenAI({
      apiKey,
      ...(proxyBaseUrl ? { httpOptions: { baseUrl: proxyBaseUrl } } : {})
    });
    emit(`Requesting character profile from ${model}...`);
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: playerCreationSchema,
        systemInstruction: system
      }
    });
    if (!response.text) {
      throw new Error("No response from Vault-Tec database.");
    }
    emit(`Response received (${response.text.length} chars). Parsing JSON...`);
    const tokenUsage = normalizeTokenUsage({
      promptTokens: response.usageMetadata?.promptTokenCount,
      completionTokens: response.usageMetadata?.candidatesTokenCount,
      totalTokens: response.usageMetadata?.totalTokenCount
    }, `${system}\n${prompt}`, response.text);
    const parsed = safeJsonParse(response.text);
    if (parsed && typeof parsed === "object") {
      parsed.tokenUsage = tokenUsage;
    }
    emit("Character JSON parsed successfully.");
    return parsed;
  }

  const baseUrl = resolveBaseUrl(provider, useProxy ? options?.proxyBaseUrl : undefined);
  if (useProxy && !baseUrl) {
    throw new Error("Missing proxy base URL.");
  }
  const apiKey = requireApiKey(useProxy ? options?.proxyApiKey : options?.apiKey, provider);
  const model = options?.textModel || "";
  if (!model) {
    throw new Error("Missing text model name.");
  }

  const targetLang = lang === "zh" ? "Chinese" : "English";
  const system = buildCharacterSystem(targetLang, options?.userSystemPrompt);
  const prompt = `Create a Fallout character for the year ${year} in ${region} based on this input: "${userInput}". Ensure they have appropriate initial perks, inventory, and starting Bottle Caps (50-200 caps). If the user mentions starting companions, include them.`;

  const result = provider === "openai"
    ? await callOpenAiJson(apiKey, baseUrl, model, system, prompt)
    : provider === "claude"
      ? await callClaudeJson(apiKey, baseUrl, model, system, prompt)
      : await callDoubaoJson(apiKey, baseUrl, model, system, prompt);

  const parsed = safeJsonParse(result.content);
  if (parsed && typeof parsed === "object") {
    parsed.tokenUsage = result.tokenUsage;
  }
  return parsed;
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
  options?: { tier?: UserTier; apiKey?: string; proxyApiKey?: string; proxyBaseUrl?: string; useProxy?: boolean; textModel?: TextModelId; provider?: ModelProvider; userSystemPrompt?: string }
): Promise<NarratorResponse> {
  const provider = normalizeProvider(options?.provider);
  const useProxy = !!options?.useProxy;
  if (provider === "gemini") {
    if (options?.tier === "guest") {
      return getGeminiNarration(player, history, userInput, year, location, quests, knownNpcs, lang, {
        tier: options?.tier,
        apiKey: options?.apiKey,
        textModel: options?.textModel,
        userSystemPrompt: options?.userSystemPrompt
      });
    }
    const proxyBaseUrl = normalizeBaseUrl(options?.proxyBaseUrl);
    if (useProxy && !proxyBaseUrl) {
      throw new Error("Missing proxy base URL.");
    }
    const apiKey = requireApiKey(useProxy ? options?.proxyApiKey : options?.apiKey, provider);
    const model = options?.textModel || "";
    if (!model) {
      throw new Error("Missing text model name.");
    }
    const targetLang = lang === "zh" ? "Chinese" : "English";
    const system = buildNarratorSystem(targetLang, year, location, options?.userSystemPrompt);
    const prompt = buildNarratorPrompt(player, history, userInput, year, location, quests, knownNpcs);
    const ai = new GoogleGenAI({
      apiKey,
      ...(proxyBaseUrl ? { httpOptions: { baseUrl: proxyBaseUrl } } : {})
    });
    const response = await ai.models.generateContent({
      model,
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
        systemInstruction: system
      }
    });
    if (!response.text) {
      throw new Error("Connection to the Wasteland lost.");
    }
    const tokenUsage = normalizeTokenUsage({
      promptTokens: response.usageMetadata?.promptTokenCount,
      completionTokens: response.usageMetadata?.candidatesTokenCount,
      totalTokens: response.usageMetadata?.totalTokenCount
    }, `${system}\n${prompt}`, response.text);
    const parsed = safeJsonParse(response.text);
    const result = parseNarrator(parsed, userInput);
    result.tokenUsage = tokenUsage;
    return result;
  }

  const baseUrl = resolveBaseUrl(provider, useProxy ? options?.proxyBaseUrl : undefined);
  if (useProxy && !baseUrl) {
    throw new Error("Missing proxy base URL.");
  }
  const apiKey = requireApiKey(useProxy ? options?.proxyApiKey : options?.apiKey, provider);
  const model = options?.textModel || "";
  if (!model) {
    throw new Error("Missing text model name.");
  }

  const targetLang = lang === "zh" ? "Chinese" : "English";
  const system = buildNarratorSystem(targetLang, year, location, options?.userSystemPrompt);
  const prompt = buildNarratorPrompt(player, history, userInput, year, location, quests, knownNpcs);

  const result = provider === "openai"
    ? await callOpenAiJson(apiKey, baseUrl, model, system, prompt)
    : provider === "claude"
      ? await callClaudeJson(apiKey, baseUrl, model, system, prompt)
      : await callDoubaoJson(apiKey, baseUrl, model, system, prompt);

  const parsed = safeJsonParse(result.content);
  const response = parseNarrator(parsed, userInput);
  response.tokenUsage = result.tokenUsage;
  return response;
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
  options?: { tier?: UserTier; apiKey?: string; proxyApiKey?: string; proxyBaseUrl?: string; useProxy?: boolean; textModel?: TextModelId; provider?: ModelProvider }
): Promise<{ update: StatusUpdate; tokenUsage?: TokenUsage }> {
  const provider = normalizeProvider(options?.provider);
  const useProxy = !!options?.useProxy;
  const targetLang = lang === "zh" ? "Chinese" : "English";
  const system = buildStatusSystem(targetLang, year, location);
  const prompt = buildStatusPrompt(player, quests, knownNpcs, year, location, currentTime, narration);

  if (provider === "gemini") {
    if (options?.tier === "guest") {
      const response = await getGeminiStatusUpdate(
        player,
        quests,
        knownNpcs,
        year,
        location,
        currentTime,
        narration,
        lang,
        { tier: options?.tier, apiKey: options?.apiKey, textModel: options?.textModel }
      );
      const update = response && typeof response === "object" ? (response as StatusUpdate) : {};
      return { update, tokenUsage: (response as any)?.tokenUsage };
    }
    const proxyBaseUrl = normalizeBaseUrl(options?.proxyBaseUrl);
    if (useProxy && !proxyBaseUrl) {
      throw new Error("Missing proxy base URL.");
    }
    const apiKey = requireApiKey(useProxy ? options?.proxyApiKey : options?.apiKey, provider);
    const model = options?.textModel || "";
    if (!model) {
      throw new Error("Missing text model name.");
    }
    const ai = new GoogleGenAI({
      apiKey,
      ...(proxyBaseUrl ? { httpOptions: { baseUrl: proxyBaseUrl } } : {})
    });
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: statusSchema,
        systemInstruction: system
      }
    });
    if (!response.text) {
      throw new Error("Connection to the Wasteland lost.");
    }
    const tokenUsage = normalizeTokenUsage({
      promptTokens: response.usageMetadata?.promptTokenCount,
      completionTokens: response.usageMetadata?.candidatesTokenCount,
      totalTokens: response.usageMetadata?.totalTokenCount
    }, `${system}\n${prompt}`, response.text);
    const parsed = safeJsonParse(response.text);
    const update = parsed && typeof parsed === "object" ? (parsed as StatusUpdate) : {};
    return { update, tokenUsage };
  }

  const baseUrl = resolveBaseUrl(provider, useProxy ? options?.proxyBaseUrl : undefined);
  if (useProxy && !baseUrl) {
    throw new Error("Missing proxy base URL.");
  }
  const apiKey = requireApiKey(useProxy ? options?.proxyApiKey : options?.apiKey, provider);
  const model = options?.textModel || "";
  if (!model) {
    throw new Error("Missing text model name.");
  }

  const result = provider === "openai"
    ? await callOpenAiJson(apiKey, baseUrl, model, system, prompt)
    : provider === "claude"
      ? await callClaudeJson(apiKey, baseUrl, model, system, prompt)
      : await callDoubaoJson(apiKey, baseUrl, model, system, prompt);

  const parsed = safeJsonParse(result.content);
  const update = parsed && typeof parsed === "object" ? (parsed as StatusUpdate) : {};
  return { update, tokenUsage: result.tokenUsage };
}

export async function refreshInventory(
  inventory: InventoryItem[],
  lang: Language,
  options?: { tier?: UserTier; apiKey?: string; proxyApiKey?: string; proxyBaseUrl?: string; useProxy?: boolean; textModel?: TextModelId; provider?: ModelProvider }
): Promise<{ inventory: InventoryItem[]; tokenUsage?: TokenUsage }> {
  const provider = normalizeProvider(options?.provider);
  const useProxy = !!options?.useProxy;
  const targetLang = lang === "zh" ? "Chinese" : "English";
  const system = buildInventoryRefreshSystem(targetLang);
  const prompt = buildInventoryRefreshPrompt(inventory);

  if (provider === "gemini") {
    if (options?.tier === "guest") {
      const response = await refreshGeminiInventory(inventory, lang, {
        tier: options?.tier,
        apiKey: options?.apiKey,
        textModel: options?.textModel
      });
      const data = response && typeof response === "object" ? (response as { inventory?: InventoryItem[] }) : {};
      return { inventory: Array.isArray(data.inventory) ? data.inventory : [], tokenUsage: (response as any)?.tokenUsage };
    }
    const proxyBaseUrl = normalizeBaseUrl(options?.proxyBaseUrl);
    if (useProxy && !proxyBaseUrl) {
      throw new Error("Missing proxy base URL.");
    }
    const apiKey = requireApiKey(useProxy ? options?.proxyApiKey : options?.apiKey, provider);
    const model = options?.textModel || "";
    if (!model) {
      throw new Error("Missing text model name.");
    }
    const ai = new GoogleGenAI({
      apiKey,
      ...(proxyBaseUrl ? { httpOptions: { baseUrl: proxyBaseUrl } } : {})
    });
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: inventoryRefreshSchema,
        systemInstruction: system
      }
    });
    if (!response.text) {
      throw new Error("Connection to the Wasteland lost.");
    }
    const tokenUsage = normalizeTokenUsage({
      promptTokens: response.usageMetadata?.promptTokenCount,
      completionTokens: response.usageMetadata?.candidatesTokenCount,
      totalTokens: response.usageMetadata?.totalTokenCount
    }, `${system}\n${prompt}`, response.text);
    const parsed = safeJsonParse(response.text);
    const items = parsed && typeof parsed === "object" && Array.isArray(parsed.inventory) ? parsed.inventory : [];
    return { inventory: items, tokenUsage };
  }

  const baseUrl = resolveBaseUrl(provider, useProxy ? options?.proxyBaseUrl : undefined);
  if (useProxy && !baseUrl) {
    throw new Error("Missing proxy base URL.");
  }
  const apiKey = requireApiKey(useProxy ? options?.proxyApiKey : options?.apiKey, provider);
  const model = options?.textModel || "";
  if (!model) {
    throw new Error("Missing text model name.");
  }

  const result = provider === "openai"
    ? await callOpenAiJson(apiKey, baseUrl, model, system, prompt)
    : provider === "claude"
      ? await callClaudeJson(apiKey, baseUrl, model, system, prompt)
      : await callDoubaoJson(apiKey, baseUrl, model, system, prompt);

  const parsed = safeJsonParse(result.content);
  const items = parsed && typeof parsed === "object" && Array.isArray(parsed.inventory) ? parsed.inventory : [];
  return { inventory: items, tokenUsage: result.tokenUsage };
}

export async function compressMemory(
  payload: { saveState: any; compressedMemory: string; recentHistory: HistoryEntry[] },
  lang: Language,
  maxMemoryK: number,
  options?: { tier?: UserTier; apiKey?: string; proxyApiKey?: string; proxyBaseUrl?: string; useProxy?: boolean; textModel?: TextModelId; provider?: ModelProvider }
): Promise<{ memory: string; tokenUsage?: TokenUsage }> {
  const provider = normalizeProvider(options?.provider);
  const useProxy = !!options?.useProxy;
  const historyText = payload.recentHistory
    .map(entry => `${entry.sender.toUpperCase()}: ${entry.text}`)
    .join("\n");
  const prompt = `SAVE STATE (JSON, no history):
${JSON.stringify(payload.saveState)}

EXISTING COMPRESSED MEMORY:
${payload.compressedMemory || 'None'}

RECENT HISTORY:
${historyText}

Return JSON: {"memory": "..."} only.`;
  const targetLang = lang === "zh" ? "Chinese" : "English";
  const system = `You are the Vault-Tec Memory Compression System.
1. Summarize the narrative memory for long-term continuity.
2. Keep the memory at or under ${maxMemoryK}K tokens.
3. Output language must be ${targetLang}.
4. Return JSON with key "memory" only.`;

  if (provider === "gemini") {
    if (options?.tier === "guest") {
      return compressGeminiMemory(payload, lang, maxMemoryK, {
        tier: options?.tier,
        apiKey: options?.apiKey,
        textModel: options?.textModel
      });
    }
    const proxyBaseUrl = normalizeBaseUrl(options?.proxyBaseUrl);
    if (useProxy && !proxyBaseUrl) {
      throw new Error("Missing proxy base URL.");
    }
    const apiKey = requireApiKey(useProxy ? options?.proxyApiKey : options?.apiKey, provider);
    const model = options?.textModel || "";
    if (!model) {
      throw new Error("Missing text model name.");
    }
    const ai = new GoogleGenAI({
      apiKey,
      ...(proxyBaseUrl ? { httpOptions: { baseUrl: proxyBaseUrl } } : {})
    });
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: memorySchema,
        systemInstruction: system
      }
    });
    if (!response.text) {
      throw new Error("No response from compression service.");
    }
    const parsed = safeJsonParse(response.text);
    const memory = typeof parsed?.memory === "string" ? parsed.memory.trim() : "";
    const tokenUsage = normalizeTokenUsage({
      promptTokens: response.usageMetadata?.promptTokenCount,
      completionTokens: response.usageMetadata?.candidatesTokenCount,
      totalTokens: response.usageMetadata?.totalTokenCount
    }, `${system}\n${prompt}`, response.text);
    if (!memory) {
      throw new Error("Compression returned empty memory.");
    }
    return { memory, tokenUsage };
  }

  const baseUrl = resolveBaseUrl(provider, useProxy ? options?.proxyBaseUrl : undefined);
  if (useProxy && !baseUrl) {
    throw new Error("Missing proxy base URL.");
  }
  const apiKey = requireApiKey(useProxy ? options?.proxyApiKey : options?.apiKey, provider);
  const model = options?.textModel || "";
  if (!model) {
    throw new Error("Missing text model name.");
  }

  const result = provider === "openai"
    ? await callOpenAiJson(apiKey, baseUrl, model, system, prompt)
    : provider === "claude"
      ? await callClaudeJson(apiKey, baseUrl, model, system, prompt)
      : await callDoubaoJson(apiKey, baseUrl, model, system, prompt);

  const parsed = safeJsonParse(result.content);
  const memory = typeof parsed?.memory === "string" ? parsed.memory.trim() : "";
  if (!memory) {
    throw new Error("Compression returned empty memory.");
  }
  return { memory, tokenUsage: result.tokenUsage };
}

export async function generateCompanionAvatar(
  npc: Actor,
  options?: { tier?: UserTier; apiKey?: string; proxyApiKey?: string; proxyBaseUrl?: string; useProxy?: boolean; imageModel?: ImageModelId; provider?: ModelProvider }
): Promise<{ url?: string; error?: string } | undefined> {
  const provider = normalizeProvider(options?.provider);
  const useProxy = !!options?.useProxy;
  if (provider === "gemini") {
    if (options?.tier === "guest") {
      return generateGeminiAvatar(npc, {
        tier: options?.tier,
        apiKey: options?.apiKey,
        imageModel: options?.imageModel
      });
    }
    const proxyBaseUrl = normalizeBaseUrl(options?.proxyBaseUrl);
    if (useProxy && !proxyBaseUrl) {
      return { error: "Missing proxy base URL." };
    }
    const apiKey = requireApiKey(useProxy ? options?.proxyApiKey : options?.apiKey, provider);
    const model = options?.imageModel || "";
    if (!model) {
      return { error: "Missing image model name." };
    }
    const prompt = `Fallout companion portrait. Name: ${npc.name}. Faction: ${npc.faction}. Gender: ${npc.gender}. Age: ${npc.age}. Style: Pip-Boy dossier headshot, gritty, realistic, neutral background.`;
    try {
      const imageAi = new GoogleGenAI({
        apiKey,
        ...(proxyBaseUrl ? { httpOptions: { baseUrl: proxyBaseUrl } } : {})
      });
      const response = await imageAi.models.generateContent({
        model,
        contents: {
          parts: [{ text: prompt }]
        },
        config: {
          imageConfig: { aspectRatio: "1:1" }
        }
      });
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
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }
  if (provider === "claude") {
    return { error: "Claude image generation is not supported." };
  }

  const baseUrl = resolveBaseUrl(provider, useProxy ? options?.proxyBaseUrl : undefined);
  if (useProxy && !baseUrl) {
    return { error: "Missing proxy base URL." };
  }
  const apiKey = requireApiKey(useProxy ? options?.proxyApiKey : options?.apiKey, provider);
  const model = options?.imageModel || "";
  if (!model) {
    return { error: "Missing image model name." };
  }

  const prompt = `Fallout companion portrait. Name: ${npc.name}. Faction: ${npc.faction}. Gender: ${npc.gender}. Age: ${npc.age}. Style: Pip-Boy dossier headshot, gritty, realistic, neutral background.`;
  try {
    const base64 = provider === "openai"
      ? await generateOpenAiImage(apiKey, baseUrl, model, prompt)
      : await generateDoubaoImage(apiKey, baseUrl, model, prompt);
    if (!base64) {
      return { error: "No image data returned from the model." };
    }
    const resized = await resizeImageToSquare(`data:image/png;base64,${base64}`, 100);
    return { url: resized };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function generateSceneImage(
  prompt: string,
  options?: { highQuality?: boolean; tier?: UserTier; apiKey?: string; proxyApiKey?: string; proxyBaseUrl?: string; useProxy?: boolean; imageModel?: ImageModelId; textModel?: TextModelId; provider?: ModelProvider; textProvider?: ModelProvider; textApiKey?: string; textProxyApiKey?: string }
): Promise<{ url?: string; sources?: GroundingSource[]; error?: string } | undefined> {
  const imageProvider = normalizeProvider(options?.provider);
  const researchProvider = normalizeProvider(options?.textProvider || options?.provider);
  const useProxy = !!options?.useProxy;
  if (imageProvider === "gemini") {
    if (options?.tier === "guest") {
      return generateGeminiScene(prompt, {
        highQuality: options?.highQuality,
        tier: options?.tier,
        apiKey: options?.apiKey,
        imageModel: options?.imageModel,
        textModel: options?.textModel
      });
    }
    const proxyBaseUrl = normalizeBaseUrl(options?.proxyBaseUrl);
    if (useProxy && !proxyBaseUrl) {
      return { error: "Missing proxy base URL." };
    }
    const imageApiKey = requireApiKey(useProxy ? options?.proxyApiKey : options?.apiKey, imageProvider);
    const imageModel = options?.imageModel || "";
    if (!imageModel) {
      return { error: "Missing image model name." };
    }
    const textModel = options?.textModel || "";
    const useHighQuality = options?.highQuality !== false;
    const researchApiKey = useProxy
      ? (options?.textProxyApiKey || options?.proxyApiKey)
      : (options?.textApiKey || options?.apiKey);
    try {
      let detailedDescription = prompt;
      let groundingSources: GroundingSource[] = [];
      if (useHighQuality && textModel && researchProvider === "gemini" && researchApiKey) {
        const researchAi = new GoogleGenAI({
          apiKey: researchApiKey,
          ...(proxyBaseUrl ? { httpOptions: { baseUrl: proxyBaseUrl } } : {})
        });
        try {
          const researchResponse = await researchAi.models.generateContent({
            model: textModel,
            contents: `Research visual references for this Fallout scene: "${prompt}".
1. Extract 3-5 keywords related to Fallout lore, items, or environment.
2. Search for these keywords + "Fallout" on Google to identify high-quality visual benchmarks (e.g. from Fallout 4 or New Vegas).
3. Based on your search results, describe the exact textures, lighting (e.g. dawn over the Mojave, fluorescent flickering in a vault), and key props.
4. Format your final response as a detailed scene description for a concept artist.`,
            config: {
              tools: [{ googleSearch: {} }]
            }
          });
          if (researchResponse?.text) {
            detailedDescription = researchResponse.text;
          }
          groundingSources = researchResponse?.candidates?.[0]?.groundingMetadata?.groundingChunks
            ?.filter((chunk: any) => chunk.web)
            ?.map((chunk: any) => ({
              title: chunk.web.title,
              uri: chunk.web.uri
            })) || [];
        } catch {
          // Skip research if the model does not support search.
        }
      }
      const finalPrompt = buildImagePrompt(detailedDescription, useHighQuality);
      const imageAi = new GoogleGenAI({
        apiKey: imageApiKey,
        ...(proxyBaseUrl ? { httpOptions: { baseUrl: proxyBaseUrl } } : {})
      });
      const imageResponse = await imageAi.models.generateContent({
        model: imageModel,
        contents: {
          parts: [{ text: finalPrompt }]
        },
        config: {
          imageConfig: { aspectRatio: "16:9" }
        }
      });
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
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }
  if (imageProvider === "claude") {
    return { error: "Claude image generation is not supported." };
  }

  const baseUrl = resolveBaseUrl(imageProvider, useProxy ? options?.proxyBaseUrl : undefined);
  if (useProxy && !baseUrl) {
    return { error: "Missing proxy base URL." };
  }
  const apiKey = requireApiKey(useProxy ? options?.proxyApiKey : options?.apiKey, imageProvider);
  const model = options?.imageModel || "";
  if (!model) {
    return { error: "Missing image model name." };
  }
  try {
    let detailedDescription = prompt;
    let groundingSources: GroundingSource[] = [];
    const useHighQuality = options?.highQuality !== false;
    const researchApiKey = useProxy
      ? (options?.textProxyApiKey || options?.proxyApiKey)
      : (options?.textApiKey || options?.apiKey);
    if (useHighQuality && options?.textModel && researchProvider === "gemini" && researchApiKey) {
      try {
        const researchAi = new GoogleGenAI({
          apiKey: researchApiKey,
          ...(useProxy && baseUrl ? { httpOptions: { baseUrl } } : {})
        });
        const researchResponse = await researchAi.models.generateContent({
          model: options.textModel,
          contents: `Research visual references for this Fallout scene: "${prompt}".
1. Extract 3-5 keywords related to Fallout lore, items, or environment.
2. Search for these keywords + "Fallout" on Google to identify high-quality visual benchmarks (e.g. from Fallout 4 or New Vegas).
3. Based on your search results, describe the exact textures, lighting (e.g. dawn over the Mojave, fluorescent flickering in a vault), and key props.
4. Format your final response as a detailed scene description for a concept artist.`,
          config: {
            tools: [{ googleSearch: {} }]
          }
        });
        if (researchResponse?.text) {
          detailedDescription = researchResponse.text;
        }
        groundingSources = researchResponse?.candidates?.[0]?.groundingMetadata?.groundingChunks
          ?.filter((chunk: any) => chunk.web)
          ?.map((chunk: any) => ({
            title: chunk.web.title,
            uri: chunk.web.uri
          })) || [];
      } catch {
        // Skip research if not supported.
      }
    }
    const finalPrompt = buildImagePrompt(detailedDescription, useHighQuality);
    const base64 = imageProvider === "openai"
      ? await generateOpenAiImage(apiKey, baseUrl, model, finalPrompt)
      : await generateDoubaoImage(apiKey, baseUrl, model, finalPrompt);
    if (!base64) {
      return { error: "No image data returned from the model." };
    }
    const compressed = await compressImage(`data:image/png;base64,${base64}`);
    return { url: compressed, sources: groundingSources };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
