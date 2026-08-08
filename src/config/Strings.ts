/**
 * Minimal localisation table.
 *
 * Keeps the game's chrome (menus, settings, pause) translatable. The active
 * language lives in {@link GameSettings}; UI reads strings through {@link t}.
 * Adding a language is a matter of adding a column here.
 */
import { Language } from './Settings';

/** Every translatable UI string key. */
export type StringKey =
  | 'title'
  | 'subtitle'
  | 'newGame'
  | 'continueGame'
  | 'quit'
  | 'paused'
  | 'resume'
  | 'settings'
  | 'inventory'
  | 'map'
  | 'save'
  | 'quitToMenu'
  | 'graphics'
  | 'audio'
  | 'controls'
  | 'display'
  | 'language'
  | 'quality'
  | 'weather'
  | 'screenShake'
  | 'fullscreen'
  | 'vsync'
  | 'master'
  | 'music'
  | 'sfx'
  | 'back'
  | 'money'
  | 'weapons'
  | 'noSave';

type Table = Record<StringKey, string>;

/** The full translation table, keyed by language then string key. */
export const STRINGS: Readonly<Record<Language, Table>> = {
  [Language.English]: {
    title: 'PIXEL CITY',
    subtitle: 'OPEN WORLD',
    newGame: 'New Game',
    continueGame: 'Continue',
    quit: 'Quit',
    paused: 'PAUSED',
    resume: 'Resume',
    settings: 'Settings',
    inventory: 'Inventory',
    map: 'Map',
    save: 'Save Game',
    quitToMenu: 'Quit to Menu',
    graphics: 'Graphics',
    audio: 'Audio',
    controls: 'Controls',
    display: 'Display',
    language: 'Language',
    quality: 'Quality',
    weather: 'Weather',
    screenShake: 'Screen Shake',
    fullscreen: 'Fullscreen',
    vsync: 'VSync',
    master: 'Master',
    music: 'Music',
    sfx: 'Effects',
    back: 'Back',
    money: 'Money',
    weapons: 'Weapons',
    noSave: 'No save found',
  },
  [Language.Spanish]: {
    title: 'CIUDAD PIXEL',
    subtitle: 'MUNDO ABIERTO',
    newGame: 'Nueva Partida',
    continueGame: 'Continuar',
    quit: 'Salir',
    paused: 'PAUSA',
    resume: 'Reanudar',
    settings: 'Ajustes',
    inventory: 'Inventario',
    map: 'Mapa',
    save: 'Guardar',
    quitToMenu: 'Menú Principal',
    graphics: 'Gráficos',
    audio: 'Audio',
    controls: 'Controles',
    display: 'Pantalla',
    language: 'Idioma',
    quality: 'Calidad',
    weather: 'Clima',
    screenShake: 'Vibración',
    fullscreen: 'Completa',
    vsync: 'VSync',
    master: 'General',
    music: 'Música',
    sfx: 'Efectos',
    back: 'Volver',
    money: 'Dinero',
    weapons: 'Armas',
    noSave: 'Sin partida guardada',
  },
  [Language.French]: {
    title: 'PIXEL CITY',
    subtitle: 'MONDE OUVERT',
    newGame: 'Nouvelle Partie',
    continueGame: 'Continuer',
    quit: 'Quitter',
    paused: 'PAUSE',
    resume: 'Reprendre',
    settings: 'Options',
    inventory: 'Inventaire',
    map: 'Carte',
    save: 'Sauvegarder',
    quitToMenu: 'Menu Principal',
    graphics: 'Graphismes',
    audio: 'Audio',
    controls: 'Commandes',
    display: 'Affichage',
    language: 'Langue',
    quality: 'Qualité',
    weather: 'Météo',
    screenShake: 'Secousse',
    fullscreen: 'Plein Écran',
    vsync: 'VSync',
    master: 'Général',
    music: 'Musique',
    sfx: 'Effets',
    back: 'Retour',
    money: 'Argent',
    weapons: 'Armes',
    noSave: 'Aucune sauvegarde',
  },
};

/** The currently active language (updated by the SettingsManager). */
let activeLanguage: Language = Language.English;

/** Set the active UI language. */
export function setLanguage(language: Language): void {
  activeLanguage = language;
}

/** Translate a key in the active language. */
export function t(key: StringKey): string {
  return STRINGS[activeLanguage][key];
}
