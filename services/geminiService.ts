
import { GoogleGenAI, Type } from "@google/genai";
import { Actor, NarratorResponse, SpecialAttr, Skill, Language, Quest, GroundingSource } from "../types";

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
    model: 'gemini-3-pro-preview',
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
    model: 'gemini-3-pro-preview',
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

/**
 * TWO-STAGE GENERATION:
 * Stage 1: Research visual details using gemini-3-pro-preview with Google Search.
 * Stage 2: Generate the image using gemini-2.5-flash-image based on research findings.
 */
export async function generateSceneImage(prompt: string): Promise<{url: string, sources: GroundingSource[]} | undefined> {
  const researchAi = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  try {
    // STAGE 1: Visual Research using Search Grounding
    // We explicitly extract keywords and use Search to "see" what things look like.
    const researchResponse = await researchAi.models.generateContent({
      model: 'gemini-3-pro-preview',
      contents: `Research visual references for this Fallout scene: "${prompt}".
      1. Extract 3-5 keywords related to Fallout lore, items, or environment.
      2. Search for these keywords + "Fallout" on Google to identify high-quality visual benchmarks (e.g. from Fallout 4 or New Vegas).
      3. Based on your search results, describe the exact textures, lighting (e.g. dawn over the Mojave, fluorescent flickering in a vault), and key props.
      4. Format your final response as a detailed scene description for a concept artist.`,
      config: {
        tools: [{ googleSearch: {} }]
      }
    });

    const detailedDescription = researchResponse.text || prompt;
    
    // Extract search grounding sources to display in the UI as per SDK rules.
    const groundingSources: GroundingSource[] = researchResponse.candidates?.[0]?.groundingMetadata?.groundingChunks
      ?.filter((chunk: any) => chunk.web)
      ?.map((chunk: any) => ({
        title: chunk.web.title,
        uri: chunk.web.uri
      })) || [];

    // STAGE 2: Grounded Generation with Gemini 2.5 Flash Image
    const imageAi = new GoogleGenAI({ apiKey: process.env.API_KEY });
    const imageResponse = await imageAi.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: {
        parts: [{ text: `Cinematic Fallout Concept Art. Environment: ${detailedDescription}. Atmosphere: Desolate, atmospheric, detailed. Style: Digital art, 4k, hyper-realistic wasteland aesthetic.` }],
      },
      config: { 
        imageConfig: { aspectRatio: "16:9" }
      },
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
  } catch (e) {
    console.error("Two-stage image generation failed:", e);
  }
  return undefined;
}
