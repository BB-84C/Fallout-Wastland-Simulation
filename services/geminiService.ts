
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
      systemInstruction: `You are the Vault-Tec Identity Reconstruction System. Use Fallout Wiki lore. Language: ${targetLang}.`
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
  const prompt = `Environment Year: ${year}\nLocation: ${location}\nPlayer: ${JSON.stringify(player)}\nQuests: ${JSON.stringify(quests)}\nAction: "${userInput}"\nContext:\n${context}`;
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
      systemInstruction: `You are the Fallout Overseer. Language: ${targetLang}. Focus on consequences and lore.`
    },
  });
  if (!response.text) throw new Error("Connection to the Wasteland lost.");
  return safeJsonParse(response.text);
}

export async function generateSceneImage(prompt: string, highQuality: boolean): Promise<{url: string, sources: GroundingSource[]} | undefined> {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  try {
    let detailedDescription = prompt;
    let groundingSources: GroundingSource[] = [];

    if (highQuality) {
      const researchResponse = await ai.models.generateContent({
        model: 'gemini-3-pro-preview',
        contents: `Research visual references for Fallout: "${prompt}". Describe textures, lighting, and lore Props. Format as conceptual description.`,
        config: { tools: [{ googleSearch: {} }] }
      });
      detailedDescription = researchResponse.text || prompt;
      groundingSources = researchResponse.candidates?.[0]?.groundingMetadata?.groundingChunks
        ?.filter((chunk: any) => chunk.web)
        ?.map((chunk: any) => ({ title: chunk.web.title, uri: chunk.web.uri })) || [];
    }

    const imageResponse = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: { parts: [{ text: `Fallout Cinematic Concept Art: ${detailedDescription}. Atmospheric wasteland aesthetic.` }] },
      config: { imageConfig: { aspectRatio: "16:9" } },
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
    console.error("Image generation failed:", e);
  }
  return undefined;
}
