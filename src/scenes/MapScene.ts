/**
 * Full-screen world map overlay.
 *
 * The scene is launched while gameplay is paused, renders the generated city at
 * a scalable tile resolution, and lets the player pan, zoom and place a custom
 * waypoint without changing the underlying world simulation.
 */
import Phaser from 'phaser';
import { SceneKeys } from '@/config/SceneKeys';
import { ServiceKeys } from '@/config/ServiceKeys';
import { COLORS, GAME_HEIGHT, GAME_WIDTH, TILE_SIZE } from '@/config/Constants';
import { ServiceLocator } from '@/core/ServiceLocator';
import {
  TileType,
  type CityId,
  type MajorBuildingDefinition,
  type MajorBuildingIcon,
  type MapData,
  type PropertyDefinition,
  type RealEstateOfficeDefinition,
  type WorldCity,
  type WorldLandmark,
} from '@/gameplay/types';
import type { Vector2 } from '@/core/types';
import { Button, Panel } from '@/ui/components';
import type { GameManager } from '@/managers/GameManager';
import type { PlayerController } from '@/systems/PlayerController';
import type { WorldManager } from '@/systems/WorldManager';
import type { MissionSystem } from '@/systems/MissionSystem';
import type { TransportationSystem } from '@/systems/TransportationSystem';
import type { TrafficSystem } from '@/systems/TrafficSystem';
import type { HousingSystem } from '@/systems/HousingSystem';
import type { TaxiDestination, TaxiFareQuote } from '@/gameplay/transit';
import { sampleSpline } from '@/gameplay/traffic/SplineMath';
import type { MobilePlatform } from '@/platform';
import { getObjectiveTarget, getWaypoint, setWaypoint } from '@/gameplay/WorldMapState';
import {
  majorBuildingIconHitRadius,
  paintMajorBuildingIcon,
} from '@/ui/hud/MajorBuildingIconPainter';
import {
  PROPERTY_MAP_COLORS,
  REAL_ESTATE_OFFICE_COLOR,
  paintRealEstateOfficeIcon,
  paintPropertyMapIcon,
  propertyMapIconHitRadius,
} from '@/ui/hud/PropertyMapIconPainter';
import {
  classifyPropertyMapStatus,
  formatPropertyMapPrice,
  propertyMapStatusLabel,
  type PropertyMapStatus,
} from '@/gameplay/HousingMapPresentation';

interface MapRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LegendItem {
  label: string;
  color?: number;
  icon?: MajorBuildingIcon;
  propertyStatus?: PropertyMapStatus;
  count?: number;
  shape?: 'circle' | 'diamond' | 'line';
  realEstateOffice?: boolean;
}

interface MajorPoiScreenTarget {
  building: MajorBuildingDefinition;
  screen: Vector2;
  hitRadius: number;
}

interface PropertyScreenTarget {
  property: PropertyDefinition;
  status: PropertyMapStatus;
  screen: Vector2;
  hitRadius: number;
}

interface RealEstateOfficeScreenTarget {
  office: RealEstateOfficeDefinition;
  screen: Vector2;
  hitRadius: number;
}

/** Cached lane-accurate polyline for a public bus line. */
interface TransitRouteLine {
  routeId: string;
  cityId: CityId;
  color: number;
  points: Vector2[];
}

const VIEW: MapRect = {
  x: 292,
  y: 72,
  width: GAME_WIDTH - 328,
  height: GAME_HEIGHT - 126,
};

const PANEL_X = 24;
const PANEL_Y = 72;
const PANEL_WIDTH = 228;
const PANEL_HEIGHT = 594;
const TOP_BAR_HEIGHT = 46;
const MIN_ZOOM = 1;
const MAX_ZOOM = 7;
const ZOOM_STEP = 1.32;
const CLICK_DRAG_THRESHOLD = 6;
const PLAYER_COLOR = 0x7dd3fc;
const WAYPOINT_COLOR = 0x22d3ee;
const OBJECTIVE_COLOR = COLORS.ACCENT;
const FULL_MAP_POI_SIZE = 13;
const PROPERTY_MARKER_SIZE = 12;
const POI_CARD_WIDTH = 300;
const POI_CARD_HEIGHT = 164;

export class MapScene extends Phaser.Scene {
  private mobile = false;
  private viewportWidth = GAME_WIDTH;
  private viewportHeight = GAME_HEIGHT;
  private viewRect: MapRect = { ...VIEW };
  private mapData: MapData | null = null;
  private content: Phaser.GameObjects.Container | null = null;
  private mapMaskSource: Phaser.GameObjects.Graphics | null = null;
  private mapContentMask: Phaser.Display.Masks.GeometryMask | null = null;
  private tileLayer: Phaser.GameObjects.Graphics | null = null;
  private cityLayer: Phaser.GameObjects.Graphics | null = null;
  private routeLayer: Phaser.GameObjects.Graphics | null = null;
  private staticMarkerLayer: Phaser.GameObjects.Graphics | null = null;
  private dynamicMarkerLayer: Phaser.GameObjects.Graphics | null = null;
  private poiLayer: Phaser.GameObjects.Graphics | null = null;
  private playerOverlayLayer: Phaser.GameObjects.Graphics | null = null;
  private poiInfoPanel: Phaser.GameObjects.Graphics | null = null;
  private poiInfoTitleText: Phaser.GameObjects.Text | null = null;
  private poiInfoBodyText: Phaser.GameObjects.Text | null = null;
  private poiHoverLabel: Phaser.GameObjects.Text | null = null;
  private statusText: Phaser.GameObjects.Text | null = null;
  private cityStatusText: Phaser.GameObjects.Text | null = null;
  private taxiQuoteText: Phaser.GameObjects.Text | null = null;
  private taxiConfirmButton: Button | null = null;
  private readonly cityLabels: Phaser.GameObjects.Text[] = [];
  private readonly poiTargets: MajorPoiScreenTarget[] = [];
  private readonly propertyTargets: PropertyScreenTarget[] = [];
  private readonly realEstateOfficeTargets: RealEstateOfficeScreenTarget[] = [];
  private uiZones: Phaser.Geom.Rectangle[] = [];
  private hoveredPoiId: string | null = null;
  private selectedPoiId: string | null = null;
  private hoveredPropertyId: string | null = null;
  private selectedPropertyId: string | null = null;
  private hoveredRealEstateOfficeId: string | null = null;
  private selectedRealEstateOfficeId: string | null = null;
  private taxiMode = false;
  private taxiDestination: TaxiDestination | null = null;
  private taxiFare: TaxiFareQuote | null = null;
  private transitRouteLines: TransitRouteLine[] = [];

  private zoom = 1;
  private baseScale = 1;
  private offsetX = VIEW.x;
  private offsetY = VIEW.y;

  private dragging = false;
  private dragMoved = false;
  private dragPointerId = -1;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragOffsetX = 0;
  private dragOffsetY = 0;

  constructor() {
    super({ key: SceneKeys.Map });
  }

  public create(): void {
    this.hoveredPoiId = null;
    this.selectedPoiId = null;
    this.hoveredPropertyId = null;
    this.selectedPropertyId = null;
    this.hoveredRealEstateOfficeId = null;
    this.selectedRealEstateOfficeId = null;
    this.taxiDestination = null;
    this.taxiFare = null;
    this.taxiMode =
      ServiceLocator.tryResolve<TransportationSystem>(ServiceKeys.Transportation)
        ?.taxiDestinationSelectionActive ?? false;
    this.poiTargets.length = 0;
    this.propertyTargets.length = 0;
    this.realEstateOfficeTargets.length = 0;
    const platform = ServiceLocator.tryResolve<MobilePlatform>(ServiceKeys.Platform);
    this.mobile = platform?.isMobile ?? false;
    if (platform?.isMobile) {
      const layout = platform.layout(this);
      this.viewportWidth = layout.width;
      this.viewportHeight = layout.height;
      this.viewRect = {
        x: VIEW.x,
        y: 104,
        width: this.viewportWidth - 328,
        height: this.viewportHeight - 130,
      };
    }
    this.enableMenuCursor();
    this.buildChrome();

    const world = ServiceLocator.tryResolve<WorldManager>(ServiceKeys.World);
    this.mapData = world?.map ?? null;
    if (!this.mapData) {
      this.showStatus('Map unavailable');
      return;
    }

    this.buildMap(this.mapData);
    this.rebuildTransitRouteLines();
    this.fitWholeCity();
    this.drawCityAreas();
    this.bindInput();
    this.refreshMarkers();

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.onShutdown, this);
  }

  public override update(): void {
    this.refreshMarkers();
  }

  public debugMajorPoiSnapshot(): {
    poiCount: number;
    renderedPoiCount: number;
    selectedId: string | null;
    hoveredId: string | null;
    waypoint: Vector2 | null;
    viewRect: MapRect;
    renderedPois: Array<{
      id: string;
      type: MajorBuildingDefinition['type'];
      city: MajorBuildingDefinition['city'];
      mapIcon: MajorBuildingIcon;
      minimapIcon: MajorBuildingIcon;
      label: string;
      screen: Vector2;
      worldPosition: Vector2;
      entrancePosition: Vector2;
      hitRadius: number;
      insideView: boolean;
    }>;
  } {
    const map = this.mapData;
    const renderedPois = this.poiTargets.map(({ building, screen, hitRadius }) => ({
      id: building.id,
      type: building.type,
      city: building.city,
      mapIcon: building.mapIcon,
      minimapIcon: building.minimapIcon,
      label: this.poiLabel(building),
      screen: { ...screen },
      worldPosition: { ...building.worldPosition },
      entrancePosition: { ...building.entrancePosition },
      hitRadius,
      insideView: this.isInView(screen.x, screen.y),
    }));
    return {
      poiCount: map?.majorBuildings.length ?? 0,
      renderedPoiCount: renderedPois.length,
      selectedId: this.selectedPoiId,
      hoveredId: this.hoveredPoiId,
      waypoint: getWaypoint(),
      viewRect: { ...this.viewRect },
      renderedPois,
    };
  }

  /** Read-only browser validation surface for the property marker layer. */
  public debugPropertySnapshot(): {
    catalogCount: number;
    renderedPropertyCount: number;
    officeCount: number;
    renderedOfficeCount: number;
    selectedId: string | null;
    hoveredId: string | null;
    selectedOfficeId: string | null;
    hoveredOfficeId: string | null;
    statusCounts: Record<PropertyMapStatus, number>;
    renderedProperties: Array<{
      id: string;
      name: string;
      cityId: PropertyDefinition['cityId'];
      status: PropertyMapStatus;
      screen: Vector2;
      entranceWorldPosition: Vector2;
      hitRadius: number;
      insideView: boolean;
    }>;
    renderedOffices: Array<{
      id: string;
      cityId: RealEstateOfficeDefinition['cityId'];
      screen: Vector2;
      worldPosition: Vector2;
      hitRadius: number;
      insideView: boolean;
    }>;
  } {
    const properties = this.validProperties();
    const offices = this.realEstateOffices();
    const statusCounts: Record<PropertyMapStatus, number> = {
      'for-sale': 0,
      owned: 0,
      active: 0,
    };
    for (const property of properties) statusCounts[this.propertyStatus(property)] += 1;
    return {
      catalogCount: properties.length,
      renderedPropertyCount: this.propertyTargets.length,
      officeCount: offices.length,
      renderedOfficeCount: this.realEstateOfficeTargets.length,
      selectedId: this.selectedPropertyId,
      hoveredId: this.hoveredPropertyId,
      selectedOfficeId: this.selectedRealEstateOfficeId,
      hoveredOfficeId: this.hoveredRealEstateOfficeId,
      statusCounts,
      renderedProperties: this.propertyTargets.map(({ property, status, screen, hitRadius }) => ({
        id: property.id,
        name: property.displayName,
        cityId: property.cityId,
        status,
        screen: { ...screen },
        entranceWorldPosition: { ...property.entranceWorldPosition },
        hitRadius,
        insideView: this.isInView(screen.x, screen.y),
      })),
      renderedOffices: this.realEstateOfficeTargets.map(({ office, screen, hitRadius }) => ({
        id: office.id,
        cityId: office.cityId,
        screen: { ...screen },
        worldPosition: { ...office.npcSpawnPosition },
        hitRadius,
        insideView: this.isInView(screen.x, screen.y),
      })),
    };
  }

  private buildChrome(): void {
    const topBarHeight = this.mobile ? 94 : TOP_BAR_HEIGHT;
    this.add.rectangle(0, 0, this.viewportWidth, this.viewportHeight, 0x06070d, 0.98).setOrigin(0);
    this.add.rectangle(0, 0, this.viewportWidth, topBarHeight, 0x0f111a, 0.96).setOrigin(0);

    this.add.text(24, 13, this.taxiMode ? 'TAXI DESTINATION' : 'WORLD MAP', {
      fontFamily: 'Courier New',
      fontSize: '22px',
      fontStyle: 'bold',
      color: this.hex(COLORS.ACCENT),
    });
    if (!this.mobile) {
      const propertyCount = this.validProperties().length;
      const officeCount = this.realEstateOffices().length;
      this.add.text(
        this.taxiMode ? 264 : 174,
        17,
        this.taxiMode
          ? 'SELECT A MARKER OR ROAD POINT'
          : `${propertyCount} HOMES • ${officeCount} OFFICES  •  CLICK A MARKER TO SET ROUTE`,
        {
          fontFamily: 'Courier New',
          fontSize: '12px',
          color: this.hex(0x94a3b8),
        },
      );
    }

    this.add
      .rectangle(
        this.viewRect.x,
        this.viewRect.y,
        this.viewRect.width,
        this.viewRect.height,
        0x0a0d14,
        1,
      )
      .setOrigin(0)
      .setStrokeStyle(2, COLORS.UI_BORDER, 1);

    new Panel(
      this,
      PANEL_X + PANEL_WIDTH / 2,
      PANEL_Y + PANEL_HEIGHT / 2,
      PANEL_WIDTH,
      PANEL_HEIGHT,
      { fill: 0x10131c, border: COLORS.UI_BORDER, alpha: 0.96 },
    );
    this.uiZones = [
      new Phaser.Geom.Rectangle(PANEL_X, PANEL_Y, PANEL_WIDTH, PANEL_HEIGHT),
      new Phaser.Geom.Rectangle(0, 0, this.viewportWidth, topBarHeight + 8),
    ];

    this.buildLegend();
    this.buildButtons();

    this.statusText = this.add.text(PANEL_X + 16, PANEL_Y + PANEL_HEIGHT - 28, '', {
      fontFamily: 'Courier New',
      fontSize: '12px',
      fontStyle: 'bold',
      color: this.hex(0xcbd5e1),
      wordWrap: { width: PANEL_WIDTH - 32 },
    });
    this.cityStatusText = this.add.text(
      PANEL_X + 16,
      PANEL_Y + (this.taxiMode ? 400 : 438),
      'CURRENT: TEHRAN',
      {
        fontFamily: 'Courier New',
        fontSize: '12px',
        fontStyle: 'bold',
        color: this.hex(COLORS.ACCENT),
        wordWrap: { width: PANEL_WIDTH - 32 },
      },
    );
    if (this.taxiMode) {
      this.taxiQuoteText = this.add.text(PANEL_X + 16, PANEL_Y + 426, 'Select a destination', {
        fontFamily: 'Courier New',
        fontSize: '12px',
        color: this.hex(0xf6c453),
        lineSpacing: 3,
        wordWrap: { width: PANEL_WIDTH - 32 },
      });
    }

    const poiPanel = this.poiPanelRect();
    this.poiInfoPanel = this.add.graphics().setDepth(12).setVisible(false);
    this.poiInfoTitleText = this.add
      .text(poiPanel.x + 14, poiPanel.y + 12, '', {
        fontFamily: 'Courier New',
        fontSize: '14px',
        fontStyle: 'bold',
        color: this.hex(COLORS.TEXT),
      })
      .setDepth(13)
      .setVisible(false);
    this.poiInfoBodyText = this.add
      .text(poiPanel.x + 14, poiPanel.y + 36, '', {
        fontFamily: 'Courier New',
        fontSize: '12px',
        color: this.hex(0xcbd5e1),
        lineSpacing: 4,
        wordWrap: { width: POI_CARD_WIDTH - 28 },
      })
      .setDepth(13)
      .setVisible(false);
    this.poiHoverLabel = this.add
      .text(0, 0, '', {
        fontFamily: 'Courier New',
        fontSize: '12px',
        fontStyle: 'bold',
        color: this.hex(COLORS.TEXT),
        backgroundColor: 'rgba(7, 10, 18, 0.92)',
        padding: { x: 6, y: 4 },
      })
      .setDepth(14)
      .setVisible(false);
  }

  private buildLegend(): void {
    const housing = this.housing();
    const properties = this.validProperties();
    const offices = this.realEstateOffices(housing);
    const statusCounts: Record<PropertyMapStatus, number> = {
      'for-sale': 0,
      owned: 0,
      active: 0,
    };
    for (const property of properties) statusCounts[this.propertyStatus(property, housing)] += 1;

    this.add.text(PANEL_X + 16, PANEL_Y + 16, 'MAP GUIDE', {
      fontFamily: 'Courier New',
      fontSize: '16px',
      fontStyle: 'bold',
      color: this.hex(COLORS.TEXT),
    });
    this.add.text(
      PANEL_X + 16,
      PANEL_Y + 39,
      `${properties.length} HOMES • ${offices.length} OFFICES`,
      {
        fontFamily: 'Courier New',
        fontSize: '11px',
        fontStyle: 'bold',
        color: this.hex(0x94a3b8),
      },
    );

    const legendIcons = this.add.graphics();
    legendIcons.lineStyle(1, 0xffffff, 0.08);
    legendIcons.lineBetween(PANEL_X + 16, PANEL_Y + 59, PANEL_X + PANEL_WIDTH - 16, PANEL_Y + 59);

    const addHeading = (label: string, y: number): void => {
      this.add.text(PANEL_X + 16, y, label, {
        fontFamily: 'Courier New',
        fontSize: '11px',
        fontStyle: 'bold',
        color: this.hex(COLORS.ACCENT),
      });
    };
    const addItem = (item: LegendItem, y: number): void => {
      const iconX = PANEL_X + 27;
      const iconY = y + 7;
      if (item.realEstateOffice) {
        paintRealEstateOfficeIcon(legendIcons, iconX, iconY, 8);
      } else if (item.propertyStatus) {
        paintPropertyMapIcon(legendIcons, item.propertyStatus, iconX, iconY, 8);
      } else if (item.icon) {
        paintMajorBuildingIcon(legendIcons, item.icon, iconX, iconY, 7);
      } else {
        const color = item.color ?? COLORS.TEXT;
        legendIcons.lineStyle(1.5, 0xffffff, 0.8);
        legendIcons.fillStyle(color, 1);
        if (item.shape === 'diamond') {
          legendIcons.beginPath();
          legendIcons.moveTo(iconX, iconY - 5);
          legendIcons.lineTo(iconX + 5, iconY);
          legendIcons.lineTo(iconX, iconY + 5);
          legendIcons.lineTo(iconX - 5, iconY);
          legendIcons.closePath();
          legendIcons.fillPath();
          legendIcons.strokePath();
        } else if (item.shape === 'line') {
          legendIcons.lineStyle(3, color, 1);
          legendIcons.lineBetween(iconX - 7, iconY, iconX + 7, iconY);
          legendIcons.lineStyle(1, 0xffffff, 0.55);
          legendIcons.strokeCircle(iconX, iconY, 7);
        } else {
          legendIcons.fillCircle(iconX, iconY, 5);
          legendIcons.strokeCircle(iconX, iconY, 5);
        }
      }
      this.add.text(PANEL_X + 42, y, item.label, {
        fontFamily: 'Courier New',
        fontSize: '12px',
        color: this.hex(COLORS.TEXT),
      });
      if (item.count !== undefined) {
        this.add.text(PANEL_X + PANEL_WIDTH - 48, y, String(item.count), {
          fontFamily: 'Courier New',
          fontSize: '12px',
          fontStyle: 'bold',
          color: this.hex(
            item.propertyStatus ? PROPERTY_MAP_COLORS[item.propertyStatus] : COLORS.TEXT,
          ),
          fixedWidth: 24,
          align: 'right',
        });
      }
    };

    addHeading('NAVIGATION', PANEL_Y + 69);
    addItem({ label: 'You', color: PLAYER_COLOR, shape: 'diamond' }, PANEL_Y + 88);
    addItem({ label: 'Mission', color: OBJECTIVE_COLOR, shape: 'diamond' }, PANEL_Y + 109);
    addItem({ label: 'Waypoint / route', color: WAYPOINT_COLOR, shape: 'diamond' }, PANEL_Y + 130);

    addHeading('PROPERTIES', PANEL_Y + 155);
    addItem(
      { label: 'For sale', propertyStatus: 'for-sale', count: statusCounts['for-sale'] },
      PANEL_Y + 174,
    );
    addItem(
      { label: 'Owned home', propertyStatus: 'owned', count: statusCounts.owned },
      PANEL_Y + 195,
    );
    addItem(
      { label: 'Active home', propertyStatus: 'active', count: statusCounts.active },
      PANEL_Y + 216,
    );
    addItem(
      { label: 'Real estate office', realEstateOffice: true, count: offices.length },
      PANEL_Y + 237,
    );

    addHeading('PLACES + ROUTES', PANEL_Y + 258);
    addItem({ label: 'Hospital', icon: 'medical-cross' }, PANEL_Y + 277);
    addItem({ label: 'Police station', icon: 'police-badge' }, PANEL_Y + 297);
    addItem({ label: 'Services / transit', color: 0x8b5cf6 }, PANEL_Y + 317);
    addItem({ label: 'City / highway', color: 0xf8d36e, shape: 'line' }, PANEL_Y + 337);

    const helpX = PANEL_X + 12;
    const helpY = PANEL_Y + 356;
    const helpWidth = PANEL_WIDTH - 24;
    legendIcons.fillStyle(0x070a12, 0.82);
    legendIcons.fillRoundedRect(helpX, helpY, helpWidth, 74, 7);
    legendIcons.lineStyle(1, 0xffffff, 0.12);
    legendIcons.strokeRoundedRect(helpX, helpY, helpWidth, 74, 7);
    this.add.text(helpX + 10, helpY + 8, 'CONTROLS', {
      fontFamily: 'Courier New',
      fontSize: '11px',
      fontStyle: 'bold',
      color: this.hex(COLORS.ACCENT),
    });
    this.add.text(
      helpX + 10,
      helpY + 27,
      ['DRAG  Pan     WHEEL  Zoom', 'CLICK marker   Set route', 'HOME  Fit all  •  F  Locate'].join(
        '\n',
      ),
      {
        fontFamily: 'Courier New',
        fontSize: '11px',
        color: this.hex(0xcbd5e1),
        lineSpacing: 3,
      },
    );
  }

  private buildButtons(): void {
    const right = this.viewportWidth - 24;
    const y = this.mobile ? 47 : 23;
    const height = this.mobile ? 76 : 32;
    const close = new Button(this, this.mobile ? right - 70 : this.viewportWidth - 78, y, {
      text: this.taxiMode ? 'Cancel' : 'Close',
      width: this.mobile ? 140 : 96,
      height,
      onClick: () => this.closeMap(),
    });
    const zoomIn = new Button(this, this.mobile ? right - 190 : this.viewportWidth - 196, y, {
      text: '+',
      width: this.mobile ? 76 : 42,
      height,
      onClick: () => this.zoomAt(ZOOM_STEP, this.viewCenterScreen()),
    });
    const zoomOut = new Button(this, this.mobile ? right - 278 : this.viewportWidth - 246, y, {
      text: '-',
      width: this.mobile ? 76 : 42,
      height,
      onClick: () => this.zoomAt(1 / ZOOM_STEP, this.viewCenterScreen()),
    });
    const clear = this.taxiMode
      ? new Button(this, PANEL_X + PANEL_WIDTH / 2, PANEL_Y + (this.mobile ? 424 : 493), {
          text: 'Cancel Trip',
          width: PANEL_WIDTH - 32,
          height: this.mobile ? 76 : 38,
          onClick: () => this.cancelTaxiSelection(),
        })
      : new Button(this, PANEL_X + PANEL_WIDTH / 2, PANEL_Y + (this.mobile ? 424 : 518), {
          text: 'Clear Route',
          width: PANEL_WIDTH - 32,
          height: this.mobile ? 76 : 38,
          onClick: () => this.clearWaypoint(),
        });
    const locate = new Button(this, this.mobile ? right - 390 : this.viewportWidth - 334, y, {
      text: 'Locate',
      width: this.mobile ? 120 : 78,
      height,
      onClick: () => this.centerOnPlayer(),
    });

    close.setDepth(10);
    zoomIn.setDepth(10);
    zoomOut.setDepth(10);
    clear.setDepth(10);
    locate.setDepth(10);
    if (this.taxiMode) {
      this.taxiConfirmButton = new Button(
        this,
        PANEL_X + PANEL_WIDTH / 2,
        PANEL_Y + (this.mobile ? 510 : 542),
        {
          text: 'Confirm Fare',
          width: PANEL_WIDTH - 32,
          height: this.mobile ? 76 : 38,
          onClick: () => this.confirmTaxiSelection(),
        },
      );
      this.taxiConfirmButton.setEnabled(false).setDepth(10);
    }
  }

  private buildMap(map: MapData): void {
    this.content = this.add.container(0, 0);
    this.tileLayer = this.add.graphics();
    this.cityLayer = this.add.graphics();
    this.routeLayer = this.add.graphics();
    this.staticMarkerLayer = this.add.graphics();
    this.dynamicMarkerLayer = this.add.graphics();
    this.poiLayer = this.add.graphics().setDepth(6);
    this.playerOverlayLayer = this.add.graphics().setDepth(7);
    this.mapMaskSource = this.make.graphics({ x: 0, y: 0 }, false);
    this.mapMaskSource.fillStyle(0xffffff, 1);
    this.mapMaskSource.fillRect(
      this.viewRect.x,
      this.viewRect.y,
      this.viewRect.width,
      this.viewRect.height,
    );
    this.mapContentMask = this.mapMaskSource.createGeometryMask();
    this.content.setMask(this.mapContentMask);
    this.poiLayer.setMask(this.mapContentMask);
    this.playerOverlayLayer.setMask(this.mapContentMask);
    this.content.add([
      this.tileLayer,
      this.cityLayer,
      this.routeLayer,
      this.staticMarkerLayer,
      this.dynamicMarkerLayer,
    ]);
    this.drawTiles(map);
    this.redrawStaticMarkers();
    this.drawCityAreas();
  }

  private drawTiles(map: MapData): void {
    const g = this.tileLayer;
    if (!g) return;
    g.clear();

    for (let y = 0; y < map.heightTiles; y += 1) {
      const row = map.tiles[y];
      if (!row) continue;
      let x = 0;
      while (x < map.widthTiles) {
        const color = this.colorForTile(row[x]);
        let run = 1;
        while (x + run < map.widthTiles && this.colorForTile(row[x + run]) === color) {
          run += 1;
        }
        g.fillStyle(color, 1);
        g.fillRect(x, y, run, 1);
        x += run;
      }
    }
  }

  private redrawStaticMarkers(): void {
    const map = this.mapData;
    const g = this.staticMarkerLayer;
    if (!map || !g) return;
    g.clear();

    for (const landmark of map.landmarks) {
      if (landmark.kind === 'hospital' || landmark.kind === 'police') continue;
      this.drawMarker(
        g,
        landmark.position,
        this.colorForLandmark(landmark),
        3.2 / this.zoom,
        landmark.kind === 'airport' || landmark.kind === 'bridge' ? 'diamond' : 'circle',
      );
    }
    for (const stop of map.busStops) {
      this.drawBusStopMarker(g, stop, 3.6 / this.zoom);
    }
  }

  private drawCityAreas(): void {
    const map = this.mapData;
    const g = this.cityLayer;
    const content = this.content;
    if (!map || !g || !content) return;
    g.clear();
    for (const label of this.cityLabels) label.destroy();
    this.cityLabels.length = 0;

    const player =
      ServiceLocator.tryResolve<PlayerController>(ServiceKeys.Player)?.playerPosition ?? null;
    const current = player ? this.cityForPoint(player) : null;
    for (const city of map.cities) {
      const bounds = city.bounds;
      const x = bounds.x / TILE_SIZE;
      const y = bounds.y / TILE_SIZE;
      const width = bounds.width / TILE_SIZE;
      const height = bounds.height / TILE_SIZE;
      const active = current?.id === city.id;
      g.fillStyle(city.color, active ? 0.2 : 0.08);
      g.fillRect(x, y, width, height);
      g.lineStyle((active ? 2 : 1) / this.zoom, city.color, active ? 1 : 0.72);
      g.strokeRect(x, y, width, height);

      const label = this.add.text(city.center.x / TILE_SIZE, city.center.y / TILE_SIZE, city.name, {
        fontFamily: 'Courier New',
        fontSize: '13px',
        fontStyle: 'bold',
        color: this.hex(city.color),
        stroke: '#080a10',
        strokeThickness: 3,
      });
      label.setOrigin(0.5);
      content.add(label);
      this.cityLabels.push(label);
    }

    g.lineStyle(1.6 / this.zoom, 0xf8d36e, 0.9);
    for (const highway of map.highways) {
      const first = highway.points[0];
      if (!first) continue;
      g.beginPath();
      g.moveTo(first.x / TILE_SIZE, first.y / TILE_SIZE);
      for (let index = 1; index < highway.points.length; index++) {
        const point = highway.points[index];
        if (point) g.lineTo(point.x / TILE_SIZE, point.y / TILE_SIZE);
      }
      g.strokePath();
    }
  }

  private refreshMarkers(): void {
    const map = this.mapData;
    const g = this.dynamicMarkerLayer;
    if (!map || !g) return;
    g.clear();

    const mission = this.currentMissionMarker();
    if (mission) {
      this.drawMarker(g, mission, OBJECTIVE_COLOR, 4.4 / this.zoom, 'diamond');
    }

    const waypoint = this.taxiMode ? (this.taxiDestination?.position ?? null) : getWaypoint();
    if (waypoint) {
      this.drawMarker(g, waypoint, WAYPOINT_COLOR, 4 / this.zoom, 'diamond');
    }

    const player = ServiceLocator.tryResolve<PlayerController>(ServiceKeys.Player)?.playerPosition;
    ServiceLocator.tryResolve<TransportationSystem>(ServiceKeys.Transportation)?.forEachServiceBlip(
      (kind, position) => {
        this.drawMarker(
          g,
          position,
          kind === 'bus' ? 0x38bdf8 : kind === 'snapp' ? 0x13c8bc : 0xf6c453,
          (kind === 'bus' ? 3.4 : kind === 'snapp' ? 3.2 : 2.7) / this.zoom,
          kind === 'bus' ? 'diamond' : 'circle',
        );
      },
    );
    this.redrawPlayerOverlay(player ?? null);
    this.drawRoutePreview(player ?? null, waypoint);
    this.updateCityStatus(player ?? null);
  }

  private updateCityStatus(player: Vector2 | null): void {
    const text = this.cityStatusText;
    if (!text) return;
    const city = player ? this.cityForPoint(player) : null;
    text.setText('CURRENT: ' + (city?.name ?? 'INTERCITY HIGHWAY'));
    text.setColor(this.hex(city?.color ?? 0xf8d36e));
  }

  private drawRoutePreview(start: Vector2 | null, target: Vector2 | null): void {
    const g = this.routeLayer;
    if (!g) return;
    g.clear();
    this.drawTransitRouteOverlays(g, start);
    if (!start || !target) return;
    const taxiRoute = this.taxiMode ? (this.taxiFare?.route.laneIds ?? null) : null;
    const points = taxiRoute
      ? this.laneRoutePoints(taxiRoute, start, target)
      : this.roadRoutePreviewPoints(start, target);
    this.strokeWorldPolyline(g, points, 2.2 / this.zoom, 0xf8d36e, 0.88);
  }

  /** Draw cached city lines only when they can be read at the current map scale. */
  private drawTransitRouteOverlays(g: Phaser.GameObjects.Graphics, player: Vector2 | null): void {
    const currentCityId = player ? (this.cityForPoint(player)?.id ?? null) : null;
    const showAllCities = this.zoom >= 1.7;
    for (const route of this.transitRouteLines) {
      if (!showAllCities && currentCityId !== route.cityId) continue;
      this.strokeWorldPolyline(g, route.points, 1.35 / this.zoom, route.color, 0.58);
    }
  }

  /** Build the public-line geometry once when the paused map opens, never per frame. */
  private rebuildTransitRouteLines(): void {
    this.transitRouteLines = [];
    const transit = this.transit();
    const traffic = ServiceLocator.tryResolve<TrafficSystem>(ServiceKeys.Traffic);
    if (!transit || !traffic?.roadNetwork) return;
    const snapshot = transit.debugSnapshot();
    for (const cityId of ['tehran', 'yazd', 'gilan'] as const) {
      for (const route of snapshot.busRoutes[cityId]) {
        if (!route.valid || route.stops.length < 2) continue;
        const points: Vector2[] = [];
        for (let index = 0; index < route.stops.length; index += 1) {
          const from = route.stops[index];
          const to = route.stops[(index + 1) % route.stops.length];
          if (!from || !to) continue;
          const preview = traffic.routePreview(from.approachPosition, to.approachPosition);
          if (!preview) continue;
          this.appendRoutePoints(
            points,
            this.laneRoutePoints(preview.laneIds, from.approachPosition, to.approachPosition),
          );
        }
        if (points.length >= 2) {
          this.transitRouteLines.push({
            routeId: route.config.id,
            cityId,
            color: route.config.color,
            points,
          });
        }
      }
    }
  }

  /** Turn legal lane ids into a sparse, render-friendly road polyline. */
  private laneRoutePoints(laneIds: readonly string[], start?: Vector2, end?: Vector2): Vector2[] {
    const network = ServiceLocator.tryResolve<TrafficSystem>(ServiceKeys.Traffic)?.roadNetwork;
    if (!network) return start && end ? [start, end] : [];
    const points: Vector2[] = [];
    if (start) this.appendRoutePoint(points, start);
    for (const laneId of laneIds) {
      const lane = network.lane(laneId);
      if (!lane) continue;
      const step = Math.max(48, Math.min(160, lane.spline.length / 10));
      for (let distance = 0; distance < lane.spline.length; distance += step) {
        this.appendRoutePoint(points, sampleSpline(lane.spline, distance).point);
      }
      this.appendRoutePoint(points, sampleSpline(lane.spline, lane.spline.length).point);
    }
    if (end) this.appendRoutePoint(points, end);
    return points;
  }

  private roadRoutePreviewPoints(start: Vector2, target: Vector2): Vector2[] {
    const preview = ServiceLocator.tryResolve<TrafficSystem>(ServiceKeys.Traffic)?.routePreview(
      start,
      target,
    );
    return preview
      ? this.laneRoutePoints(preview.laneIds, start, target)
      : this.routePreviewPoints(start, target);
  }

  private appendRoutePoints(target: Vector2[], source: readonly Vector2[]): void {
    for (const point of source) this.appendRoutePoint(target, point);
  }

  private appendRoutePoint(target: Vector2[], point: Vector2): void {
    const previous = target[target.length - 1];
    if (previous && Phaser.Math.Distance.Between(previous.x, previous.y, point.x, point.y) < 2) {
      return;
    }
    target.push({ x: point.x, y: point.y });
  }

  private strokeWorldPolyline(
    g: Phaser.GameObjects.Graphics,
    points: readonly Vector2[],
    width: number,
    color: number,
    alpha: number,
  ): void {
    if (points.length < 2) return;
    const first = points[0];
    if (!first) return;
    g.lineStyle(width, color, alpha);
    g.beginPath();
    g.moveTo(first.x / TILE_SIZE, first.y / TILE_SIZE);
    for (let index = 1; index < points.length; index += 1) {
      const point = points[index];
      if (point) g.lineTo(point.x / TILE_SIZE, point.y / TILE_SIZE);
    }
    g.strokePath();
  }

  private routePreviewPoints(start: Vector2, target: Vector2): Vector2[] {
    const map = this.mapData;
    if (!map) return [start, target];
    const from = this.cityForPoint(start);
    const to = this.cityForPoint(target);
    if (!from || !to || from.id === to.id) return [start, target];
    const route = map.highways.find(
      (entry) =>
        (entry.from === from.id && entry.to === to.id) ||
        (entry.from === to.id && entry.to === from.id),
    );
    if (!route) return [start, target];
    const roadPoints = route.from === from.id ? route.points : route.points.slice().reverse();
    return [start, ...roadPoints, target];
  }

  private cityForPoint(point: Vector2): WorldCity | null {
    const map = this.mapData;
    if (!map) return null;
    for (const city of map.cities) {
      const bounds = city.bounds;
      if (
        point.x >= bounds.x &&
        point.y >= bounds.y &&
        point.x < bounds.x + bounds.width &&
        point.y < bounds.y + bounds.height
      ) {
        return city;
      }
    }
    return null;
  }

  private drawMarker(
    g: Phaser.GameObjects.Graphics,
    point: Vector2,
    color: number,
    radius: number,
    shape: 'circle' | 'diamond' | 'player',
  ): void {
    const x = point.x / TILE_SIZE;
    const y = point.y / TILE_SIZE;

    g.lineStyle(Math.max(0.45, radius * 0.35), 0xffffff, 0.85);
    g.fillStyle(color, 1);

    if (shape === 'diamond') {
      g.beginPath();
      g.moveTo(x, y - radius);
      g.lineTo(x + radius, y);
      g.lineTo(x, y + radius);
      g.lineTo(x - radius, y);
      g.closePath();
      g.fillPath();
      g.strokePath();
      return;
    }

    if (shape === 'player') {
      g.fillCircle(x, y, radius);
      g.strokeCircle(x, y, radius);
      g.lineStyle(Math.max(0.35, radius * 0.25), color, 0.45);
      g.strokeCircle(x, y, radius * 1.8);
      return;
    }

    g.fillCircle(x, y, radius);
    g.strokeCircle(x, y, radius);
  }

  /** Dedicated transit sign used on the full map instead of a generic POI dot. */
  private drawBusStopMarker(g: Phaser.GameObjects.Graphics, point: Vector2, size: number): void {
    const x = point.x / TILE_SIZE;
    const y = point.y / TILE_SIZE;
    g.fillStyle(0x38bdf8, 1);
    g.fillRect(x - size * 0.42, y - size, size * 0.84, size * 2);
    g.lineStyle(Math.max(0.45, size * 0.24), 0xe6f6ff, 0.95);
    g.strokeRect(x - size * 0.42, y - size, size * 0.84, size * 2);
    g.fillStyle(0x07111c, 1);
    g.fillCircle(x, y - size * 0.35, Math.max(0.45, size * 0.22));
  }

  private redrawPoiMarkers(): void {
    const map = this.mapData;
    const g = this.poiLayer;
    if (!map || !g) return;
    g.clear();
    this.poiTargets.length = 0;
    this.propertyTargets.length = 0;
    this.realEstateOfficeTargets.length = 0;

    const housing = this.housing();
    for (const office of this.realEstateOffices(housing)) {
      const screen = this.worldToMapScreen(office.npcSpawnPosition);
      const hitRadius = Math.max(
        propertyMapIconHitRadius(PROPERTY_MARKER_SIZE),
        this.mobile ? 22 : 16,
      );
      if (!this.isInViewWithMargin(screen.x, screen.y, hitRadius + 3)) continue;

      this.realEstateOfficeTargets.push({ office, screen, hitRadius });
      const selected = this.selectedRealEstateOfficeId === office.id;
      const hovered = this.hoveredRealEstateOfficeId === office.id;
      const x = Math.round(screen.x);
      const y = Math.round(screen.y);
      if (selected || hovered) {
        g.fillStyle(REAL_ESTATE_OFFICE_COLOR, selected ? 0.2 : 0.12);
        g.fillCircle(x, y, hitRadius + (selected ? 7 : 4));
        g.lineStyle(selected ? 3 : 2, selected ? COLORS.ACCENT : 0xffffff, 0.95);
        g.strokeCircle(x, y, hitRadius + (selected ? 5 : 3));
      }
      paintRealEstateOfficeIcon(g, x, y, PROPERTY_MARKER_SIZE);
    }

    for (const property of this.validProperties(housing)) {
      const screen = this.worldToMapScreen(property.entranceWorldPosition);
      const status = this.propertyStatus(property, housing);
      const hitRadius = Math.max(
        propertyMapIconHitRadius(PROPERTY_MARKER_SIZE),
        this.mobile ? 22 : 16,
      );
      if (!this.isInViewWithMargin(screen.x, screen.y, hitRadius + 3)) continue;

      this.propertyTargets.push({ property, status, screen, hitRadius });
      const selected = this.selectedPropertyId === property.id;
      const hovered = this.hoveredPropertyId === property.id;
      const x = Math.round(screen.x);
      const y = Math.round(screen.y);

      if (selected || hovered) {
        g.fillStyle(PROPERTY_MAP_COLORS[status], selected ? 0.2 : 0.12);
        g.fillCircle(x, y, hitRadius + (selected ? 7 : 4));
        g.lineStyle(selected ? 3 : 2, selected ? COLORS.ACCENT : 0xffffff, 0.95);
        g.strokeCircle(x, y, hitRadius + (selected ? 5 : 3));
      }
      paintPropertyMapIcon(g, status, x, y, PROPERTY_MARKER_SIZE);
    }

    for (const building of map.majorBuildings) {
      const screen = this.worldToMapScreen(building.worldPosition);
      const hitRadius = majorBuildingIconHitRadius(FULL_MAP_POI_SIZE);
      if (!this.isInViewWithMargin(screen.x, screen.y, hitRadius + 2)) {
        continue;
      }

      this.poiTargets.push({ building, screen, hitRadius });
      const selected = this.selectedPoiId === building.id;
      const hovered = this.hoveredPoiId === building.id;
      const color = this.poiColor(building);
      const x = Math.round(screen.x);
      const y = Math.round(screen.y);

      g.fillStyle(0x050712, selected ? 0.78 : hovered ? 0.58 : 0.36);
      g.fillRect(x - hitRadius, y - hitRadius, hitRadius * 2, hitRadius * 2);

      if (selected || hovered) {
        g.lineStyle(selected ? 3 : 2, selected ? COLORS.ACCENT : color, 1);
        g.strokeRect(x - hitRadius - 2, y - hitRadius - 2, hitRadius * 2 + 4, hitRadius * 2 + 4);
      }

      paintMajorBuildingIcon(g, building.mapIcon, x, y, FULL_MAP_POI_SIZE);
    }

    this.updatePoiInfoPanel();
    this.updatePoiHoverLabel();
  }

  private redrawPlayerOverlay(player: Vector2 | null): void {
    const g = this.playerOverlayLayer;
    if (!g) return;
    g.clear();
    if (!player) return;
    const screen = this.worldToMapScreen(player);
    if (!this.isInViewWithMargin(screen.x, screen.y, 10)) return;
    const x = Math.round(screen.x);
    const y = Math.round(screen.y);
    const radius = 7;

    g.fillStyle(0x050712, 0.78);
    g.fillRect(x - 9, y - 9, 18, 18);
    g.lineStyle(2, 0xffffff, 0.95);
    g.fillStyle(COLORS.ACCENT, 1);
    g.beginPath();
    g.moveTo(x, y - radius);
    g.lineTo(x + radius, y);
    g.lineTo(x, y + radius);
    g.lineTo(x - radius, y);
    g.closePath();
    g.fillPath();
    g.strokePath();
    g.lineStyle(1, PLAYER_COLOR, 0.75);
    g.strokeRect(x - 11, y - 11, 22, 22);
  }

  private worldToMapScreen(point: Vector2): Vector2 {
    const map = this.mapData;
    const tileSize = map?.tileSize ?? TILE_SIZE;
    const scale = this.scalePerTile();
    return {
      x: this.offsetX + (point.x / tileSize) * scale,
      y: this.offsetY + (point.y / tileSize) * scale,
    };
  }

  private findPoiAtScreen(x: number, y: number): MajorPoiScreenTarget | null {
    let best: MajorPoiScreenTarget | null = null;
    let bestDistanceSq = Infinity;
    for (const target of this.poiTargets) {
      const dx = target.screen.x - x;
      const dy = target.screen.y - y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq > target.hitRadius * target.hitRadius || distanceSq >= bestDistanceSq) {
        continue;
      }
      best = target;
      bestDistanceSq = distanceSq;
    }
    return best;
  }

  private findPropertyAtScreen(x: number, y: number): PropertyScreenTarget | null {
    let best: PropertyScreenTarget | null = null;
    let bestDistanceSq = Infinity;
    for (const target of this.propertyTargets) {
      const dx = target.screen.x - x;
      const dy = target.screen.y - y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq > target.hitRadius * target.hitRadius || distanceSq >= bestDistanceSq) {
        continue;
      }
      best = target;
      bestDistanceSq = distanceSq;
    }
    return best;
  }

  private findRealEstateOfficeAtScreen(x: number, y: number): RealEstateOfficeScreenTarget | null {
    let best: RealEstateOfficeScreenTarget | null = null;
    let bestDistanceSq = Infinity;
    for (const target of this.realEstateOfficeTargets) {
      const dx = target.screen.x - x;
      const dy = target.screen.y - y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq > target.hitRadius * target.hitRadius || distanceSq >= bestDistanceSq) {
        continue;
      }
      best = target;
      bestDistanceSq = distanceSq;
    }
    return best;
  }

  /** Bus platforms and landmark pins are first-class taxi targets, not generic map clicks. */
  private findTaxiDestinationAtScreen(x: number, y: number): TaxiDestination | null {
    const map = this.mapData;
    if (!map) return null;
    let result: TaxiDestination | null = null;
    let bestDistanceSq = Infinity;
    const consider = (destination: TaxiDestination, hitRadius: number): void => {
      const screen = this.worldToMapScreen(destination.position);
      const dx = screen.x - x;
      const dy = screen.y - y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq > hitRadius * hitRadius || distanceSq >= bestDistanceSq) return;
      result = destination;
      bestDistanceSq = distanceSq;
    };
    for (const stop of map.busStops) {
      consider(
        {
          id: `bus-stop:${stop.id}`,
          label: `Bus stop ${stop.id.replace(/^bus-stop:[^:]+:/, '')}`,
          position: { ...stop.approachPosition },
          cityId: stop.cityId,
          source: 'bus-stop',
        },
        12,
      );
    }
    for (const landmark of map.landmarks) {
      const cityId = landmark.cityId ?? this.cityForPoint(landmark.position)?.id;
      if (!cityId) continue;
      consider(
        {
          id: `landmark:${landmark.id}`,
          label: landmark.name,
          position: { ...landmark.position },
          cityId,
          source: 'landmark',
        },
        13,
      );
    }
    return result;
  }

  private updatePoiHover(x: number, y: number): void {
    const office = this.isInView(x, y) ? this.findRealEstateOfficeAtScreen(x, y) : null;
    if (office) {
      this.setHoveredRealEstateOffice(office.office);
      return;
    }
    const property = this.isInView(x, y) ? this.findPropertyAtScreen(x, y) : null;
    if (property) {
      this.setHoveredProperty(property.property);
      return;
    }
    const target = this.isInView(x, y) ? this.findPoiAtScreen(x, y) : null;
    this.setHoveredPoi(target?.building ?? null);
  }

  private setHoveredPoi(building: MajorBuildingDefinition | null): void {
    const nextId = building?.id ?? null;
    if (
      this.hoveredPoiId === nextId &&
      this.hoveredPropertyId === null &&
      this.hoveredRealEstateOfficeId === null
    ) {
      this.updatePoiHoverLabel();
      return;
    }
    this.hoveredPoiId = nextId;
    this.hoveredPropertyId = null;
    this.hoveredRealEstateOfficeId = null;
    this.redrawPoiMarkers();
  }

  private setHoveredProperty(property: PropertyDefinition | null): void {
    const nextId = property?.id ?? null;
    if (
      this.hoveredPropertyId === nextId &&
      this.hoveredPoiId === null &&
      this.hoveredRealEstateOfficeId === null
    ) {
      this.updatePoiHoverLabel();
      return;
    }
    this.hoveredPropertyId = nextId;
    this.hoveredPoiId = null;
    this.hoveredRealEstateOfficeId = null;
    this.redrawPoiMarkers();
  }

  private setHoveredRealEstateOffice(office: RealEstateOfficeDefinition | null): void {
    const nextId = office?.id ?? null;
    if (
      this.hoveredRealEstateOfficeId === nextId &&
      this.hoveredPoiId === null &&
      this.hoveredPropertyId === null
    ) {
      this.updatePoiHoverLabel();
      return;
    }
    this.hoveredRealEstateOfficeId = nextId;
    this.hoveredPoiId = null;
    this.hoveredPropertyId = null;
    this.redrawPoiMarkers();
  }

  private selectPoi(building: MajorBuildingDefinition): void {
    if (this.taxiMode) {
      this.selectTaxiDestination({
        id: `major:${building.id}`,
        label: building.name,
        position: { ...building.entrancePosition },
        cityId: building.city,
        source: 'landmark',
      });
      return;
    }
    this.selectedPoiId = building.id;
    this.selectedPropertyId = null;
    this.selectedRealEstateOfficeId = null;
    setWaypoint(building.entrancePosition);
    this.showStatus(`${this.poiTypeLabel(building)} waypoint set`);
    this.redrawPoiMarkers();
    this.refreshMarkers();
  }

  private selectProperty(property: PropertyDefinition): void {
    if (this.taxiMode) {
      this.selectTaxiDestination({
        id: `property:${property.id}`,
        label: property.displayName,
        position: { ...property.entranceWorldPosition },
        cityId: property.cityId,
        source: 'landmark',
      });
      return;
    }
    this.selectedPropertyId = property.id;
    this.selectedPoiId = null;
    this.selectedRealEstateOfficeId = null;
    setWaypoint(property.entranceWorldPosition);
    this.showStatus(`${property.displayName} route set`);
    this.redrawPoiMarkers();
    this.refreshMarkers();
  }

  private selectRealEstateOffice(office: RealEstateOfficeDefinition): void {
    const label = `Real Estate Office — ${this.cityLabel(office.cityId)}`;
    if (this.taxiMode) {
      this.selectTaxiDestination({
        id: `real-estate:${office.id}`,
        label,
        position: { ...office.npcSpawnPosition },
        cityId: office.cityId,
        source: 'landmark',
      });
      return;
    }
    this.selectedRealEstateOfficeId = office.id;
    this.selectedPropertyId = null;
    this.selectedPoiId = null;
    setWaypoint(office.npcSpawnPosition);
    this.showStatus(`${label} route set`);
    this.redrawPoiMarkers();
    this.refreshMarkers();
  }

  private updatePoiInfoPanel(): void {
    const panel = this.poiInfoPanel;
    const title = this.poiInfoTitleText;
    const body = this.poiInfoBodyText;
    if (!panel || !title || !body) return;

    const hoveredOffice = this.realEstateOfficeById(this.hoveredRealEstateOfficeId);
    const hoveredProperty = this.propertyById(this.hoveredPropertyId);
    const hoveredBuilding = this.buildingById(this.hoveredPoiId);
    const selectedOffice = this.realEstateOfficeById(this.selectedRealEstateOfficeId);
    const selectedProperty = this.propertyById(this.selectedPropertyId);
    const selectedBuilding = this.buildingById(this.selectedPoiId);
    const office = hoveredOffice ?? (!hoveredProperty && !hoveredBuilding ? selectedOffice : null);
    const property = office
      ? null
      : (hoveredProperty ?? (hoveredBuilding ? null : selectedProperty));
    const building = office || property ? null : (hoveredBuilding ?? selectedBuilding);
    if (!office && !property && !building) {
      panel.clear();
      panel.setVisible(false);
      title.setVisible(false);
      body.setVisible(false);
      return;
    }

    const rect = this.poiPanelRect();
    const propertyStatus = property ? this.propertyStatus(property) : null;
    const selected = office
      ? this.selectedRealEstateOfficeId === office.id
      : property
        ? this.selectedPropertyId === property.id
        : this.selectedPoiId === building?.id;
    const color = office
      ? REAL_ESTATE_OFFICE_COLOR
      : propertyStatus
        ? PROPERTY_MAP_COLORS[propertyStatus]
        : this.poiColor(building as MajorBuildingDefinition);
    const heading = office
      ? 'REAL ESTATE OFFICE'
      : property
        ? `HOME • ${propertyMapStatusLabel(propertyStatus as PropertyMapStatus).toUpperCase()}`
        : this.poiTypeLabel(building as MajorBuildingDefinition).toUpperCase();
    const lines = office
      ? [
          `Real Estate Office — ${this.cityLabel(office.cityId)}`,
          'Property agent and home listings',
          `Listings: ${this.validProperties().filter((entry) => entry.cityId === office.cityId).length}`,
          `Distance: ${this.distanceLabel(office.npcSpawnPosition)}`,
          selected ? 'Route: agent waypoint set' : 'Click: set route to agent',
        ]
      : property
        ? [
            property.displayName,
            `${this.cityLabel(property.cityId)} • ${this.humanize(property.districtId)}`,
            propertyStatus === 'for-sale'
              ? `Price: ${formatPropertyMapPrice(property.price, property.currency)}`
              : `Status: ${propertyMapStatusLabel(propertyStatus as PropertyMapStatus)}`,
            `Parking: ${property.parkingCapacity} • ${property.features[0] ?? 'Home'}`,
            `Distance: ${this.distanceLabel(property.entranceWorldPosition)}`,
            selected ? 'Route: entrance waypoint set' : 'Click: set route to entrance',
          ]
        : [
            this.poiLabel(building as MajorBuildingDefinition),
            (building as MajorBuildingDefinition).name,
            `Distance: ${this.distanceLabel((building as MajorBuildingDefinition).entrancePosition)}`,
            selected ? 'Route: entrance waypoint set' : 'Click: set route to entrance',
          ];

    panel.clear();
    panel.setVisible(true);
    panel.fillStyle(0x070a12, 0.96);
    panel.fillRect(rect.x, rect.y, rect.width, rect.height);
    panel.lineStyle(2, color, 0.95);
    panel.strokeRect(rect.x, rect.y, rect.width, rect.height);
    panel.fillStyle(color, 0.95);
    panel.fillRect(rect.x, rect.y, 5, rect.height);

    title
      .setVisible(true)
      .setPosition(rect.x + 14, rect.y + 12)
      .setText(heading)
      .setColor(this.hex(color));
    body
      .setVisible(true)
      .setPosition(rect.x + 14, rect.y + 36)
      .setText(lines.join('\n'));
  }

  private updatePoiHoverLabel(): void {
    const label = this.poiHoverLabel;
    if (!label) return;
    const propertyTarget = this.propertyTargets.find(
      (entry) => entry.property.id === this.hoveredPropertyId,
    );
    const officeTarget = this.realEstateOfficeTargets.find(
      (entry) => entry.office.id === this.hoveredRealEstateOfficeId,
    );
    const poiTarget = this.poiTargets.find((entry) => entry.building.id === this.hoveredPoiId);
    const screen = officeTarget?.screen ?? propertyTarget?.screen ?? poiTarget?.screen;
    if (!screen) {
      label.setVisible(false);
      return;
    }
    const text = officeTarget
      ? `Real Estate Office • ${this.cityLabel(officeTarget.office.cityId)}`
      : propertyTarget
        ? [
            propertyTarget.property.displayName,
            propertyMapStatusLabel(propertyTarget.status),
            propertyTarget.status === 'for-sale'
              ? formatPropertyMapPrice(
                  propertyTarget.property.price,
                  propertyTarget.property.currency,
                )
              : null,
          ]
            .filter((part): part is string => part !== null)
            .join(' • ')
        : this.poiLabel((poiTarget as MajorPoiScreenTarget).building);
    label.setText(text);
    label.setColor(this.hex(COLORS.TEXT));
    label.setVisible(true);

    const labelWidth = label.width;
    const labelHeight = label.height;
    const x = Phaser.Math.Clamp(
      screen.x + 15,
      this.viewRect.x + 6,
      this.viewRect.x + this.viewRect.width - labelWidth - 6,
    );
    const y = Phaser.Math.Clamp(
      screen.y - labelHeight - 14,
      this.viewRect.y + 6,
      this.viewRect.y + this.viewRect.height - labelHeight - 6,
    );
    label.setPosition(Math.round(x), Math.round(y));
  }

  private buildingById(id: string | null): MajorBuildingDefinition | null {
    if (!id || !this.mapData) return null;
    return this.mapData.majorBuildings.find((building) => building.id === id) ?? null;
  }

  private propertyById(id: string | null): PropertyDefinition | null {
    if (!id) return null;
    return this.housing()?.getProperty(id) ?? null;
  }

  private realEstateOfficeById(id: string | null): RealEstateOfficeDefinition | null {
    if (!id) return null;
    return this.housing()?.officesForWorld.find((office) => office.id === id) ?? null;
  }

  private housing(): HousingSystem | null {
    return ServiceLocator.tryResolve<HousingSystem>(ServiceKeys.Housing);
  }

  private validProperties(
    housing: HousingSystem | null = this.housing(),
  ): readonly PropertyDefinition[] {
    return housing?.catalog.filter((property) => property.valid) ?? [];
  }

  private realEstateOffices(
    housing: HousingSystem | null = this.housing(),
  ): readonly RealEstateOfficeDefinition[] {
    return housing?.officesForWorld ?? [];
  }

  private propertyStatus(
    property: PropertyDefinition,
    housing: HousingSystem | null = this.housing(),
  ): PropertyMapStatus {
    const state = housing?.ownershipState;
    return classifyPropertyMapStatus(
      property.id,
      state?.ownedPropertyIds ?? [],
      state?.activeHomeId ?? null,
    );
  }

  private humanize(value: string): string {
    return value.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  private poiPanelRect(): MapRect {
    return {
      x: Math.round(this.viewRect.x + this.viewRect.width - POI_CARD_WIDTH - 16),
      y: Math.round(this.viewRect.y + 16),
      width: POI_CARD_WIDTH,
      height: POI_CARD_HEIGHT,
    };
  }

  private poiLabel(building: MajorBuildingDefinition): string {
    return `${this.poiTypeLabel(building)} — ${this.cityLabel(building.city)}`;
  }

  private poiTypeLabel(building: MajorBuildingDefinition): string {
    return building.type === 'hospital' ? 'Hospital' : 'Police Station';
  }

  private cityLabel(cityId: MajorBuildingDefinition['city']): string {
    const city = this.mapData?.cities.find((entry) => entry.id === cityId);
    if (city) {
      return city.name.charAt(0) + city.name.slice(1).toLowerCase();
    }
    return cityId.charAt(0).toUpperCase() + cityId.slice(1);
  }

  private poiColor(building: MajorBuildingDefinition): number {
    return building.type === 'hospital' ? COLORS.HEALTH : 0x3a6cff;
  }

  private distanceLabel(point: Vector2): string {
    const player = ServiceLocator.tryResolve<PlayerController>(ServiceKeys.Player)?.playerPosition;
    if (!player) return '--';
    const meters = Math.max(
      1,
      Math.round(
        (Phaser.Math.Distance.Between(player.x, player.y, point.x, point.y) / TILE_SIZE) * 5,
      ),
    );
    return `${meters.toLocaleString()}m`;
  }

  private fitWholeCity(): void {
    const map = this.mapData;
    if (!map) return;
    this.baseScale = Math.min(
      this.viewRect.width / map.widthTiles,
      this.viewRect.height / map.heightTiles,
    );
    this.zoom = 1;
    this.offsetX = this.viewRect.x + (this.viewRect.width - map.widthTiles * this.baseScale) / 2;
    this.offsetY = this.viewRect.y + (this.viewRect.height - map.heightTiles * this.baseScale) / 2;
    this.applyTransform();
  }

  private bindInput(): void {
    this.input.keyboard?.on('keydown-ESC', this.closeMap, this);
    this.input.keyboard?.on('keydown-M', this.closeMap, this);
    this.input.keyboard?.on('keydown-TAB', this.closeMap, this);
    this.input.keyboard?.on('keydown-BACKSPACE', this.clearWaypoint, this);
    this.input.keyboard?.on('keydown-DELETE', this.clearWaypoint, this);
    this.input.keyboard?.on('keydown-PLUS', () => this.zoomAt(ZOOM_STEP, this.viewCenterScreen()));
    this.input.keyboard?.on('keydown-NUMPAD_ADD', () =>
      this.zoomAt(ZOOM_STEP, this.viewCenterScreen()),
    );
    this.input.keyboard?.on('keydown-MINUS', () =>
      this.zoomAt(1 / ZOOM_STEP, this.viewCenterScreen()),
    );
    this.input.keyboard?.on('keydown-NUMPAD_SUBTRACT', () =>
      this.zoomAt(1 / ZOOM_STEP, this.viewCenterScreen()),
    );
    this.input.keyboard?.on('keydown-HOME', this.fitWholeCity, this);
    this.input.keyboard?.on('keydown-F', this.centerOnPlayer, this);

    this.input.on(Phaser.Input.Events.POINTER_DOWN, this.onPointerDown, this);
    this.input.on(Phaser.Input.Events.POINTER_MOVE, this.onPointerMove, this);
    this.input.on(Phaser.Input.Events.POINTER_UP, this.onPointerUp, this);
    this.input.on(Phaser.Input.Events.POINTER_WHEEL, this.onWheel, this);
  }

  private onPointerDown(pointer: Phaser.Input.Pointer): void {
    if (this.isUiPoint(pointer.x, pointer.y)) {
      return;
    }
    if (pointer.rightButtonDown()) {
      this.clearWaypoint();
      return;
    }
    if (!pointer.leftButtonDown() || !this.isInView(pointer.x, pointer.y)) {
      return;
    }
    this.setHoveredPoi(null);
    this.dragging = true;
    this.dragMoved = false;
    this.dragPointerId = pointer.id;
    this.dragStartX = pointer.x;
    this.dragStartY = pointer.y;
    this.dragOffsetX = this.offsetX;
    this.dragOffsetY = this.offsetY;
  }

  private onPointerMove(pointer: Phaser.Input.Pointer): void {
    if (!this.dragging) {
      this.updatePoiHover(pointer.x, pointer.y);
      return;
    }
    if (pointer.id !== this.dragPointerId) {
      return;
    }
    const dx = pointer.x - this.dragStartX;
    const dy = pointer.y - this.dragStartY;
    if (Math.hypot(dx, dy) >= CLICK_DRAG_THRESHOLD) {
      this.dragMoved = true;
    }
    this.offsetX = this.dragOffsetX + dx;
    this.offsetY = this.dragOffsetY + dy;
    this.constrainView();
    this.applyTransform();
  }

  private onPointerUp(pointer: Phaser.Input.Pointer): void {
    if (!this.dragging || pointer.id !== this.dragPointerId) {
      return;
    }
    const shouldPlace = !this.dragMoved && this.isInView(pointer.x, pointer.y);
    this.dragging = false;
    this.dragPointerId = -1;
    if (shouldPlace) {
      const office = this.findRealEstateOfficeAtScreen(pointer.x, pointer.y);
      const property = office ? null : this.findPropertyAtScreen(pointer.x, pointer.y);
      const poi = office || property ? null : this.findPoiAtScreen(pointer.x, pointer.y);
      if (office) {
        this.selectRealEstateOffice(office.office);
      } else if (property) {
        this.selectProperty(property.property);
      } else if (poi) {
        this.selectPoi(poi.building);
      } else if (this.taxiMode) {
        const destination = this.findTaxiDestinationAtScreen(pointer.x, pointer.y);
        if (destination) this.selectTaxiDestination(destination);
        else this.placeWaypoint(pointer.x, pointer.y);
      } else {
        this.placeWaypoint(pointer.x, pointer.y);
      }
    }
    this.updatePoiHover(pointer.x, pointer.y);
  }

  private onWheel(
    pointer: Phaser.Input.Pointer,
    _objects: Phaser.GameObjects.GameObject[],
    _dx: number,
    dy: number,
  ): void {
    if (!this.isInView(pointer.x, pointer.y)) {
      return;
    }
    this.zoomAt(dy < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, { x: pointer.x, y: pointer.y });
    this.updatePoiHover(pointer.x, pointer.y);
  }

  private zoomAt(factor: number, screen: Vector2): void {
    const map = this.mapData;
    if (!map) return;

    const before = this.screenToMap(screen.x, screen.y);
    const nextZoom = Phaser.Math.Clamp(this.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    if (Math.abs(nextZoom - this.zoom) < 1e-4) {
      return;
    }

    this.zoom = nextZoom;
    const scale = this.scalePerTile();
    this.offsetX = screen.x - before.x * scale;
    this.offsetY = screen.y - before.y * scale;
    this.constrainView();
    this.applyTransform();
    this.redrawStaticMarkers();
    this.drawCityAreas();
    this.refreshMarkers();
  }

  private centerOnPlayer(): void {
    const map = this.mapData;
    const player =
      ServiceLocator.tryResolve<PlayerController>(ServiceKeys.Player)?.playerPosition ?? null;
    if (!map || !player) return;
    this.zoom = Math.max(this.zoom, 2.1);
    const scale = this.scalePerTile();
    this.offsetX = this.viewRect.x + this.viewRect.width / 2 - (player.x / map.tileSize) * scale;
    this.offsetY = this.viewRect.y + this.viewRect.height / 2 - (player.y / map.tileSize) * scale;
    this.constrainView();
    this.applyTransform();
    this.redrawStaticMarkers();
    this.drawCityAreas();
    this.refreshMarkers();
    this.showStatus('Map centered on player');
  }

  private placeWaypoint(screenX: number, screenY: number): void {
    const map = this.mapData;
    if (!map) return;
    const mapPoint = this.screenToMap(screenX, screenY);
    const worldPoint = {
      x: Phaser.Math.Clamp(mapPoint.x, 0, map.widthTiles) * map.tileSize,
      y: Phaser.Math.Clamp(mapPoint.y, 0, map.heightTiles) * map.tileSize,
    };
    if (this.taxiMode) {
      this.selectTaxiMapPoint(worldPoint);
      return;
    }
    setWaypoint(worldPoint);
    this.selectedPoiId = null;
    this.selectedPropertyId = null;
    this.selectedRealEstateOfficeId = null;
    this.updatePoiInfoPanel();
    this.showStatus('Waypoint set');
    this.refreshMarkers();
  }

  private clearWaypoint(): void {
    if (this.taxiMode) {
      this.cancelTaxiSelection();
      return;
    }
    setWaypoint(null);
    this.selectedPoiId = null;
    this.selectedPropertyId = null;
    this.selectedRealEstateOfficeId = null;
    this.updatePoiInfoPanel();
    this.showStatus('Waypoint cleared');
    this.refreshMarkers();
  }

  private selectTaxiDestination(destination: TaxiDestination): void {
    const transit = this.transit();
    const fare = transit?.previewTaxiDestination(destination) ?? null;
    if (!fare) {
      this.showStatus('Taxi cannot reach that destination by road');
      return;
    }
    this.taxiDestination = destination;
    this.taxiFare = fare;
    this.taxiQuoteText?.setText(
      [
        destination.label,
        `DISTANCE  ${fare.distanceKm.toFixed(1)} km`,
        `FARE  Base $${fare.baseFare} + Road $${fare.distanceCost}`,
        `TOTAL  $${fare.total}`,
      ].join('\n'),
    );
    this.taxiConfirmButton?.setEnabled(true);
    this.showStatus('Confirm fare to start the trip');
    this.refreshMarkers();
  }

  private selectTaxiMapPoint(position: Vector2): void {
    const transit = this.transit();
    const cityId = this.cityForPoint(position)?.id;
    if (!cityId) {
      this.showStatus('Choose a point inside a city service area');
      return;
    }
    const fare = transit?.previewTaxiMapPoint(position, 'Map pin') ?? null;
    if (!fare) {
      this.showStatus('Choose a reachable point inside this taxi service area');
      return;
    }
    const destination: TaxiDestination = {
      id: `map:${Math.round(position.x)}:${Math.round(position.y)}`,
      label: 'Map pin',
      position: { ...position },
      cityId,
      source: 'map',
    };
    this.taxiDestination = destination;
    this.taxiFare = fare;
    this.taxiQuoteText?.setText(
      [
        'Map pin',
        `DISTANCE  ${fare.distanceKm.toFixed(1)} km`,
        `FARE  Base $${fare.baseFare} + Road $${fare.distanceCost}`,
        `TOTAL  $${fare.total}`,
      ].join('\n'),
    );
    this.taxiConfirmButton?.setEnabled(true);
    this.showStatus('Confirm fare to start the trip');
    this.refreshMarkers();
  }

  private confirmTaxiSelection(): void {
    if (!this.taxiFare) {
      this.showStatus('Select a destination first');
      return;
    }
    const result = this.transit()?.confirmTaxiFare() ?? 'invalid-trip';
    if (result === 'paid') {
      this.taxiMode = false;
      ServiceLocator.tryResolve<GameManager>(ServiceKeys.Game)?.resumeGame();
      return;
    }
    if (result === 'insufficient-funds') {
      this.showStatus('Insufficient funds');
      return;
    }
    this.showStatus('Taxi trip is no longer available');
  }

  private cancelTaxiSelection(): void {
    this.transit()?.cancelTaxiDestination();
    this.taxiMode = false;
    ServiceLocator.tryResolve<GameManager>(ServiceKeys.Game)?.resumeGame();
  }

  private currentMissionMarker(): Vector2 | null {
    const objective = getObjectiveTarget();
    if (objective) {
      return objective;
    }
    return ServiceLocator.tryResolve<MissionSystem>(ServiceKeys.Mission)?.currentMapMarker ?? null;
  }

  private closeMap(): void {
    if (this.taxiMode) {
      this.cancelTaxiSelection();
      return;
    }
    ServiceLocator.tryResolve<GameManager>(ServiceKeys.Game)?.resumeGame();
  }

  private transit(): TransportationSystem | null {
    return ServiceLocator.tryResolve<TransportationSystem>(ServiceKeys.Transportation);
  }

  private enableMenuCursor(): void {
    this.input.setDefaultCursor('default');
    this.input.mouse?.releasePointerLock();
    this.game.canvas.style.cursor = 'default';
  }

  private applyTransform(): void {
    const content = this.content;
    if (!content) return;
    const scale = this.scalePerTile();
    content.setPosition(this.offsetX, this.offsetY);
    content.setScale(scale);
    this.redrawPoiMarkers();
    this.redrawPlayerOverlay(
      ServiceLocator.tryResolve<PlayerController>(ServiceKeys.Player)?.playerPosition ?? null,
    );
  }

  private constrainView(): void {
    const map = this.mapData;
    if (!map) return;
    const width = map.widthTiles * this.scalePerTile();
    const height = map.heightTiles * this.scalePerTile();

    this.offsetX = this.clampOffset(
      this.offsetX,
      this.viewRect.x,
      this.viewRect.x + this.viewRect.width,
      width,
    );
    this.offsetY = this.clampOffset(
      this.offsetY,
      this.viewRect.y,
      this.viewRect.y + this.viewRect.height,
      height,
    );
  }

  private clampOffset(offset: number, minEdge: number, maxEdge: number, size: number): number {
    if (size <= maxEdge - minEdge) {
      return minEdge + (maxEdge - minEdge - size) / 2;
    }
    return Phaser.Math.Clamp(offset, maxEdge - size, minEdge);
  }

  private scalePerTile(): number {
    return this.baseScale * this.zoom;
  }

  private screenToMap(screenX: number, screenY: number): Vector2 {
    const scale = this.scalePerTile();
    return {
      x: (screenX - this.offsetX) / scale,
      y: (screenY - this.offsetY) / scale,
    };
  }

  private viewCenterScreen(): Vector2 {
    return {
      x: this.viewRect.x + this.viewRect.width / 2,
      y: this.viewRect.y + this.viewRect.height / 2,
    };
  }

  private isInView(x: number, y: number): boolean {
    return (
      x >= this.viewRect.x &&
      y >= this.viewRect.y &&
      x <= this.viewRect.x + this.viewRect.width &&
      y <= this.viewRect.y + this.viewRect.height
    );
  }

  private isInViewWithMargin(x: number, y: number, margin: number): boolean {
    return (
      x >= this.viewRect.x - margin &&
      y >= this.viewRect.y - margin &&
      x <= this.viewRect.x + this.viewRect.width + margin &&
      y <= this.viewRect.y + this.viewRect.height + margin
    );
  }

  private isUiPoint(x: number, y: number): boolean {
    if (this.uiZones.some((zone) => zone.contains(x, y))) {
      return true;
    }
    if (this.poiInfoPanel?.visible) {
      const panel = this.poiPanelRect();
      return (
        x >= panel.x && y >= panel.y && x <= panel.x + panel.width && y <= panel.y + panel.height
      );
    }
    return false;
  }

  private colorForTile(tile: number | undefined): number {
    switch (tile) {
      case TileType.Water:
        return 0x1f5f86;
      case TileType.Road:
      case TileType.RoadLineH:
      case TileType.RoadLineV:
      case TileType.Crossing:
        return 0x2f333b;
      case TileType.Sidewalk:
        return 0xa6adb5;
      case TileType.Building:
        return 0x6b7280;
      case TileType.BuildingRes:
        return 0x8c6b58;
      case TileType.BuildingInd:
        return 0x59636d;
      case TileType.Sand:
        return 0xd7b96a;
      case TileType.Dirt:
        return 0x8a6840;
      case TileType.Rock:
        return 0x4d5561;
      case TileType.Concrete:
        return 0x7d858f;
      case TileType.Runway:
        return 0x262a32;
      case TileType.Dock:
        return 0x7b5435;
      case TileType.Grass:
      default:
        return 0x2e6b3f;
    }
  }

  private colorForLandmark(landmark: WorldLandmark): number {
    switch (landmark.kind) {
      case 'hospital':
        return COLORS.HEALTH;
      case 'police':
        return 0x3a6cff;
      case 'airport':
        return 0x94a3b8;
      case 'gas':
        return COLORS.MONEY;
      case 'shop':
      case 'bazaar':
        return 0x8b5cf6;
      case 'government':
      case 'station':
      case 'metro':
      case 'tower':
      case 'financial':
      case 'observatory':
        return 0xf8d36e;
      case 'harbor':
      case 'marina':
      case 'lighthouse':
      case 'waterfall':
      case 'park':
      case 'viewpoint':
      case 'forest':
      case 'camping':
      case 'oasis':
        return 0x4cbf87;
      case 'cargo':
      case 'military':
      case 'solar':
      case 'port':
        return 0x94a3b8;
      case 'salt-lake':
        return 0x67b7dc;
      case 'bridge':
        return 0xf4d35e;
      default:
        return 0xe7a34b;
    }
  }

  private showStatus(message: string): void {
    const text = this.statusText;
    if (!text) return;
    text.setText(message);
    text.setAlpha(1);
    this.tweens.killTweensOf(text);
    this.tweens.add({
      targets: text,
      alpha: { from: 1, to: 0.35 },
      delay: 900,
      duration: 450,
    });
  }

  private hex(color: number): string {
    return '#' + color.toString(16).padStart(6, '0');
  }

  private onShutdown(): void {
    this.input.keyboard?.off('keydown-ESC', this.closeMap, this);
    this.input.keyboard?.off('keydown-M', this.closeMap, this);
    this.input.keyboard?.off('keydown-TAB', this.closeMap, this);
    this.input.keyboard?.off('keydown-BACKSPACE', this.clearWaypoint, this);
    this.input.keyboard?.off('keydown-DELETE', this.clearWaypoint, this);
    this.input.keyboard?.off('keydown-HOME', this.fitWholeCity, this);
    this.input.keyboard?.off('keydown-F', this.centerOnPlayer, this);
    this.input.off(Phaser.Input.Events.POINTER_DOWN, this.onPointerDown, this);
    this.input.off(Phaser.Input.Events.POINTER_MOVE, this.onPointerMove, this);
    this.input.off(Phaser.Input.Events.POINTER_UP, this.onPointerUp, this);
    this.input.off(Phaser.Input.Events.POINTER_WHEEL, this.onWheel, this);
    this.content?.clearMask(false);
    this.poiLayer?.clearMask(false);
    this.playerOverlayLayer?.clearMask(false);
    this.mapContentMask?.destroy();
    this.mapContentMask = null;
    this.mapMaskSource?.destroy();
    this.mapMaskSource = null;
  }
}
