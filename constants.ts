
import { SpecialAttr, SpecialSet } from './types';

export const FALLOUT_ERA_STARTS = [
  { year: 2161, region: "Southern California (Fallout 1)", description: "The era of the Master's rise." },
  { year: 2241, region: "Northern California (Fallout 2)", description: "The era of the Enclave and the Chosen One." },
  { year: 2277, region: "Capital Wasteland (Fallout 3)", description: "The era of the Lone Wanderer." },
  { year: 2281, region: "Mojave Wasteland (Fallout: New Vegas)", description: "The era of the Courier and the battle for Hoover Dam." },
  { year: 2287, region: "The Commonwealth (Fallout 4)", description: "The era of the Sole Survivor and the Institute." },
  { year: 2102, region: "Appalachia (Fallout 76)", description: "The early years of reclamation." }
];

export const DEFAULT_SPECIAL: SpecialSet = {
  [SpecialAttr.Strength]: 5,
  [SpecialAttr.Perception]: 5,
  [SpecialAttr.Endurance]: 5,
  [SpecialAttr.Charisma]: 5,
  [SpecialAttr.Intelligence]: 5,
  [SpecialAttr.Agility]: 5,
  [SpecialAttr.Luck]: 5
};

export const PIP_BOY_GREEN = '#1aff1a';
export const PIP_BOY_DARK = '#0c0c0c';
