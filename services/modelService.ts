import { GoogleGenAI, Type } from "@google/genai";
import { Actor, NarratorResponse, Language, Quest, GroundingSource, UserTier, PlayerCreationResult, TextModelId, ImageModelId, ModelProvider, SpecialAttr, Skill, TokenUsage, HistoryEntry, StatusUpdate, InventoryItem, EventOutcome, EventNarrationResponse } from "../types";
import {
  createPlayerCharacter as createGeminiPlayer,
  getNarrativeResponse as getGeminiNarration,
  getArenaNarration as getGeminiArenaNarration,
  generateSceneImage as generateGeminiScene,
  generateCompanionAvatar as generateGeminiAvatar,
  compressMemory as compressGeminiMemory,
  getStatusUpdate as getGeminiStatusUpdate,
  getEventOutcome as getGeminiEventOutcome,
  getEventNarration as getGeminiEventNarration,
  refreshInventory as refreshGeminiInventory,
  auditInventoryWeights as auditGeminiInventoryWeights,
  recoverInventoryStatus as recoverGeminiInventoryStatus
} from "./geminiService";

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const GROK_BASE_URL = "https://api.x.ai/v1";
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
name, age, gender, faction, appearance, special, skills, perks, inventory, lore, health, maxHealth, karma, caps, ifCompanion (optional), avatarUrl (optional).
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
    appearance: { type: Type.STRING },
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

const eventSchema = {
  type: Type.OBJECT,
  properties: {
    outcomeSummary: { type: Type.STRING },
    ruleViolation: { type: Type.STRING },
    timePassedMinutes: { type: Type.NUMBER },
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
  },
  required: ["outcomeSummary", "timePassedMinutes"]
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
    appearance: { type: "string" },
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
  required: ["name", "age", "faction", "appearance", "special", "skills", "lore", "health", "maxHealth", "caps"],
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

const jsonNarratorSchemaDoubao: JsonSchema = {
  ...jsonNarratorSchema,
  properties: {
    ...jsonNarratorSchema.properties,
    ruleViolation: { type: "string" }
  }
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

const jsonEventSchema: JsonSchema = {
  type: "object",
  properties: {
    outcomeSummary: { type: "string" },
    ruleViolation: { type: ["string", "null"] },
    timePassedMinutes: { type: "number" },
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
  required: ["outcomeSummary", "timePassedMinutes"],
  additionalProperties: false
};

const jsonEventSchemaDoubao: JsonSchema = {
  ...jsonEventSchema,
  properties: {
    ...jsonEventSchema.properties,
    ruleViolation: { type: "string" }
  }
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
8. FIELDS TO LOCALIZE: name, faction, appearance, lore, perks[].name, perks[].description, inventory[].name, inventory[].description, companions[].name, companions[].faction, companions[].appearance, companions[].lore, companions[].perks[].name, companions[].perks[].description, companions[].inventory[].name, companions[].inventory[].description.
9. When generating the text in "lore", use markdown format for better readability. Use * for listing if needed.
${userSystemPrompt && userSystemPrompt.trim() ? `10. USER DIRECTIVE: ${userSystemPrompt.trim()}` : ''}
${actorSchemaHint}`;

const buildNarratorSystem = (targetLang: string, year: number, location: string, userSystemPrompt?: string) => `You are the Fallout Overseer.
1. SOURCE: Strictly source all lore, item stats, and location details from the Fallout Wiki in English.
1.1. OUTPUT RULE: Never cite sources, URLs, or parenthetical provenance in player-facing narration. Keep the narration immersive.
2. MANDATORY LANGUAGE: You MUST output all text presented to the player in ${targetLang}.
3. STATUS CONTROL: Do NOT update quests, inventory, caps, perks, companions, location, or any player/NPC stats. A separate status manager handles all status updates.
4. RULE GUARD: Only set ruleViolation when the player explicitly dictates outcomes or facts (e.g., "I succeed and get the item," "the guard is dead because I say so"). If they only state intent/attempts, do NOT set ruleViolation, even if the attempt fails or goes badly. If the action fails due to missing tools/items or unmet conditions, describe that in storyText/outcomeSummary instead of using ruleViolation. If no violation, set ruleViolation to "false".
5. CONTINUITY CORRECTION: If the player says prior narration missed/forgot plot or lore, comply and correct the continuity in the response.
6. TRANSLATION: Use "Term (Original)" for unlocalized items.
7. CONSISTENCY: Ensure current year (${year}) and location (${location}) lore is followed.
8. When generating the text for "storyText", use markdown format for better readability. For example, use '>' for dialogues. Use bullet points or numbered lists where appropriate. Use **bold** to highlight important terms. Use *italics* for emphasis. Use underline for key actions or items. Use * for listing available choices.
${userSystemPrompt && userSystemPrompt.trim() ? `9. USER DIRECTIVE: ${userSystemPrompt.trim()}` : ''}`;

const buildEventSystem = (targetLang: string, year: number, location: string, userSystemPrompt?: string) => `You are the Vault-Tec Event Manager.
1. SOURCE: Strictly source all lore, item stats, and location details from the Fallout Wiki in English.
1.1. OUTPUT RULE:
- Never cite sources, URLs, or parenthetical provenance in player-facing text.
- The world adheres to Fallout's physics, technology, social dynamics, and faction logic.
- Event outcomes must be explainable through environment, resources, motivations, and constraints—not simply "because the plot demands it."
- Avoid obvious optimal strategies; if present, explain why they weren't adopted or failed.
- Encourage using indirect means, environmental factors, deception, sabotage, timing, and psychological tactics to alter situations.
- Storylines should reflect 3–6 steps of implied causality chains, but avoid presenting reasoning as a list.
- The text in the "outcomeSummary" must remain short and concise but obey the logic above, and be precise and comprehensive. For example, "Someone done something because of reasons, leading to results. And/meanwhile A causes B by doing C, resulting in D, the situation ends with E.", avoid using any dramatic or decorative language.
- Update the other keys strictly based on the values in the "outcomeSummary" key. 
2. MANDATORY LANGUAGE: You MUST output all text fields in ${targetLang}.
3. PURPOSE: Determine the concrete outcome of the player action and emit ONLY the state deltas.
4. RULE GUARD: Only set ruleViolation when the player explicitly dictates outcomes or facts. Do NOT use ruleViolation for unlucky/partial results, missing tools/items, or to justify item quality; handle those in outcomeSummary/playerChange. If no violation, set ruleViolation to "false".
5. CONTINUITY CORRECTION: If the player says prior narration missed/forgot plot or lore, comply and correct the continuity in the outcomeSummary (do not flag ruleViolation).
6. DIFF ONLY: Output only changed fields. Omit keys when no changes occur.
6.1. If a required field has no reasonable value, use empty string/0/false (or []/{} for lists/objects) rather than inventing details.
7. INVENTORY CHANGE: Use inventoryChange.add/remove only. add items with full details; remove uses name + count. Do NOT output full inventory lists.
7.1. Whenever the narration or outcome mentions using, consuming, looting, or losing items, translate those movements into inventoryChange entries so the status manager can apply them. Do not leave inventoryChange empty when the text already describes tangible loot or consumption.
8. PLAYER CHANGE: All numeric playerChange fields are DELTAS (positive or negative), not final totals. special and skills are per-stat deltas.
9. QUESTS: Return questUpdates entries only when a quest is created, advanced, completed, or failed. Do not delete quests.
10. NEW NPCS: For newNpc entries, include a short physical appearance description in the appearance field.
11. CONSISTENCY: Ensure current year (${year}) and location (${location}) lore is followed.
${userSystemPrompt && userSystemPrompt.trim() ? `12. USER DIRECTIVE: ${userSystemPrompt.trim()}` : ''}`;

const buildEventNarratorSystem = (targetLang: string, year: number, location: string, userSystemPrompt?: string) => `You are the Fallout Overseer.
1. SOURCE: Strictly source all lore, item stats, and location details from the Fallout Wiki in English.
1.1. OUTPUT RULE: Never cite sources, URLs, or parenthetical provenance in player-facing narration. Keep the narration immersive.
2. MANDATORY LANGUAGE: You MUST output all text presented to the player in ${targetLang}.
3. EVENT LOCK: Narrate ONLY what is contained in EVENT_OUTCOME. Do NOT invent or alter outcomes, items, NPCs, quests, or stats.
4. TRANSLATION: Use "Term (Original)" for unlocalized items.
5. CONSISTENCY: Ensure current year (${year}) and location (${location}) lore is followed.
6. When generating the text for "storyText", use markdown format for better readability. For example, use '>' for dialogues. Use bullet points or numbered lists where appropriate. Use **bold** to highlight important terms. Use *italics* for emphasis. Use underline for key actions or items. Use * for listing available choices.
7. Please state any status change strictly based on the "EVENT_OUTCOME:" json, for example: state the player inventory changes and other player status change strictly based on the values in "playerChange" under "EVENT_OUTCOME:", do not hallucinate any status change from your own narration.
8. Use markdown to state the status change. For example: "\` Lost Item:\` **10x Stimpak**", "\` Gained Caps:\` **+50 Caps**", "\` Quest Updated:\` **'Find the Vault' - Completed**", "\`Companion Updated:\` **'Companion Name' - Status Changed**".
${userSystemPrompt && userSystemPrompt.trim() ? `9. USER DIRECTIVE: ${userSystemPrompt.trim()}` : ''}`;

const buildStatusSystem = (targetLang: string, year: number, location: string) => `You are the Vault-Tec Status Manager.
1. PURPOSE: Emit ONLY status changes shown in the status bar (player stats, inventory, caps, quests, known NPCs/companions, location/year/time).
2. INPUTS: Use the CURRENT STATUS and the LAST NARRATION only. Do NOT infer changes that are not explicitly stated or clearly implied by the narration.
3. CONSISTENCY: Keep existing items, caps, perks, SPECIAL, skills, and quests unless the narration clearly changes them. Never invent trades or items.
4. INVENTORY CHANGE: Use inventoryChange.add/remove only. add items with full details; remove uses name + count. Do NOT output full inventory lists.
5. PLAYER CHANGE: All numeric playerChange fields are DELTAS (positive or negative), not final totals. special and skills are per-stat deltas.
6. QUESTS: Return questUpdates entries only when a quest is created, advanced, completed, or failed. Do not delete quests.
7. OUTPUT LANGUAGE: All text fields must be in ${targetLang}.
8. NEW NPCS: For newNpc entries, include a short physical appearance description in the appearance field.
9. RETURN FORMAT: Return JSON only. If nothing changes, return an empty object {}.
10. LORE: Respect Fallout lore for year ${year} and location ${location}.`;

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
10. Simulation rules:
  - The world adheres to Fallout's physics, technology, social dynamics, and faction logic.
  - Event outcomes must be explainable through environment, resources, motivations, and constraints—not simply "because the plot demands it."
  - Avoid obvious optimal strategies; if present, explain why they weren't adopted or failed.
  - Encourage using indirect means, environmental factors, deception, sabotage, timing, and psychological tactics to alter situations.
  - Storylines should reflect 3–6 steps of implied causality chains, but avoid presenting reasoning as a list.
11. When generating the text for "storyText", use markdown format for better readability. For example, use '>' for dialogues. Use bullet points or numbered lists where appropriate. Use **bold** to highlight important terms. Use *italics* for emphasis. Use underline for key actions or items. Use * for listing if needed.
${userSystemPrompt && userSystemPrompt.trim() ? `12. USER DIRECTIVE: ${userSystemPrompt.trim()}` : ''}`;

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
7. Only set ruleViolation when the player explicitly dictates outcomes or facts; missing tools/items or unmet conditions are not violations. If no violation, set ruleViolation to "false".
8. If the player notes that prior narration missed/forgot plot or lore, comply and correct the continuity in your narration.
Return strict JSON with keys: storyText, ruleViolation, timePassedMinutes, imagePrompt.`;

const buildEventPrompt = (
  player: Actor,
  history: any[],
  userInput: string,
  year: number,
  location: string,
  currentTime: string,
  quests: Quest[],
  knownNpcs: Actor[]
) => `
Environment Year: ${year}
Environment Location: ${location}
Current Time: ${currentTime}
Current Player Status: ${JSON.stringify(player)}
Existing Quests: ${JSON.stringify(quests)}
Known NPCs: ${JSON.stringify(knownNpcs)}
Interaction Context:
${history.map(h => `${h.sender.toUpperCase()}: ${h.text}`).join("\n")}
Player's current intent/action: "${userInput}"

TASK:
1. Determine the outcome of the action.
2. Define the concrete event outcomes and state changes (diff-only).
3. Avoid assuming the player is the protagonist, unless the user specified or the player background says so.
4. You are encouraged to create new events for the player that fit within the Fallout universe to enhance the story.
5. You are not encouraged to force bind the existed wiki events/quest to the player. Only do that occasionally if it fits well.
6. If the player's action includes using an item that is not in their inventory, don't return a rule violation. Instead, set the outcome where the player realizes they don't have the item.
7. Only set ruleViolation when the player explicitly dictates outcomes or facts; missing tools/items or unmet conditions are not violations. If no violation, set ruleViolation to "false".
8. If the player notes that prior narration missed/forgot plot or lore, comply and correct the continuity in outcomeSummary.
9. All numeric playerChange fields must be deltas (positive or negative), not final totals. special and skills are per-stat deltas.
Return strict JSON with keys: outcomeSummary, ruleViolation, timePassedMinutes, playerChange, questUpdates, companionUpdates, newNpc (array), location, currentYear, currentTime.`;

const buildEventNarratorPrompt = (
  player: Actor,
  year: number,
  location: string,
  eventOutcome: EventOutcome
) => `
Environment Year: ${year}
Environment Location: ${location}
Current Player Profile: ${JSON.stringify(player)}

EVENT_OUTCOME:
${JSON.stringify(eventOutcome)}

TASK:
1. Narrate the outcome strictly based on EVENT_OUTCOME. Do NOT add new outcomes or state changes.
2. Focus on vivid descriptions, character dialogues, and environmental details that align with the event.
Return JSON with keys: storyText, imagePrompt.`;

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
playerChange should contain only changed fields, plus inventoryChange with add/remove lists.
All numeric playerChange fields must be deltas (positive or negative), not final totals. special and skills are per-stat deltas.
Each newNpc entry MUST include appearance (short physical description).
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
  provider && ["openai", "grok", "gemini", "claude", "doubao"].includes(provider) ? provider : "gemini";

const isOpenAiCompatible = (provider: ModelProvider) => provider === "openai" || provider === "grok";

const getOpenAiLabel = (provider: ModelProvider) => (provider === "grok" ? "Grok" : "OpenAI");

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

const extractGrokCitations = (payload: any): GroundingSource[] => {
  const candidates = [
    payload?.citations,
    payload?.choices?.[0]?.citations,
    payload?.choices?.[0]?.message?.citations,
    payload?.choices?.[0]?.message?.context?.citations
  ];
  const citationList = candidates.find((entry) => Array.isArray(entry)) as any[] | undefined;
  if (!citationList) return [];
  return citationList
    .map((item) => {
      if (!item) return null;
      if (typeof item === "string") {
        return { title: item, uri: item };
      }
      const uri = item.url || item.uri || "";
      if (!uri) return null;
      const title = item.title || item.name || item.text || uri;
      return { title, uri };
    })
    .filter((entry): entry is GroundingSource => !!entry);
};

const callGrokWebSearch = async (
  apiKey: string,
  baseUrl: string,
  model: string,
  prompt: string,
  maxLength = 800
): Promise<{ text: string; sources: GroundingSource[] }> => {
  const res = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "user", content: prompt }
      ],
      tools: [{ type: "web_search" }]
    })
  });
  if (!res.ok) {
    throw new Error(await formatHttpError(res, "Grok request failed"));
  }
  const data = await res.json();
  let content = "";
  if (typeof data?.output_text === "string") {
    content = data.output_text;
  } else if (Array.isArray(data?.output)) {
    data.output.forEach((entry: any) => {
      const parts = Array.isArray(entry?.content) ? entry.content : [];
      parts.forEach((part: any) => {
        if (typeof part?.text === "string") {
          content += part.text;
        }
      });
    });
  }
  const sources = extractGrokCitations(data);
  const trimmed = clampImagePrompt(content, maxLength);
  return { text: trimmed, sources };
};

const callOpenAiWebSearch = async (
  apiKey: string,
  baseUrl: string,
  model: string,
  prompt: string,
  maxLength = 800
): Promise<{ text: string }> => {
  const res = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "user", content: prompt }
      ],
      tools: [{ type: "web_search" }]
    })
  });
  if (!res.ok) {
    throw new Error(await formatHttpError(res, "OpenAI request failed"));
  }
  const data = await res.json();
  let content = "";
  if (typeof data?.output_text === "string") {
    content = data.output_text;
  } else if (Array.isArray(data?.output)) {
    data.output.forEach((entry: any) => {
      const parts = Array.isArray(entry?.content) ? entry.content : [];
      parts.forEach((part: any) => {
        if (typeof part?.text === "string") {
          content += part.text;
        }
      });
    });
  }
  const trimmed = clampImagePrompt(content, maxLength);
  return { text: trimmed };
};

const resolveBaseUrl = (provider: ModelProvider, baseUrl?: string) => {
  const normalized = normalizeBaseUrl(baseUrl);
  if (normalized) return normalized;
  switch (provider) {
    case "openai":
      return OPENAI_BASE_URL;
    case "grok":
      return GROK_BASE_URL;
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
  const ruleViolationRaw = typeof raw?.ruleViolation === "string" ? raw.ruleViolation.trim() : "";
  const normalizedRuleViolation = ruleViolationRaw
    && ruleViolationRaw.toLowerCase() !== "null"
    && ruleViolationRaw.toLowerCase() !== "false"
    ? ruleViolationRaw
    : null;
  return {
    storyText,
    ruleViolation: normalizedRuleViolation,
    timePassedMinutes,
    imagePrompt: raw?.imagePrompt || fallbackPrompt
  };
};

const normalizeInventoryChangeCarrier = (raw: any) => {
  if (!raw || typeof raw !== "object") return raw;
  if (!raw.inventoryChange || typeof raw.inventoryChange !== "object") return raw;
  const playerChange = raw.playerChange && typeof raw.playerChange === "object" ? raw.playerChange : {};
  const nextPlayerChange = playerChange.inventoryChange
    ? playerChange
    : { ...playerChange, inventoryChange: raw.inventoryChange };
  const { inventoryChange: _inventoryChange, ...rest } = raw;
  return { ...rest, playerChange: nextPlayerChange };
};

const parseEventOutcome = (raw: any) => {
  const normalized = normalizeInventoryChangeCarrier(raw);
  const outcomeSummary = typeof normalized?.outcomeSummary === "string" ? normalized.outcomeSummary : "";
  const timePassedMinutes = typeof normalized?.timePassedMinutes === "number" ? normalized.timePassedMinutes : 0;
  const ruleViolationRaw = typeof normalized?.ruleViolation === "string" ? normalized.ruleViolation.trim() : "";
  const normalizedRuleViolation = ruleViolationRaw
    && ruleViolationRaw.toLowerCase() !== "null"
    && ruleViolationRaw.toLowerCase() !== "false"
    ? ruleViolationRaw
    : null;
  return {
    outcomeSummary,
    ruleViolation: normalizedRuleViolation,
    timePassedMinutes,
    playerChange: normalized?.playerChange,
    questUpdates: normalized?.questUpdates,
    companionUpdates: normalized?.companionUpdates,
    newNpc: normalized?.newNpc,
    location: normalized?.location,
    currentYear: normalized?.currentYear,
    currentTime: normalized?.currentTime
  };
};

const parseEventNarration = (raw: any, fallbackPrompt: string) => {
  const storyText = typeof raw?.storyText === "string" ? raw.storyText : "";
  const imagePrompt = typeof raw?.imagePrompt === "string" ? raw.imagePrompt : fallbackPrompt;
  return { storyText, imagePrompt };
};

const buildImagePrompt = (prompt: string, highQuality: boolean) => {
  if (!highQuality) return prompt;
  return `Cinematic Fallout concept art. ${prompt}. Atmosphere: desolate, atmospheric, detailed. Style: digital art, 4k, hyper-realistic wasteland aesthetic.`;
};

const clampImagePrompt = (prompt: string, maxLength: number) => {
  const cleaned = prompt
    .replace(/\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\[[0-9]+\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  return cleaned.slice(0, maxLength).trim();
};

const buildUserGuidanceLine = (userSystemPrompt?: string) => {
  const guidance = userSystemPrompt?.trim();
  return guidance ? `User guidance: ${guidance}` : "";
};

const buildImageContext = (imageUserSystemPrompt?: string) => {
  return buildUserGuidanceLine(imageUserSystemPrompt);
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
  schemaName = "response",
  providerLabel = "OpenAI"
) => {
  const requestLabel = providerLabel || "OpenAI";
  const responseFormatChat = schema
    ? { type: "json_schema", json_schema: { name: schemaName, schema, strict: true } }
    : { type: "json_object" };
  const responseFormatResponses = schema
    ? { type: "json_schema", name: schemaName, schema, strict: true }
    : { type: "json_object" };
  const baseHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`
  };
  const isResponsesOnlyModel = /^gpt-5/i.test(model);
  const includeReasoning = requestLabel !== "Grok";
  const buildResponsesBody = (formatOverride?: any) => {
    const body: Record<string, any> = {
      model,
      instructions: system,
      input: [
        { role: "user", content: prompt }
      ],
      text: { format: formatOverride ?? responseFormatResponses }
    };
    if (includeReasoning) {
      body.reasoning = { effort: "low" };
    }
    return body;
  };
  const extractResponsesContent = (data: any) => {
    if (typeof data?.output_text === "string" && data.output_text.trim()) {
      return data.output_text;
    }
    let text = "";
    let jsonPayload: any = null;
    const outputs = Array.isArray(data?.output) ? data.output : [];
    outputs.forEach((entry: any) => {
      const parts = Array.isArray(entry?.content) ? entry.content : [];
      parts.forEach((part: any) => {
        if (!part || typeof part !== "object") return;
        if (part.type === "output_json" && part.json != null) {
          jsonPayload = part.json;
        }
        if (typeof part.text === "string") {
          text += part.text;
        }
      });
    });
    if (jsonPayload != null) {
      return JSON.stringify(jsonPayload);
    }
    return text;
  };
  let res = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: baseHeaders,
    body: JSON.stringify(buildResponsesBody())
  });
  if (res.ok) {
    const data = await res.json();
    const content = extractResponsesContent(data);
    if (data?.status === "incomplete" && data?.incomplete_details?.reason) {
      const error = new Error(`${requestLabel} response incomplete: ${data.incomplete_details.reason}`);
      (error as { rawOutput?: string }).rawOutput = JSON.stringify(data);
      throw error;
    }
    if (!content.trim()) {
      const error = new Error(`${requestLabel} response contained no output.`);
      (error as { rawOutput?: string }).rawOutput = JSON.stringify(data);
      throw error;
    }
    const usage = data?.usage;
    const tokenUsage = normalizeTokenUsage({
      promptTokens: usage?.input_tokens,
      completionTokens: usage?.output_tokens,
      totalTokens: usage?.total_tokens
    }, `${system}\n${prompt}`, content);
    return { content, tokenUsage };
  }

  const errorText = await res.text();
    const formatRejected = schema && (errorText.includes("json_schema") || errorText.includes("text.format"));
  if (formatRejected) {
    const retryBody = buildResponsesBody({ type: "json_object" });
    res = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: baseHeaders,
      body: JSON.stringify(retryBody)
    });
    if (res.ok) {
      const data = await res.json();
      const content = extractResponsesContent(data);
      if (!content.trim()) {
        const error = new Error(`${requestLabel} response contained no output.`);
        (error as { rawOutput?: string }).rawOutput = JSON.stringify(data);
        throw error;
      }
      const usage = data?.usage;
      const tokenUsage = normalizeTokenUsage({
        promptTokens: usage?.input_tokens,
        completionTokens: usage?.output_tokens,
        totalTokens: usage?.total_tokens
      }, `${system}\n${prompt}`, content);
      return { content, tokenUsage };
    }
  }

  const shouldFallback = !isResponsesOnlyModel && (
    res.status === 404
    || res.status === 405
    || (requestLabel === "Grok" && res.status === 400)
  );
  if (!shouldFallback) {
    const message = errorText
      ? `${requestLabel} request failed (HTTP ${res.status}): ${errorText}`
      : `${requestLabel} request failed (HTTP ${res.status}).`;
    throw new Error(message);
  }

  const baseBody = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt }
    ]
  };
  let chatRes = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: baseHeaders,
    body: JSON.stringify({ ...baseBody, response_format: responseFormatChat })
  });
  if (!chatRes.ok) {
    const text = await chatRes.text();
    const formatRejected = text.includes("response_format") || text.includes("json_schema");
    if (schema && formatRejected) {
      chatRes = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: baseHeaders,
        body: JSON.stringify({ ...baseBody, response_format: { type: "json_object" } })
      });
      if (!chatRes.ok) {
        throw new Error(await formatHttpError(chatRes, `${requestLabel} request failed`));
      }
    } else {
      const message = text
        ? `${requestLabel} request failed (HTTP ${chatRes.status}): ${text}`
        : `${requestLabel} request failed (HTTP ${chatRes.status}).`;
      throw new Error(message);
    }
  }
  const data = await chatRes.json();
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

const generateOpenAiImage = async (
  apiKey: string,
  baseUrl: string,
  model: string,
  prompt: string,
  provider: ModelProvider
) => {
  const requestLabel = getOpenAiLabel(provider);
  if (provider === "openai" && !/^(gpt-image-|dall-e-)/i.test(model)) {
    throw new Error(`${requestLabel} image model "${model}" is not supported. Use gpt-image-1 or a DALL·E model.`);
  }
  const effectivePrompt = provider === "grok"
    ? clampImagePrompt(prompt, 1024)
    : prompt;
  const requestBody: Record<string, any> = {
    model,
    prompt: effectivePrompt
  };
  if (provider !== "grok") {
    requestBody.size = "1024x1024";
  }
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
    const message = text
      ? `${requestLabel} image request failed (HTTP ${res.status}): ${text}`
      : `${requestLabel} image request failed (HTTP ${res.status}).`;
    throw new Error(message);
  }
  const data = await res.json();
  const b64 = data?.data?.[0]?.b64_json as string | undefined;
  if (b64) return b64;
  const url = data?.data?.[0]?.url as string | undefined;
  if (url) {
    if (provider === "grok") {
      return url;
    }
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
    const prompt = `Create a Fallout character for the year ${year} in ${region} based on this input: "${userInput}". Ensure they have appropriate initial perks, inventory, and starting Bottle Caps (50-200 caps). Include a short appearance description for the player and any companions. If the user mentions starting companions, include them.`;
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
  const prompt = `Create a Fallout character for the year ${year} in ${region} based on this input: "${userInput}". Ensure they have appropriate initial perks, inventory, and starting Bottle Caps (50-200 caps). Include a short appearance description for the player and any companions. If the user mentions starting companions, include them.`;

  const result = isOpenAiCompatible(provider)
    ? await callOpenAiJson(
      apiKey,
      baseUrl,
      model,
      system,
      prompt,
      jsonPlayerCreationSchema,
      "player_creation",
      getOpenAiLabel(provider)
    )
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

  const narratorSchema = provider === "doubao" ? jsonNarratorSchemaDoubao : jsonNarratorSchema;
  const result = isOpenAiCompatible(provider)
    ? await callOpenAiJson(
      apiKey,
      baseUrl,
      model,
      system,
      prompt,
      narratorSchema,
      "narrator",
      getOpenAiLabel(provider)
    )
    : provider === "claude"
      ? await callClaudeJson(apiKey, baseUrl, model, system, prompt, narratorSchema)
      : await callDoubaoJson(apiKey, baseUrl, model, system, prompt, narratorSchema, "narrator");

  const parsed = safeJsonParse(result.content);
  const response = parseNarrator(parsed, userInput);
  response.tokenUsage = result.tokenUsage;
  return response;
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
  options?: { tier?: UserTier; apiKey?: string; proxyApiKey?: string; proxyBaseUrl?: string; useProxy?: boolean; textModel?: TextModelId; provider?: ModelProvider; userSystemPrompt?: string }
): Promise<EventOutcome> {
  const provider = normalizeProvider(options?.provider);
  const useProxy = !!options?.useProxy;
  const targetLang = lang === "zh" ? "Chinese" : "English";
  const system = buildEventSystem(targetLang, year, location, options?.userSystemPrompt);
  const prompt = buildEventPrompt(player, history, userInput, year, location, currentTime, quests, knownNpcs);

  if (provider === "gemini") {
    if (options?.tier === "guest") {
      const response = await getGeminiEventOutcome(
        player,
        history,
        userInput,
        year,
        location,
        currentTime,
        quests,
        knownNpcs,
        lang,
        { tier: options?.tier, apiKey: options?.apiKey, textModel: options?.textModel, userSystemPrompt: options?.userSystemPrompt }
      );
      return response;
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
        responseSchema: eventSchema,
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
    const outcome = { ...parseEventOutcome(parsed), tokenUsage };
    return outcome as EventOutcome;
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

  const eventSchemaForProvider = provider === "doubao" ? jsonEventSchemaDoubao : jsonEventSchema;
  const result = isOpenAiCompatible(provider)
    ? await callOpenAiJson(
      apiKey,
      baseUrl,
      model,
      system,
      prompt,
      eventSchemaForProvider,
      "event_outcome",
      getOpenAiLabel(provider)
    )
    : provider === "claude"
      ? await callClaudeJson(apiKey, baseUrl, model, system, prompt, eventSchemaForProvider)
      : await callDoubaoJson(apiKey, baseUrl, model, system, prompt, eventSchemaForProvider, "event_outcome");

  const parsed = safeJsonParse(result.content);
  const outcome = { ...parseEventOutcome(parsed), tokenUsage: result.tokenUsage };
  return outcome as EventOutcome;
}

export async function getEventNarration(
  player: Actor,
  year: number,
  location: string,
  eventOutcome: EventOutcome,
  lang: Language,
  options?: { tier?: UserTier; apiKey?: string; proxyApiKey?: string; proxyBaseUrl?: string; useProxy?: boolean; textModel?: TextModelId; provider?: ModelProvider; userSystemPrompt?: string }
): Promise<EventNarrationResponse> {
  const provider = normalizeProvider(options?.provider);
  const useProxy = !!options?.useProxy;
  const targetLang = lang === "zh" ? "Chinese" : "English";
  const system = buildEventNarratorSystem(targetLang, year, location, options?.userSystemPrompt);
  const prompt = buildEventNarratorPrompt(player, year, location, eventOutcome);

  if (provider === "gemini") {
    if (options?.tier === "guest") {
      return getGeminiEventNarration(player, year, location, eventOutcome, lang, {
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
            imagePrompt: { type: Type.STRING }
          },
          required: ["storyText", "imagePrompt"]
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
    const narration = { ...parseEventNarration(parsed, eventOutcome.outcomeSummary || ""), tokenUsage };
    return narration as EventNarrationResponse;
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

  const eventNarrationSchema: JsonSchema = {
    type: "object",
    properties: {
      storyText: { type: "string" },
      imagePrompt: { type: "string" }
    },
    required: ["storyText", "imagePrompt"],
    additionalProperties: false
  };

  const result = isOpenAiCompatible(provider)
    ? await callOpenAiJson(
      apiKey,
      baseUrl,
      model,
      system,
      prompt,
      eventNarrationSchema,
      "event_narration",
      getOpenAiLabel(provider)
    )
    : provider === "claude"
      ? await callClaudeJson(apiKey, baseUrl, model, system, prompt, eventNarrationSchema)
      : await callDoubaoJson(apiKey, baseUrl, model, system, prompt, eventNarrationSchema, "event_narration");

  const parsed = safeJsonParse(result.content);
  const narration = { ...parseEventNarration(parsed, eventOutcome.outcomeSummary || ""), tokenUsage: result.tokenUsage };
  return narration as EventNarrationResponse;
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

  const result = isOpenAiCompatible(provider)
    ? await callOpenAiJson(
      apiKey,
      baseUrl,
      model,
      system,
      prompt,
      jsonArenaSchema,
      "arena",
      getOpenAiLabel(provider)
    )
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
        const normalized = normalizeInventoryChangeCarrier(response);
        const update = normalized && typeof normalized === "object" ? (normalized as StatusUpdate) : {};
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
      const normalized = normalizeInventoryChangeCarrier(parsed);
      const update = normalized && typeof normalized === "object" ? (normalized as StatusUpdate) : {};
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

  const result = isOpenAiCompatible(provider)
    ? await callOpenAiJson(
      apiKey,
      baseUrl,
      model,
      system,
      prompt,
      jsonStatusSchema,
      "status_update",
      getOpenAiLabel(provider)
    )
    : provider === "claude"
      ? await callClaudeJson(apiKey, baseUrl, model, system, prompt, jsonStatusSchema)
      : await callDoubaoJson(apiKey, baseUrl, model, system, prompt, jsonStatusSchema, "status_update");

    const parsed = safeJsonParse(result.content);
    const normalized = normalizeInventoryChangeCarrier(parsed);
    const update = normalized && typeof normalized === "object" ? (normalized as StatusUpdate) : {};
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

  const result = isOpenAiCompatible(provider)
    ? await callOpenAiJson(
      apiKey,
      baseUrl,
      model,
      system,
      prompt,
      jsonInventoryRefreshSchema,
      "inventory_refresh",
      getOpenAiLabel(provider)
    )
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

  const result = isOpenAiCompatible(provider)
    ? await callOpenAiJson(
      apiKey,
      baseUrl,
      model,
      system,
      prompt,
      jsonInventoryRefreshSchema,
      "inventory_audit",
      getOpenAiLabel(provider)
    )
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

  const result = isOpenAiCompatible(provider)
    ? await callOpenAiJson(
      apiKey,
      baseUrl,
      model,
      system,
      prompt,
      jsonInventoryRecoverySchema,
      "inventory_recovery",
      getOpenAiLabel(provider)
    )
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

  const result = isOpenAiCompatible(provider)
    ? await callOpenAiJson(
      apiKey,
      baseUrl,
      model,
      system,
      prompt,
      jsonMemorySchema,
      "memory",
      getOpenAiLabel(provider)
    )
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
    const appearance = npc.appearance?.trim() || npc.lore?.trim();
    const appearanceLine = appearance ? `Appearance: ${appearance}.` : '';
    const prompt = `Fallout companion portrait. Name: ${npc.name}. Faction: ${npc.faction}. Gender: ${npc.gender}. Age: ${npc.age}. ${appearanceLine} Style: Pip-Boy dossier headshot, gritty, realistic, neutral background.`;
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

  const appearance = npc.appearance?.trim() || npc.lore?.trim();
  const appearanceLine = appearance ? `Appearance: ${appearance}.` : '';
  const prompt = `Fallout companion portrait. Name: ${npc.name}. Faction: ${npc.faction}. Gender: ${npc.gender}. Age: ${npc.age}. ${appearanceLine} Style: Pip-Boy dossier headshot, gritty, realistic, neutral background.`;
  try {
    const base64 = isOpenAiCompatible(provider)
      ? await generateOpenAiImage(apiKey, baseUrl, model, prompt, provider)
      : await generateDoubaoImage(apiKey, baseUrl, model, prompt);
    if (!base64) {
      return { error: "No image data returned from the model." };
    }
    if (provider === "grok" && /^https?:/i.test(base64)) {
      return { url: base64 };
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
    imageUserSystemPrompt?: string;
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
  const guidanceLine = buildUserGuidanceLine(options?.imageUserSystemPrompt);
  const guidanceBlock = guidanceLine ? `\n${guidanceLine}` : "";

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
          contents: `Research a Fallout portrait for: ${description}.${guidanceBlock}
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
    } else if (researchProvider === "grok" && researchApiKey) {
      try {
        const researchBaseUrl = resolveBaseUrl(researchProvider, useProxy ? proxyBaseUrl : undefined);
        const researchResponse = await callGrokWebSearch(
          researchApiKey,
          researchBaseUrl,
          textModel,
          `Research a Fallout portrait for: ${description}.${guidanceBlock}
1. Identify key visual traits, attire, and faction motifs.
2. Use Fallout Wiki terms when possible.
3. Output a concise portrait description for a concept artist.
4. Return plain text only, no citations or URLs. Keep it under 500 characters.`
        , 500
        );
        if (researchResponse.text) {
          finalPrompt = `Fallout dossier portrait. ${researchResponse.text}`;
        }
      } catch {
        finalPrompt = basePrompt;
      }
    } else if (researchProvider === "openai" && researchApiKey) {
      try {
        const researchBaseUrl = resolveBaseUrl(researchProvider, useProxy ? proxyBaseUrl : undefined);
        const researchResponse = await callOpenAiWebSearch(
          researchApiKey,
          researchBaseUrl,
          textModel,
          `Research a Fallout portrait for: ${description}.${guidanceBlock}
1. Identify key visual traits, attire, and faction motifs.
2. Use Fallout Wiki terms when possible.
3. Output a concise portrait description for a concept artist.
4. Return plain text only, no citations or URLs. Keep it under 500 characters.`
        , 500
        );
        if (researchResponse.text) {
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

    const base64 = isOpenAiCompatible(imageProvider)
      ? await generateOpenAiImage(
        imageApiKey,
        resolveBaseUrl(imageProvider, proxyBaseUrl),
        imageModel,
        finalPrompt,
        imageProvider
      )
      : await generateDoubaoImage(imageApiKey, resolveBaseUrl(imageProvider, proxyBaseUrl), imageModel, finalPrompt);
    if (!base64) {
      return { error: "No image data returned from the model." };
    }
    if (imageProvider === "grok" && /^https?:/i.test(base64)) {
      return { url: base64 };
    }
    const resized = await resizeImageToSquare(`data:image/png;base64,${base64}`, 100);
    return { url: resized };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function generateSceneImage(
  prompt: string,
  options?: { highQuality?: boolean; tier?: UserTier; apiKey?: string; proxyApiKey?: string; proxyBaseUrl?: string; useProxy?: boolean; imageModel?: ImageModelId; textModel?: TextModelId; provider?: ModelProvider; textProvider?: ModelProvider; textApiKey?: string; textProxyApiKey?: string; imageUserSystemPrompt?: string }
): Promise<{ url?: string; sources?: GroundingSource[]; error?: string } | undefined> {
  const imageProvider = normalizeProvider(options?.provider);
  const researchProvider = normalizeProvider(options?.textProvider || options?.provider);
  const useProxy = !!options?.useProxy;
  const contextSuffix = buildImageContext(options?.imageUserSystemPrompt);
  const imageContextSuffix = contextSuffix;
  const guidanceLine = buildUserGuidanceLine(options?.imageUserSystemPrompt);
  const guidanceBlock = guidanceLine ? `\n${guidanceLine}` : "";
  if (imageProvider === "gemini") {
    if (options?.tier === "guest") {
      const guestPrompt = imageContextSuffix ? `${prompt}\n${imageContextSuffix}` : prompt;
      return generateGeminiScene(guestPrompt, {
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
      if (useHighQuality && textModel && researchApiKey) {
        if (researchProvider === "gemini") {
          const researchAi = new GoogleGenAI({
            apiKey: researchApiKey,
            ...(proxyBaseUrl ? { httpOptions: { baseUrl: proxyBaseUrl } } : {})
          });
          try {
            const researchResponse = await researchAi.models.generateContent({
              model: textModel,
              contents: `Research visual references for this Fallout scene: "${prompt}".${guidanceBlock}
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
        } else if (researchProvider === "grok") {
          try {
            const researchBaseUrl = resolveBaseUrl(researchProvider, useProxy ? proxyBaseUrl : undefined);
            const researchResponse = await callGrokWebSearch(
              researchApiKey,
              researchBaseUrl,
              textModel,
              `Research visual references for this Fallout scene: "${prompt}".${guidanceBlock}
1. Extract 3-5 keywords related to Fallout lore, items, or environment.
2. Search for these keywords + "Fallout" on Google to identify high-quality visual benchmarks (e.g. from Fallout 4 or New Vegas).
3. Based on your search results, describe the exact textures, lighting (e.g. dawn over the Mojave, fluorescent flickering in a vault), and key props.
4. Format your final response as a detailed scene description for a concept artist.
5. Return plain text only, no citations or URLs. Keep it under 800 characters.`
            , 800
            );
            if (researchResponse.text) {
              detailedDescription = researchResponse.text;
            }
            groundingSources = researchResponse.sources;
          } catch {
            // Skip research if not supported.
          }
        } else if (researchProvider === "openai") {
          try {
            const researchBaseUrl = resolveBaseUrl(researchProvider, useProxy ? proxyBaseUrl : undefined);
            const researchResponse = await callOpenAiWebSearch(
              researchApiKey,
              researchBaseUrl,
              textModel,
              `Research visual references for this Fallout scene: "${prompt}".${guidanceBlock}
1. Extract 3-5 keywords related to Fallout lore, items, or environment.
2. Search for these keywords + "Fallout" on Google to identify high-quality visual benchmarks (e.g. from Fallout 4 or New Vegas).
3. Based on your search results, describe the exact textures, lighting (e.g. dawn over the Mojave, fluorescent flickering in a vault), and key props.
4. Format your final response as a detailed scene description for a concept artist.
5. Return plain text only, no citations or URLs. Keep it under 800 characters.`
            , 800
            );
            if (researchResponse.text) {
              detailedDescription = researchResponse.text;
            }
          } catch {
            // Skip research if not supported.
          }
        }
      }
      const finalDescription = imageContextSuffix ? `${detailedDescription}\n${imageContextSuffix}` : detailedDescription;
      const finalPrompt = buildImagePrompt(finalDescription, useHighQuality);
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
    if (useHighQuality && options?.textModel && researchApiKey) {
      if (researchProvider === "gemini") {
        try {
          const researchAi = new GoogleGenAI({
            apiKey: researchApiKey,
            ...(useProxy && baseUrl ? { httpOptions: { baseUrl } } : {})
          });
          const researchResponse = await researchAi.models.generateContent({
            model: options.textModel,
            contents: `Research visual references for this Fallout scene: "${prompt}".${guidanceBlock}
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
      } else if (researchProvider === "grok") {
        try {
          const researchBaseUrl = resolveBaseUrl(researchProvider, useProxy ? options?.proxyBaseUrl : undefined);
          const researchResponse = await callGrokWebSearch(
            researchApiKey,
            researchBaseUrl,
            options.textModel,
            `Research visual references for this Fallout scene: "${prompt}".${guidanceBlock}
1. Extract 3-5 keywords related to Fallout lore, items, or environment.
2. Search for these keywords + "Fallout" on Google to identify high-quality visual benchmarks (e.g. from Fallout 4 or New Vegas).
3. Based on your search results, describe the exact textures, lighting (e.g. dawn over the Mojave, fluorescent flickering in a vault), and key props.
4. Format your final response as a detailed scene description for a concept artist.
5. Return plain text only, no citations or URLs. Keep it under 800 characters.`
          , 800
          );
          if (researchResponse.text) {
            detailedDescription = researchResponse.text;
          }
          groundingSources = researchResponse.sources;
        } catch {
          // Skip research if not supported.
        }
      } else if (researchProvider === "openai") {
        try {
          const researchBaseUrl = resolveBaseUrl(researchProvider, useProxy ? options?.proxyBaseUrl : undefined);
          const researchResponse = await callOpenAiWebSearch(
            researchApiKey,
            researchBaseUrl,
            options.textModel,
            `Research visual references for this Fallout scene: "${prompt}".${guidanceBlock}
1. Extract 3-5 keywords related to Fallout lore, items, or environment.
2. Search for these keywords + "Fallout" on Google to identify high-quality visual benchmarks (e.g. from Fallout 4 or New Vegas).
3. Based on your search results, describe the exact textures, lighting (e.g. dawn over the Mojave, fluorescent flickering in a vault), and key props.
4. Format your final response as a detailed scene description for a concept artist.
5. Return plain text only, no citations or URLs. Keep it under 800 characters.`
          , 800
          );
          if (researchResponse.text) {
            detailedDescription = researchResponse.text;
          }
        } catch {
          // Skip research if not supported.
        }
      }
    }
    const finalDescription = imageContextSuffix ? `${detailedDescription}\n${imageContextSuffix}` : detailedDescription;
    const finalPrompt = buildImagePrompt(finalDescription, useHighQuality);
    const base64 = isOpenAiCompatible(imageProvider)
      ? await generateOpenAiImage(apiKey, baseUrl, model, finalPrompt, imageProvider)
      : await generateDoubaoImage(apiKey, baseUrl, model, finalPrompt);
    if (!base64) {
      return { error: "No image data returned from the model." };
    }
    if (imageProvider === "grok" && /^https?:/i.test(base64)) {
      return { url: base64, sources: groundingSources };
    }
    const compressed = await compressImage(`data:image/png;base64,${base64}`);
    return { url: compressed, sources: groundingSources };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
