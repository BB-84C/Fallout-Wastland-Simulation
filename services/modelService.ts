import { GoogleGenAI, Type } from "@google/genai";
import { Actor, NarratorResponse, Language, Quest, GroundingSource, UserTier, PlayerCreationResult, TextModelId, ImageModelId, ModelProvider, SpecialAttr, Skill, TokenUsage, HistoryEntry, StatusUpdate, InventoryItem } from "../types";
import {
  createPlayerCharacter as createGeminiPlayer,
  getNarrativeResponse as getGeminiNarration,
  getArenaNarration as getGeminiArenaNarration,
  generateSceneImage as generateGeminiScene,
  generateCompanionAvatar as generateGeminiAvatar,
  compressMemory as compressGeminiMemory,
  getStatusUpdate as getGeminiStatusUpdate,
  refreshInventory as refreshGeminiInventory,
  auditInventoryWeights as auditGeminiInventoryWeights,
  recoverInventoryStatus as recoverGeminiInventoryStatus
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
Perks must include name, rank, and a non-empty description.
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
  required: [...actorSchema.required, "companions"]
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

const partialSpecialSchema = {
  type: Type.OBJECT,
  properties: {
    [SpecialAttr.Strength]: { type: Type.NUMBER },
    [SpecialAttr.Perception]: { type: Type.NUMBER },
    [SpecialAttr.Endurance]: { type: Type.NUMBER },
    [SpecialAttr.Charisma]: { type: Type.NUMBER },
    [SpecialAttr.Intelligence]: { type: Type.NUMBER },
    [SpecialAttr.Agility]: { type: Type.NUMBER },
    [SpecialAttr.Luck]: { type: Type.NUMBER }
  }
};

const partialSkillsSchema = {
  type: Type.OBJECT,
  properties: Object.values(Skill).reduce(
    (acc: Record<string, any>, skill) => ({ ...acc, [skill]: { type: Type.NUMBER } }),
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

const playerChangeSchema = {
  type: Type.OBJECT,
  properties: {
    health: { type: Type.NUMBER },
    maxHealth: { type: Type.NUMBER },
    karma: { type: Type.NUMBER },
    caps: { type: Type.NUMBER },
    special: partialSpecialSchema,
    skills: partialSkillsSchema,
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
    location: { type: Type.STRING },
    currentYear: { type: Type.NUMBER },
    currentTime: { type: Type.STRING }
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

type JsonSchema = Record<string, any>;

const specialJsonProperties = Object.values(SpecialAttr).reduce((acc: Record<string, any>, attr) => {
  acc[attr] = { type: "number" };
  return acc;
}, {});

const skillsJsonProperties = Object.values(Skill).reduce((acc: Record<string, any>, skill) => {
  acc[skill] = { type: "number" };
  return acc;
}, {});

const jsonPerkSchema: JsonSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    rank: { type: "number" }
  },
  required: ["name", "description", "rank"],
  additionalProperties: false
};

const jsonInventoryItemSchema: JsonSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    type: { type: "string" },
    description: { type: "string" },
    weight: { type: "number" },
    value: { type: "number" },
    count: { type: "number" },
    isConsumable: { type: "boolean" }
  },
  required: ["name", "type", "description", "weight", "value", "count", "isConsumable"],
  additionalProperties: false
};

const jsonInventoryChangeSchema: JsonSchema = {
  type: "object",
  properties: {
    add: {
      type: "array",
      items: jsonInventoryItemSchema
    },
    remove: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          count: { type: "number" }
        },
        required: ["name"],
        additionalProperties: false
      }
    }
  },
  additionalProperties: false
};

const jsonPlayerChangeSchema: JsonSchema = {
  type: "object",
  properties: {
    health: { type: "number" },
    maxHealth: { type: "number" },
    karma: { type: "number" },
    caps: { type: "number" },
    special: {
      type: "object",
      properties: specialJsonProperties,
      additionalProperties: false
    },
    skills: {
      type: "object",
      properties: skillsJsonProperties,
      additionalProperties: false
    },
    perksAdd: { type: "array", items: jsonPerkSchema },
    perksRemove: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false
      }
    },
    inventoryChange: jsonInventoryChangeSchema
  },
  additionalProperties: false
};

const jsonQuestSchema: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    objective: { type: "string" },
    status: { type: "string", enum: ["active", "completed", "failed"] },
    hiddenProgress: { type: "string" }
  },
  required: ["id", "name", "objective", "status", "hiddenProgress"],
  additionalProperties: false
};

const jsonCompanionUpdatesSchema: JsonSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      name: { type: "string" },
      ifCompanion: { type: "boolean" },
      reason: { type: "string" }
    },
    required: ["name", "ifCompanion"],
    additionalProperties: false
  }
};

const jsonActorSchema: JsonSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    age: { type: "number" },
    gender: { type: "string" },
    faction: { type: "string" },
    special: {
      type: "object",
      properties: specialJsonProperties,
      required: Object.values(SpecialAttr),
      additionalProperties: false
    },
    skills: {
      type: "object",
      properties: skillsJsonProperties,
      additionalProperties: false
    },
    perks: { type: "array", items: jsonPerkSchema },
    inventory: { type: "array", items: jsonInventoryItemSchema },
    lore: { type: "string" },
    health: { type: "number" },
    maxHealth: { type: "number" },
    karma: { type: "number" },
    caps: { type: "number" },
    ifCompanion: { type: "boolean" },
    avatarUrl: { type: "string" }
  },
  required: ["name", "age", "faction", "special", "skills", "lore", "health", "maxHealth", "caps"],
  additionalProperties: false
};

const jsonPlayerCreationSchema: JsonSchema = {
  type: "object",
  properties: {
    ...jsonActorSchema.properties,
    companions: {
      type: "array",
      items: jsonActorSchema
    }
  },
  required: [...jsonActorSchema.required, "companions"],
  additionalProperties: false
};

const jsonNarratorSchema: JsonSchema = {
  type: "object",
  properties: {
    storyText: { type: "string" },
    ruleViolation: { type: ["string", "null"] },
    timePassedMinutes: { type: "number" },
    imagePrompt: { type: "string" }
  },
  required: ["storyText", "timePassedMinutes", "imagePrompt"],
  additionalProperties: false
};

const jsonArenaSchema: JsonSchema = {
  type: "object",
  properties: {
    storyText: { type: "string" },
    imagePrompt: { type: "string" },
    forcePowers: {
      type: "array",
      items: { type: "number" }
    }
  },
  required: ["storyText", "imagePrompt"],
  additionalProperties: false
};

const jsonStatusSchema: JsonSchema = {
  type: "object",
  properties: {
    playerChange: jsonPlayerChangeSchema,
    questUpdates: {
      type: "array",
      items: jsonQuestSchema
    },
    companionUpdates: jsonCompanionUpdatesSchema,
    newNpc: {
      type: "array",
      items: jsonActorSchema
    },
    location: { type: "string" },
    currentYear: { type: "number" },
    currentTime: { type: "string" }
  },
  additionalProperties: false
};

const jsonInventoryRefreshSchema: JsonSchema = {
  type: "object",
  properties: {
    inventory: {
      type: "array",
      items: jsonInventoryItemSchema
    }
  },
  required: ["inventory"],
  additionalProperties: false
};

const jsonInventoryRecoverySchema: JsonSchema = {
  type: "object",
  properties: {
    initialInventory: {
      type: "array",
      items: jsonInventoryItemSchema
    },
    inventoryChanges: {
      type: "array",
      items: {
        type: "object",
        properties: {
          narration_index: { type: "number" },
          inventoryChange: jsonInventoryChangeSchema
        },
        required: ["narration_index", "inventoryChange"],
        additionalProperties: false
      }
    }
  },
  required: ["initialInventory", "inventoryChanges"],
  additionalProperties: false
};

const jsonMemorySchema: JsonSchema = {
  type: "object",
  properties: {
    memory: { type: "string" }
  },
  required: ["memory"],
  additionalProperties: false
};

const buildInventoryWeightSystem = (targetLang: string) => `You are the Vault-Tec Inventory Auditor.
1. PURPOSE: Only verify and correct item WEIGHT values.
2. WEIGHT RULE: If weight is 0 lb, verify via Fallout Wiki and correct it. If the item truly weighs 0 (e.g. bottle caps), keep 0.
3. DO NOT change name, type, description, value, count, or isConsumable.
4. OUTPUT LANGUAGE: All text fields must be in ${targetLang}.
5. RETURN FORMAT: Return JSON only with key inventory.`;

const buildInventoryWeightPrompt = (inventory: InventoryItem[]) => `
Current Inventory (JSON):
${JSON.stringify(inventory)}

TASK:
Return JSON with key inventory containing the same items, with weight corrected if needed.`;

const buildInventoryRecoverySystem = (targetLang: string) => `You are the Vault-Tec Inventory Recovery System.
1. PURPOSE: Reconstruct the inventory timeline for an old save.
2. INPUTS: Use player lore and the full narration list. Do NOT use player actions.
3. OUTPUTS:
  - initialInventory: the player's starting inventory based on lore.
  - inventoryChanges: list of inventoryChange entries keyed by narration_index (1-based, narrator entries only).
4. inventoryChange must use add/remove only. add items with full details; remove uses name + count.
5. Do NOT invent items unless narration clearly implies gain or loss.
6. OUTPUT LANGUAGE: All text fields must be in ${targetLang}.
7. RETURN FORMAT: Return JSON only.`;

const buildInventoryRecoveryPrompt = (lore: string, narrations: string[]) => `
PLAYER LORE:
${lore}

NARRATIONS (1-based):
${narrations.map((text, index) => `[${index + 1}] ${text}`).join("\n")}

TASK:
Return JSON with initialInventory and inventoryChanges (narration_index + inventoryChange).`;

const buildCharacterSystem = (targetLang: string, userSystemPrompt?: string) => `You are the Vault-Tec Identity Reconstruction System.
1. INTERNAL PROCESSING: Always research and use the Fallout Wiki in English for lore accuracy.
2. MANDATORY LANGUAGE: All text fields in the final JSON MUST be in ${targetLang}.
3. TRANSLATION RULE: Use official Fallout localizations for ${targetLang}. If an official term does not exist, translate it manually and append the original English in parentheses.
4. ECONOMY: Assign 50-200 starting caps in the 'caps' field.
5. PERK SYSTEM: Assign 1-2 starting perks. And 1 perk particularly relevant to the character background. Each perk MUST include name, rank, and a non-empty description.
6. COMPANIONS: Always include a 'companions' array (empty if none). If the user specifies existing companions, include full NPC profiles (even animals or any creatures) and set ifCompanion=true for each.
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
1. PURPOSE: Emit ONLY status changes shown in the status bar (player stats, inventory, caps, quests, known NPCs/companions, location/year/time).
2. INPUTS: Use the CURRENT STATUS and the LAST NARRATION only. Do NOT infer changes that are not explicitly stated or clearly implied by the narration.
3. CONSISTENCY: Keep existing items, caps, perks, SPECIAL, skills, and quests unless the narration clearly changes them. Never invent trades or items.
4. INVENTORY CHANGE: Use inventoryChange.add/remove only. add items with full details; remove uses name + count. Do NOT output full inventory lists.
5. QUESTS: Return questUpdates entries only when a quest is created, advanced, completed, or failed. Do not delete quests.
6. OUTPUT LANGUAGE: All text fields must be in ${targetLang}.
7. RETURN FORMAT: Return JSON only. If nothing changes, return an empty object {}.
8. LORE: Respect Fallout lore for year ${year} and location ${location}.`;

const buildArenaSystem = (targetLang: string, mode: 'scenario' | 'wargame', userSystemPrompt?: string) => `You are the Wasteland Smash Arena simulator.
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
${userSystemPrompt && userSystemPrompt.trim() ? `10. USER DIRECTIVE: ${userSystemPrompt.trim()}` : ''}`;

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

const buildArenaPrompt = (
  focus: string,
  involvedParties: string[],
  history: HistoryEntry[],
  finish: boolean,
  mode: 'scenario' | 'wargame',
  phase: 'briefing' | 'battle',
  forcePowers?: Array<number | null>
) => `
FOCUS QUESTION:
${focus}

INVOLVED PARTIES:
${involvedParties.map((party, index) => `[${index + 1}] ${party}`).join("\n")}

${mode === 'wargame' ? `CURRENT FORCE POWER:
${(forcePowers || []).map((value, index) => `[${index + 1}] ${value === null || value === undefined ? 'UNKNOWN' : value}`).join("\n")}` : ''}

SIMULATION HISTORY:
${history.map(entry => `${entry.sender.toUpperCase()}: ${entry.text}`).join("\n")}

FINISH: ${finish ? "true" : "false"}
PHASE: ${phase}

TASK:
${mode === 'wargame'
  ? `If PHASE is briefing, provide a concise situation briefing only (no combat actions or damage). If CURRENT FORCE POWER is provided, return the same values unchanged; otherwise set initial forcePowers for each party (integer). If PHASE is battle, continue the battle as a war game report. Update forcePowers for each party (integer). If a party is a single unit, set forcePowers to that unit's HP. If a party is down to 0, mark them as defeated but keep narrating until FINISH or only one party remains.
forcePowers MUST be a JSON array of integers in the exact order of INVOLVED PARTIES. Example: "forcePowers":[1000,950]. Do NOT use an object/map.
Return JSON with keys: storyText, forcePowers, imagePrompt. imagePrompt is REQUIRED.`
  : `If PHASE is briefing, provide a concise situation briefing only (no combat actions or damage). If PHASE is battle, continue the battle simulation with tactics, setbacks, and momentum shifts. If FINISH is true, conclude the battle with a decisive outcome and aftermath.
Return JSON with keys: storyText, imagePrompt. imagePrompt is REQUIRED.`}`;

const normalizeForcePowerKey = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').trim();

const extractPartyHint = (party: string) => {
  const trimmed = party.trim();
  const firstSegment = trimmed.split(/[，,;\n]/)[0] || trimmed;
  return normalizeForcePowerKey(firstSegment);
};

const parseForcePowers = (value: any, involvedParties: string[]) => {
  if (Array.isArray(value)) {
    const mapped = value.map((entry: any) => Number(entry));
    return mapped.every(entry => Number.isFinite(entry)) ? mapped : undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const partyHints = involvedParties.map(party => extractPartyHint(party));
  const entries = Object.entries(value);
  const result: Array<number | null> = new Array(involvedParties.length).fill(null);
  entries.forEach(([rawKey, rawValue]) => {
    const key = normalizeForcePowerKey(rawKey);
    if (!key) return;
    const idx = partyHints.findIndex(hint => hint && (hint.includes(key) || key.includes(hint)));
    if (idx >= 0 && result[idx] === null) {
      const numeric = Number(rawValue);
      if (Number.isFinite(numeric)) {
        result[idx] = numeric;
      }
    }
  });
  const fallbackValues = entries.map(([, rawValue]) => Number(rawValue)).filter(val => Number.isFinite(val));
  let fallbackIndex = 0;
  for (let i = 0; i < result.length; i += 1) {
    if (result[i] !== null) continue;
    const candidate = fallbackValues[fallbackIndex++];
    if (!Number.isFinite(candidate)) return undefined;
    result[i] = candidate;
  }
  return result.every(entry => Number.isFinite(entry as number))
    ? (result as number[])
    : undefined;
};

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
playerChange, questUpdates, companionUpdates, newNpc (array), location, currentYear, currentTime.
playerChange should contain only changed fields (new values), plus inventoryChange with add/remove lists.
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

const callOpenAiJson = async (
  apiKey: string,
  baseUrl: string,
  model: string,
  system: string,
  prompt: string,
  schema?: JsonSchema,
  schemaName = "response"
) => {
  const baseBody = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt }
    ],
    max_completion_tokens: 2048
  };
  const responseFormat = schema
    ? { type: "json_schema", json_schema: { name: schemaName, schema, strict: true } }
    : { type: "json_object" };
  let res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ ...baseBody, response_format: responseFormat })
  });
  if (!res.ok) {
    const text = await res.text();
    const formatRejected = text.includes("response_format") || text.includes("json_schema");
    if (schema && formatRejected) {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({ ...baseBody, response_format: { type: "json_object" } })
      });
      if (!res.ok) {
        throw new Error(await formatHttpError(res, "OpenAI request failed"));
      }
    } else {
      const message = text
        ? `OpenAI request failed (HTTP ${res.status}): ${text}`
        : `OpenAI request failed (HTTP ${res.status}).`;
      throw new Error(message);
    }
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

const callClaudeJson = async (
  apiKey: string,
  baseUrl: string,
  model: string,
  system: string,
  prompt: string,
  schema?: JsonSchema
) => {
  const baseBody: Record<string, any> = {
    model,
    max_tokens: 4096,
    system,
    messages: [{ role: "user", content: prompt }]
  };
  if (schema) {
    baseBody.output_format = {
      type: "json_schema",
      schema
    };
    baseBody.betas = ["structured-outputs-2025-11-13"];
  }
  let res = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(baseBody)
  });
  if (!res.ok) {
    const text = await res.text();
    const formatRejected = text.includes("output_format") || text.includes("json_schema") || text.includes("structured");
    if (schema && formatRejected) {
      res = await fetch(`${baseUrl}/messages`, {
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
    } else {
      const message = text
        ? `Claude request failed (HTTP ${res.status}): ${text}`
        : `Claude request failed (HTTP ${res.status}).`;
      throw new Error(message);
    }
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

const callDoubaoJson = async (
  apiKey: string,
  baseUrl: string,
  model: string,
  system: string,
  prompt: string,
  schema?: JsonSchema,
  schemaName = "response"
) => {
  const baseBody = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt }
    ],
    max_tokens: 2048
  };
  const responseFormat = schema
    ? { type: "json_schema", json_schema: { name: schemaName, schema, strict: true } }
    : { type: "json_object" };
  let res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ ...baseBody, response_format: responseFormat })
  });
  if (!res.ok) {
    const text = await res.text();
    const formatRejected = text.includes("response_format") || text.includes("json_schema");
    if (schema && formatRejected) {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({ ...baseBody, response_format: { type: "json_object" } })
      });
      if (!res.ok) {
        throw new Error(await formatHttpError(res, "Doubao request failed"));
      }
    } else {
      const message = text
        ? `Doubao request failed (HTTP ${res.status}): ${text}`
        : `Doubao request failed (HTTP ${res.status}).`;
      throw new Error(message);
    }
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
    ? await callOpenAiJson(apiKey, baseUrl, model, system, prompt, jsonPlayerCreationSchema, "player_creation")
    : provider === "claude"
      ? await callClaudeJson(apiKey, baseUrl, model, system, prompt, jsonPlayerCreationSchema)
      : await callDoubaoJson(apiKey, baseUrl, model, system, prompt, jsonPlayerCreationSchema, "player_creation");

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
    ? await callOpenAiJson(apiKey, baseUrl, model, system, prompt, jsonNarratorSchema, "narrator")
    : provider === "claude"
      ? await callClaudeJson(apiKey, baseUrl, model, system, prompt, jsonNarratorSchema)
      : await callDoubaoJson(apiKey, baseUrl, model, system, prompt, jsonNarratorSchema, "narrator");

  const parsed = safeJsonParse(result.content);
  const response = parseNarrator(parsed, userInput);
  response.tokenUsage = result.tokenUsage;
  return response;
}

export async function getArenaNarration(
  focus: string,
  involvedParties: string[],
  history: HistoryEntry[],
  lang: Language,
  options?: {
    tier?: UserTier;
    apiKey?: string;
    proxyApiKey?: string;
    proxyBaseUrl?: string;
    useProxy?: boolean;
    textModel?: TextModelId;
    provider?: ModelProvider;
    userSystemPrompt?: string;
    finish?: boolean;
    mode?: 'scenario' | 'wargame';
    phase?: 'briefing' | 'battle';
    forcePowers?: Array<number | null>;
  }
): Promise<{ storyText: string; tokenUsage?: TokenUsage; forcePowers?: number[]; imagePrompt?: string }> {
  const provider = normalizeProvider(options?.provider);
  const useProxy = !!options?.useProxy;
  const finish = !!options?.finish;
  const mode = options?.mode === 'wargame' ? 'wargame' : 'scenario';
  const phase = options?.phase === 'battle' ? 'battle' : 'briefing';
  if (provider === "gemini") {
    if (options?.tier === "guest") {
      return getGeminiArenaNarration(focus, involvedParties, history, lang, {
        tier: options?.tier,
        apiKey: options?.apiKey,
        textModel: options?.textModel,
        userSystemPrompt: options?.userSystemPrompt,
        finish,
        mode,
        phase,
        forcePowers: options?.forcePowers
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
    const system = buildArenaSystem(targetLang, mode, options?.userSystemPrompt);
    const prompt = buildArenaPrompt(focus, involvedParties, history, finish, mode, phase, options?.forcePowers);
    const ai = new GoogleGenAI({
      apiKey,
      ...(proxyBaseUrl ? { httpOptions: { baseUrl: proxyBaseUrl } } : {})
    });
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: arenaSchema,
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
    const storyText = parsed?.storyText ? String(parsed.storyText) : "";
    if (!storyText.trim()) {
      throw new Error("Invalid arena response.");
    }
    const imagePrompt = typeof parsed?.imagePrompt === "string" ? parsed.imagePrompt : "";
    if (!imagePrompt.trim()) {
      throw new Error("Invalid arena response.");
    }
    const forcePowers = parseForcePowers(parsed?.forcePowers, involvedParties);
    if (mode === 'wargame' && (!forcePowers || forcePowers.length !== involvedParties.length)) {
      throw new Error("Invalid force power output.");
    }
    return { storyText, tokenUsage, forcePowers, imagePrompt };
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
  const system = buildArenaSystem(targetLang, mode, options?.userSystemPrompt);
  const prompt = buildArenaPrompt(focus, involvedParties, history, finish, mode, phase, options?.forcePowers);

  const result = provider === "openai"
    ? await callOpenAiJson(apiKey, baseUrl, model, system, prompt, jsonArenaSchema, "arena")
    : provider === "claude"
      ? await callClaudeJson(apiKey, baseUrl, model, system, prompt, jsonArenaSchema)
      : await callDoubaoJson(apiKey, baseUrl, model, system, prompt, jsonArenaSchema, "arena");

  const parsed = safeJsonParse(result.content);
  const storyText = parsed?.storyText ? String(parsed.storyText) : "";
  if (!storyText.trim()) {
    throw new Error("Invalid arena response.");
  }
  const imagePrompt = typeof parsed?.imagePrompt === "string" ? parsed.imagePrompt : "";
  if (!imagePrompt.trim()) {
    throw new Error("Invalid arena response.");
  }
  const forcePowers = parseForcePowers(parsed?.forcePowers, involvedParties);
  if (mode === 'wargame' && (!forcePowers || forcePowers.length !== involvedParties.length)) {
    throw new Error("Invalid force power output.");
  }
  return { storyText, tokenUsage: result.tokenUsage, forcePowers, imagePrompt };
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
    ? await callOpenAiJson(apiKey, baseUrl, model, system, prompt, jsonStatusSchema, "status_update")
    : provider === "claude"
      ? await callClaudeJson(apiKey, baseUrl, model, system, prompt, jsonStatusSchema)
      : await callDoubaoJson(apiKey, baseUrl, model, system, prompt, jsonStatusSchema, "status_update");

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
    ? await callOpenAiJson(apiKey, baseUrl, model, system, prompt, jsonInventoryRefreshSchema, "inventory_refresh")
    : provider === "claude"
      ? await callClaudeJson(apiKey, baseUrl, model, system, prompt, jsonInventoryRefreshSchema)
      : await callDoubaoJson(apiKey, baseUrl, model, system, prompt, jsonInventoryRefreshSchema, "inventory_refresh");

  const parsed = safeJsonParse(result.content);
  const items = parsed && typeof parsed === "object" && Array.isArray(parsed.inventory) ? parsed.inventory : [];
  return { inventory: items, tokenUsage: result.tokenUsage };
}

export async function auditInventoryWeights(
  inventory: InventoryItem[],
  lang: Language,
  options?: { tier?: UserTier; apiKey?: string; proxyApiKey?: string; proxyBaseUrl?: string; useProxy?: boolean; textModel?: TextModelId; provider?: ModelProvider }
): Promise<{ inventory: InventoryItem[]; tokenUsage?: TokenUsage }> {
  const provider = normalizeProvider(options?.provider);
  const useProxy = !!options?.useProxy;
  const targetLang = lang === "zh" ? "Chinese" : "English";
  const system = buildInventoryWeightSystem(targetLang);
  const prompt = buildInventoryWeightPrompt(inventory);

  if (provider === "gemini") {
    if (options?.tier === "guest") {
      const response = await auditGeminiInventoryWeights(inventory, lang, {
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
    ? await callOpenAiJson(apiKey, baseUrl, model, system, prompt, jsonInventoryRefreshSchema, "inventory_audit")
    : provider === "claude"
      ? await callClaudeJson(apiKey, baseUrl, model, system, prompt, jsonInventoryRefreshSchema)
      : await callDoubaoJson(apiKey, baseUrl, model, system, prompt, jsonInventoryRefreshSchema, "inventory_audit");

  const parsed = safeJsonParse(result.content);
  const items = parsed && typeof parsed === "object" && Array.isArray(parsed.inventory) ? parsed.inventory : [];
  return { inventory: items, tokenUsage: result.tokenUsage };
}

export async function recoverInventoryStatus(
  lore: string,
  narrations: string[],
  lang: Language,
  options?: { tier?: UserTier; apiKey?: string; proxyApiKey?: string; proxyBaseUrl?: string; useProxy?: boolean; textModel?: TextModelId; provider?: ModelProvider }
): Promise<{ initialInventory: InventoryItem[]; inventoryChanges: { narration_index: number; inventoryChange: any }[]; tokenUsage?: TokenUsage }> {
  const provider = normalizeProvider(options?.provider);
  const useProxy = !!options?.useProxy;
  const targetLang = lang === "zh" ? "Chinese" : "English";
  const system = buildInventoryRecoverySystem(targetLang);
  const prompt = buildInventoryRecoveryPrompt(lore, narrations);

  if (provider === "gemini") {
    if (options?.tier === "guest") {
      const response = await recoverGeminiInventoryStatus(lore, narrations, lang, {
        tier: options?.tier,
        apiKey: options?.apiKey,
        textModel: options?.textModel
      });
      const data = response && typeof response === "object" ? response as any : {};
      return {
        initialInventory: Array.isArray(data.initialInventory) ? data.initialInventory : [],
        inventoryChanges: Array.isArray(data.inventoryChanges) ? data.inventoryChanges : [],
        tokenUsage: data?.tokenUsage
      };
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
        responseSchema: inventoryRecoverySchema,
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
    return {
      initialInventory: Array.isArray(parsed?.initialInventory) ? parsed.initialInventory : [],
      inventoryChanges: Array.isArray(parsed?.inventoryChanges) ? parsed.inventoryChanges : [],
      tokenUsage
    };
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
    ? await callOpenAiJson(apiKey, baseUrl, model, system, prompt, jsonInventoryRecoverySchema, "inventory_recovery")
    : provider === "claude"
      ? await callClaudeJson(apiKey, baseUrl, model, system, prompt, jsonInventoryRecoverySchema)
      : await callDoubaoJson(apiKey, baseUrl, model, system, prompt, jsonInventoryRecoverySchema, "inventory_recovery");

  const parsed = safeJsonParse(result.content);
  return {
    initialInventory: Array.isArray(parsed?.initialInventory) ? parsed.initialInventory : [],
    inventoryChanges: Array.isArray(parsed?.inventoryChanges) ? parsed.inventoryChanges : [],
    tokenUsage: result.tokenUsage
  };
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
    ? await callOpenAiJson(apiKey, baseUrl, model, system, prompt, jsonMemorySchema, "memory")
    : provider === "claude"
      ? await callClaudeJson(apiKey, baseUrl, model, system, prompt, jsonMemorySchema)
      : await callDoubaoJson(apiKey, baseUrl, model, system, prompt, jsonMemorySchema, "memory");

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

export async function generateArenaAvatar(
  label: string,
  description: string,
  options?: {
    highQuality?: boolean;
    tier?: UserTier;
    apiKey?: string;
    proxyApiKey?: string;
    proxyBaseUrl?: string;
    useProxy?: boolean;
    imageModel?: ImageModelId;
    textModel?: TextModelId;
    provider?: ModelProvider;
    textProvider?: ModelProvider;
    textApiKey?: string;
    textProxyApiKey?: string;
  }
): Promise<{ url?: string; error?: string } | undefined> {
  const imageProvider = normalizeProvider(options?.provider);
  const researchProvider = normalizeProvider(options?.textProvider || options?.provider);
  const useProxy = !!options?.useProxy;
  const proxyBaseUrl = normalizeBaseUrl(options?.proxyBaseUrl);
  if (useProxy && !proxyBaseUrl) {
    return { error: "Missing proxy base URL." };
  }
  if (imageProvider === "claude") {
    return { error: "Claude image generation is not supported." };
  }

  const imageApiKey = requireApiKey(useProxy ? options?.proxyApiKey : options?.apiKey, imageProvider);
  const imageModel = options?.imageModel || "";
  if (!imageModel) {
    return { error: "Missing image model name." };
  }

  const basePrompt = `Fallout dossier portrait for "${label}". Description: ${description}. Style: Pip-Boy dossier headshot, gritty, realistic, neutral background.`;
  let finalPrompt = basePrompt;

  if (options?.highQuality !== false && options?.textModel) {
    const textModel = options.textModel;
    const researchApiKey = useProxy
      ? (options?.textProxyApiKey || options?.proxyApiKey)
      : (options?.textApiKey || options?.apiKey);
    if (researchProvider === "gemini" && researchApiKey) {
      try {
        const researchAi = new GoogleGenAI({
          apiKey: researchApiKey,
          ...(proxyBaseUrl ? { httpOptions: { baseUrl: proxyBaseUrl } } : {})
        });
        const researchResponse = await researchAi.models.generateContent({
          model: textModel,
          contents: `Research a Fallout portrait for: ${description}.
1. Identify key visual traits, attire, and faction motifs.
2. Use Fallout Wiki terms when possible.
3. Output a concise portrait description for a concept artist.`,
          config: {
            tools: [{ googleSearch: {} }]
          }
        });
        if (researchResponse?.text) {
          finalPrompt = `Fallout dossier portrait. ${researchResponse.text}`;
        }
      } catch {
        finalPrompt = basePrompt;
      }
    }
  }

  try {
    if (imageProvider === "gemini") {
      const imageAi = new GoogleGenAI({
        apiKey: imageApiKey,
        ...(proxyBaseUrl ? { httpOptions: { baseUrl: proxyBaseUrl } } : {})
      });
      const response = await imageAi.models.generateContent({
        model: imageModel,
        contents: {
          parts: [{ text: finalPrompt }]
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
    }

    const base64 = imageProvider === "openai"
      ? await generateOpenAiImage(imageApiKey, resolveBaseUrl(imageProvider, proxyBaseUrl), imageModel, finalPrompt)
      : await generateDoubaoImage(imageApiKey, resolveBaseUrl(imageProvider, proxyBaseUrl), imageModel, finalPrompt);
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
