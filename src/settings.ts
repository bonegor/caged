// Player preferences, remembered in localStorage when available.

export interface Settings {
  musicVolume: number;
  sfxVolume: number;
  edgeScroll: boolean;
  healthBars: 'always' | 'damaged' | 'selected';
  difficulty: 'easy' | 'normal' | 'hard';
  playerColor: string;
  enemyColor: string;
  seenTutorial: boolean;
}

const KEY = 'caged.settings.v1';

const DEFAULTS: Settings = {
  musicVolume: 0.5,
  sfxVolume: 0.7,
  edgeScroll: true,
  healthBars: 'damaged',
  difficulty: 'normal',
  playerColor: 'blue',
  enemyColor: 'red',
  seenTutorial: false,
};

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    // Storage unavailable (private mode, sandbox): fall back to defaults.
  }
  return { ...DEFAULTS };
}

export const settings: Settings = load();

export function saveSettings(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Ignore: settings just won't persist.
  }
}
