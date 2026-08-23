param(
  [string]$Url = 'http://127.0.0.1:5173',
  [string]$Screenshot = 'traffic-browser-smoke.png',
  [ValidateRange(0, 300)]
  [int]$ObservationSeconds = 0,
  [switch]$OpenMap,
  [switch]$NoOverlay,
  [ValidateSet('', 'tehran', 'yazd', 'gilan')]
  [string]$City = '',
  [ValidateSet('', 'tehran-tower', 'tehran-government', 'tehran-stadium', 'yazd-mosque')]
  [string]$ArchitectureLandmark = '',
  [ValidateSet('', 'national-1-alborz', 'national-7-desert', 'national-22-caspian')]
  [string]$Highway = '',
  [ValidateSet('service', 'midpoint', 'from-transition', 'to-transition')]
  [string]$HighwayLocation = 'service',
  [ValidateRange(-1, 23)]
  [int]$Hour = -1,
  [ValidateRange(0.2, 2.0)]
  [double]$Zoom = 1.0,
  [ValidateRange(-256, 256)]
  [int]$CityOffsetTilesX = 0,
  [ValidateRange(-256, 256)]
  [int]$CityOffsetTilesY = 0
)

$ErrorActionPreference = 'Stop'
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path -LiteralPath $chrome)) { throw 'Google Chrome is not installed.' }

$debugPort = 9223
$profile = Join-Path $env:TEMP "pixel-city-traffic-smoke-$PID"
$process = $null

function Receive-Cdp([System.Net.WebSockets.ClientWebSocket]$socket) {
  $stream = [System.IO.MemoryStream]::new()
  try {
    do {
      $buffer = [byte[]]::new(1MB)
      $segment = [ArraySegment[byte]]::new($buffer)
      $result = $socket.ReceiveAsync($segment, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
      $stream.Write($buffer, 0, $result.Count)
    } while (-not $result.EndOfMessage)
    return [Text.Encoding]::UTF8.GetString($stream.ToArray()) | ConvertFrom-Json
  } finally {
    $stream.Dispose()
  }
}

$script:cdpId = 0
function Invoke-Cdp(
  [System.Net.WebSockets.ClientWebSocket]$socket,
  [string]$method,
  [hashtable]$params = @{}
) {
  $script:cdpId += 1
  $id = $script:cdpId
  $payload = @{ id = $id; method = $method; params = $params } | ConvertTo-Json -Depth 12 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
  $socket.SendAsync(
    [ArraySegment[byte]]::new($bytes),
    [Net.WebSockets.WebSocketMessageType]::Text,
    $true,
    [Threading.CancellationToken]::None
  ).GetAwaiter().GetResult() | Out-Null
  do { $message = Receive-Cdp $socket } while ($message.id -ne $id)
  if ($message.error) { throw "CDP $method failed: $($message.error.message)" }
  return $message.result
}

function Evaluate-Cdp(
  [System.Net.WebSockets.ClientWebSocket]$socket,
  [string]$expression
) {
  $response = Invoke-Cdp $socket 'Runtime.evaluate' @{
    expression = $expression
    returnByValue = $true
    awaitPromise = $true
  }
  return $response.result.value
}

try {
  New-Item -ItemType Directory -Path $profile | Out-Null
  $process = Start-Process -FilePath $chrome -ArgumentList @(
    '--headless=new',
    '--hide-scrollbars',
    "--remote-debugging-port=$debugPort",
    "--user-data-dir=$profile",
    '--window-size=1280,720',
    'about:blank'
  ) -WindowStyle Hidden -PassThru

  $targets = $null
  for ($attempt = 0; $attempt -lt 50 -and -not $targets; $attempt++) {
    Start-Sleep -Milliseconds 100
    try { $targets = Invoke-RestMethod "http://127.0.0.1:$debugPort/json" } catch { $targets = $null }
  }
  $target = $targets | Where-Object { $_.type -eq 'page' } | Select-Object -First 1
  if (-not $target) { throw 'Chrome DevTools target did not start.' }

  $socket = [System.Net.WebSockets.ClientWebSocket]::new()
  $socket.ConnectAsync(
    [Uri]$target.webSocketDebuggerUrl,
    [Threading.CancellationToken]::None
  ).GetAwaiter().GetResult() | Out-Null
  Invoke-Cdp $socket 'Page.enable' | Out-Null
  Invoke-Cdp $socket 'Runtime.enable' | Out-Null
  Invoke-Cdp $socket 'Emulation.setDeviceMetricsOverride' @{
    width = 1280
    height = 720
    deviceScaleFactor = 1
    mobile = $false
  } | Out-Null
  Invoke-Cdp $socket 'Page.addScriptToEvaluateOnNewDocument' @{
    source = @'
window.__smokeErrors = [];
window.addEventListener('error', event => window.__smokeErrors.push(String(event.error || event.message)));
window.addEventListener('unhandledrejection', event => window.__smokeErrors.push(String(event.reason)));
const originalError = console.error;
console.error = (...args) => { window.__smokeErrors.push(args.map(String).join(' ')); originalError(...args); };
'@
  } | Out-Null
  Invoke-Cdp $socket 'Page.navigate' @{ url = $Url } | Out-Null
  Start-Sleep -Seconds 1

  # World validation can occupy the main thread before Phaser activates the
  # menu. Wait for that exact scene instead of guessing a fixed boot delay,
  # then invoke the menu action exactly once. A coordinate click followed by a
  # direct call can start two worlds while the menu is stopping.
  $menuReady = $false
  for ($attempt = 0; $attempt -lt 180 -and -not $menuReady; $attempt++) {
    Start-Sleep -Milliseconds 500
    $menuReady = Evaluate-Cdp $socket @'
(() => window.game?.phaser?.scene?.getScenes(true)?.some(scene => scene.scene.key === 'MainMenuScene') ?? false)()
'@
  }
  if (-not $menuReady) { throw 'Main menu did not become ready after world validation.' }
  $newGameStartup = [Diagnostics.Stopwatch]::StartNew()
  Evaluate-Cdp $socket @'
(() => {
  const active = window.game?.phaser?.scene?.getScenes(true)?.map(scene => scene.scene.key) ?? [];
  if (active.includes('MainMenuScene')) {
    window.game.phaser.scene.getScene('MainMenuScene').onNewGame();
  }
  return true;
})()
'@ | Out-Null
  $newGameStartup.Stop()
  $newGameStartupMs = [Math]::Round($newGameStartup.Elapsed.TotalMilliseconds, 1)
  Write-Host "New Game startup: $newGameStartupMs ms"

  $snapshot = $null
  for ($attempt = 0; $attempt -lt 45; $attempt++) {
    Start-Sleep -Seconds 1
    $snapshot = Evaluate-Cdp $socket @'
(() => {
  const game = window.game;
  const scenes = game?.phaser?.scene?.getScenes(true)?.map(scene => scene.scene.key) ?? [];
  const managers = game?.registry?.managers ?? [];
  const traffic = managers.find(manager => manager.key === 'TrafficSystem');
  const world = managers.find(manager => manager.key === 'WorldManager');
  return {
    ready: scenes.includes('GameScene') && scenes.includes('UIScene') && Boolean(traffic),
    scenes,
    traffic: traffic ? {
      ...(traffic.trafficDebugSnapshot?.() ?? {}),
      generatedLaneDeadEnds: traffic.network?.lanes?.().filter(
        lane => lane.kind === 'travel' && (lane.connectionIds?.length ?? 0) === 0
      ).length ?? 0,
      generatedLaneDeadEndSamples: traffic.network?.lanes?.().filter(
        lane => lane.kind === 'travel' && (lane.connectionIds?.length ?? 0) === 0
      ).slice(0, 12).map(lane => ({
        id: lane.id,
        roadSegmentId: lane.roadSegmentId,
        laneIndex: lane.laneIndex,
        fromNodeId: lane.fromNodeId,
        toNodeId: lane.toNodeId,
        policy: world?.map?.roadEdges?.find(edge =>
          (edge.fromNodeId === lane.fromNodeId && edge.toNodeId === lane.toNodeId) ||
          (edge.fromNodeId === lane.toNodeId && edge.toNodeId === lane.fromNodeId)
        ) ?? null
      })) ?? []
    } : null,
    world: world ? {
      dimensions: [world.map.widthTiles, world.map.heightTiles],
      cities: world.map.cities.map(city => city.id),
      highways: world.map.highways.map(highway => highway.id),
      highwayPlan: {
        quality: world.map.highwayQuality ?? null,
        routes: world.map.highways.map(highway => ({
          id: highway.id,
          templates: highway.interchanges?.map(interchange => interchange.kind) ?? [],
          carriageways: highway.carriageways?.length ?? 0,
          interchanges: highway.interchanges?.length ?? 0,
          serviceAreas: highway.serviceAreas?.length ?? 0,
          structures: highway.structures?.length ?? 0,
          furniture: highway.furniture?.length ?? 0,
          scenery: highway.scenery?.length ?? 0
        }))
      },
      urbanPlan: {
        roads: world.map.urbanPlan?.roads?.length ?? 0,
        blocks: world.map.urbanPlan?.blocks?.length ?? 0,
        buildings: world.map.urbanPlan?.buildings?.length ?? 0,
        spaces: world.map.urbanPlan?.spaces?.length ?? 0,
        blockPrograms: (world.map.urbanPlan?.blocks ?? []).reduce((counts, block) => {
          counts[block.program] = (counts[block.program] ?? 0) + 1;
          return counts;
        }, {}),
        architecture: (() => {
          const buildings = world.map.urbanPlan?.buildings ?? [];
          const spaces = world.map.urbanPlan?.spaces ?? [];
          const countBy = field => buildings.reduce((counts, building) => {
            const value = building?.[field] ?? 'missing';
            counts[value] = (counts[value] ?? 0) + 1;
            return counts;
          }, {});
          const roofAssets = buildings.reduce(
            (count, building) => count + (building.roofAssets?.length ?? 0),
            0
          );
          const entrances = buildings.reduce(
            (count, building) => count + (building.entrances?.length ?? 0),
            0
          );
          const groundFeatures = spaces.flatMap(space => space.features ?? []);
          return {
            shapes: countBy('shape'),
            sizes: countBy('size'),
            kinds: countBy('kind'),
            programs: countBy('program'),
            roofAssets,
            entrances,
            groundFeatures: groundFeatures.length,
            multiTileGroundFeatures: groundFeatures.filter(
              feature => (feature.bounds?.width ?? 0) > 1 || (feature.bounds?.height ?? 0) > 1
            ).length,
            exactSpaces: spaces.every(space =>
              (space.footprint?.length ?? 0) > 0 &&
              (space.footprint ?? []).every(part => part.width > 0 && part.height > 0)
            ),
            fullyPlanned: buildings.every(building =>
              Boolean(building.shape) &&
              Boolean(building.size) &&
              Boolean(building.kind) &&
              (building.entrances?.length ?? 0) > 0 &&
              (building.roofAssets?.length ?? 0) > 0
            )
          };
        })(),
        quality: world.map.urbanPlan?.quality ?? null
      },
      validation: world.map.validation,
      loadedChunks: world.loadedChunkCount,
      loadedRegions: world.loadedRegionCounts
    } : null,
    errors: window.__smokeErrors ?? [],
    fps: game?.phaser?.loop?.actualFps ?? 0,
    canvas: (() => { const c = document.querySelector('canvas'); return c ? { width: c.width, height: c.height, clientWidth: c.clientWidth, clientHeight: c.clientHeight } : null; })()
  };
})()
'@
    if (
      $snapshot.ready -and
      $snapshot.traffic.stats.activeDrivers -ge 12 -and
      $snapshot.traffic.validation.checkedVehicles -gt 0
    ) { break }
    $fatalErrors = @($snapshot.errors | Where-Object { $_ -notlike '*pointer lock*' })
    if ($fatalErrors.Count -gt 0) { break }
  }

  if ($ObservationSeconds -gt 0) {
    Start-Sleep -Seconds $ObservationSeconds
    $snapshot = Evaluate-Cdp $socket @'
(() => {
  const game = window.game;
  const managers = game?.registry?.managers ?? [];
  const traffic = managers.find(manager => manager.key === 'TrafficSystem');
  return {
    ready: Boolean(traffic),
    traffic: traffic ? {
      ...(traffic.trafficDebugSnapshot?.() ?? {}),
      generatedLaneDeadEnds: traffic.network?.lanes?.().filter(
        lane => lane.kind === 'travel' && (lane.connectionIds?.length ?? 0) === 0
      ).length ?? 0,
      generatedLaneDeadEndSamples: traffic.network?.lanes?.().filter(
        lane => lane.kind === 'travel' && (lane.connectionIds?.length ?? 0) === 0
      ).slice(0, 12).map(lane => ({ id: lane.id, roadSegmentId: lane.roadSegmentId, laneIndex: lane.laneIndex })) ?? []
    } : null,
    errors: window.__smokeErrors ?? [],
    fps: game?.phaser?.loop?.actualFps ?? 0
  };
})()
'@
  }

  # Prove cutaway-roof ownership before moving to the requested capture destination.
  # The closest distinct-building interior pair should fit in the same streamed
  # neighborhood; the standard world seed must keep the neighbor roof closed.
  $roofProbe = Evaluate-Cdp $socket @'
(async () => {
  const managers = window.game?.registry?.managers ?? [];
  const world = managers.find(manager => manager.key === 'WorldManager');
  const player = managers.find(manager => manager.key === 'PlayerController');
  const scene = window.game?.phaser?.scene?.getScene?.('GameScene');
  const sprite = player?.player?.sprite;
  const camera = scene?.cameras?.main;
  const centerOf = interior => ({
    x: interior.bounds.x + interior.bounds.w * 0.5,
    y: interior.bounds.y + interior.bounds.h * 0.5
  });
  const interiors = [...(world?.map?.buildingInteriors ?? [])]
    .filter(interior =>
      Boolean(interior?.id) &&
      Boolean(interior?.buildingId) &&
      Number.isFinite(interior?.bounds?.x) &&
      Number.isFinite(interior?.bounds?.y) &&
      interior?.bounds?.w > 0 &&
      interior?.bounds?.h > 0
    )
    .sort((first, second) => first.id.localeCompare(second.id));

  let closestPair = null;
  for (let firstIndex = 0; firstIndex < interiors.length; firstIndex++) {
    for (let secondIndex = firstIndex + 1; secondIndex < interiors.length; secondIndex++) {
      const first = interiors[firstIndex];
      const second = interiors[secondIndex];
      if (first.buildingId === second.buildingId) continue;
      const firstCenter = centerOf(first);
      const secondCenter = centerOf(second);
      const distanceSq =
        (firstCenter.x - secondCenter.x) ** 2 +
        (firstCenter.y - secondCenter.y) ** 2;
      if (!closestPair || distanceSq < closestPair.distanceSq) {
        closestPair = { first, second, firstCenter, secondCenter, distanceSq };
      }
    }
  }

  const first = closestPair?.first ?? interiors[0] ?? null;
  const second = closestPair?.second ?? null;
  const firstCenter = first ? centerOf(first) : null;
  const secondCenter = second ? centerOf(second) : null;
  const midpoint = firstCenter
    ? secondCenter
      ? {
          x: (firstCenter.x + secondCenter.x) * 0.5,
          y: (firstCenter.y + secondCenter.y) * 0.5
        }
      : { ...firstCenter }
    : null;
  const describeInterior = (interior, center) => interior ? {
    id: interior.id,
    buildingId: interior.buildingId,
    kind: interior.kind,
    center
  } : null;

  if (!world || !sprite || !camera || !first || !midpoint) {
    return {
      passed: false,
      error: 'Cutaway probe prerequisites were unavailable.',
      interiorCount: interiors.length,
      selected: {
        first: describeInterior(first, firstCenter),
        second: describeInterior(second, secondCenter)
      },
      neighborCoverage: false
    };
  }

  const original = {
    player: { x: sprite.x, y: sprite.y },
    camera: { scrollX: camera.scrollX, scrollY: camera.scrollY }
  };
  const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const roofState = interior => {
    if (!interior) return null;
    const handle = world.enterableRoofs?.get?.(interior.id) ?? null;
    return {
      id: interior.id,
      buildingId: interior.buildingId,
      registered: Boolean(handle),
      chunkKey: handle?.chunkKey ?? null,
      active: handle?.roof?.active ?? null,
      visible: handle?.roof?.visible ?? null
    };
  };
  let result = null;

  try {
    world.setInteriorRoofOpen?.(null);
    sprite.setPosition(midpoint.x, midpoint.y);
    sprite.body?.reset?.(midpoint.x, midpoint.y);
    camera.centerOn(midpoint.x, midpoint.y);

    const waitStartedAt = performance.now();
    const deadline = waitStartedAt + 8000;
    while (performance.now() < deadline) {
      const firstLoaded = Boolean(world.enterableRoofs?.get?.(first.id));
      const secondLoaded = !second || Boolean(world.enterableRoofs?.get?.(second.id));
      if (firstLoaded && secondLoaded) break;
      await pause(100);
    }
    world.updateChunkVisibility?.(true);

    const firstHandle = world.enterableRoofs?.get?.(first.id) ?? null;
    const secondHandle = second ? world.enterableRoofs?.get?.(second.id) ?? null : null;
    const distinctRoofHandles = Boolean(
      firstHandle && secondHandle && firstHandle.roof !== secondHandle.roof
    );
    const closed = { first: roofState(first), second: roofState(second) };

    world.setInteriorRoofOpen?.(first.id);
    const open = { first: roofState(first), second: roofState(second) };

    world.setInteriorRoofOpen?.(null);
    const restored = { first: roofState(first), second: roofState(second) };

    const singleRoofCyclePassed = Boolean(
      closed.first?.registered &&
      closed.first?.visible === true &&
      open.first?.visible === false &&
      restored.first?.visible === true
    );
    const neighborCoverage = Boolean(
      distinctRoofHandles &&
      closed.second?.registered &&
      closed.second?.visible === true &&
      open.second?.visible === true &&
      restored.second?.visible === true
    );
    result = {
      passed: singleRoofCyclePassed && neighborCoverage,
      error: null,
      interiorCount: interiors.length,
      selected: {
        first: describeInterior(first, firstCenter),
        second: describeInterior(second, secondCenter),
        distance: closestPair ? Math.sqrt(closestPair.distanceSq) : null,
        midpoint
      },
      waitedMs: Math.round(performance.now() - waitStartedAt),
      registeredRoofs: [...(world.enterableRoofs?.entries?.() ?? [])]
        .map(([id, handle]) => ({
          id,
          chunkKey: handle.chunkKey,
          visible: handle.roof?.visible ?? null
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      distinctRoofHandles,
      singleRoofCyclePassed,
      neighborCoverage,
      closed,
      open,
      restored
    };
  } catch (error) {
    result = {
      passed: false,
      error: String(error),
      interiorCount: interiors.length,
      selected: {
        first: describeInterior(first, firstCenter),
        second: describeInterior(second, secondCenter),
        midpoint
      },
      neighborCoverage: false
    };
  } finally {
    world.setInteriorRoofOpen?.(null);
    sprite.setPosition(original.player.x, original.player.y);
    sprite.body?.reset?.(original.player.x, original.player.y);
    camera.setScroll(original.camera.scrollX, original.camera.scrollY);
    result ??= { passed: false, error: 'Cutaway probe did not produce a result.' };
    result.restoration = {
      playerRestored:
        Math.abs(sprite.x - original.player.x) < 0.01 &&
        Math.abs(sprite.y - original.player.y) < 0.01,
      cameraRestored:
        Math.abs(camera.scrollX - original.camera.scrollX) < 0.01 &&
        Math.abs(camera.scrollY - original.camera.scrollY) < 0.01
    };
  }

  return result;
})()
'@
  Add-Member -InputObject $snapshot -NotePropertyName cutawayRoofOwnership -NotePropertyValue $roofProbe -Force
  Add-Member -InputObject $snapshot -NotePropertyName newGameStartupMs -NotePropertyValue $newGameStartupMs -Force

  if ($City) {
    Evaluate-Cdp $socket @"
(() => {
  const managers = window.game?.registry?.managers ?? [];
  const world = managers.find(manager => manager.key === 'WorldManager');
  const player = managers.find(manager => manager.key === 'PlayerController');
  const center = world?.map?.cities?.find(city => city.id === '$City')?.center;
  const destination = center ? {
    x: center.x + $CityOffsetTilesX * 32,
    y: center.y + $CityOffsetTilesY * 32
  } : null;
  const sprite = player?.player?.sprite;
  if (!destination || !sprite) return false;
  sprite.setPosition(destination.x, destination.y);
  sprite.body?.reset(destination.x, destination.y);
  return true;
})()
"@ | Out-Null
    Start-Sleep -Seconds 4
  }
  if ($Highway) {
    Evaluate-Cdp $socket @"
(() => {
  const managers = window.game?.registry?.managers ?? [];
  const world = managers.find(manager => manager.key === 'WorldManager');
  const player = managers.find(manager => manager.key === 'PlayerController');
  const route = world?.map?.highways?.find(highway => highway.id === '$Highway');
  const location = '$HighwayLocation';
  const fromTransition = route?.interchanges?.[0];
  const toTransition = route?.interchanges?.[route?.interchanges?.length - 1];
  const transitionCenter = interchange => interchange
    ? {
        x: (interchange.position.x + interchange.gateZone.center.x) * 0.5,
        y: (interchange.position.y + interchange.gateZone.center.y) * 0.5
      }
    : null;
  const destination = location === 'midpoint'
    ? route?.points?.[Math.floor((route?.points?.length ?? 1) / 2)]
    : location === 'from-transition'
      ? transitionCenter(fromTransition)
      : location === 'to-transition'
        ? transitionCenter(toTransition)
        : route?.serviceAreas?.[0]?.position ?? route?.points?.[Math.floor((route?.points?.length ?? 1) / 2)];
  const sprite = player?.player?.sprite;
  if (!destination || !sprite) return false;
  sprite.setPosition(destination.x, destination.y);
  sprite.body?.reset(destination.x, destination.y);
  return true;
})()
"@ | Out-Null
    Start-Sleep -Seconds 5
  }
  if ($ArchitectureLandmark) {
    $landmarkCapture = Evaluate-Cdp $socket @"
(() => {
  const managers = window.game?.registry?.managers ?? [];
  const world = managers.find(manager => manager.key === 'WorldManager');
  const player = managers.find(manager => manager.key === 'PlayerController');
  const scene = window.game?.phaser?.scene?.getScene?.('GameScene');
  const selectors = {
    'tehran-tower': { cityId: 'tehran', kind: 'tower', reservationId: 'tehran-financial' },
    'tehran-government': {
      cityId: 'tehran',
      kind: 'government',
      reservationId: 'tehran-government'
    },
    'tehran-stadium': { cityId: 'tehran', kind: 'stadium', reservationId: 'tehran-stadium' },
    'yazd-mosque': { cityId: 'yazd', kind: 'mosque', reservationId: 'yazd-mosque' }
  };
  const selector = selectors['$ArchitectureLandmark'];
  const reservedBlock = (world?.map?.urbanPlan?.blocks ?? []).find(block =>
    block.cityId === selector?.cityId &&
    block.signature?.includes('reserved-' + selector?.reservationId)
  );
  const building = (world?.map?.urbanPlan?.buildings ?? []).find(candidate =>
    candidate.landmark &&
    candidate.cityId === selector?.cityId &&
    candidate.kind === selector?.kind &&
    candidate.blockId === reservedBlock?.id
  );
  const sprite = player?.player?.sprite;
  const camera = scene?.cameras?.main;
  if (!selector || !building || !sprite || !camera) {
    return {
      found: false,
      key: '$ArchitectureLandmark',
      selector,
      error: !selector
        ? 'Unknown architecture-landmark selector.'
        : !reservedBlock
          ? 'The reserved architecture-landmark block was not found.'
          : !building
            ? 'The exact planned landmark building was not found inside its reserved block.'
          : 'Player or camera was unavailable.'
    };
  }

  const tileSize = world.map.tileSize ?? 32;
  const entrance = building.entrances?.find(candidate => candidate.primary) ?? building.entrances?.[0];
  const playerTile = entrance?.apron ?? {
    x: building.bounds.x + Math.floor(building.bounds.width / 2),
    y: building.bounds.y + building.bounds.height
  };
  const destination = {
    x: (playerTile.x + 0.5) * tileSize,
    y: (playerTile.y + 0.5) * tileSize
  };
  const center = {
    x: (building.bounds.x + building.bounds.width * 0.5) * tileSize,
    y: (building.bounds.y + building.bounds.height * 0.5) * tileSize
  };

  sprite.setPosition(destination.x, destination.y);
  sprite.body?.reset?.(destination.x, destination.y);
  camera.stopFollow?.();
  camera.centerOn(center.x, center.y);
  world.updateChunkVisibility?.(true);

  return {
    found: true,
    key: '$ArchitectureLandmark',
    id: building.id,
    blockId: building.blockId,
    reservationId: selector.reservationId,
    reservedBlock: {
      id: reservedBlock.id,
      bounds: reservedBlock.bounds,
      footprint: reservedBlock.footprint,
      program: reservedBlock.program,
      signature: reservedBlock.signature
    },
    cityId: building.cityId,
    kind: building.kind,
    shape: building.shape,
    size: building.size,
    floors: building.floors,
    material: building.material,
    bounds: building.bounds,
    footprint: building.footprint,
    entrances: building.entrances,
    roofAssets: building.roofAssets,
    destination,
    center
  };
})()
"@
    Add-Member -InputObject $snapshot -NotePropertyName architectureLandmarkCapture -NotePropertyValue $landmarkCapture -Force
    if (-not $landmarkCapture.found) {
      throw "Architecture landmark capture failed: $($landmarkCapture.error)"
    }
    Start-Sleep -Seconds 5
    Evaluate-Cdp $socket @"
(() => {
  const scene = window.game?.phaser?.scene?.getScene?.('GameScene');
  const camera = scene?.cameras?.main;
  if (!camera) return false;
  camera.stopFollow?.();
  camera.centerOn($($landmarkCapture.center.x), $($landmarkCapture.center.y));
  return true;
})()
"@ | Out-Null
  }
  if ($Hour -ge 0) {
    Evaluate-Cdp $socket @"
(() => {
  const managers = window.game?.registry?.managers ?? [];
  const clock = managers.find(manager => manager.key === 'DayNightSystem');
  clock?.setTime?.($Hour, 0);
  return Boolean(clock);
})()
"@ | Out-Null
    Start-Sleep -Seconds 2
  }
  Evaluate-Cdp $socket @"
(() => {
  const scene = window.game?.phaser?.scene?.getScene?.('GameScene');
  scene?.cameras?.main?.setZoom?.($Zoom);
  return scene?.cameras?.main?.zoom ?? null;
})()
"@ | Out-Null
  Start-Sleep -Seconds 2

  if ($OpenMap) {
    Invoke-Cdp $socket 'Input.dispatchKeyEvent' @{ type = 'keyDown'; key = 'm'; code = 'KeyM'; windowsVirtualKeyCode = 77 } | Out-Null
    Invoke-Cdp $socket 'Input.dispatchKeyEvent' @{ type = 'keyUp'; key = 'm'; code = 'KeyM'; windowsVirtualKeyCode = 77 } | Out-Null
  } elseif (-not $NoOverlay) {
    Invoke-Cdp $socket 'Input.dispatchKeyEvent' @{ type = 'keyDown'; key = 'F7'; code = 'F7'; windowsVirtualKeyCode = 118 } | Out-Null
    Invoke-Cdp $socket 'Input.dispatchKeyEvent' @{ type = 'keyUp'; key = 'F7'; code = 'F7'; windowsVirtualKeyCode = 118 } | Out-Null
  }
  Start-Sleep -Seconds 3
  $captureRuntime = Evaluate-Cdp $socket @'
(() => {
  const game = window.game;
  const managers = game?.registry?.managers ?? [];
  const world = managers.find(manager => manager.key === 'WorldManager');
  const traffic = managers.find(manager => manager.key === 'TrafficSystem');
  return {
    fps: game?.phaser?.loop?.actualFps ?? 0,
    loadedChunks: world?.loadedChunkCount ?? 0,
    loadedRegions: world?.loadedRegionCounts ?? null,
    traffic: traffic?.trafficDebugSnapshot?.() ?? null
  };
})()
'@
  Add-Member -InputObject $snapshot -NotePropertyName captureRuntime -NotePropertyValue $captureRuntime -Force
  $screenshotResult = Invoke-Cdp $socket 'Page.captureScreenshot' @{ format = 'png'; fromSurface = $true }
  [IO.File]::WriteAllBytes((Join-Path (Get-Location) $Screenshot), [Convert]::FromBase64String($screenshotResult.data))
  $socket.Dispose()

  $snapshot | ConvertTo-Json -Depth 12
  if (-not $snapshot.ready) { throw 'Game scene did not become ready.' }
  if ([double]$snapshot.newGameStartupMs -gt 10000) {
    throw "New Game blocked the browser for $($snapshot.newGameStartupMs) ms."
  }
  if ($null -eq $snapshot.world -or [int]$snapshot.world.loadedChunks -lt 1) {
    throw 'Game scene became ready without a player-start terrain chunk.'
  }
  $roofProbe = $snapshot.cutawayRoofOwnership
  if ($null -eq $roofProbe) { throw 'Cutaway-roof ownership probe did not produce a snapshot.' }
  if ($roofProbe.error) { throw "Cutaway-roof ownership probe failed: $($roofProbe.error)" }
  if (-not $roofProbe.restoration.playerRestored -or -not $roofProbe.restoration.cameraRestored) {
    throw 'Cutaway-roof ownership probe did not restore the temporary player/camera position.'
  }
  if (-not $roofProbe.closed.first.registered -or $roofProbe.closed.first.visible -ne $true) {
    throw 'Primary enterable roof was not registered and visible while closed.'
  }
  if ($roofProbe.open.first.visible -ne $false) {
    throw 'Opening an interior did not hide its owning roof.'
  }
  if ($roofProbe.restored.first.visible -ne $true) {
    throw 'Closing an interior did not restore its owning roof.'
  }
  if (-not $roofProbe.singleRoofCyclePassed) {
    throw 'Primary enterable roof failed its closed/open/closed visibility cycle.'
  }
  if (-not $roofProbe.neighborCoverage) {
    throw 'Standard seed did not prove two-roof cutaway ownership isolation.'
  }
  if (-not $roofProbe.passed) { throw 'Cutaway-roof ownership validation did not pass.' }
  $unexpectedErrors = @($snapshot.errors | Where-Object { $_ -notlike '*pointer lock*' })
  if ($unexpectedErrors.Count -gt 0) { throw "Browser errors: $($unexpectedErrors -join '; ')" }
  if (-not $snapshot.traffic.validation.passed) { throw 'Runtime traffic validator reported failures.' }
  if ($snapshot.traffic.generatedLaneDeadEnds -gt 0) { throw 'Generated traffic network contains travel lanes with no legal exit.' }
  if ($snapshot.traffic.stats.activeDrivers -lt 1) { throw 'No active traffic drivers spawned.' }
  $urbanQuality = $snapshot.world.urbanPlan.quality
  if (-not $urbanQuality.passed) { throw 'Urban quality validation did not pass.' }
  $emptyFailures = @(
    $urbanQuality.oversizedEmptyBlocks,
    $urbanQuality.excessiveEmptyTerrainBlocks,
    $urbanQuality.unprogrammedOpenSpaces,
    $urbanQuality.streetsLeadingToEmptyLand
  ) | Measure-Object -Sum
  if ($emptyFailures.Sum -gt 0) { throw 'Generated world contains rejected empty-land conditions.' }
  if ($urbanQuality.meaninglessDeadEnds -gt 0) { throw 'Generated world contains meaningless road endings.' }
  if ($urbanQuality.repetitiveDistricts -gt 0) { throw 'Generated world contains repetitive districts.' }
  if ($urbanQuality.landmarkCoverageViolations -gt 0) { throw 'Generated world contains landmark coverage gaps.' }
  if ($urbanQuality.urbanizedBlockRatio -lt 0.96) { throw 'Generated world is below the urbanized-block target.' }
  $ownershipFailures = @(
    $urbanQuality.unownedBuildingTiles,
    $urbanQuality.footprintMismatches,
    $urbanQuality.inaccessibleEntrances,
    $urbanQuality.missingSiteContent,
    $urbanQuality.cityStyleViolations
  ) | Measure-Object -Sum
  if ($ownershipFailures.Sum -gt 0) { throw 'Generated architecture ownership or access audit failed.' }
  $architecture = $snapshot.world.urbanPlan.architecture
  if (-not $architecture.fullyPlanned) { throw 'A generated building is missing rich architecture metadata.' }
  if ($snapshot.world.urbanPlan.spaces -lt $snapshot.world.urbanPlan.blocks) {
    throw 'One or more city blocks have no planned public realm.'
  }
  if (-not $architecture.exactSpaces) {
    throw 'A planned public realm is missing its exact positive footprint.'
  }
  if ($architecture.multiTileGroundFeatures -lt 1) {
    throw 'Generated public realm contains no meaningful multi-tile features.'
  }
  if (($architecture.shapes.PSObject.Properties | Measure-Object).Count -lt 8) {
    throw 'Generated footprint grammar does not expose enough shape variety.'
  }
  if (($architecture.sizes.PSObject.Properties | Measure-Object).Count -lt 4) {
    throw 'Generated buildings do not cover all size categories.'
  }
  if (($architecture.kinds.PSObject.Properties | Measure-Object).Count -lt 12) {
    throw 'Generated architecture does not expose enough semantic building kinds.'
  }
  foreach ($requiredKind in @('tower', 'mosque', 'government', 'stadium')) {
    $kindProperty = $architecture.kinds.PSObject.Properties[$requiredKind]
    if ($null -eq $kindProperty -or [int]$kindProperty.Value -le 0) {
      throw "Generated runtime architecture is missing required '$requiredKind' building kind."
    }
  }
  if ($architecture.roofAssets -lt $snapshot.world.urbanPlan.buildings) {
    throw 'Generated roofs are missing authored equipment/detail plans.'
  }
  if ($architecture.entrances -lt $snapshot.world.urbanPlan.buildings) {
    throw 'Generated buildings are missing authored entrances.'
  }
  $highwayQuality = $snapshot.world.highwayPlan.quality
  if (-not $highwayQuality.passed) { throw 'Highway quality validation did not pass.' }
  $highwayFailures = @(
    $highwayQuality.jaggedEdgeViolations,
    $highwayQuality.brokenGuardRails,
    $highwayQuality.medianDiscontinuities,
    $highwayQuality.opposingPavementOverlaps,
    $highwayQuality.brokenLaneMarkings,
    $highwayQuality.unexpectedLaneWidthChanges,
    $highwayQuality.highwayDeadEnds,
    $highwayQuality.invalidRamps,
    $highwayQuality.serviceSpacingViolations,
    $highwayQuality.rampCurvatureViolations,
    $highwayQuality.overlappingMarkings,
    $highwayQuality.shortMergeLanes,
    $highwayQuality.directLocalConnections,
    $highwayQuality.oversizedGores,
    $highwayQuality.roadEdgeIntersections,
    $highwayQuality.missingHierarchyLinks,
    $highwayQuality.missingCityGateZones
  ) | Measure-Object -Sum
  if ($highwayFailures.Sum -gt 0) { throw 'Generated highway system contains rejected geometry or topology.' }
} finally {
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force }
  $resolvedProfile = [IO.Path]::GetFullPath($profile)
  $resolvedTemp = [IO.Path]::GetFullPath($env:TEMP)
  if ($resolvedProfile.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedProfile)) {
    Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$resolvedProfile*" } | ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 500
    for ($attempt = 0; $attempt -lt 5 -and (Test-Path -LiteralPath $resolvedProfile); $attempt++) {
      Remove-Item -LiteralPath $resolvedProfile -Recurse -Force -ErrorAction SilentlyContinue
      if (Test-Path -LiteralPath $resolvedProfile) { Start-Sleep -Milliseconds 300 }
    }
  }
}
