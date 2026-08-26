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
  | 'phoneSnappMapHint'
  | 'phoneSnappPickupAnchor'
  | 'phoneSnappDropoffSnap'
  | 'phoneSnappRemaining'
  | 'phoneSnappRecenter'
  | 'phoneSnappFitRoute'
  | 'phoneSnappMeetAt'
  | 'phoneSnappMapPin'
  | 'phoneSnappOpen'
  | 'phoneSnappDismiss'
  | 'phoneSnappLegendPlayer'
  | 'phoneSnappLegendDriver'
  | 'phoneSnappLegendPickup'
  | 'phoneSnappLegendDestination'
  | 'phoneSnappPickupWait'
  | 'phoneSnappNoShow'
  | 'phoneSnappEnterSnapp'
  | 'phoneSnappMoveCloser'
  | 'phoneSnappExitVehicleFirst'
  | 'phoneSnappDriverNotReady'
  | 'phoneSnappBoardingBlocked'
  | 'phoneSnappPlayerUnavailable'
  | 'phoneSnappTransitionInProgress'
  | 'phoneSnappVehicleUnavailable'
  | 'phoneSnappVehicleMoving'
  | 'phoneSnappWrongRide'
  | 'phoneSnappMoveCloserDoor'
  | 'phoneSnappSeatUnavailable'
  | 'phoneSnappPathToDoorBlocked'
  | 'phoneSnappApproachUnavailable'
  | 'phoneSnappExpandMap'
  | 'phoneSnappPortraitMap'
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
    phoneSnappDriverArrived: 'Your Snapp driver has arrived',
    phoneSnappBoard: 'BOARD VEHICLE',
    phoneSnappRiding: 'Ride in progress',
    phoneSnappCompleted: 'Ride completed',
    phoneSnappCancel: 'CANCEL RIDE',
    phoneSnappNoDestinations: 'No reachable destinations nearby.',
    phoneSnappNoRoute: 'This destination is not reachable by road.',
    phoneSnappUnavailable: 'No Snapp vehicle is available right now.',
    phoneSnappPickupHint: 'Pickup is locked to your current position.',
    phoneSnappCloseHint: 'You may close the Phone while your driver continues.',
    phoneSnappMapHint: 'Tap a road or landmark. Drag to pan; wheel or +/- to zoom.',
    phoneSnappPickupAnchor: 'Pickup walk',
    phoneSnappDropoffSnap: 'Drop-off adjusted',
    phoneSnappRemaining: 'Remaining',
    phoneSnappRecenter: 'Center map on player',
    phoneSnappFitRoute: 'Fit active route',
    phoneSnappMeetAt: 'Meet at',
    phoneSnappMapPin: 'Map pin',
    phoneSnappOpen: 'OPEN SNAPP',
    phoneSnappDismiss: 'DISMISS',
    phoneSnappLegendPlayer: 'PLAYER',
    phoneSnappLegendDriver: 'DRIVER',
    phoneSnappLegendPickup: 'PICKUP',
    phoneSnappLegendDestination: 'DESTINATION',
    phoneSnappPickupWait: 'Driver waiting',
    phoneSnappNoShow: 'Your driver left because the 2-minute pickup window expired.',
    phoneSnappEnterSnapp: 'ENTER SNAPP  E / F',
    phoneSnappMoveCloser: 'Move closer to your assigned Snapp vehicle.',
    phoneSnappExitVehicleFirst: 'Exit your current vehicle before boarding Snapp.',
    phoneSnappDriverNotReady: 'Your assigned Snapp vehicle is not ready for boarding yet.',
    phoneSnappBoardingBlocked: 'The passenger door is blocked. Move beside the rear door and try again.',
    phoneSnappPlayerUnavailable: 'You cannot board Snapp right now.',
    phoneSnappTransitionInProgress: 'A vehicle entry or exit is already in progress.',
    phoneSnappVehicleUnavailable: 'Your assigned Snapp vehicle is no longer available.',
    phoneSnappVehicleMoving: 'Wait until your Snapp vehicle has fully stopped.',
    phoneSnappWrongRide: 'This is not the vehicle assigned to your Snapp booking.',
    phoneSnappMoveCloserDoor: 'Move {distance} m closer to the rear passenger door.',
    phoneSnappSeatUnavailable: 'The rear-right passenger seat is unavailable.',
    phoneSnappPathToDoorBlocked: 'The path to the rear passenger door is blocked.',
    phoneSnappApproachUnavailable: 'No safe approach to the rear passenger door is available.',
    phoneSnappExpandMap: 'Open landscape map',
    phoneSnappPortraitMap: 'Return to portrait Phone',
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
    phoneSnappDriverArrived: 'Tu conductor de Snapp ha llegado',
    phoneSnappBoard: 'SUBIR AL VEHÍCULO',
    phoneSnappRiding: 'Viaje en curso',
    phoneSnappCompleted: 'Viaje completado',
    phoneSnappCancel: 'CANCELAR VIAJE',
    phoneSnappNoDestinations: 'No hay destinos accesibles cerca.',
    phoneSnappNoRoute: 'No se puede llegar por carretera.',
    phoneSnappUnavailable: 'No hay vehículo Snapp disponible.',
    phoneSnappPickupHint: 'La recogida usa tu posición actual.',
    phoneSnappCloseHint: 'Puedes cerrar el teléfono mientras llega el conductor.',
    phoneSnappMapHint: 'Toca una carretera o lugar. Arrastra para mover; rueda o +/- para zoom.',
    phoneSnappPickupAnchor: 'Caminata a recogida',
    phoneSnappDropoffSnap: 'Destino ajustado',
    phoneSnappRemaining: 'Restante',
    phoneSnappRecenter: 'Centrar mapa en jugador',
    phoneSnappFitRoute: 'Ajustar ruta',
    phoneSnappMeetAt: 'Encuentro en',
    phoneSnappMapPin: 'Punto del mapa',
    phoneSnappOpen: 'ABRIR SNAPP',
    phoneSnappDismiss: 'DESCARTAR',
    phoneSnappLegendPlayer: 'JUGADOR',
    phoneSnappLegendDriver: 'CONDUCTOR',
    phoneSnappLegendPickup: 'RECOGIDA',
    phoneSnappLegendDestination: 'DESTINO',
    phoneSnappPickupWait: 'Conductor esperando',
    phoneSnappNoShow: 'Tu conductor se fue porque venció la ventana de recogida de 2 minutos.',
    phoneSnappEnterSnapp: 'SUBIR A SNAPP  E / F',
    phoneSnappMoveCloser: 'Acércate a tu vehículo Snapp asignado.',
    phoneSnappExitVehicleFirst: 'Sal de tu vehículo actual antes de subir a Snapp.',
    phoneSnappDriverNotReady: 'Tu vehículo Snapp aún no está listo para subir.',
    phoneSnappBoardingBlocked: 'La puerta trasera está bloqueada. Ponte junto a ella e inténtalo de nuevo.',
    phoneSnappPlayerUnavailable: 'No puedes subir a Snapp ahora mismo.',
    phoneSnappTransitionInProgress: 'Ya hay una entrada o salida de vehículo en curso.',
    phoneSnappVehicleUnavailable: 'Tu vehículo Snapp asignado ya no está disponible.',
    phoneSnappVehicleMoving: 'Espera a que tu vehículo Snapp se detenga por completo.',
    phoneSnappWrongRide: 'Este no es el vehículo asignado a tu reserva Snapp.',
    phoneSnappMoveCloserDoor: 'Acércate {distance} m más a la puerta trasera del pasajero.',
    phoneSnappSeatUnavailable: 'El asiento trasero derecho no está disponible.',
    phoneSnappPathToDoorBlocked: 'El camino a la puerta trasera está bloqueado.',
    phoneSnappApproachUnavailable: 'No hay un acceso seguro a la puerta trasera.',
    phoneSnappExpandMap: 'Abrir mapa apaisado',
    phoneSnappPortraitMap: 'Volver al teléfono vertical',
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
    phoneSnappDriverArrived: 'Votre conducteur Snapp est arrivé',
    phoneSnappBoard: 'MONTER',
    phoneSnappRiding: 'Trajet en cours',
    phoneSnappCompleted: 'Trajet terminé',
    phoneSnappCancel: 'ANNULER LE TRAJET',
    phoneSnappNoDestinations: 'Aucune destination accessible à proximité.',
    phoneSnappNoRoute: 'Destination inaccessible par la route.',
    phoneSnappUnavailable: 'Aucun véhicule Snapp disponible.',
    phoneSnappPickupHint: 'La prise en charge utilise votre position.',
    phoneSnappCloseHint: 'Vous pouvez fermer le téléphone pendant l’arrivée.',
    phoneSnappMapHint: 'Touchez une route ou un lieu. Glissez pour déplacer; molette ou +/- pour zoomer.',
    phoneSnappPickupAnchor: 'Marche jusqu’à la prise en charge',
    phoneSnappDropoffSnap: 'Dépose ajustée',
    phoneSnappRemaining: 'Restant',
    phoneSnappRecenter: 'Centrer la carte sur le joueur',
    phoneSnappFitRoute: 'Afficher la route',
    phoneSnappMeetAt: 'Rendez-vous à',
    phoneSnappMapPin: 'Point sur la carte',
    phoneSnappOpen: 'OUVRIR SNAPP',
    phoneSnappDismiss: 'FERMER',
    phoneSnappLegendPlayer: 'JOUEUR',
    phoneSnappLegendDriver: 'CONDUCTEUR',
    phoneSnappLegendPickup: 'PRISE EN CHARGE',
    phoneSnappLegendDestination: 'DESTINATION',
    phoneSnappPickupWait: 'Conducteur en attente',
    phoneSnappNoShow: 'Votre conducteur est parti après la fenêtre de prise en charge de 2 minutes.',
    phoneSnappEnterSnapp: 'MONTER DANS SNAPP  E / F',
    phoneSnappMoveCloser: 'Rapprochez-vous du véhicule Snapp qui vous est attribué.',
    phoneSnappExitVehicleFirst: 'Quittez votre véhicule actuel avant de monter dans Snapp.',
    phoneSnappDriverNotReady: 'Votre véhicule Snapp n’est pas encore prêt pour l’embarquement.',
    phoneSnappBoardingBlocked: 'La porte arrière est bloquée. Placez-vous près de la porte et réessayez.',
    phoneSnappPlayerUnavailable: 'Vous ne pouvez pas monter dans Snapp pour le moment.',
    phoneSnappTransitionInProgress: 'Une entrée ou sortie de véhicule est déjà en cours.',
    phoneSnappVehicleUnavailable: 'Votre véhicule Snapp assigné n’est plus disponible.',
    phoneSnappVehicleMoving: 'Attendez que votre véhicule Snapp soit complètement arrêté.',
    phoneSnappWrongRide: 'Ce véhicule n’est pas celui assigné à votre réservation Snapp.',
    phoneSnappMoveCloserDoor: 'Approchez-vous encore de {distance} m de la porte arrière.',
    phoneSnappSeatUnavailable: 'Le siège passager arrière droit n’est pas disponible.',
    phoneSnappPathToDoorBlocked: 'Le passage vers la porte arrière est bloqué.',
    phoneSnappApproachUnavailable: 'Aucun accès sûr à la porte arrière n’est disponible.',
    phoneSnappExpandMap: 'Ouvrir la carte paysage',
    phoneSnappPortraitMap: 'Revenir au téléphone portrait',
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
