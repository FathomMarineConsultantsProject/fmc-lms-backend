// src/utils/rankSort.js

const normalizeRank = (r) =>
  String(r || "")
    .trim()
    .toLowerCase()
    .replace(/[\.\-_,]/g, " ")
    .replace(/[\/\\]/g, " ")
    .replace(/\s+/g, " ");

export const RANK_WEIGHT = {
  MASTER: 1,
  CHIEF_OFFICER: 2,
  SECOND_OFFICER: 3,
  THIRD_OFFICER: 4,
  DECK_CADET: 5,
  CHIEF_ENGINEER: 6,
  SECOND_ENGINEER: 7,
  THIRD_ENGINEER: 8,
  ELECTRICIAN: 9,
  BOSUN: 10,
  AB: 11,
  OS: 12,
  OILER: 13,
  WIPER: 14,
  COOK: 15,
  OTHER: 999,
};

export const RANK_ALIASES = {
  MASTER: ["master", "mstr", "mster", "mst", "mtr", "captain", "cap", "capt"],

  CHIEF_OFFICER: [
    "chief officer", "chief mate", "c/o", "coff", "c off",
    "1st officer", "first officer", "1/off", "1off", "1o", "chef off" ,"chefoff",
  ],

  SECOND_OFFICER: ["second officer", "2nd officer", "2/off", "2off", "2o", "2officer", "ADD 2OFF", "ADD 2/O" , "2/O"],

  THIRD_OFFICER: ["third officer", "3rd officer", "3/off", "3off", "3o", "3officer", "ADD 3OFF", "ADD 3/O", "2/O"],

  DECK_CADET: ["DECK CADET", "DC", "deck c", "deck cadet", "deck", "dcadet", "d cadet"],

  CHIEF_ENGINEER: ["chief engineer", "c/e", "ce", "c eng", "cheng", "ch eng"],

  SECOND_ENGINEER: ["second engineer", "2nd engineer", "2/e", "2e", "2 eng", "2eng", "ADD 2/E"],

  THIRD_ENGINEER: ["third engineer", "3rd engineer", "3/e", "3e", "3 eng", "3eng", "ADD 3/E"],

  FOURTH_ENGINEER: ["fourth engineer", "4th engineer", "4/e", "4e", "4 eng", "4eng", "ADD 4/E", "4/E",],

  ELECTRICIAN: ["electrician", "elec", "ee", "j/ee", "jele", "elect"],

  BOSUN: ["bosun", "bosn", "boatswain"],

  AB: ["ab", "able", "able seaman", "able seafarer", "a/b"],

  OS: ["os", "ordinary seaman", "orse", "FTR", ],

  OILER: ["oiler", "GRES"],

  WIPER: ["wiper"],

  COOK: ["cook", "ccok", "cok", "2cok", "2/cok", "2 cook"],
};

export const canonicalRankKey = (rankRaw) => {
  const r = normalizeRank(rankRaw);
  if (!r) return "OTHER";

  for (const [key, list] of Object.entries(RANK_ALIASES)) {
    for (const a of list) {
      const aa = normalizeRank(a);
      if (r === aa) return key;
      if (r.includes(aa)) return key;
    }
  }

  // fallback patterns
  if (/\b2\s*off\b|\b2off\b/.test(r)) return "SECOND_OFFICER";
  if (/\b3\s*off\b|\b3off\b/.test(r)) return "THIRD_OFFICER";
  if (/\b2\s*eng\b|\b2eng\b/.test(r)) return "SECOND_ENGINEER";
  if (/\b3\s*eng\b|\b3eng\b/.test(r)) return "THIRD_ENGINEER";

  return "OTHER";
};

export const rankSortValue = (rankRaw) => {
  const key = canonicalRankKey(rankRaw);
  return RANK_WEIGHT[key] ?? RANK_WEIGHT.OTHER;
};
