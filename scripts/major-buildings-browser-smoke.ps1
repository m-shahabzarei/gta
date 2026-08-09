param(
  [string]$Url = 'http://127.0.0.1:5173',
  [string]$OutputDirectory = 'major-buildings-audit',
  [ValidateRange(15, 45)]
  [int]$PopulationSettleSeconds = 25,
  [ValidateRange(5, 30)]
  [int]$SettledSampleSeconds = 10,
  [switch]$PerformanceOnly
)

$ErrorActionPreference = 'Stop'
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path -LiteralPath $chrome)) { throw 'Google Chrome is not installed.' }

$output = Join-Path (Get-Location) $OutputDirectory
New-Item -ItemType Directory -Path $output -Force | Out-Null
$debugPort = 9400 + ($PID % 400)
$profile = Join-Path $env:TEMP "pixel-city-major-buildings-$PID"
$process = $null
$socket = $null

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
  if ($response.result.subtype -eq 'error') { throw $response.result.description }
  return $response.result.value
}

function Save-Capture(
  [System.Net.WebSockets.ClientWebSocket]$socket,
  [string]$path
) {
  $capture = Invoke-Cdp $socket 'Page.captureScreenshot' @{
    format = 'png'
    captureBeyondViewport = $false
  }
  [IO.File]::WriteAllBytes($path, [Convert]::FromBase64String($capture.data))
}

function Reset-PerformanceProbe([System.Net.WebSockets.ClientWebSocket]$socket) {
  Evaluate-Cdp $socket @'
(() => {
  window.__majorBuildingPerf.frames.length = 0;
  window.__majorBuildingPerf.longTasks.length = 0;
  return true;
})()
'@ | Out-Null
}

function Get-PerformanceSample(
  [System.Net.WebSockets.ClientWebSocket]$socket,
  [string]$label
) {
  return Evaluate-Cdp $socket @"
(() => {
  const managers = window.game?.registry?.managers ?? [];
  const byKey = key => managers.find(manager => manager.key === key);
  const frames = window.__majorBuildingPerf.frames.slice().sort((a, b) => a - b);
  const percentile = amount => frames.length
    ? frames[Math.min(frames.length - 1, Math.floor((frames.length - 1) * amount))]
    : 0;
  const averageMs = frames.length
    ? frames.reduce((sum, value) => sum + value, 0) / frames.length
    : 0;
  const profiler = window.__engineProfiler?.() ?? null;
  const traffic = byKey('TrafficSystem')?.trafficDebugSnapshot?.() ?? null;
  const world = byKey('WorldManager');
  return {
    label: '$label',
    durationSeconds: $SettledSampleSeconds,
    frameCount: frames.length,
    averageMs,
    calculatedFps: averageMs > 0 ? 1000 / averageMs : 0,
    phaserFps: window.game?.phaser?.loop?.actualFps ?? 0,
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    maxMs: frames.at(-1) ?? 0,
    framesOver33Ms: frames.filter(value => value > 33.34).length,
    framesOver50Ms: frames.filter(value => value > 50).length,
    longTasks: window.__majorBuildingPerf.longTasks.slice(),
    profiler: profiler ? {
      fps: profiler.fps,
      frameMs: profiler.frameMs,
      cpuMs: profiler.cpuMs,
      renderMs: profiler.renderMs,
      physicsMs: profiler.physicsMs,
      drawCalls: profiler.drawCalls,
      aiMs: profiler.aiMs,
      trafficMs: profiler.trafficMs,
      pathfindingMs: profiler.pathfindingMs,
      queuedPaths: profiler.queuedPaths,
      loadedChunks: profiler.loadedChunks,
      loadedNpcs: profiler.loadedNpcs,
      activeNpcs: profiler.activeNpcs,
      sleepingNpcs: profiler.sleepingNpcs,
      loadedVehicles: profiler.loadedVehicles,
      activeVehicles: profiler.activeVehicles,
      sleepingVehicles: profiler.sleepingVehicles,
      nearEntities: profiler.nearEntities,
      mediumEntities: profiler.mediumEntities,
      farEntities: profiler.farEntities,
      veryFarEntities: profiler.veryFarEntities,
      dormantEntities: profiler.dormantEntities,
      physicsBodies: profiler.physicsBodies
    } : null,
    traffic: traffic ? {
      activeDrivers: traffic.stats?.activeDrivers ?? 0,
      virtualVehicles: traffic.stats?.virtualVehicles ?? 0,
      nearVehicles: traffic.stats?.nearSimulationVehicles ?? 0,
      mediumVehicles: traffic.stats?.mediumSimulationVehicles ?? 0,
      farVehicles: traffic.stats?.farSimulationVehicles ?? 0,
      frozenVehicles: traffic.stats?.frozenSimulationVehicles ?? 0
    } : null,
    loadedRegions: world?.loadedRegionCounts ?? {}
  };
})()
"@
}

try {
  New-Item -ItemType Directory -Path $profile | Out-Null
  $process = Start-Process -FilePath $chrome -ArgumentList @(
    '--headless=new',
    '--hide-scrollbars',
    '--disable-background-timer-throttling',
    '--enable-gpu',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    "--remote-debugging-port=$debugPort",
    "--user-data-dir=$profile",
    '--window-size=1280,720',
    'about:blank'
  ) -WindowStyle Hidden -PassThru

  $targets = $null
  for ($attempt = 0; $attempt -lt 60 -and -not $targets; $attempt++) {
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
window.__majorBuildingErrors = [];
window.__majorBuildingPerf = { frames: [], longTasks: [] };
let __majorBuildingPreviousFrame = performance.now();
requestAnimationFrame(function __majorBuildingFrame(now) {
  window.__majorBuildingPerf.frames.push(now - __majorBuildingPreviousFrame);
  __majorBuildingPreviousFrame = now;
  requestAnimationFrame(__majorBuildingFrame);
});
try {
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      window.__majorBuildingPerf.longTasks.push({ startMs: entry.startTime, durationMs: entry.duration });
    }
  }).observe({ type: 'longtask', buffered: true });
} catch {}
window.addEventListener('error', event => window.__majorBuildingErrors.push(String(event.error || event.message)));
window.addEventListener('unhandledrejection', event => window.__majorBuildingErrors.push(String(event.reason)));
const originalError = console.error;
console.error = (...args) => { window.__majorBuildingErrors.push(args.map(String).join(' ')); originalError(...args); };
Object.defineProperty(Element.prototype, 'requestPointerLock', {
  configurable: true,
  value: () => Promise.resolve()
});
'@
  } | Out-Null
  Invoke-Cdp $socket 'Page.navigate' @{ url = $Url } | Out-Null

  $menuReady = $false
  for ($attempt = 0; $attempt -lt 180 -and -not $menuReady; $attempt++) {
    Start-Sleep -Milliseconds 500
    $menuReady = Evaluate-Cdp $socket @'
(() => window.game?.phaser?.scene?.getScenes(true)?.some(scene => scene.scene.key === 'MainMenuScene') ?? false)()
'@
  }
  if (-not $menuReady) { throw 'Main menu did not become ready after world generation.' }
  Evaluate-Cdp $socket @'
(() => {
  window.game.phaser.scene.getScene('MainMenuScene').onNewGame();
  return true;
})()
'@ | Out-Null

  $ready = $false
  for ($attempt = 0; $attempt -lt 90 -and -not $ready; $attempt++) {
    Start-Sleep -Milliseconds 500
    $ready = Evaluate-Cdp $socket @'
(() => {
  const managers = window.game?.registry?.managers ?? [];
  const scenes = window.game?.phaser?.scene?.getScenes(true)?.map(scene => scene.scene.key) ?? [];
  return scenes.includes('GameScene') && managers.some(manager => manager.key === 'WorldManager');
})()
'@
  }
  if (-not $ready) { throw 'GameScene did not become ready.' }

  Evaluate-Cdp $socket @'
(() => {
  const managers = window.game.registry.managers;
  managers.find(manager => manager.key === 'DayNightSystem')?.setTime?.(12, 0);
  window.game.phaser.scene.getScene('GameScene')?.cameras?.main?.setZoom?.(1.35);
  return true;
})()
'@ | Out-Null
  Start-Sleep -Seconds 2

  $registry = Evaluate-Cdp $socket @'
(() => {
  const managers = window.game.registry.managers;
  const world = managers.find(manager => manager.key === 'WorldManager');
  const minimap = window.game.phaser.scene.getScene('UIScene')?.minimap ?? null;
  return {
    buildings: world.map.majorBuildings,
    hospitals: world.map.hospitals,
    policeStations: world.map.policeStations,
    interiorCount: world.map.buildingInteriors.length,
    serviceLandmarks: world.map.landmarks.filter(item => item.kind === 'hospital' || item.kind === 'police'),
    minimap: minimap?.debugSnapshot?.() ?? {
      hasMap: Boolean(minimap?.hasMap),
      majorPoiCount: world.map.majorBuildings.length,
      scale: 0,
      viewCenter: { x: 0, y: 0 }
    }
  };
})()
'@
  if ($registry.buildings.Count -ne 8) { throw "Expected 8 major buildings, got $($registry.buildings.Count)." }
  if ($registry.hospitals.Count -ne 4 -or $registry.policeStations.Count -ne 4) {
    throw 'Compatibility service projections do not contain 4 hospitals and 4 police stations.'
  }
  if ($registry.serviceLandmarks.Count -ne 0) { throw 'Duplicate police/hospital landmarks remain.' }
  if (-not $registry.minimap.hasMap) { throw 'Minimap did not consume the generated map.' }
  if ($registry.minimap.majorPoiCount -ne 8) { throw "Expected 8 minimap service POIs, got $($registry.minimap.majorPoiCount)." }

  $results = @()
  $settledExterior = $null
  $settledInterior = $null
  $settledAfterExit = $null
  foreach ($building in $registry.buildings) {
    $id = [string]$building.id
    Evaluate-Cdp $socket @"
(() => {
  const managers = window.game.registry.managers;
  const world = managers.find(manager => manager.key === 'WorldManager');
  const controller = managers.find(manager => manager.key === 'PlayerController');
  const building = world.map.majorBuildings.find(item => item.id === '$id');
  const sprite = controller.player.sprite;
  sprite.setPosition(building.entrancePosition.x, building.entrancePosition.y);
  sprite.body?.reset(building.entrancePosition.x, building.entrancePosition.y);
  const camera = window.game.phaser.scene.getScene('GameScene').cameras.main;
  camera.stopFollow?.();
  camera.centerOn(building.worldPosition.x, building.worldPosition.y);
  return true;
})()
"@ | Out-Null
    Start-Sleep -Milliseconds 2200
    if ($results.Count -eq 0) {
      Start-Sleep -Seconds $PopulationSettleSeconds
      Reset-PerformanceProbe $socket
      Start-Sleep -Seconds $SettledSampleSeconds
      $settledExterior = Get-PerformanceSample $socket "$id-exterior-settled"
    }
    Save-Capture $socket (Join-Path $output "$id-exterior.png")
    $exterior = Evaluate-Cdp $socket @"
(() => {
  const managers = window.game.registry.managers;
  const world = managers.find(manager => manager.key === 'WorldManager');
  const vehicles = managers.find(manager => manager.key === 'VehicleSystem');
  const building = world.map.majorBuildings.find(item => item.id === '$id');
  const serviceVehicles = vehicles.vehicles.filter(vehicle => vehicle.sprite.getData('majorBuildingId') === '$id');
  return {
    roofOpen: world.openInteriorRoofId ?? null,
    serviceVehicles: serviceVehicles.map(vehicle => ({ kind: vehicle.def.kind, x: vehicle.sprite.x, y: vehicle.sprite.y })),
    parkingDistance: Math.hypot(
      building.parkingArea.position.x - building.entrancePosition.x,
      building.parkingArea.position.y - building.entrancePosition.y
    ),
    fps: window.game.phaser.loop.actualFps
  };
})()
"@

    Evaluate-Cdp $socket @"
(() => {
  const managers = window.game.registry.managers;
  const world = managers.find(manager => manager.key === 'WorldManager');
  const controller = managers.find(manager => manager.key === 'PlayerController');
  const building = world.map.majorBuildings.find(item => item.id === '$id');
  const interior = world.map.buildingInteriors.find(item => item.id === building.interiorId);
  const destination = { x: building.entrancePosition.x, y: interior.bounds.y + 48 };
  controller.player.sprite.setPosition(destination.x, destination.y);
  controller.player.sprite.body?.reset(destination.x, destination.y);
  return true;
})()
"@ | Out-Null
    Start-Sleep -Milliseconds 2600
    if ($results.Count -eq 0) {
      Reset-PerformanceProbe $socket
      Start-Sleep -Seconds $SettledSampleSeconds
      $settledInterior = Get-PerformanceSample $socket "$id-interior-settled"
    }
    Save-Capture $socket (Join-Path $output "$id-interior.png")
    $interior = Evaluate-Cdp $socket @"
(async () => {
  const managers = window.game.registry.managers;
  const world = managers.find(manager => manager.key === 'WorldManager');
  const navigation = managers.find(manager => manager.key === 'NavigationSystem');
  const pedestrians = managers.find(manager => manager.key === 'PedestrianSystem');
  const interiors = managers.find(manager => manager.key === 'WorldInteriorSystem');
  const building = world.map.majorBuildings.find(item => item.id === '$id');
  const interior = world.map.buildingInteriors.find(item => item.id === building.interiorId);
  const routePairs = interior.npcSpawns.flatMap(spawn => (spawn.anchors ?? []).map(anchor => ({
    role: spawn.role,
    from: { x: spawn.x, y: spawn.y },
    to: anchor
  })));
  const routes = await Promise.all(routePairs.map(pair => new Promise(resolve => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve({ role: pair.role, passed: false, timeout: true }); } }, 3500);
    navigation.requestPath(pair.from, pair.to, 'pedestrian', result => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ role: pair.role, passed: result.complete && Array.isArray(result.waypoints) });
    }, 0);
  })));
  const peds = pedestrians.pedestrians.filter(ped => ped.sprite.getData('interiorId') === interior.id);
  const visualBatch = interiors.visualsByInterior.get(interior.id) ?? [];
  return {
    roofOpen: world.openInteriorRoofId ?? null,
    interiorAtPlayer: interiors.interiorAt(
      managers.find(manager => manager.key === 'PlayerController').playerPosition.x,
      managers.find(manager => manager.key === 'PlayerController').playerPosition.y
    )?.id ?? null,
    roles: peds.map(ped => ({
      role: ped.sprite.getData('interiorRole'),
      activity: ped.sprite.getData('interiorActivity'),
      state: ped.ai.currentState,
      x: ped.sprite.x,
      y: ped.sprite.y,
      inBounds:
        ped.sprite.x >= interior.bounds.x && ped.sprite.x <= interior.bounds.x + interior.bounds.w &&
        ped.sprite.y >= interior.bounds.y && ped.sprite.y <= interior.bounds.y + interior.bounds.h
    })),
    expectedRoles: interior.npcSpawns.map(spawn => spawn.role),
    routes,
    clearSeeds: interior.npcSpawns.every(spawn =>
      world.isPedestrianClearAtWorld(spawn.x, spawn.y, 10) &&
      (spawn.anchors ?? []).every(anchor => world.isPedestrianClearAtWorld(anchor.x, anchor.y, 10))
    ),
    visibleInteriorObjects: visualBatch.filter(object => object.visible !== false).length,
    totalInteriorObjects: visualBatch.length,
    interactions: interior.objects.filter(object => object.action).length,
    fps: window.game.phaser.loop.actualFps
  };
})()
"@

    Evaluate-Cdp $socket @"
(() => {
  const managers = window.game.registry.managers;
  const world = managers.find(manager => manager.key === 'WorldManager');
  const controller = managers.find(manager => manager.key === 'PlayerController');
  const building = world.map.majorBuildings.find(item => item.id === '$id');
  controller.player.sprite.setPosition(building.entrancePosition.x, building.entrancePosition.y);
  controller.player.sprite.body?.reset(building.entrancePosition.x, building.entrancePosition.y);
  return true;
})()
"@ | Out-Null
    Start-Sleep -Milliseconds 800
    if ($results.Count -eq 0) {
      Reset-PerformanceProbe $socket
      Start-Sleep -Seconds $SettledSampleSeconds
      $settledAfterExit = Get-PerformanceSample $socket "$id-after-exit-settled"
    }
    $exit = Evaluate-Cdp $socket @'
(() => {
  const managers = window.game.registry.managers;
  const world = managers.find(manager => manager.key === 'WorldManager');
  return { roofOpen: world.openInteriorRoofId ?? null };
})()
'@

    $results += [ordered]@{
      id = $id
      city = $building.city
      type = $building.type
      variant = $building.architecturalVariant
      exterior = $exterior
      interior = $interior
      exit = $exit
    }
    if ($PerformanceOnly) { break }
  }

  $mapPoiAudit = $null
  if (-not $PerformanceOnly) {
    Invoke-Cdp $socket 'Input.dispatchKeyEvent' @{ type = 'keyDown'; key = 'm'; code = 'KeyM'; windowsVirtualKeyCode = 77 } | Out-Null
    Invoke-Cdp $socket 'Input.dispatchKeyEvent' @{ type = 'keyUp'; key = 'm'; code = 'KeyM'; windowsVirtualKeyCode = 77 } | Out-Null
    $mapReady = $false
    for ($attempt = 0; $attempt -lt 40 -and -not $mapReady; $attempt++) {
      Start-Sleep -Milliseconds 250
      $mapReady = Evaluate-Cdp $socket @'
(() => {
  const scene = window.game.phaser.scene.getScene('MapScene');
  return Boolean(window.game.phaser.scene.isActive('MapScene') && scene.debugMajorPoiSnapshot?.().renderedPoiCount === 8);
})()
'@
    }
    if (-not $mapReady) { throw 'World map POIs did not become ready.' }
    $mapPoiAudit = Evaluate-Cdp $socket @'
(() => {
  const scene = window.game.phaser.scene.getScene('MapScene');
  const snapshot = scene.debugMajorPoiSnapshot();
  const renderedPois = snapshot.renderedPois;
  return {
    before: snapshot,
    firstPoi: renderedPois[0] ?? null,
    hospitalCount: renderedPois.filter(item => item.type === 'hospital').length,
    policeCount: renderedPois.filter(item => item.type === 'police-station').length,
    labelsOk: renderedPois.every(item =>
      typeof item.label === 'string' &&
      item.label.length > 0 &&
      (item.label.includes('Hospital') || item.label.includes('Police Station')) &&
      (item.label.includes('Tehran') || item.label.includes('Yazd') || item.label.includes('Gilan'))
    ),
    iconsOk: renderedPois.every(item =>
      item.type === 'hospital'
        ? item.mapIcon === 'medical-cross' && item.minimapIcon === 'medical-cross'
        : item.mapIcon === 'police-badge' && item.minimapIcon === 'police-badge'
    ),
    allInsideView: renderedPois.every(item => item.insideView === true)
  };
})()
'@
    if (-not $mapPoiAudit.firstPoi) { throw 'No rendered full-map POI available to click.' }
    $clickX = [int][Math]::Round([double]$mapPoiAudit.firstPoi.screen.x)
    $clickY = [int][Math]::Round([double]$mapPoiAudit.firstPoi.screen.y)
    Invoke-Cdp $socket 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = $clickX; y = $clickY; button = 'none' } | Out-Null
    Start-Sleep -Milliseconds 150
    Invoke-Cdp $socket 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = $clickX; y = $clickY; button = 'left'; clickCount = 1 } | Out-Null
    Invoke-Cdp $socket 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = $clickX; y = $clickY; button = 'left'; clickCount = 1 } | Out-Null
    Start-Sleep -Milliseconds 500
    $mapPoiAudit = Evaluate-Cdp $socket @'
(() => {
  const scene = window.game.phaser.scene.getScene('MapScene');
  const snapshot = scene.debugMajorPoiSnapshot();
  const selected = snapshot.renderedPois.find(item => item.id === snapshot.selectedId) ?? null;
  const waypointMatches = Boolean(
    selected &&
    snapshot.waypoint &&
    Math.abs(snapshot.waypoint.x - selected.entrancePosition.x) < 0.5 &&
    Math.abs(snapshot.waypoint.y - selected.entrancePosition.y) < 0.5
  );
  return {
    before: null,
    after: snapshot,
    selected,
    waypointMatches,
    hospitalCount: snapshot.renderedPois.filter(item => item.type === 'hospital').length,
    policeCount: snapshot.renderedPois.filter(item => item.type === 'police-station').length,
    labelsOk: snapshot.renderedPois.every(item =>
      typeof item.label === 'string' &&
      item.label.length > 0 &&
      (item.label.includes('Hospital') || item.label.includes('Police Station')) &&
      (item.label.includes('Tehran') || item.label.includes('Yazd') || item.label.includes('Gilan'))
    ),
    iconsOk: snapshot.renderedPois.every(item =>
      item.type === 'hospital'
        ? item.mapIcon === 'medical-cross' && item.minimapIcon === 'medical-cross'
        : item.mapIcon === 'police-badge' && item.minimapIcon === 'police-badge'
    ),
    allInsideView: snapshot.renderedPois.every(item => item.insideView === true)
  };
})()
'@
    Save-Capture $socket (Join-Path $output 'major-buildings-world-map.png')
  }

  $errors = Evaluate-Cdp $socket '(() => window.__majorBuildingErrors ?? [])()'
  $report = [ordered]@{
    registry = $registry
    locations = $results
    steadyStatePerformance = [ordered]@{
      buildingId = [string]$registry.buildings[0].id
      exterior = $settledExterior
      interior = $settledInterior
      afterExit = $settledAfterExit
      interiorAverageFrameRatio = if ($settledExterior.averageMs -gt 0) {
        $settledInterior.averageMs / $settledExterior.averageMs
      } else { 0 }
      afterExitAverageFrameRatio = if ($settledExterior.averageMs -gt 0) {
        $settledAfterExit.averageMs / $settledExterior.averageMs
      } else { 0 }
    }
    minimumFps = ($results | ForEach-Object { @($_.exterior.fps, $_.interior.fps) } | Measure-Object -Minimum).Minimum
    mapPoiAudit = $mapPoiAudit
    browserErrors = $errors
  }
  $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $output 'report.json') -Encoding utf8

  $failures = @()
  foreach ($location in $results) {
    if ($location.exterior.roofOpen) { $failures += "$($location.id): roof opened outside" }
    if ($location.exterior.serviceVehicles.Count -lt 1) { $failures += "$($location.id): no streamed service vehicle" }
    if ($location.exterior.parkingDistance -lt 48) { $failures += "$($location.id): parking blocks entrance" }
    if ($location.interior.roofOpen -ne ($registry.buildings | Where-Object id -eq $location.id).interiorId) { $failures += "$($location.id): owning roof did not open" }
    if ($location.interior.interiorAtPlayer -ne $location.interior.roofOpen) { $failures += "$($location.id): player/interior identity mismatch" }
    if ($location.interior.roles.Count -lt $location.interior.expectedRoles.Count) { $failures += "$($location.id): dedicated NPCs missing" }
    if (($location.interior.roles | Where-Object { -not $_.inBounds }).Count -gt 0) { $failures += "$($location.id): NPC outside interior" }
    if (($location.interior.routes | Where-Object { -not $_.passed }).Count -gt 0) { $failures += "$($location.id): unreachable NPC route" }
    if (-not $location.interior.clearSeeds) { $failures += "$($location.id): spawn or anchor collision" }
    if ($location.interior.visibleInteriorObjects -ne $location.interior.totalInteriorObjects) { $failures += "$($location.id): interior art did not stream in" }
    if ($location.interior.interactions -lt 1) { $failures += "$($location.id): no gameplay interaction" }
    if ($location.exit.roofOpen) { $failures += "$($location.id): roof stayed open after exit" }
  }
  if ($errors.Count -gt 0) { $failures += "Browser errors: $($errors -join '; ')" }
  if (-not $PerformanceOnly) {
    if (-not $mapPoiAudit) {
      $failures += 'Map POI audit did not run'
    } else {
      if ($mapPoiAudit.after.poiCount -ne 8) { $failures += "Full map POI source count is $($mapPoiAudit.after.poiCount), expected 8" }
      if ($mapPoiAudit.after.renderedPoiCount -ne 8) { $failures += "Full map rendered POI count is $($mapPoiAudit.after.renderedPoiCount), expected 8" }
      if ($mapPoiAudit.hospitalCount -ne 4) { $failures += "Full map hospital POI count is $($mapPoiAudit.hospitalCount), expected 4" }
      if ($mapPoiAudit.policeCount -ne 4) { $failures += "Full map police POI count is $($mapPoiAudit.policeCount), expected 4" }
      if (-not $mapPoiAudit.labelsOk) { $failures += 'Full map POI labels are incomplete' }
      if (-not $mapPoiAudit.iconsOk) { $failures += 'Full map POI icons are incorrect' }
      if (-not $mapPoiAudit.allInsideView) { $failures += 'At least one full map POI is not visible at maximum zoom-out' }
      if (-not $mapPoiAudit.selected) { $failures += 'Clicking a full map POI did not select it' }
      if (-not $mapPoiAudit.waypointMatches) { $failures += 'Clicking a full map POI did not set the existing waypoint to the building entrance' }
    }
  }
  if ($failures.Count -gt 0) { throw ($failures -join [Environment]::NewLine) }

  [ordered]@{
    locations = $results.Count
    policeStations = @($results | Where-Object type -eq 'police-station').Count
    hospitals = @($results | Where-Object type -eq 'hospital').Count
    minimumFps = $report.minimumFps
    screenshots = (Get-ChildItem -LiteralPath $output -Filter '*.png').Count
    browserErrors = $errors.Count
  } | ConvertTo-Json
} finally {
  if ($socket) { $socket.Dispose() }
  if ($process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force
    Wait-Process -Id $process.Id -Timeout 5 -ErrorAction SilentlyContinue
  }
  for ($attempt = 0; $attempt -lt 10 -and (Test-Path -LiteralPath $profile); $attempt++) {
    try { Remove-Item -LiteralPath $profile -Recurse -Force }
    catch {
      if ($attempt -ge 9) { Write-Warning "Could not remove browser profile: $profile" }
      else { Start-Sleep -Milliseconds 150 }
    }
  }
}
