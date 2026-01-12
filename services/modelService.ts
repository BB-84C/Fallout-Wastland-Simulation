import { GoogleGenAI, Type } from "@google/genai";
import { Actor, NarratorResponse, Language, Quest, GroundingSource, UserTier, PlayerCreationResult, TextModelId, ImageModelId, ModelProvider, SpecialAttr, Skill } from "../types";
import {
  createPlayerCharacter as createGeminiPlayer,
  getNarrativeResponse as getGeminiNarration,
  generateSceneImage as generateGeminiScene,
  generateCompanionAvatar as generateGeminiAvatar
} from "./geminiService";

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const CLAUDE_BASE_URL = "https://api.anthropic.com/v1";
const DOUBAO_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";

const actorSchemaHint = `Return JSON with keys:
name, age, gender, faction, special, skills, perks, inventory, lore, health, maxHealth, karma, caps, ifCompanion (optional), avatarUrl (optional).
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
          value: { type: Type.NUMBER }
        }
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

const buildCharacterSystem = (targetLang: string) => `You are the Vault-Tec Identity Reconstruction System.
1. INTERNAL PROCESSING: Always research and use the Fallout Wiki in English for lore accuracy.
2. MANDATORY LANGUAGE: All text fields in the final JSON MUST be in ${targetLang}.
3. TRANSLATION RULE: Use official Fallout localizations for ${targetLang}. If an official term does not exist, translate it manually and append the original English in parentheses.
4. ECONOMY: Assign 50-200 starting caps in the 'caps' field.
5. PERK SYSTEM: Assign 1-2 starting perks.
6. COMPANIONS: If the user specifies existing companions, include a 'companions' array with full NPC profiles and set ifCompanion=true.
7. SKILLS: The skills object must include all skills with numeric values (do not omit any skill).
8. FIELDS TO LOCALIZE: name, faction, lore, perks[].name, perks[].description, inventory[].name, inventory[].description, companions[].name, companions[].faction, companions[].lore, companions[].perks[].name, companions[].perks[].description, companions[].inventory[].name, companions[].inventory[].description.
${actorSchemaHint}`;

const buildNarratorSystem = (targetLang: string, year: number, location: string) => `You are the Fallout Overseer.
1. SOURCE: Strictly source all lore, item stats, and location details from the Fallout Wiki in English.
1.1. OUTPUT RULE: Never cite sources, URLs, or parenthetical provenance in player-facing narration. Keep the narration immersive.
2. MANDATORY LANGUAGE: You MUST output all text presented to the player in ${targetLang}.
3. QUEST SYSTEM (CRITICAL):
   - You are responsible for maintaining the quest log via the 'questUpdates' field.
   - CREATE: If the player is given a task, you MUST generate a new quest object in 'questUpdates' with a unique ID.
   - UPDATE: If the player completes an objective or receives new information that changes the goal, provide the updated quest in 'questUpdates'.
   - FINISH: When a task is done, set its status to 'completed'.
   - Never delete quests; only update their status.
4. ECONOMY & TRADING:
   - Calculate costs based on Barter skill, Charisma, and perks. Update 'updatedPlayer' caps and inventory on trade.
5. PERKS: Incorporate player perks into story outcomes.
6. COMPANION SYSTEM:
   - Based on the interaction history and NPC relationship, decide if any known NPC becomes a companion.
   - If a companion status changes, add an entry in 'companionUpdates' with the NPC name and ifCompanion=true/false.
   - Only include updates for NPCs already in Known NPCs or the newly created NPC.
7. RULE GUARD: If player dictates narrative outcomes, return 'ruleViolation'.
8. TRANSLATION: Use "Term (Original)" for unlocalized items.
9. CONSISTENCY: Ensure current year (${year}) and location (${location}) lore is followed.`;

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
2. CHECK QUESTS: Does this action start a new quest, progress an existing one, or complete/fail one?
   - If a new goal is set by an NPC or circumstance, add a new quest to 'questUpdates'.
   - If an objective is met, update the 'status' to 'completed' in 'questUpdates'.
   - Use 'questUpdates' to signal changes to the quest log.
Return strict JSON with keys: storyText, ruleViolation, timePassedMinutes, questUpdates, companionUpdates, newNpc, updatedPlayer, imagePrompt.`;

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
    questUpdates: raw?.questUpdates,
    companionUpdates: raw?.companionUpdates,
    newNpc: raw?.newNpc,
    updatedPlayer: raw?.updatedPlayer,
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
  return data?.choices?.[0]?.message?.content || "";
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
  return content || "";
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
  return data?.choices?.[0]?.message?.content || "";
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
  options?: { tier?: UserTier; onProgress?: (message: string) => void; apiKey?: string; proxyApiKey?: string; proxyBaseUrl?: string; useProxy?: boolean; textModel?: TextModelId; provider?: ModelProvider }
): Promise<PlayerCreationResult> {
  const provider = normalizeProvider(options?.provider);
  const useProxy = !!options?.useProxy;
  if (provider === "gemini") {
    if (options?.tier === "guest") {
      return createGeminiPlayer(userInput, year, region, lang, {
        tier: options?.tier,
        onProgress: options?.onProgress,
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
    const emit = (message: string) => options?.onProgress?.(message);
    const targetLang = lang === "zh" ? "Chinese" : "English";
    const system = buildCharacterSystem(targetLang);
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
    const parsed = safeJsonParse(response.text);
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
  const system = buildCharacterSystem(targetLang);
  const prompt = `Create a Fallout character for the year ${year} in ${region} based on this input: "${userInput}". Ensure they have appropriate initial perks, inventory, and starting Bottle Caps (50-200 caps). If the user mentions starting companions, include them.`;

  const raw = provider === "openai"
    ? await callOpenAiJson(apiKey, baseUrl, model, system, prompt)
    : provider === "claude"
      ? await callClaudeJson(apiKey, baseUrl, model, system, prompt)
      : await callDoubaoJson(apiKey, baseUrl, model, system, prompt);

  return safeJsonParse(raw);
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
  options?: { tier?: UserTier; apiKey?: string; proxyApiKey?: string; proxyBaseUrl?: string; useProxy?: boolean; textModel?: TextModelId; provider?: ModelProvider }
): Promise<NarratorResponse> {
  const provider = normalizeProvider(options?.provider);
  const useProxy = !!options?.useProxy;
  if (provider === "gemini") {
    if (options?.tier === "guest") {
      return getGeminiNarration(player, history, userInput, year, location, quests, knownNpcs, lang, {
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
    const targetLang = lang === "zh" ? "Chinese" : "English";
    const system = buildNarratorSystem(targetLang, year, location);
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
            questUpdates: questSchema,
            companionUpdates: {
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
            },
            newNpc: actorSchema,
            updatedPlayer: actorSchema,
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
    const parsed = safeJsonParse(response.text);
    return parseNarrator(parsed, userInput);
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
  const system = buildNarratorSystem(targetLang, year, location);
  const prompt = buildNarratorPrompt(player, history, userInput, year, location, quests, knownNpcs);

  const raw = provider === "openai"
    ? await callOpenAiJson(apiKey, baseUrl, model, system, prompt)
    : provider === "claude"
      ? await callClaudeJson(apiKey, baseUrl, model, system, prompt)
      : await callDoubaoJson(apiKey, baseUrl, model, system, prompt);

  const parsed = safeJsonParse(raw);
  return parseNarrator(parsed, userInput);
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
  options?: { highQuality?: boolean; tier?: UserTier; apiKey?: string; proxyApiKey?: string; proxyBaseUrl?: string; useProxy?: boolean; imageModel?: ImageModelId; textModel?: TextModelId; provider?: ModelProvider }
): Promise<{ url?: string; sources?: GroundingSource[]; error?: string } | undefined> {
  const provider = normalizeProvider(options?.provider);
  const useProxy = !!options?.useProxy;
  if (provider === "gemini") {
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
    const apiKey = requireApiKey(useProxy ? options?.proxyApiKey : options?.apiKey, provider);
    const imageModel = options?.imageModel || "";
    if (!imageModel) {
      return { error: "Missing image model name." };
    }
    const textModel = options?.textModel || "";
    const useHighQuality = options?.highQuality !== false;
    try {
      let detailedDescription = prompt;
      let groundingSources: GroundingSource[] = [];
      if (useHighQuality && textModel) {
        const researchAi = new GoogleGenAI({
          apiKey,
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
        apiKey,
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
  try {
    const finalPrompt = buildImagePrompt(prompt, options?.highQuality !== false);
    const base64 = provider === "openai"
      ? await generateOpenAiImage(apiKey, baseUrl, model, finalPrompt)
      : await generateDoubaoImage(apiKey, baseUrl, model, finalPrompt);
    if (!base64) {
      return { error: "No image data returned from the model." };
    }
    const compressed = await compressImage(`data:image/png;base64,${base64}`);
    return { url: compressed, sources: [] };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
