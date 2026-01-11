
import { GoogleGenAI, Type } from "@google/genai";
import { Actor, NarratorResponse, SpecialAttr, Skill, Language, Quest, GroundingSource, UserTier, PlayerCreationResult } from "../types";

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

const TEXT_MODELS = {
  adminPrimary: 'gemini-3-pro-preview',
  adminFallback: 'gemini-3-flash-preview',
  normal: 'gemini-2.5-flash',
  guest: 'gemini-2.5-flash-lite'
};

const IMAGE_MODELS = {
  adminPrimary: 'gemini-3-pro-image-preview',
  adminFallback: 'gemini-2.5-flash-image',
  normal: 'gemini-2.5-flash-image',
  guest: 'gemini-2.5-flash-image'
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

const resolveApiKey = () => {
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

function safeJsonParse(text: string): any {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (innerE) {
        throw e;
      }
    }
    throw e;
  }
}

export async function createPlayerCharacter(
  userInput: string,
  year: number,
  region: string,
  lang: Language,
  options?: { tier?: UserTier; onProgress?: (message: string) => void }
): Promise<PlayerCreationResult> {
  const tier = options?.tier ?? 'guest';
  const isAdmin = tier === 'admin';
  const textModel = tier === 'admin' ? TEXT_MODELS.adminPrimary : tier === 'normal' ? TEXT_MODELS.normal : TEXT_MODELS.guest;
  const { key: apiKey, source } = resolveApiKey();
  const emit = (message: string) => options?.onProgress?.(message);
  const ai = new GoogleGenAI({ apiKey: apiKey || '' });
  const targetLang = lang === 'zh' ? 'Chinese' : 'English';
  
  const response = await (async () => {
    try {
      emit(`API key: ${source} (${describeApiKey(apiKey)})`);
      emit(`Requesting character profile from ${textModel}...`);
      return await ai.models.generateContent({
        model: textModel,
        contents: `Create a Fallout character for the year ${year} in ${region} based on this input: "${userInput}". Ensure they have appropriate initial perks, inventory, and starting Bottle Caps (50-200 caps). If the user mentions starting companions, include them.`,
        config: {
          responseMimeType: "application/json",
          responseSchema: playerCreationSchema,
          systemInstruction: `You are the Vault-Tec Identity Reconstruction System.
          1. INTERNAL PROCESSING: Always research and use the Fallout Wiki in English for lore accuracy.
          2. MANDATORY LANGUAGE: All text fields in the final JSON MUST be in ${targetLang}.
          3. TRANSLATION RULE: Use official Fallout localizations for ${targetLang}. If an official term does not exist, translate it manually and append the original English in parentheses.
          4. ECONOMY: Assign 50-200 starting caps in the 'caps' field.
          5. PERK SYSTEM: Assign 1-2 starting perks.
          6. COMPANIONS: If the user specifies existing companions, include a 'companions' array with full NPC profiles and set ifCompanion=true.
          7. FIELDS TO LOCALIZE: name, faction, lore, perks[].name, perks[].description, inventory[].name, inventory[].description, companions[].name, companions[].faction, companions[].lore, companions[].perks[].name, companions[].perks[].description, companions[].inventory[].name, companions[].inventory[].description.`
        },
      });
    } catch (e) {
      if (!isAdmin) throw e;
      emit(`Primary model failed. Retrying with ${TEXT_MODELS.adminFallback}...`);
      const fallbackAi = new GoogleGenAI({ apiKey: apiKey || '' });
      return await fallbackAi.models.generateContent({
        model: TEXT_MODELS.adminFallback,
        contents: `Create a Fallout character for the year ${year} in ${region} based on this input: "${userInput}". Ensure they have appropriate initial perks, inventory, and starting Bottle Caps (50-200 caps). If the user mentions starting companions, include them.`,
        config: {
          responseMimeType: "application/json",
          responseSchema: playerCreationSchema,
          systemInstruction: `You are the Vault-Tec Identity Reconstruction System.
          1. INTERNAL PROCESSING: Always research and use the Fallout Wiki in English for lore accuracy.
          2. MANDATORY LANGUAGE: All text fields in the final JSON MUST be in ${targetLang}.
          3. TRANSLATION RULE: Use official Fallout localizations for ${targetLang}. If an official term does not exist, translate it manually and append the original English in parentheses.
          4. ECONOMY: Assign 50-200 starting caps in the 'caps' field.
          5. PERK SYSTEM: Assign 1-2 starting perks.
          6. COMPANIONS: If the user specifies existing companions, include a 'companions' array with full NPC profiles and set ifCompanion=true.
          7. FIELDS TO LOCALIZE: name, faction, lore, perks[].name, perks[].description, inventory[].name, inventory[].description, companions[].name, companions[].faction, companions[].lore, companions[].perks[].name, companions[].perks[].description, companions[].inventory[].name, companions[].inventory[].description.`
        },
      });
    }
  })();
  
  if (!response.text) throw new Error("No response from Vault-Tec database.");
  emit(`Response received (${response.text.length} chars). Parsing JSON...`);
  try {
    const parsed = safeJsonParse(response.text);
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
  options?: { tier?: UserTier }
): Promise<NarratorResponse> {
  const { key: apiKey } = resolveApiKey();
  const ai = new GoogleGenAI({ apiKey: apiKey || '' });
  const targetLang = lang === 'zh' ? 'Chinese' : 'English';
  const context = history.slice(-15).map(h => `${h.sender.toUpperCase()}: ${h.text}`).join('\n');
  const tier = options?.tier ?? 'guest';
  const isAdmin = tier === 'admin';
  const textModel = tier === 'admin' ? TEXT_MODELS.adminPrimary : tier === 'normal' ? TEXT_MODELS.normal : TEXT_MODELS.guest;

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
    2. CHECK QUESTS: Does this action start a new quest, progress an existing one, or complete/fail one? 
       - If a new goal is set by an NPC or circumstance, add a new quest to 'questUpdates'.
       - If an objective is met, update the 'status' to 'completed' in 'questUpdates'.
       - Use 'questUpdates' to signal changes to the quest log.
  `;

  const response = await (async () => {
    try {
      return await ai.models.generateContent({
        model: textModel,
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
          systemInstruction: `You are the Fallout Overseer. 
          1. SOURCE: Strictly source all lore, item stats, and location details from the Fallout Wiki in English.
          2. MANDATORY LANGUAGE: You MUST output all text presented to the player in ${targetLang}.
          3. QUEST SYSTEM (CRITICAL):
             - You are responsible for maintaining the quest log via the 'questUpdates' field.
             - CREATE: If the player is given a task (e.g., "Find the water chip", "Kill the radroaches"), you MUST generate a new quest object in 'questUpdates' with a unique ID.
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
          9. CONSISTENCY: Ensure current year (${year}) and location (${location}) lore is followed.`
        },
      });
    } catch (e) {
      if (!isAdmin) throw e;
      const fallbackAi = new GoogleGenAI({ apiKey: apiKey || '' });
      return await fallbackAi.models.generateContent({
        model: TEXT_MODELS.adminFallback,
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
          systemInstruction: `You are the Fallout Overseer. 
          1. SOURCE: Strictly source all lore, item stats, and location details from the Fallout Wiki in English.
          2. MANDATORY LANGUAGE: You MUST output all text presented to the player in ${targetLang}.
          3. QUEST SYSTEM (CRITICAL):
             - You are responsible for maintaining the quest log via the 'questUpdates' field.
             - CREATE: If the player is given a task (e.g., "Find the water chip", "Kill the radroaches"), you MUST generate a new quest object in 'questUpdates' with a unique ID.
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
          9. CONSISTENCY: Ensure current year (${year}) and location (${location}) lore is followed.`
        },
      });
    }
  })();

  if (!response.text) throw new Error("Connection to the Wasteland lost.");
  return safeJsonParse(response.text);
}

export async function generateCompanionAvatar(
  npc: Actor,
  options?: { tier?: UserTier }
): Promise<{ url?: string; error?: string } | undefined> {
  const tier = options?.tier ?? 'guest';
  const isAdmin = tier === 'admin';
  const imageModel = tier === 'admin' ? IMAGE_MODELS.adminPrimary : tier === 'normal' ? IMAGE_MODELS.normal : IMAGE_MODELS.guest;
  const { key: apiKey } = resolveApiKey();
  const prompt = `Fallout companion portrait. Name: ${npc.name}. Faction: ${npc.faction}. Gender: ${npc.gender}. Age: ${npc.age}. Style: Pip-Boy dossier headshot, gritty, realistic, neutral background.`;

  try {
    const imageAi = new GoogleGenAI({ apiKey: apiKey || '' });
    const response = await (async () => {
      try {
        return await imageAi.models.generateContent({
          model: imageModel,
          contents: {
            parts: [{ text: prompt }],
          },
          config: {
            imageConfig: { aspectRatio: "1:1" }
          },
        });
      } catch (e) {
        if (!isAdmin) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
        const fallbackAi = new GoogleGenAI({ apiKey: apiKey || '' });
        return await fallbackAi.models.generateContent({
          model: IMAGE_MODELS.adminFallback,
          contents: {
            parts: [{ text: prompt }],
          },
          config: {
            imageConfig: { aspectRatio: "1:1" }
          },
        });
      }
    })();

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
  options?: { highQuality?: boolean; tier?: UserTier }
): Promise<{url?: string, sources?: GroundingSource[], error?: string} | undefined> {
  const useHighQuality = options?.highQuality !== false;
  const tier = options?.tier ?? 'guest';
  const isAdmin = tier === 'admin';
  const textModel = tier === 'admin' ? TEXT_MODELS.adminPrimary : tier === 'normal' ? TEXT_MODELS.normal : TEXT_MODELS.guest;
  const imageModel = tier === 'admin' ? IMAGE_MODELS.adminPrimary : tier === 'normal' ? IMAGE_MODELS.normal : IMAGE_MODELS.guest;
  const { key: apiKey } = resolveApiKey();

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
        } catch (e) {
          if (!isAdmin) return undefined;
          const fallbackAi = new GoogleGenAI({ apiKey: apiKey || '' });
          return await fallbackAi.models.generateContent({
            model: TEXT_MODELS.adminFallback,
            contents: `Research visual references for this Fallout scene: "${prompt}".
            1. Extract 3-5 keywords related to Fallout lore, items, or environment.
            2. Search for these keywords + "Fallout" on Google to identify high-quality visual benchmarks (e.g. from Fallout 4 or New Vegas).
            3. Based on your search results, describe the exact textures, lighting (e.g. dawn over the Mojave, fluorescent flickering in a vault), and key props.
            4. Format your final response as a detailed scene description for a concept artist.`,
            config: {
              tools: [{ googleSearch: {} }]
            }
          });
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
    const imageResponse = await (async () => {
      const imageAi = new GoogleGenAI({ apiKey: apiKey || '' });
      try {
        return await imageAi.models.generateContent({
          model: imageModel,
          contents: {
            parts: [{ text: `Cinematic Fallout Concept Art. Environment: ${detailedDescription}. Atmosphere: Desolate, atmospheric, detailed. Style: Digital art, 4k, hyper-realistic wasteland aesthetic.` }],
          },
          config: { 
            imageConfig: { aspectRatio: "16:9" }
          },
        });
      } catch (e) {
        if (!isAdmin) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
        const fallbackAi = new GoogleGenAI({ apiKey: apiKey || '' });
        return await fallbackAi.models.generateContent({
          model: IMAGE_MODELS.adminFallback,
          contents: {
            parts: [{ text: `Cinematic Fallout Concept Art. Environment: ${detailedDescription}. Atmosphere: Desolate, atmospheric, detailed. Style: Digital art, 4k, hyper-realistic wasteland aesthetic.` }],
          },
          config: { 
            imageConfig: { aspectRatio: "16:9" }
          },
        });
      }
    })();

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
