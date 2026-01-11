import { Language } from './types';

const LOCATION_LOCALIZATIONS: Record<string, string> = {
  "Southern California (Fallout 1)": "南加州（辐射1）",
  "Northern California (Fallout 2)": "北加州（辐射2）",
  "Capital Wasteland (Fallout 3)": "首都废土（辐射3）",
  "Mojave Wasteland (Fallout: New Vegas)": "莫哈维废土（辐射：新维加斯）",
  "The Commonwealth (Fallout 4)": "联邦（辐射4）",
  "Appalachia (Fallout 76)": "阿巴拉契亚（辐射76）"
};

export const localizeLocation = (location: string, language: Language) => {
  if (language !== 'zh') return location;
  return LOCATION_LOCALIZATIONS[location] || location;
};

export const formatYear = (year: number, language: Language) => {
  const formatter = new Intl.NumberFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
    useGrouping: false
  });
  const formatted = formatter.format(year);
  return language === 'zh' ? `${formatted}年` : formatted;
};
