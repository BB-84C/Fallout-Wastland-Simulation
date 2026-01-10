
import { GoogleGenAI, Type } from "@google/genai";
import { Actor, NarratorResponse, SpecialAttr, Skill, Language, Quest } from "../types";

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

/**
 * Resizes and compresses a base64 image to target ~400KB and 640p height.
 */
async function compressImage(base64: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const targetHeight = 640;
      const scale = targetHeight / img.height;
      const width = img.width * scale;
      const height = targetHeight;

      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(base64);
        return;
      }

      ctx.drawImage(img, 0, 0, width, height);
      
      // Start with quality 0.7 to keep file size low
      let quality = 0.7;
      let result = canvas.toDataURL('image/jpeg', quality);
      
      // Rough estimation of base64 size (string length * 0.75)
      // 400KB is roughly 533,333 characters in base64
      while (result.length > 533333 && quality > 0.1) {
        quality -= 0.1;
        result = canvas.toDataURL('image/jpeg', quality);
      }
      
      resolve(result);
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

export async function createPlayerCharacter(userInput: string, year: number, region: string, lang: Language): Promise<Actor> {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const targetLang = lang === 'zh' ? 'Chinese' : 'English';
  
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `Create a Fallout character for the year ${year} in ${region} based on this input: "${userInput}". Ensure they have appropriate initial perks, inventory, and starting Bottle Caps (50-200 caps).`,
    config: {
      responseMimeType: "application/json",
      responseSchema: actorSchema,
      systemInstruction: `You are the Vault-Tec Identity Reconstruction System.
      1. INTERNAL PROCESSING: Always research and use the Fallout Wiki in English for lore accuracy.
      2. MANDATORY LANGUAGE: All text fields in the final JSON MUST be in ${targetLang}.
      3. TRANSLATION RULE: Use official Fallout localizations for ${targetLang}. If an official term does not exist, translate it manually and append the original English in parentheses.
      4. ECONOMY: Assign 50-200 starting caps in the 'caps' field.
      5. PERK SYSTEM: Assign 1-2 starting perks.
      6. FIELDS TO LOCALIZE: name, faction, lore, perks[].name, perks[].description, inventory[].name, inventory[].description.`
    },
  });
  
  if (!response.text) throw new Error("No response from Vault-Tec database.");
  return safeJsonParse(response.text);
}

export async function getNarrativeResponse(
  player: Actor,
  history: any[],
  userInput: string,
  year: number,
  location: string,
  quests: Quest[],
  lang: Language
): Promise<NarratorResponse> {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const targetLang = lang === 'zh' ? 'Chinese' : 'English';
  const context = history.slice(-15).map(h => `${h.sender.toUpperCase()}: ${h.text}`).join('\n');

  const prompt = `
    Environment Year: ${year}
    Environment Location: ${location}
    Current Player Profile: ${JSON.stringify(player)}
    Existing Quests: ${JSON.stringify(quests)}
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

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
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
      6. RULE GUARD: If player dictates narrative outcomes, return 'ruleViolation'.
      7. TRANSLATION: Use "Term (Original)" for unlocalized items.
      8. CONSISTENCY: Ensure current year (${year}) and location (${location}) lore is followed.`
    },
  });

  if (!response.text) throw new Error("Connection to the Wasteland lost.");
  return safeJsonParse(response.text);
}

export async function generateSceneImage(prompt: string): Promise<string | undefined> {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-pro-image-preview',
      contents: {
        parts: [{ text: `Generate a Fallout-themed scene: ${prompt}. Refer to Fallout visual archives to ensure environmental accuracy (e.g. vault tech, power armor, wasteland ruins). Style: Cinematic concept art.` }],
      },
      config: { 
        imageConfig: { aspectRatio: "16:9", imageSize: "1K" },
        tools: [{ googleSearch: {} }] 
      },
    });

    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) {
        const rawBase64 = `data:image/png;base64,${part.inlineData.data}`;
        // Compress the image before returning to avoid storage issues
        return await compressImage(rawBase64);
      }
    }
  } catch (e) {
    console.error("High-quality image generation failed.", e);
  }
  return undefined;
}
