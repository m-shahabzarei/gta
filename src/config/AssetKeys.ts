/**
 * Registry of texture / audio / data keys.
 *
 * In Phase 1 most textures are generated procedurally by
 * `PlaceholderTextureFactory`; the keys below are the contract those textures
 * are registered under, so Phase 2 can swap in real Aseprite/Tiled art without
 * touching any consumer code.
 */

/** Procedural + sprite texture keys. */
export enum TextureKeys {
  /** 1×1 white pixel — the universal building block for tinting/scaling. */
  Pixel = 'tex:pixel',
  /** Soft round particle used by the ParticleManager. */
  Particle = 'tex:particle',
  /** Generic 9-slice-able UI panel background. */
  UIPanel = 'tex:ui-panel',
  /** UI button background. */
  UIButton = 'tex:ui-button',

  // World tiles (placeholder swatches, TILE_SIZE²).
  TileGrass = 'tile:grass',
  TileRoad = 'tile:road',
  TileRoadLine = 'tile:road-line',
  TileSidewalk = 'tile:sidewalk',
  TileWater = 'tile:water',
  TileBuilding = 'tile:building',

  // Placeholder entities.
  Player = 'entity:player',
  Car = 'entity:car',
  Tree = 'prop:tree',
  StreetLight = 'prop:street-light',

  // ── Phase 2 gameplay art ──────────────────────────────────────────────────
  /** Combined city tileset strip (indices match the TileType enum). */
  CityTileset = 'tileset:city',

  // Character sprite sheets (top-down, facing "north"; rotated to face heading).
  CharPlayer = 'char:player',
  CharPed = 'char:ped',
  CharPolice = 'char:police',
  CharSwat = 'char:swat',

  // Ambient animal sprite sheets.
  AnimalDog = 'animal:dog',
  AnimalCat = 'animal:cat',
  AnimalBird = 'animal:bird',

  // Vehicle sprites (top-down, facing "north"; frame 0 pristine, 1 damaged).
  VehSedan = 'veh:sedan',
  VehTaxi = 'veh:taxi',
  VehPolice = 'veh:police',
  VehPoliceSuv = 'veh:police-suv',
  VehAmbulance = 'veh:ambulance',
  VehFireTruck = 'veh:fire-truck',
  VehSports = 'veh:sports',
  VehLuxury = 'veh:luxury',
  VehClassic = 'veh:classic',
  VehMuscle = 'veh:muscle',
  VehTruck = 'veh:truck',
  VehVan = 'veh:van',
  VehPickup = 'veh:pickup',
  VehSuv = 'veh:suv',
  VehBus = 'veh:bus',
  VehMotorcycle = 'veh:motorcycle',
  VehScooter = 'veh:scooter',
  VehBicycle = 'veh:bicycle',
  VehDelivery = 'veh:delivery',
  VehConstruction = 'veh:construction',
  Helicopter = 'veh:helicopter',
  HeliRotor = 'veh:heli-rotor',

  // Combat / effect textures.
  Bullet = 'fx:bullet',
  Rocket = 'fx:rocket',
  GrenadeFx = 'fx:grenade',
  MolotovFx = 'fx:molotov',
  Muzzle = 'fx:muzzle',
  Blood = 'fx:blood',
  Explosion = 'fx:explosion',
  Smoke = 'fx:smoke',
  Spark = 'fx:spark',
  Casing = 'fx:casing',
  Flame = 'fx:flame',
  /** Soft radial glow used for lamps / headlights / brake lights. */
  GlowSoft = 'fx:glow-soft',
  /** Forward light cone for night headlights. */
  HeadlightCone = 'fx:headlight-cone',
  /** Short dark streak stamped as a tire skid mark. */
  SkidMark = 'fx:skid-mark',
  /** Thin expanding ring (rain splashes, shockwaves). */
  Ring = 'fx:ring',
  Snowflake = 'fx:snowflake',

  // World props.
  TrafficLight = 'prop:traffic-light',
  MissionMarker = 'prop:mission-marker',
  Pickup = 'prop:pickup',
  PickupHealth = 'prop:pickup-health',
  PickupArmor = 'prop:pickup-armor',
  PickupMoney = 'prop:pickup-money',
  PickupAmmo = 'prop:pickup-ammo',
  PickupWeapon = 'prop:pickup-weapon',
  Package = 'prop:package',
  SpikeStrip = 'prop:spike-strip',
  RoadBarrier = 'prop:road-barrier',
  RaceFlag = 'prop:race-flag',
  Cactus = 'prop:cactus',
  Rock = 'prop:rock',
  Crate = 'prop:crate',
  Bench = 'prop:bench',
  TrashBin = 'prop:trash-bin',
  Mailbox = 'prop:mailbox',
  FireHydrant = 'prop:fire-hydrant',
  RoadSign = 'prop:road-sign',
  BikeRack = 'prop:bike-rack',
  CafeTable = 'prop:cafe-table',
  Planter = 'prop:planter',
  UtilityBox = 'prop:utility-box',
  ParkingMeter = 'prop:parking-meter',
  TrafficCone = 'prop:traffic-cone',
  ConstructionFence = 'prop:construction-fence',
  StreetAd = 'prop:street-ad',

  // Hand-authored environment modules. These are visual overlays only: the
  // collision tile beneath each module remains the source of gameplay truth.
  RoofModernA = 'env:roof-modern-a',
  RoofModernB = 'env:roof-modern-b',
  RoofResidential = 'env:roof-residential',
  RoofLuxury = 'env:roof-luxury',
  RoofCivic = 'env:roof-civic',
  RoofIndustrial = 'env:roof-industrial',
  RoofAdobeA = 'env:roof-adobe-a',
  RoofAdobeB = 'env:roof-adobe-b',
  RoofWoodA = 'env:roof-wood-a',
  RoofWoodB = 'env:roof-wood-b',
  RoofBazaar = 'env:roof-bazaar',
  RoadCrack = 'env:road-crack',
  RoadPatch = 'env:road-patch',
  OilStain = 'env:oil-stain',
  Manhole = 'env:manhole',
  StormDrain = 'env:storm-drain',
  RoadArrow = 'env:road-arrow',
  SpeedBump = 'env:speed-bump',
  PavementCrack = 'env:pavement-crack',
  Puddle = 'env:puddle',
  FallenLeaves = 'env:fallen-leaves',
  GrassTuft = 'env:grass-tuft',
  FlowerPatch = 'env:flower-patch',
  Bush = 'env:bush',
  TreePlane = 'env:tree-plane',
  TreeCypress = 'env:tree-cypress',
  TreePalm = 'env:tree-palm',
  TreeGilan = 'env:tree-gilan',
  Pallet = 'env:pallet',
  Barrel = 'env:barrel',
  AcUnit = 'env:ac-unit',
  SatelliteDish = 'env:satellite-dish',
  WaterTank = 'env:water-tank',
  MarketAwning = 'env:market-awning',
  Graffiti = 'env:graffiti',

  // Weapon HUD icons.
  IconFist = 'icon:fist',
  IconKnife = 'icon:knife',
  IconBat = 'icon:bat',
  IconPistol = 'icon:pistol',
  IconRevolver = 'icon:revolver',
  IconSmg = 'icon:smg',
  IconShotgun = 'icon:shotgun',
  IconRifle = 'icon:rifle',
  IconSniper = 'icon:sniper',
  IconRocket = 'icon:rocket',
  IconGrenade = 'icon:grenade',
  IconMolotov = 'icon:molotov',

  HitMarker = 'ui:hit-marker',

  /** Title-screen logo (procedural in Phase 1). */
  Logo = 'ui:logo',
}

/**
 * Texture key for the i-th generated civilian sprite-sheet variant.
 * Kept beside {@link TextureKeys} so producers and consumers can never drift.
 */
export function pedVariantKey(index: number): string {
  return `char:ped-${index}`;
}

/** Number of distinct civilian sprite-sheet variants generated at boot. */
export const PED_VARIANT_COUNT = 14;

/** Audio keys (registered against files declared in the asset manifest). */
export enum AudioKeys {
  MusicMenu = 'music:menu',
  MusicCity = 'music:city',
  SfxUiClick = 'sfx:ui-click',
  SfxUiConfirm = 'sfx:ui-confirm',
}

/** Bitmap/web font keys. */
export enum FontKeys {
  Pixel = 'font:pixel',
}

/** JSON data keys (asset manifest, animation definitions, …). */
export enum DataKeys {
  Manifest = 'data:manifest',
  Animations = 'data:animations',
}
