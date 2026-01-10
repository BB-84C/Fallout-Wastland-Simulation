
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
    karma: { type: Type.NUMBER }
  },
  required: ["name", "age", "faction", "special", "skills", "lore", "health", "maxHealth"]
};

const questSchema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      id: { type: Type.STRING },
      name: { type: Type.STRING },
      objective: { type: Type.STRING },
      // Fix: Removed 'enum' as it is not explicitly listed in available Type enum properties for responseSchema.
      status: { type: Type.STRING },
      hiddenProgress: { type: Type.STRING }
    },
    required: ["id", "name", "objective", "status", "hiddenProgress"]
  }
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
    contents: `Create a Fallout character for the year ${year} in ${region} based on this input: "${userInput}". Ensure they have appropriate initial perks from the series or unique ones fitting their background.`,
    config: {
      responseMimeType: "application/json",
      responseSchema: actorSchema,
      systemInstruction: `You are the Vault-Tec Identity Reconstruction System.
      1. INTERNAL PROCESSING: Always research and use the Fallout Wiki in English for lore accuracy.
      2. MANDATORY LANGUAGE: All text fields in the final JSON MUST be in ${targetLang}.
      3. TRANSLATION RULE: Use official Fallout localizations for ${targetLang}. If an official term does not exist, translate it manually and append the original English in parentheses, e.g., "翻译 (Original English)".
      4. PERK SYSTEM: Assign 1-2 starting perks. Perks should have clear benefits (implied in description).
      5. FIELDS TO LOCALIZE: name, faction, lore, perks[].name, perks[].description, inventory[].name, inventory[].description.`
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
          // Fix: Removed 'nullable' property as it is not part of the standard Type enum used for schema definitions.
          ruleViolation: { type: Type.STRING },
          timePassedMinutes: { type: Type.NUMBER },
          questUpdates: questSchema,
          newNpc: actorSchema,
          imagePrompt: { type: Type.STRING }
        },
        required: ["storyText", "timePassedMinutes", "imagePrompt"]
      },
      systemInstruction: `You are the Fallout Overseer. 
      1. SOURCE: Strictly source all lore, item stats, and location details from the Fallout Wiki in English.
      2. MANDATORY LANGUAGE: You MUST output all text presented to the player in ${targetLang}.
      3. PERKS: Actively consider the player's perks (e.g., Bloody Mess, Lady Killer, Black Widow, etc.) when determining narrative outcomes.
      4. RULE GUARD: The player may only describe thoughts and actions. If they dictate outcomes, return 'ruleViolation'.
      5. TRANSLATION: Use "Term (Original)" for unlocalized items.
      6. QUESTS: Manage consistency across all active and finished quests.`
    },
  });

  if (!response.text) throw new Error("Connection to the Wasteland lost.");
  return safeJsonParse(response.text);
}

export async function generateSceneImage(prompt: string): Promise<string | undefined> {
  // Fix: Create a new GoogleGenAI instance right before making an API call to ensure it always uses the most up-to-date API key.
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-pro-image-preview',
      contents: {
        parts: [{ text: `Generate a Fallout-themed scene: ${prompt}. Refer to Fallout visual archives to ensure environmental accuracy (e.g. vault tech, power armor, wasteland ruins). Style: Cinematic concept art.` }],
      },
      config: { 
        imageConfig: { aspectRatio: "16:9", imageSize: "1K" },
        // Fix: Use googleSearch as it is the permitted tool name for search grounding.
        tools: [{ googleSearch: {} }] 
      },
    });

    for (const part of response.candidates?.[0]?.content?.parts || []) {
      // Find the image part as per guidelines.
      if (part.inlineData) return `data:image/png;base64,${part.inlineData.data}`;
    }
  } catch (e) {
    console.error("High-quality image generation failed, falling back to flash.", e);
    // Fix: Create a new instance right before the fallback call.
    const fallbackAi = new GoogleGenAI({ apiKey: process.env.API_KEY });
    const fallbackResponse = await fallbackAi.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: {
        parts: [{ text: `Fallout concept art: ${prompt}` }],
      },
      config: { imageConfig: { aspectRatio: "16:9" } },
    });
    for (const part of fallbackResponse.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) return `data:image/png;base64,${part.inlineData.data}`;
    }
  }
  return undefined;
}
