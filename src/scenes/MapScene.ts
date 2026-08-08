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
import { TileType, type MapData, type WorldCity, type WorldLandmark } from '@/gameplay/types';
import type { Vector2 } from '@/core/types';
import { Button, Panel } from '@/ui/components';
import type { GameManager } from '@/managers/GameManager';
import type { PlayerController } from '@/systems/PlayerController';
import type { WorldManager } from '@/systems/WorldManager';
import type { MissionSystem } from '@/systems/MissionSystem';
import type { MobilePlatform } from '@/platform';
import { getObjectiveTarget, getWaypoint, setWaypoint } from '@/gameplay/WorldMapState';

interface MapRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LegendItem {
  label: string;
  color: number;
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
const PANEL_HEIGHT = 542;
const TOP_BAR_HEIGHT = 46;
const MIN_ZOOM = 1;
const MAX_ZOOM = 7;
const ZOOM_STEP = 1.32;
const CLICK_DRAG_THRESHOLD = 6;
const PLAYER_COLOR = 0x7dd3fc;
const WAYPOINT_COLOR = 0x22d3ee;
const OBJECTIVE_COLOR = COLORS.ACCENT;

export class MapScene extends Phaser.Scene {
  private mobile = false;
  private viewportWidth = GAME_WIDTH;
  private viewportHeight = GAME_HEIGHT;
  private viewRect: MapRect = { ...VIEW };
  private mapData: MapData | null = null;
  private content: Phaser.GameObjects.Container | null = null;
  private tileLayer: Phaser.GameObjects.Graphics | null = null;
  private cityLayer: Phaser.GameObjects.Graphics | null = null;
  private routeLayer: Phaser.GameObjects.Graphics | null = null;
  private staticMarkerLayer: Phaser.GameObjects.Graphics | null = null;
  private dynamicMarkerLayer: Phaser.GameObjects.Graphics | null = null;
  private statusText: Phaser.GameObjects.Text | null = null;
  private cityStatusText: Phaser.GameObjects.Text | null = null;
  private readonly cityLabels: Phaser.GameObjects.Text[] = [];
  private uiZones: Phaser.Geom.Rectangle[] = [];

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
    this.fitWholeCity();
    this.drawCityAreas();
    this.bindInput();
    this.refreshMarkers();

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.onShutdown, this);
  }

  public override update(): void {
    this.refreshMarkers();
  }

  private buildChrome(): void {
    const topBarHeight = this.mobile ? 94 : TOP_BAR_HEIGHT;
    this.add.rectangle(0, 0, this.viewportWidth, this.viewportHeight, 0x06070d, 0.98).setOrigin(0);
    this.add.rectangle(0, 0, this.viewportWidth, topBarHeight, 0x0f111a, 0.96).setOrigin(0);

    this.add.text(24, 13, 'WORLD MAP', {
      fontFamily: 'Courier New',
      fontSize: '22px',
      fontStyle: 'bold',
      color: this.hex(COLORS.ACCENT),
    });

    this.add
      .rectangle(this.viewRect.x, this.viewRect.y, this.viewRect.width, this.viewRect.height, 0x0a0d14, 1)
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

    this.statusText = this.add.text(PANEL_X + 16, PANEL_Y + PANEL_HEIGHT - 38, '', {
      fontFamily: 'Courier New',
      fontSize: '14px',
      color: this.hex(0x9aa0a6),
      wordWrap: { width: PANEL_WIDTH - 32 },
    });
    this.cityStatusText = this.add.text(PANEL_X + 16, PANEL_Y + 332, 'CURRENT: TEHRAN', {
      fontFamily: 'Courier New',
      fontSize: '13px',
      fontStyle: 'bold',
      color: this.hex(COLORS.ACCENT),
      wordWrap: { width: PANEL_WIDTH - 32 },
    });
  }

  private buildLegend(): void {
    this.add.text(PANEL_X + 16, PANEL_Y + 18, 'LEGEND', {
      fontFamily: 'Courier New',
      fontSize: '16px',
      fontStyle: 'bold',
      color: this.hex(COLORS.TEXT),
    });

    const items: LegendItem[] = [
      { label: 'Player', color: PLAYER_COLOR },
      { label: 'Mission', color: OBJECTIVE_COLOR },
      { label: 'Waypoint', color: WAYPOINT_COLOR },
      { label: 'City Area', color: 0xf59e0b },
      { label: 'Highway Route', color: 0xf8d36e },
      { label: 'Airport', color: 0x94a3b8 },
      { label: 'Hospital', color: COLORS.HEALTH },
      { label: 'Police', color: 0x3a6cff },
      { label: 'Services / Shops', color: 0x8b5cf6 },
      { label: 'Nature / View', color: 0x4cbf87 },
    ];

    items.forEach((item, index) => {
      const y = PANEL_Y + 58 + index * 25;
      this.add.circle(PANEL_X + 26, y + 7, 5, item.color, 1).setStrokeStyle(2, 0xffffff, 0.75);
      this.add.text(PANEL_X + 42, y, item.label, {
        fontFamily: 'Courier New',
        fontSize: '12px',
        color: this.hex(COLORS.TEXT),
      });
    });
  }

  private buildButtons(): void {
    const right = this.viewportWidth - 24;
    const y = this.mobile ? 47 : 23;
    const height = this.mobile ? 76 : 32;
    const close = new Button(this, this.mobile ? right - 70 : this.viewportWidth - 78, y, {
      text: 'Close',
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
    const clear = new Button(this, PANEL_X + PANEL_WIDTH / 2, PANEL_Y + (this.mobile ? 424 : 368), {
      text: 'Clear Waypoint',
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
  }

  private buildMap(map: MapData): void {
    this.content = this.add.container(0, 0);
    this.tileLayer = this.add.graphics();
    this.cityLayer = this.add.graphics();
    this.routeLayer = this.add.graphics();
    this.staticMarkerLayer = this.add.graphics();
    this.dynamicMarkerLayer = this.add.graphics();
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
      this.drawMarker(
        g,
        landmark.position,
        this.colorForLandmark(landmark),
        3.2 / this.zoom,
        landmark.kind === 'airport' || landmark.kind === 'bridge' ? 'diamond' : 'circle',
      );
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

    const waypoint = getWaypoint();
    if (waypoint) {
      this.drawMarker(g, waypoint, WAYPOINT_COLOR, 4 / this.zoom, 'diamond');
    }

    const player = ServiceLocator.tryResolve<PlayerController>(ServiceKeys.Player)?.playerPosition;
    if (player) {
      this.drawMarker(g, player, PLAYER_COLOR, 4.2 / this.zoom, 'player');
    }
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
    if (!start || !target) return;
    const points = this.routePreviewPoints(start, target);
    if (points.length < 2) return;
    const first = points[0];
    if (!first) return;
    g.lineStyle(2.2 / this.zoom, 0xf8d36e, 0.88);
    g.beginPath();
    g.moveTo(first.x / TILE_SIZE, first.y / TILE_SIZE);
    for (let index = 1; index < points.length; index++) {
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

  private fitWholeCity(): void {
    const map = this.mapData;
    if (!map) return;
    this.baseScale = Math.min(this.viewRect.width / map.widthTiles, this.viewRect.height / map.heightTiles);
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
    this.dragging = true;
    this.dragMoved = false;
    this.dragPointerId = pointer.id;
    this.dragStartX = pointer.x;
    this.dragStartY = pointer.y;
    this.dragOffsetX = this.offsetX;
    this.dragOffsetY = this.offsetY;
  }

  private onPointerMove(pointer: Phaser.Input.Pointer): void {
    if (!this.dragging || pointer.id !== this.dragPointerId) {
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
      this.placeWaypoint(pointer.x, pointer.y);
    }
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
    setWaypoint(worldPoint);
    this.showStatus('Waypoint set');
    this.refreshMarkers();
  }

  private clearWaypoint(): void {
    setWaypoint(null);
    this.showStatus('Waypoint cleared');
    this.refreshMarkers();
  }

  private currentMissionMarker(): Vector2 | null {
    const objective = getObjectiveTarget();
    if (objective) {
      return objective;
    }
    return ServiceLocator.tryResolve<MissionSystem>(ServiceKeys.Mission)?.currentMapMarker ?? null;
  }

  private closeMap(): void {
    ServiceLocator.tryResolve<GameManager>(ServiceKeys.Game)?.resumeGame();
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
  }

  private constrainView(): void {
    const map = this.mapData;
    if (!map) return;
    const width = map.widthTiles * this.scalePerTile();
    const height = map.heightTiles * this.scalePerTile();

    this.offsetX = this.clampOffset(this.offsetX, this.viewRect.x, this.viewRect.x + this.viewRect.width, width);
    this.offsetY = this.clampOffset(this.offsetY, this.viewRect.y, this.viewRect.y + this.viewRect.height, height);
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
    return x >= this.viewRect.x && y >= this.viewRect.y && x <= this.viewRect.x + this.viewRect.width && y <= this.viewRect.y + this.viewRect.height;
  }

  private isUiPoint(x: number, y: number): boolean {
    return this.uiZones.some((zone) => zone.contains(x, y));
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
  }
}
