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
  | 'noSave'
  | 'phoneReady'
  | 'phoneClose'
  | 'phoneBack'
  | 'phoneStore'
  | 'phoneStoreEmpty'
  | 'phoneStoreEmptyCompact'
  | 'phoneStoreCatalogHint'
  | 'phoneStoreCatalogHintCompact'
  | 'phoneInstall'
  | 'phoneStoreInstallHint'
  | 'phoneSnapp'
  | 'phoneSnappHome'
  | 'phoneSnappChooseDestination'
  | 'phoneSnappCurrentLocation'
  | 'phoneSnappDestination'
  | 'phoneSnappQuote'
  | 'phoneSnappDistance'
  | 'phoneSnappDuration'
  | 'phoneSnappFare'
  | 'phoneSnappWallet'
  | 'phoneSnappConfirmPay'
  | 'phoneSnappInsufficientFunds'
  | 'phoneSnappPaymentProcessing'
  | 'phoneSnappDriverEnRoute'
  | 'phoneSnappDriverArrived'
  | 'phoneSnappBoard'
  | 'phoneSnappRiding'
  | 'phoneSnappCompleted'
  | 'phoneSnappCancel'
  | 'phoneSnappNoDestinations'
  | 'phoneSnappNoRoute'
  | 'phoneSnappUnavailable'
  | 'phoneSnappPickupHint'
  | 'phoneSnappCloseHint'
  | 'phoneNoApps'
  | 'phoneNoAppsCompact'
  | 'phoneRegistryReady'
  | 'phoneRegistryReadyCompact'
  | 'phoneTitleCompact';

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
    phoneReady: 'PHONE READY',
    phoneClose: 'CLOSE',
    phoneBack: 'BACK',
    phoneStore: 'Store',
    phoneStoreEmpty: 'No apps are available yet.',
    phoneStoreEmptyCompact: 'EMPTY',
    phoneStoreCatalogHint: 'The catalog is empty for now.',
    phoneStoreCatalogHintCompact: 'CATALOG EMPTY',
    phoneInstall: 'INSTALL',
    phoneStoreInstallHint: 'Add to your Phone',
    phoneSnapp: 'Snapp',
    phoneSnappHome: 'RIDE REQUESTS',
    phoneSnappChooseDestination: 'CHOOSE DESTINATION',
    phoneSnappCurrentLocation: 'CURRENT LOCATION',
    phoneSnappDestination: 'DESTINATION',
    phoneSnappQuote: 'FARE QUOTE',
    phoneSnappDistance: 'Route distance',
    phoneSnappDuration: 'Estimated time',
    phoneSnappFare: 'Fare',
    phoneSnappWallet: 'Wallet',
    phoneSnappConfirmPay: 'CONFIRM & PAY',
    phoneSnappInsufficientFunds: 'Not enough money for this ride.',
    phoneSnappPaymentProcessing: 'Payment processing…',
    phoneSnappDriverEnRoute: 'Driver is on the way',
    phoneSnappDriverArrived: 'Your driver has arrived',
    phoneSnappBoard: 'BOARD VEHICLE',
    phoneSnappRiding: 'Ride in progress',
    phoneSnappCompleted: 'Ride completed',
    phoneSnappCancel: 'CANCEL RIDE',
    phoneSnappNoDestinations: 'No reachable destinations nearby.',
    phoneSnappNoRoute: 'This destination is not reachable by road.',
    phoneSnappUnavailable: 'No Snapp vehicle is available right now.',
    phoneSnappPickupHint: 'Pickup is locked to your current position.',
    phoneSnappCloseHint: 'You may close the Phone while your driver continues.',
    phoneNoApps: 'NO APPS AVAILABLE',
    phoneNoAppsCompact: 'NO APPS',
    phoneRegistryReady: 'APP REGISTRY READY',
    phoneRegistryReadyCompact: 'READY',
    phoneTitleCompact: 'PIXEL',
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
    phoneReady: 'TELÉFONO LISTO',
    phoneClose: 'CERRAR',
    phoneBack: 'VOLVER',
    phoneStore: 'Tienda',
    phoneStoreEmpty: 'Aún no hay aplicaciones disponibles.',
    phoneStoreEmptyCompact: 'VACÍO',
    phoneStoreCatalogHint: 'El catálogo está vacío por ahora.',
    phoneStoreCatalogHintCompact: 'CATÁLOGO VACÍO',
    phoneInstall: 'INSTALAR',
    phoneStoreInstallHint: 'Añadir al teléfono',
    phoneSnapp: 'Snapp',
    phoneSnappHome: 'SOLICITUDES',
    phoneSnappChooseDestination: 'ELEGIR DESTINO',
    phoneSnappCurrentLocation: 'UBICACIÓN ACTUAL',
    phoneSnappDestination: 'DESTINO',
    phoneSnappQuote: 'TARIFA',
    phoneSnappDistance: 'Distancia de ruta',
    phoneSnappDuration: 'Tiempo estimado',
    phoneSnappFare: 'Tarifa',
    phoneSnappWallet: 'Dinero',
    phoneSnappConfirmPay: 'CONFIRMAR Y PAGAR',
    phoneSnappInsufficientFunds: 'No tienes suficiente dinero.',
    phoneSnappPaymentProcessing: 'Procesando pago…',
    phoneSnappDriverEnRoute: 'El conductor está en camino',
    phoneSnappDriverArrived: 'Tu conductor ha llegado',
    phoneSnappBoard: 'SUBIR AL VEHÍCULO',
    phoneSnappRiding: 'Viaje en curso',
    phoneSnappCompleted: 'Viaje completado',
    phoneSnappCancel: 'CANCELAR VIAJE',
    phoneSnappNoDestinations: 'No hay destinos accesibles cerca.',
    phoneSnappNoRoute: 'No se puede llegar por carretera.',
    phoneSnappUnavailable: 'No hay vehículo Snapp disponible.',
    phoneSnappPickupHint: 'La recogida usa tu posición actual.',
    phoneSnappCloseHint: 'Puedes cerrar el teléfono mientras llega el conductor.',
    phoneNoApps: 'NO HAY APPS DISPONIBLES',
    phoneNoAppsCompact: 'SIN APPS',
    phoneRegistryReady: 'REGISTRO DE APPS LISTO',
    phoneRegistryReadyCompact: 'LISTO',
    phoneTitleCompact: 'PIXEL',
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
    phoneReady: 'TÉLÉPHONE PRÊT',
    phoneClose: 'FERMER',
    phoneBack: 'RETOUR',
    phoneStore: 'Boutique',
    phoneStoreEmpty: 'Aucune application n’est disponible pour le moment.',
    phoneStoreEmptyCompact: 'VIDE',
    phoneStoreCatalogHint: 'Le catalogue est vide pour le moment.',
    phoneStoreCatalogHintCompact: 'CATALOGUE VIDE',
    phoneInstall: 'INSTALLER',
    phoneStoreInstallHint: 'Ajouter au téléphone',
    phoneSnapp: 'Snapp',
    phoneSnappHome: 'DEMANDES',
    phoneSnappChooseDestination: 'CHOISIR LA DESTINATION',
    phoneSnappCurrentLocation: 'POSITION ACTUELLE',
    phoneSnappDestination: 'DESTINATION',
    phoneSnappQuote: 'TARIF',
    phoneSnappDistance: 'Distance du trajet',
    phoneSnappDuration: 'Durée estimée',
    phoneSnappFare: 'Tarif',
    phoneSnappWallet: 'Portefeuille',
    phoneSnappConfirmPay: 'CONFIRMER ET PAYER',
    phoneSnappInsufficientFunds: 'Fonds insuffisants pour ce trajet.',
    phoneSnappPaymentProcessing: 'Paiement en cours…',
    phoneSnappDriverEnRoute: 'Le conducteur arrive',
    phoneSnappDriverArrived: 'Votre conducteur est arrivé',
    phoneSnappBoard: 'MONTER',
    phoneSnappRiding: 'Trajet en cours',
    phoneSnappCompleted: 'Trajet terminé',
    phoneSnappCancel: 'ANNULER LE TRAJET',
    phoneSnappNoDestinations: 'Aucune destination accessible à proximité.',
    phoneSnappNoRoute: 'Destination inaccessible par la route.',
    phoneSnappUnavailable: 'Aucun véhicule Snapp disponible.',
    phoneSnappPickupHint: 'La prise en charge utilise votre position.',
    phoneSnappCloseHint: 'Vous pouvez fermer le téléphone pendant l’arrivée.',
    phoneNoApps: 'AUCUNE APP DISPONIBLE',
    phoneNoAppsCompact: 'AUCUNE APP',
    phoneRegistryReady: 'REGISTRE DES APPS PRÊT',
    phoneRegistryReadyCompact: 'PRÊT',
    phoneTitleCompact: 'PIXEL',
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
