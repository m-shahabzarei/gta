param(
  [string]$Url = 'http://127.0.0.1:5173',
  [string]$Screenshot = 'transit-browser-smoke.png',
  [switch]$ProbeOnly,
  [switch]$CoreOnly,
  [int]$WatchBusSeconds = 0
)

$ErrorActionPreference = 'Stop'
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path -LiteralPath $chrome)) { throw 'Google Chrome is not installed.' }

$debugPort = 9227
$profile = Join-Path $env:TEMP "pixel-city-transit-smoke-$PID"
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
  $payload = @{ id = $id; method = $method; params = $params } | ConvertTo-Json -Depth 16 -Compress
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

function Evaluate-Cdp([System.Net.WebSockets.ClientWebSocket]$socket, [string]$expression) {
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
window.__transitSmokeErrors = [];
window.addEventListener('error', event => window.__transitSmokeErrors.push(String(event.error || event.message)));
window.addEventListener('unhandledrejection', event => window.__transitSmokeErrors.push(String(event.reason)));
const originalError = console.error;
console.error = (...args) => { window.__transitSmokeErrors.push(args.map(String).join(' ')); originalError(...args); };
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
  if (-not $menuReady) { throw 'Main menu did not become ready after world validation.' }
  Evaluate-Cdp $socket @'
(() => {
  const scene = window.game?.phaser?.scene?.getScene?.('MainMenuScene');
  if (scene) scene.onNewGame();
  return Boolean(scene);
})()
'@ | Out-Null

  $snapshot = $null
  for ($attempt = 0; $attempt -lt 50; $attempt++) {
    Start-Sleep -Seconds 1
    $snapshot = Evaluate-Cdp $socket @'
(() => {
  const managers = window.game?.registry?.managers ?? [];
  const byKey = key => managers.find(manager => manager.key === key) ?? null;
  const transit = byKey('TransportationSystem');
  const world = byKey('WorldManager');
  const traffic = byKey('TrafficSystem');
  const vehicles = byKey('VehicleSystem');
  const player = byKey('PlayerController')?.player ?? null;
  const snapshot = transit?.debugSnapshot?.() ?? null;
  const allRoutes = snapshot
    ? ['tehran', 'yazd', 'gilan'].flatMap(city => snapshot.busRoutes[city] ?? [])
    : [];
  return {
    ready: Boolean(transit && world && traffic && snapshot),
    errors: window.__transitSmokeErrors ?? [],
    busCount: snapshot?.buses?.length ?? 0,
    taxiCount: snapshot?.taxis?.length ?? 0,
    checks: {
      tehranRouteCount: snapshot?.busRoutes?.tehran?.length === 4,
      allRoutesValid: allRoutes.length === 8 && allRoutes.every(route => route.valid && route.stops.length >= 3),
      taxiDrivers: (snapshot?.taxis ?? []).every(taxi => taxi.hasDriver),
      busDrivers: (snapshot?.buses ?? []).every(bus => bus.passengerCapacity > 0),
      cityStopCoverage: ['tehran', 'yazd', 'gilan'].every(city =>
        (world?.map?.busStops?.filter(stop => stop.cityId === city).length ?? 0) > 0
      )
    },
    routeIssues: allRoutes.filter(route => !route.valid).map(route => ({ id: route.config.id, issue: route.issue })),
    player: player ? {
      position: { x: Math.round(player.sprite.x), y: Math.round(player.sprite.y) },
      city: world?.cityAt?.(player.sprite.x, player.sprite.y)?.id ?? null,
    } : null,
    nearestStops: player && world ? [...world.map.busStops]
      .map(stop => ({
        id: stop.id,
        city: stop.cityId,
        distance: Math.round(Math.hypot(stop.x - player.sprite.x, stop.y - player.sprite.y)),
      }))
      .sort((left, right) => left.distance - right.distance)
      .slice(0, 4) : [],
    nearestTaxis: player && snapshot ? [...snapshot.taxis]
      .map(taxi => ({
        id: taxi.vehicleId,
        city: taxi.cityId,
        state: taxi.state,
        driver: taxi.hasDriver,
        passenger: taxi.hasPassenger,
        navigation: taxi.driverState,
        distance: Math.round(taxi.distanceToPlayer ?? Infinity),
      }))
      .sort((left, right) => left.distance - right.distance)
      .slice(0, 6) : [],
    busStates: (snapshot?.buses ?? []).map(bus => ({ id: bus.routeId, state: bus.state, passengers: bus.passengerCount })),
    taxis: (snapshot?.taxis ?? []).map(taxi => ({ id: taxi.vehicleId, city: taxi.cityId, state: taxi.state, hasDriver: taxi.hasDriver })),
    stopCounts: world ? Object.fromEntries(['tehran', 'yazd', 'gilan'].map(city => [
      city,
      world.map.busStops.filter(stop => stop.cityId === city).length
    ])) : {},
    fps: window.game?.phaser?.loop?.actualFps ?? 0
  };
})()
'@
    if ($snapshot.ready -and $snapshot.busCount -ge 8 -and $snapshot.taxiCount -ge 16) { break }
    $fatalErrors = @($snapshot.errors | Where-Object { $_ -notlike '*pointer lock*' })
    if ($fatalErrors.Count -gt 0) { break }
  }
  if (-not $snapshot.ready) { throw 'Transportation service did not become ready.' }
  if ($snapshot.busCount -lt 8 -or $snapshot.taxiCount -lt 16) {
    throw "Transit service population is incomplete: buses=$($snapshot.busCount), taxis=$($snapshot.taxiCount), routeIssues=$($snapshot.routeIssues | ConvertTo-Json -Compress), busStates=$($snapshot.busStates | ConvertTo-Json -Compress)."
  }
  if (-not $snapshot.checks.tehranRouteCount -or -not $snapshot.checks.allRoutesValid) {
    throw "Generated bus routes are incomplete or unreachable: $($snapshot.routeIssues | ConvertTo-Json -Compress)"
  }
  if (-not $snapshot.checks.taxiDrivers -or -not $snapshot.checks.busDrivers) {
    throw 'A transit service vehicle spawned without its required driver or passenger capacity.'
  }
  if (-not $snapshot.checks.cityStopCoverage) {
    throw 'Generated transit stops are missing city coverage.'
  }
  if ($ProbeOnly) {
    $routeProbe = Evaluate-Cdp $socket @'
(() => {
  const managers = window.game?.registry?.managers ?? [];
  const transit = managers.find(manager => manager.key === 'TransportationSystem');
  const traffic = managers.find(manager => manager.key === 'TrafficSystem');
  const network = traffic?.roadNetwork;
  return (transit?.debugSnapshot?.().busRoutes?.tehran ?? []).map(route => ({
    id: route.config.id,
    name: route.config.name,
    valid: route.valid,
    stops: route.stops.map(stop => ({
      id: stop.id,
      laneId: stop.laneId,
      stopPosition: stop.stopPosition,
      platform: { x: stop.x, y: stop.y },
    })),
    segments: route.segments.map(segment => ({
      from: segment.fromStopId,
      to: segment.toStopId,
      valid: segment.valid,
      lanes: segment.laneIds.length,
      distance: Math.round(segment.laneIds.reduce((total, laneId) =>
        total + (network?.lane(laneId)?.spline.length ?? 0), 0)),
    })),
    parkingNearStops: route.stops.map(stop => {
      const lane = network?.lane(stop.laneId) ?? null;
      return {
        stopId: stop.id,
        spaces: lane ? network.parkingSpaces()
          .map(space => ({
            space,
            projection: network.projectPoint(space.position, lane),
          }))
          .filter(candidate => candidate.projection.distanceSq <= 100 * 100)
          .map(candidate => ({
            id: candidate.space.id,
            adjacentLaneId: candidate.space.adjacentLaneId,
            position: candidate.space.position,
            heading: candidate.space.heading,
            width: candidate.space.width,
            length: candidate.space.length,
            laneDistance: Math.round(candidate.projection.distance),
            lateralDistance: Math.round(Math.sqrt(candidate.projection.distanceSq) * 10) / 10,
          })) : [],
      };
    }),
    validation: route.validation,
  }));
})()
'@
    [PSCustomObject]@{ initial = $snapshot; routes = $routeProbe } | ConvertTo-Json -Depth 12
    return
  }
  if ($WatchBusSeconds -gt 0) {
    $watch = Evaluate-Cdp $socket @"
(async () => {
  const managers = window.game?.registry?.managers ?? [];
  const byKey = key => managers.find(manager => manager.key === key) ?? null;
  const transit = byKey('TransportationSystem');
  const traffic = byKey('TrafficSystem');
  const vehicles = byKey('VehicleSystem');
  const player = byKey('PlayerController')?.player;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const bus = [...(transit?.buses?.values?.() ?? [])].find(candidate =>
    candidate.cityId === 'tehran' && candidate.route.config.id === 'T1' && candidate.vehicle.sprite.active
  ) ?? null;
  if (!bus || !traffic || !player) return { error: 'T1 bus or traffic runtime unavailable' };
  const records = [];
  const startedAt = performance.now();
  let nextRecordAt = startedAt;
  let lastKey = '';
  while (performance.now() - startedAt < $($WatchBusSeconds * 1000)) {
    const heading = bus.vehicle.movement.heading;
    player.sprite.setPosition(
      bus.vehicle.sprite.x + Math.sin(heading) * 180,
      bus.vehicle.sprite.y - Math.cos(heading) * 180,
    );
    player.sprite.body?.reset?.(player.sprite.x, player.sprite.y);
    const driver = traffic.driverFor(bus.vehicle);
    const debug = driver?.debug ?? null;
    const target = bus.route.stops[bus.targetStopIndex] ?? null;
    const network = traffic.roadNetwork;
    const intersectionState = (() => {
      const lane = debug?.laneId ? network?.lane?.(debug.laneId) : null;
      const connector = debug?.targetLaneId ? network?.lane?.(debug.targetLaneId) : null;
      const controller = traffic.intersections;
      if (!lane || !connector?.intersectionId || !controller) return null;
      const outgoing = debug?.route?.[debug.route.indexOf(connector.id) + 1] ?? null;
      const queue = controller.queuedByIntersection?.get?.(connector.intersectionId);
      const queued = queue?.get?.(bus.vehicle.id) ?? null;
      const reservation = controller.hasReservation?.(bus.vehicle.id) ?? null;
      const downstream = outgoing
        ? [...(traffic.drivers?.values?.() ?? [])]
            .map(candidate => ({ id: candidate.id, debug: candidate.debug }))
            .filter(candidate => candidate.id !== bus.vehicle.id && candidate.debug?.laneId === outgoing)
            .map(candidate => ({
              id: candidate.id,
              laneDistance: Math.round(candidate.debug.laneDistance),
              speed: Math.round(candidate.debug.currentSpeed * 10) / 10,
              state: candidate.debug.state,
            }))
        : [];
      return {
        intersectionId: connector.intersectionId,
        incomingLaneId: lane.id,
        connectorLaneId: connector.id,
        outgoingLaneId: outgoing,
        reservation: reservation ? { id: reservation.id, entered: reservation.entered } : null,
        queued: queued ? {
          downstreamClear: queued.downstreamClear,
          distanceToStopLine: Math.round(queued.distanceToStopLine),
          priority: queued.priority,
          emergency: queued.emergency,
        } : null,
        queueSize: queue?.size ?? 0,
        activeReservations: controller.reservationsByIntersection?.get?.(connector.intersectionId)?.map?.(entry => ({
          vehicleId: entry.vehicleId,
          connectorLaneId: entry.connectorLaneId,
          entered: entry.entered,
        })) ?? [],
        signal: controller.signalColor?.(
          connector.intersectionId,
          Math.abs(Math.sin(lane.spline?.controlPoints?.[3]?.y - lane.spline?.controlPoints?.[0]?.y ?? 0)) >=
            Math.abs(Math.cos(lane.spline?.controlPoints?.[3]?.x - lane.spline?.controlPoints?.[0]?.x ?? 0)),
        ) ?? null,
        downstream,
      };
    })();
    const blocker = debug?.collisionPrediction?.entityId === null || debug?.collisionPrediction?.entityId === undefined
      ? null
      : (vehicles?.vehicles ?? []).find(candidate => candidate.id === debug.collisionPrediction.entityId) ?? null;
    const blockerSweep = (() => {
      if (!blocker || !debug?.predictedPath?.length) return null;
      let nearestIndex = 0;
      let nearestDistanceSq = Infinity;
      for (let index = 0; index < debug.predictedPath.length; index += 1) {
        const point = debug.predictedPath[index];
        if (!point) continue;
        const dx = blocker.sprite.x - point.x;
        const dy = blocker.sprite.y - point.y;
        const distanceSq = dx * dx + dy * dy;
        if (distanceSq < nearestDistanceSq) {
          nearestDistanceSq = distanceSq;
          nearestIndex = index;
        }
      }
      const before = debug.predictedPath[Math.max(0, nearestIndex - 1)];
      const after = debug.predictedPath[Math.min(debug.predictedPath.length - 1, nearestIndex + 1)];
      const point = debug.predictedPath[nearestIndex];
      if (!before || !after || !point) return null;
      const tx = after.x - before.x;
      const ty = after.y - before.y;
      const length = Math.hypot(tx, ty) || 1;
      const tangent = { x: tx / length, y: ty / length };
      const normal = { x: -tangent.y, y: tangent.x };
      const dx = blocker.sprite.x - point.x;
      const dy = blocker.sprite.y - point.y;
      return {
        nearestPathIndex: nearestIndex,
        pathPoint: { x: Math.round(point.x), y: Math.round(point.y) },
        tangent,
        longitudinal: Math.round((dx * tangent.x + dy * tangent.y) * 10) / 10,
        lateral: Math.round(Math.abs(dx * normal.x + dy * normal.y) * 10) / 10,
      };
    })();
    const parkingSpace = (() => {
      const spaceId = blocker?.sprite.getData?.('parkingSpaceId');
      const space = spaceId ? network?.parkingSpaces?.().find(candidate => candidate.id === spaceId) : null;
      if (!space) return null;
      return {
        id: space.id,
        adjacentLaneId: space.adjacentLaneId,
        width: space.width,
        length: space.length,
        heading: Math.round(space.heading * 1000) / 1000,
        position: { x: Math.round(space.position.x), y: Math.round(space.position.y) },
        travelClearance: network?.parkingSpaceHasTravelClearance?.(space, blocker?.def?.width, blocker?.def?.height) ?? null,
      };
    })();
    const key = [bus.state, bus.currentStopIndex, bus.targetStopIndex, debug?.state, debug?.laneId, debug?.targetLaneId].join('|');
    if (performance.now() >= nextRecordAt || key !== lastKey) {
      records.push({
        t: Math.round(performance.now() - startedAt),
        busState: bus.state,
        currentStopIndex: bus.currentStopIndex,
        targetStopIndex: bus.targetStopIndex,
        arrived: driver?.arrived ?? null,
        speed: Math.round((debug?.currentSpeed ?? 0) * 10) / 10,
        desiredSpeed: Math.round((debug?.desiredSpeed ?? 0) * 10) / 10,
        driverState: debug?.state ?? null,
        intention: debug?.intention ?? null,
        laneId: debug?.laneId ?? null,
        targetLaneId: debug?.targetLaneId ?? null,
        laneDistance: Math.round(debug?.laneDistance ?? -1),
        distanceToDestination: debug?.distanceToDestination === null ? null : Math.round(debug?.distanceToDestination ?? -1),
        routeLength: debug?.route?.length ?? 0,
        recovery: debug?.recovery ?? null,
        heading: Math.round(bus.vehicle.movement.heading * 1000) / 1000,
        collision: debug?.collisionPrediction ?? null,
        blocker: blocker ? {
          id: blocker.id,
          kind: blocker.def?.kind ?? null,
          destroyed: blocker.isDestroyed === true,
          speed: blocker.movement?.speed ?? null,
          heading: Math.round((blocker.movement?.heading ?? 0) * 1000) / 1000,
          parked: blocker.sprite.getData?.('parked') ?? false,
          parkingSpaceId: blocker.sprite.getData?.('parkingSpaceId') ?? null,
          position: { x: Math.round(blocker.sprite.x), y: Math.round(blocker.sprite.y) },
          persistentTransitService: blocker.sprite.getData?.('persistentTransitService') ?? false,
          trafficDriver: (() => {
            const blockerDebug = traffic.driverFor(blocker)?.debug ?? null;
            return blockerDebug ? {
              state: blockerDebug.state,
              intention: blockerDebug.intention,
              laneId: blockerDebug.laneId,
              laneDistance: Math.round(blockerDebug.laneDistance),
              speed: blockerDebug.currentSpeed,
              desiredSpeed: blockerDebug.desiredSpeed,
              recovery: blockerDebug.recovery,
            } : null;
          })(),
        } : null,
        blockerSweep,
        parkingSpace,
        intersectionState,
        targetDistance: target ? Math.round(Math.hypot(bus.vehicle.sprite.x - target.stopPosition.x, bus.vehicle.sprite.y - target.stopPosition.y)) : null,
        position: { x: Math.round(bus.vehicle.sprite.x), y: Math.round(bus.vehicle.sprite.y) },
      });
      nextRecordAt = performance.now() + 5000;
      lastKey = key;
    }
    await pause(100);
  }
  const progress = records.filter((record, index) => {
    const previous = records[index - 1];
    return !previous ||
      record.currentStopIndex !== previous.currentStopIndex ||
      record.targetStopIndex !== previous.targetStopIndex ||
      record.busState !== previous.busState;
  });
  const summarizeRecord = record => ({
    t: record.t,
    busState: record.busState,
    currentStopIndex: record.currentStopIndex,
    targetStopIndex: record.targetStopIndex,
    arrived: record.arrived,
    speed: record.speed,
    desiredSpeed: record.desiredSpeed,
    driverState: record.driverState,
    intention: record.intention,
    laneId: record.laneId,
    laneDistance: record.laneDistance,
    targetDistance: record.targetDistance,
    collision: record.collision ? {
      kind: record.collision.kind,
      entityId: record.collision.entityId,
      distance: record.collision.distance,
    } : null,
    blocker: record.blocker ? {
      id: record.blocker.id,
      kind: record.blocker.kind,
      parked: record.blocker.parked,
      trafficDriver: record.blocker.trafficDriver ? {
        state: record.blocker.trafficDriver.state,
        intention: record.blocker.trafficDriver.intention,
        speed: Math.round(record.blocker.trafficDriver.speed * 10) / 10,
        recovery: record.blocker.trafficDriver.recovery,
      } : null,
    } : null,
    recovery: record.recovery,
  });
  return JSON.stringify({
    route: bus.route.config.id,
    stops: bus.route.stops.map(stop => stop.id),
    summary: {
      final: records.length ? summarizeRecord(records[records.length - 1]) : null,
      intersectionWaits: records.filter(record =>
        record.intersectionState?.queued || record.intersectionState?.reservation || record.driverState === 'Yielding'
      ).slice(-12).map(summarizeRecord),
      progress: progress.slice(-24).map(summarizeRecord),
    },
  });
})()
"@
    [Console]::WriteLine([string]$watch)
    return
  }

  $ride = Evaluate-Cdp $socket @'
(async () => {
  const managers = window.game?.registry?.managers ?? [];
  const byKey = key => managers.find(manager => manager.key === key) ?? null;
  const transit = byKey('TransportationSystem');
  const traffic = byKey('TrafficSystem');
  const world = byKey('WorldManager');
  const occupants = byKey('VehicleOccupantSystem');
  const playerController = byKey('PlayerController');
  const gameManager = byKey('GameManager');
  const player = playerController?.player;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const waitFor = async (predicate, timeoutMs) => {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if (predicate()) return true;
      await pause(50);
    }
    return predicate();
  };
  const movePlayer = point => {
    if (!player || !point) return false;
    player.sprite.setPosition(point.x, point.y);
    player.sprite.body?.reset?.(point.x, point.y);
    return true;
  };
  const legalRoute = laneIds => {
    const network = traffic?.roadNetwork;
    if (!network || !Array.isArray(laneIds) || laneIds.length === 0) return false;
    for (let index = 0; index < laneIds.length - 1; index += 1) {
      const lane = network.lane(laneIds[index]);
      if (!lane?.connectionIds?.includes(laneIds[index + 1])) return false;
    }
    return true;
  };
  const wrapAngle = angle => {
    const turn = Math.PI * 2;
    return ((angle + Math.PI) % turn + turn) % turn - Math.PI;
  };
  const result = { economy: {}, bus: {}, taxi: {}, cityPresence: [], transitFixtures: false, errors: [] };
  if (!transit || !traffic || !world || !occupants || !playerController || !player) {
    result.errors.push('required runtime managers unavailable');
    return result;
  }

  // New games use the real inventory wallet. The isolated Chrome profile makes
  // this a true first-run assertion rather than a UI text check.
  result.economy.newGameMoney = player.inventory.money;
  const save = byKey('SaveManager');
  if (save) {
    const savedBalance = player.inventory.money;
    const saved = save.save(2, 'Transit wallet smoke');
    player.inventory.setMoney(1);
    const loaded = save.load(2);
    result.economy.existingSaveMoneyPreserved = Boolean(saved && loaded && player.inventory.money === savedBalance);
    player.inventory.setMoney(savedBalance);
  } else {
    result.economy.existingSaveMoneyPreserved = false;
  }

  const bus = [...transit.buses.values()].find(candidate =>
    candidate.cityId === 'tehran' && candidate.vehicle.def.kind === 'bus' && candidate.vehicle.sprite.active
  ) ?? null;
  result.bus.vehicleKind = bus?.vehicle.def.kind === 'bus';
  const keepPlayerNearBus = candidate => {
    if (!candidate) return false;
    const heading = candidate.vehicle.movement.heading;
    // Follow from the curb side at a safe distance. This raises only the test
    // player's LOD; the bus remains a normal traffic-driven vehicle.
    return movePlayer({
      x: candidate.vehicle.sprite.x + Math.sin(heading) * 180,
      y: candidate.vehicle.sprite.y - Math.cos(heading) * 180,
    });
  };
  const stopRecord = (candidate, startedAt, observation) => {
    const stop = candidate.route.stops[candidate.currentStopIndex] ?? null;
    const debug = traffic.driverFor(candidate.vehicle)?.debug ?? null;
    const distance = stop
      ? Math.hypot(candidate.vehicle.sprite.x - stop.stopPosition.x, candidate.vehicle.sprite.y - stop.stopPosition.y)
      : Infinity;
    const headingError = stop
      ? Math.abs(wrapAngle(candidate.vehicle.movement.heading - stop.heading))
      : Infinity;
    return {
      index: candidate.currentStopIndex,
      stopId: stop?.id ?? null,
      stopped: candidate.state === 'STOPPED_AT_STOP',
      boardingActive: candidate.boardingActive === true,
      laneMatched: debug?.laneId === stop?.laneId,
      distance: Math.round(distance * 10) / 10,
      headingError: Math.round(headingError * 1000) / 1000,
      approached: observation?.approached === true,
      aligned: observation?.aligned === true,
      approachDistanceReduced: observation?.maxDistance > observation?.minDistance,
      approachSpeed: Math.round(observation?.maxSpeed ?? 0),
      alignSpeed: Math.round(observation?.alignSpeed ?? 0),
      dwellStartedAt: startedAt,
      departed: false,
      dwellMs: null,
    };
  };
  if (!bus) {
    result.errors.push('no active Tehran bus for route-cycle test');
  } else {
    keepPlayerNearBus(bus);
    result.bus.initialStop = await waitFor(
      () => bus.state === 'STOPPED_AT_STOP' && bus.boardingActive && Math.abs(bus.vehicle.movement.speed) < 1.5,
      12000,
    );
    const initialStop = bus.route.stops[bus.currentStopIndex] ?? null;
    const seat = occupants.availablePassengerSeats(bus.vehicle)[0] ?? null;
    const door = seat ? occupants.doorWorldPosition(bus.vehicle, seat, 4) : null;
    movePlayer(door);
    result.transitFixtures = await waitFor(
      () => (world.vehicleOnlyCollisionLayers ?? []).some(layer =>
        String(layer.layer?.name ?? layer.name ?? '').startsWith('transit-stop:')
      ),
      2500,
    );
    result.bus.boardPrompt = transit.interactionAt(player.position)?.prompt ?? null;
    result.bus.entryStarted = result.bus.boardPrompt === 'BOARD BUS  E';
    if (result.bus.entryStarted) transit.handlePlayerInteraction({ x: player.sprite.x, y: player.sprite.y });
    result.bus.boarded = await waitFor(
      () => playerController.playerIsTransitPassenger && playerController.currentVehicle?.id === bus.vehicle.id,
      4500,
    );
    result.bus.hud = transit.playerRide ?? null;
    result.bus.exitPrompt = result.bus.boarded ? transit.interactionAt(playerController.playerPosition)?.prompt ?? null : null;
    result.bus.exitStarted = result.bus.exitPrompt === 'EXIT BUS  E';
    if (result.bus.exitStarted) transit.handlePlayerInteraction(playerController.playerPosition);
    result.bus.exited = await waitFor(() => !playerController.playerIsTransitPassenger, 4500);

    const route = bus.route;
    const startIndex = bus.currentStopIndex;
    const expectedStops = Array.from({ length: route.stops.length + 1 }, (_, offset) =>
      route.stops[(startIndex + offset) % route.stops.length]?.id ?? null,
    );
    const routeDistance = route.segments.reduce((total, segment) => total + segment.laneIds.reduce((sum, laneId) =>
      sum + (traffic.roadNetwork?.lane(laneId)?.spline.length ?? 0), 0), 0);
    const maxCycleMs = Math.min(
      1200000,
      Math.max(120000, Math.ceil((routeDistance / 30) * 1000 + route.stops.length * 9000 + 30000)),
    );
    const observations = route.stops.map(() => ({
      approached: false,
      aligned: false,
      maxDistance: 0,
      minDistance: Infinity,
      maxSpeed: 0,
      alignSpeed: Infinity,
    }));
    const records = [];
    const initialObservation = observations[startIndex];
    if (initialObservation) initialObservation.aligned = true;
    if (initialStop && bus.state === 'STOPPED_AT_STOP') {
      records.push(stopRecord(bus, performance.now(), initialObservation));
    }
    let wasStopped = bus.state === 'STOPPED_AT_STOP';
    let movingPromptSuppressed = false;
    let recoveryObserved = false;
    const deadline = performance.now() + maxCycleMs;
    while (performance.now() < deadline && records.length < route.stops.length + 1) {
      keepPlayerNearBus(bus);
      const targetIndex = bus.targetStopIndex;
      const observation = observations[targetIndex];
      const target = bus.route.stops[targetIndex] ?? null;
      const debug = traffic.driverFor(bus.vehicle)?.debug ?? null;
      const distance = target
        ? Math.hypot(bus.vehicle.sprite.x - target.stopPosition.x, bus.vehicle.sprite.y - target.stopPosition.y)
        : Infinity;
      if (observation) {
        observation.maxDistance = Math.max(observation.maxDistance, distance);
        observation.minDistance = Math.min(observation.minDistance, distance);
        observation.maxSpeed = Math.max(observation.maxSpeed, Math.abs(debug?.currentSpeed ?? 0));
      }
      if (bus.state === 'APPROACHING_STOP' && observation) observation.approached = true;
      if (bus.state === 'ALIGNING_WITH_STOP' && observation) {
        observation.aligned = true;
        observation.alignSpeed = Math.min(observation.alignSpeed, Math.abs(debug?.currentSpeed ?? 0));
      }
      if (bus.state === 'RECOVERING') recoveryObserved = true;
      if (bus.state !== 'STOPPED_AT_STOP' && !movingPromptSuppressed) {
        movingPromptSuppressed = !(transit.interactionAt(player.position)?.prompt ?? '').includes('BOARD BUS');
      }
      if (bus.state === 'STOPPED_AT_STOP' && !wasStopped) {
        records.push(stopRecord(bus, performance.now(), observations[bus.currentStopIndex]));
        wasStopped = true;
      } else if (bus.state !== 'STOPPED_AT_STOP' && wasStopped) {
        const previous = records[records.length - 1];
        if (previous) {
          previous.departed = true;
          previous.dwellMs = Math.round(performance.now() - previous.dwellStartedAt);
        }
        wasStopped = false;
      }
      await pause(50);
    }
    const sequence = records.map(record => record.stopId);
    const arrivals = records.slice(1);
    result.bus.routeCycle = {
      routeId: route.config.id,
      routeName: route.config.name,
      expectedStops,
      observedStops: sequence,
      routeDistance: Math.round(routeDistance),
      timeoutMs: maxCycleMs,
      recovered: recoveryObserved,
      movingPromptSuppressed,
      records: records.map(record => ({ ...record, dwellStartedAt: undefined })),
      complete: records.length === expectedStops.length && sequence.every((id, index) => id === expectedStops[index]),
      allApproachedAndAligned: arrivals.every(record => record.approached && record.aligned && record.approachDistanceReduced),
      allStoppedOnCurb: arrivals.every(record =>
        record.stopped && record.boardingActive && record.laneMatched && record.distance <= 28 && record.headingError <= 0.42
      ),
      allDeparted: records.slice(0, -1).every(record => record.departed && (record.dwellMs ?? 0) >= 4300),
      slowedBeforeStops: arrivals.every(record => record.approachSpeed > record.alignSpeed),
    };
  }

  const activeChunks = () => Array.from(world.chunks?.values?.() ?? []);
  const fixtureVisible = stop => activeChunks().some(chunk =>
    (chunk.objects ?? []).some(object =>
      object.getData?.('busStopId') === stop.id && object.visible !== false
    )
  );
  for (const city of world.map.cities ?? []) {
    movePlayer(city.center);
    await pause(180);
    const centerStop = [...world.map.busStops]
      .filter(stop => stop.cityId === city.id)
      .sort((left, right) =>
        Math.hypot(left.x - city.center.x, left.y - city.center.y) -
        Math.hypot(right.x - city.center.x, right.y - city.center.y)
      )[0] ?? null;
    const streamedFixture = centerStop
      ? await waitFor(() => fixtureVisible(centerStop), 3500)
      : false;
    const taxiRadius = transit.debugSnapshot()?.cityConfigs?.[city.id]?.taxiEncounterRadius ?? 0;
    const availableTaxi = await waitFor(() => [...transit.taxis.values()].some(candidate => {
      const hasDriver = occupants.occupantsFor(candidate.vehicle).some(occupant =>
        occupant.seat === 'driver' && occupant.role === 'taxi-driver' && occupant.state === 'seated'
      );
      return candidate.cityId === city.id &&
        candidate.state === 'AVAILABLE' &&
        candidate.vehicle.def.kind === 'taxi' &&
        hasDriver &&
        Math.hypot(candidate.vehicle.sprite.x - player.sprite.x, candidate.vehicle.sprite.y - player.sprite.y) <= taxiRadius;
    }), 5000);
    const cityBus = [...transit.buses.values()].find(candidate =>
      candidate.cityId === city.id && candidate.vehicle.def.kind === 'bus' && candidate.vehicle.sprite.active
    ) ?? null;
    let busFixture = false;
    if (cityBus) {
      movePlayer({ x: cityBus.vehicle.sprite.x, y: cityBus.vehicle.sprite.y });
      const stop = cityBus.route.stops[cityBus.currentStopIndex] ?? null;
      busFixture = stop ? await waitFor(() => fixtureVisible(stop), 3500) : false;
    }
    result.cityPresence.push({
      city: city.id,
      centerStopId: centerStop?.id ?? null,
      centerStopDistance: centerStop
        ? Math.round(Math.hypot(centerStop.x - city.center.x, centerStop.y - city.center.y))
        : null,
      streamedFixture,
      availableTaxi,
      taxiRadius,
      busVehicle: Boolean(cityBus),
      busFixture,
    });
  }

  const taxi = [...transit.taxis.values()].find(candidate => candidate.state === 'AVAILABLE') ?? null;
  if (!taxi) {
    result.errors.push('no available taxi for passenger test');
    return result;
  }
  const noTaxiProbe = world.map.busStops.find(stop =>
    stop.cityId === taxi.cityId &&
    [...transit.taxis.values()].every(candidate =>
      Math.hypot(candidate.vehicle.sprite.x - stop.x, candidate.vehicle.sprite.y - stop.y) > 90
    )
  ) ?? null;
  const noTaxiPrompt = noTaxiProbe ? transit.interactionAt(noTaxiProbe)?.prompt ?? '' : '';
  result.taxi.noGlobalCallPrompt = !noTaxiPrompt.includes('TAXI');
  traffic.setDriverStopped(taxi.vehicle, true);
  await waitFor(() => Math.abs(taxi.vehicle.movement.speed) < 1.5, 4000);
  const taxiSeat = occupants.availablePassengerSeats(taxi.vehicle)[0] ?? null;
  movePlayer(taxiSeat ? occupants.doorWorldPosition(taxi.vehicle, taxiSeat, 4) : null);
  result.taxi.callPrompt = transit.interactionAt(player.position)?.prompt ?? null;
  result.taxi.callStarted = result.taxi.callPrompt === 'CALL TAXI  E';
  if (result.taxi.callStarted) transit.handlePlayerInteraction({ x: player.sprite.x, y: player.sprite.y });
  result.taxi.approaching = await waitFor(() => taxi.state === 'APPROACHING_PICKUP', 2500);
  result.taxi.pickupRoadTarget = Boolean(
    taxi.pickupPosition && traffic.routePreview(taxi.vehicle.position, taxi.pickupPosition)
  );
  result.taxi.callPromptCleared = !(transit.interactionAt(player.position)?.prompt ?? '').includes('CALL TAXI');
  result.taxi.waitingForPassenger = await waitFor(
    () => taxi.state === 'WAITING_FOR_PASSENGER',
    25000,
  );
  movePlayer(taxiSeat ? occupants.doorWorldPosition(taxi.vehicle, taxiSeat, 4) : null);
  result.taxi.enterPrompt = transit.interactionAt(player.position)?.prompt ?? null;
  result.taxi.entryStarted = result.taxi.enterPrompt === 'ENTER TAXI  E';
  if (result.taxi.entryStarted) transit.handlePlayerInteraction({ x: player.sprite.x, y: player.sprite.y });
  result.taxi.boarded = await waitFor(
    () => playerController.playerIsTransitPassenger && playerController.currentVehicle?.id === taxi.vehicle.id,
    5000,
  );
  result.taxi.destinationMap = await waitFor(() => transit.taxiDestinationSelectionActive, 2500);
  if (!result.taxi.boarded) {
    result.errors.push('taxi passenger transition did not complete');
    return result;
  }

  const destinationOptions = transit.taxiDestinations(taxi.cityId);
  result.taxi.destinationOptions = {
    landmarks: destinationOptions.filter(destination => destination.source === 'landmark').length,
    busStops: destinationOptions.filter(destination => destination.source === 'bus-stop').length,
  };
  const roadNetwork = traffic.roadNetwork;
  const manualCandidates = (roadNetwork?.nearbyTravelLanes(taxi.vehicle.position, 1800, 48) ?? [])
    .map(lane => {
      const point = roadNetwork.pointAt(lane, Math.max(48, lane.spline.length * 0.55)).point;
      return { point, route: traffic.routePreview(taxi.vehicle.position, point) };
    })
    .filter(candidate =>
      candidate.route &&
      candidate.route.distancePx >= 450 &&
      candidate.route.distancePx <= 2200 &&
      world.cityAt(candidate.point.x, candidate.point.y)?.id === taxi.cityId
    )
    .sort((left, right) => left.route.distancePx - right.route.distancePx);
  const selected = manualCandidates[0]
    ? { kind: 'map', point: manualCandidates[0].point, route: manualCandidates[0].route }
    : null;
  if (!selected) {
    result.errors.push('no road-reachable taxi destination');
    return result;
  }
  const quote = transit.previewTaxiMapPoint(selected.point, 'Map pin');
  result.taxi.quote = quote;
  result.taxi.selectionSource = selected.kind;
  result.taxi.quoteRouteLegal = legalRoute(quote?.route?.laneIds ?? []);
  player.inventory.setMoney(0);
  result.taxi.insufficient = transit.confirmTaxiFare();
  result.taxi.moneyAfterRejectedFare = player.inventory.money;
  // Restore the actual new-game wallet before payment. This verifies that a
  // normal fare comes from the same $700 inventory balance shown by the HUD.
  player.inventory.setMoney(result.economy.newGameMoney);
  const beforePayment = player.inventory.money;
  result.taxi.paid = transit.confirmTaxiFare();
  const afterPayment = player.inventory.money;
  result.taxi.moneyBeforePayment = beforePayment;
  result.taxi.moneyAfterPayment = afterPayment;
  result.taxi.debitedExactlyOnce = Boolean(
    quote &&
      beforePayment === 700 &&
      afterPayment === 700 - quote.total &&
      transit.confirmTaxiFare() !== 'paid' &&
      player.inventory.money === afterPayment
  );
  gameManager?.resumeGame?.();
  await pause(1600);
  const taxiDriver = traffic.driverFor(taxi.vehicle);
  result.taxi.driverRouteLegal = legalRoute(taxiDriver?.debug?.route ?? []);
  result.taxi.inService = taxi.state === 'IN_SERVICE';
  result.taxi.arrived = await waitFor(() => taxi.state === 'ARRIVING', 40000);
  const driverDebug = taxiDriver?.debug ?? null;
  result.taxi.afterTripWait = {
    gameState: gameManager?.state ?? null,
    taxiState: taxi.state,
    driverState: driverDebug?.state ?? null,
    intention: driverDebug?.intention ?? null,
    laneId: driverDebug?.laneId ?? null,
    currentSpeed: driverDebug?.currentSpeed ?? null,
    desiredSpeed: driverDebug?.desiredSpeed ?? null,
    routeLength: driverDebug?.route?.length ?? 0,
    vehiclePosition: { x: Math.round(taxi.vehicle.sprite.x), y: Math.round(taxi.vehicle.sprite.y) },
    destinationDistance: taxi.destination
      ? Math.round(Math.hypot(taxi.vehicle.sprite.x - taxi.destination.position.x, taxi.vehicle.sprite.y - taxi.destination.position.y))
      : null,
  };
  if (result.taxi.arrived) {
    result.taxi.exitPrompt = transit.interactionAt(playerController.playerPosition)?.prompt ?? null;
    result.taxi.exitStarted = result.taxi.exitPrompt === 'EXIT TAXI  E';
    if (result.taxi.exitStarted) transit.handlePlayerInteraction(playerController.playerPosition);
    result.taxi.exited = await waitFor(() => !playerController.playerIsTransitPassenger, 4500);
    await pause(1200);
    result.taxi.returnedToService = taxi.state === 'AVAILABLE';
  }
  const visualStop = world.map.busStops.find(stop => stop.cityId === taxi.cityId) ?? null;
  if (visualStop) {
    movePlayer(visualStop);
    await pause(1800);
    result.bus.visualStop = {
      id: visualStop.id,
      platform: { x: Math.round(visualStop.x), y: Math.round(visualStop.y) },
      stopPosition: { x: Math.round(visualStop.stopPosition.x), y: Math.round(visualStop.stopPosition.y) },
      roadOffset: Math.round(Math.hypot(visualStop.x - visualStop.stopPosition.x, visualStop.y - visualStop.stopPosition.y)),
    };
  }
  return result;
})()
'@

  # Assert the actual gameplay run before optional evidence-frame capture. A
  # late chunk-streaming race must never hide a missed-stop or wallet result.
  $fatalErrors = @($snapshot.errors | Where-Object { $_ -notlike '*pointer lock*' })
  if ($fatalErrors.Count -gt 0) { throw "Browser errors: $($fatalErrors -join '; ')" }
  $cityPresenceFailures = @($ride.cityPresence | Where-Object {
    -not $_.centerStopId -or
    $_.centerStopDistance -gt 720 -or
    -not $_.streamedFixture -or
    -not $_.busVehicle
  })
  if (@($ride.cityPresence).Count -ne 3 -or $cityPresenceFailures.Count -gt 0) {
    throw "City transit presence check failed: $($ride.cityPresence | ConvertTo-Json -Depth 8 -Compress)"
  }
  $busCycle = $ride.bus.routeCycle
  $busOk = $ride.bus.initialStop -and $ride.bus.vehicleKind -and $ride.bus.boardPrompt -eq 'BOARD BUS  E' -and $ride.bus.entryStarted -and $ride.bus.boarded -and $ride.bus.exitPrompt -eq 'EXIT BUS  E' -and $ride.bus.exitStarted -and $ride.bus.exited -and $busCycle.complete -and $busCycle.allApproachedAndAligned -and $busCycle.allStoppedOnCurb -and $busCycle.allDeparted -and $busCycle.slowedBeforeStops -and $busCycle.movingPromptSuppressed -and -not $busCycle.recovered
  if (-not $busOk) { throw "Bus passenger/runtime check failed: $($ride.bus | ConvertTo-Json -Depth 8 -Compress)" }
  $taxiOk = $ride.economy.newGameMoney -eq 700 -and $ride.economy.existingSaveMoneyPreserved -and $ride.taxi.noGlobalCallPrompt -and $ride.taxi.callPrompt -eq 'CALL TAXI  E' -and $ride.taxi.callStarted -and $ride.taxi.approaching -and $ride.taxi.pickupRoadTarget -and $ride.taxi.callPromptCleared -and $ride.taxi.waitingForPassenger -and $ride.taxi.enterPrompt -eq 'ENTER TAXI  E' -and $ride.taxi.entryStarted -and $ride.taxi.boarded -and $ride.taxi.destinationMap -and $ride.taxi.destinationOptions.landmarks -gt 0 -and $ride.taxi.destinationOptions.busStops -gt 0 -and $ride.taxi.quoteRouteLegal -and $ride.taxi.insufficient -eq 'insufficient-funds' -and $ride.taxi.moneyAfterRejectedFare -eq 0 -and $ride.taxi.moneyBeforePayment -eq 700 -and $ride.taxi.paid -eq 'paid' -and $ride.taxi.debitedExactlyOnce -and $ride.taxi.driverRouteLegal -and $ride.taxi.inService -and $ride.taxi.arrived -and $ride.taxi.exitPrompt -eq 'EXIT TAXI  E' -and $ride.taxi.exitStarted -and $ride.taxi.exited -and $ride.taxi.returnedToService
  if (-not $taxiOk) { throw "Taxi passenger/runtime check failed: $($ride.taxi | ConvertTo-Json -Depth 8 -Compress)" }
  if (-not $ride.transitFixtures) { throw 'Streamed bus-stop collision fixture did not materialize.' }
  if ($ride.errors.Count -gt 0) { throw "Transit ride errors: $($ride.errors -join '; ')" }
  if ($CoreOnly) {
    [PSCustomObject]@{
      initial = $snapshot
      economy = $ride.economy
      cityPresence = $ride.cityPresence
      bus = $ride.bus
      taxi = $ride.taxi
    } | ConvertTo-Json -Depth 12
    return
  }

  $busScreens = [ordered]@{}
  foreach ($cityId in @('tehran', 'yazd', 'gilan')) {
    $busPose = Evaluate-Cdp $socket @"
(() => {
  const managers = window.game?.registry?.managers ?? [];
  const byKey = key => managers.find(manager => manager.key === key) ?? null;
  const transit = byKey('TransportationSystem');
  const traffic = byKey('TrafficSystem');
  const dayNight = byKey('DayNightSystem');
  const gameScene = window.game?.phaser?.scene?.getScene?.('GameScene') ?? null;
  const player = byKey('PlayerController')?.player;
  const bus = [...(transit?.buses?.values?.() ?? [])].find(candidate =>
    candidate.cityId === '$cityId' && candidate.vehicle.def.kind === 'bus' && candidate.vehicle.sprite.active
  ) ?? null;
  const camera = gameScene?.cameras?.main ?? null;
  if (!bus || !player || !traffic || !camera) return null;
  // Pause only this live driver for the evidence frame. This keeps the actual
  // service entity in camera while the smoke test remains otherwise unmodified.
  traffic.setDriverStopped(bus.vehicle, true);
  player.sprite.setPosition(bus.vehicle.sprite.x + 128, bus.vehicle.sprite.y + 48);
  player.sprite.body?.reset?.(player.sprite.x, player.sprite.y);
  dayNight?.setTime?.(12, 0);
  camera.stopFollow();
  camera.centerOn(bus.vehicle.sprite.x, bus.vehicle.sprite.y);
  return { vehicleId: bus.vehicle.id, routeId: bus.route.config.id, state: bus.state, kind: bus.vehicle.def.kind };
})()
"@
    if (-not $busPose -or $busPose.kind -ne 'bus') { throw "No active $cityId bus was available for visual capture." }
    $busFrame = $null
    for ($attempt = 0; $attempt -lt 18; $attempt++) {
      Start-Sleep -Milliseconds 250
      $busFrame = Evaluate-Cdp $socket @"
(() => {
  const managers = window.game?.registry?.managers ?? [];
  const byKey = key => managers.find(manager => manager.key === key) ?? null;
  const transit = byKey('TransportationSystem');
  const traffic = byKey('TrafficSystem');
  const gameScene = window.game?.phaser?.scene?.getScene?.('GameScene') ?? null;
  const bus = transit?.buses?.get?.($($busPose.vehicleId)) ?? null;
  const camera = gameScene?.cameras?.main ?? null;
  if (!bus || !traffic || !camera) return null;
  traffic.setDriverStopped(bus.vehicle, true);
  camera.stopFollow();
  camera.centerOn(bus.vehicle.sprite.x, bus.vehicle.sprite.y);
  return {
    active: bus.vehicle.sprite.active,
    visible: bus.vehicle.sprite.visible,
    speed: Math.abs(bus.vehicle.movement.speed),
    x: Math.round(bus.vehicle.sprite.x),
    y: Math.round(bus.vehicle.sprite.y),
  };
})()
"@
      if ($busFrame -and $busFrame.active -and $busFrame.visible -and $busFrame.speed -lt 1.5) { break }
    }
    if (-not $busFrame -or -not $busFrame.active -or -not $busFrame.visible -or $busFrame.speed -ge 1.5) {
      throw "The $cityId bus did not become a visible stopped live entity for capture: $($busFrame | ConvertTo-Json -Compress)"
    }
    $busCapture = Invoke-Cdp $socket 'Page.captureScreenshot' @{ format = 'png'; captureBeyondViewport = $false }
    $busPath = Join-Path $PWD "transit-$cityId-bus-smoke.png"
    [IO.File]::WriteAllBytes($busPath, [Convert]::FromBase64String($busCapture.data))
    $busScreens[$cityId] = $busPath
  }

  $taxiPose = Evaluate-Cdp $socket @'
(() => {
  const managers = window.game?.registry?.managers ?? [];
  const byKey = key => managers.find(manager => manager.key === key) ?? null;
  const transit = byKey('TransportationSystem');
  const traffic = byKey('TrafficSystem');
  const dayNight = byKey('DayNightSystem');
  const world = byKey('WorldManager');
  const gameScene = window.game?.phaser?.scene?.getScene?.('GameScene') ?? null;
  const player = byKey('PlayerController')?.player;
  const city = world?.map?.cities?.find(candidate => candidate.id === 'tehran') ?? null;
  const taxi = city ? [...(transit?.taxis?.values?.() ?? [])]
    .filter(candidate => candidate.cityId === city.id && candidate.state === 'AVAILABLE' && candidate.vehicle.sprite.active)
    .sort((left, right) =>
      Math.hypot(left.vehicle.sprite.x - city.center.x, left.vehicle.sprite.y - city.center.y) -
      Math.hypot(right.vehicle.sprite.x - city.center.x, right.vehicle.sprite.y - city.center.y)
    )[0] ?? null : null;
  const camera = gameScene?.cameras?.main ?? null;
  if (!taxi || !player || !traffic || !camera) return null;
  // This is browser-smoke capture control, not a gameplay transition.
  traffic.setDriverStopped(taxi.vehicle, true);
  player.sprite.setPosition(taxi.vehicle.sprite.x + 112, taxi.vehicle.sprite.y + 44);
  player.sprite.body?.reset?.(player.sprite.x, player.sprite.y);
  dayNight?.setTime?.(12, 0);
  camera.stopFollow();
  camera.centerOn(taxi.vehicle.sprite.x, taxi.vehicle.sprite.y);
  return { vehicleId: taxi.vehicle.id, kind: taxi.vehicle.def.kind };
})()
'@
  if (-not $taxiPose -or $taxiPose.kind -ne 'taxi') { throw 'No available Tehran taxi was available for visual capture.' }
  $taxiFrame = $null
  for ($attempt = 0; $attempt -lt 18; $attempt++) {
    Start-Sleep -Milliseconds 250
    $taxiFrame = Evaluate-Cdp $socket @'
(() => {
  const managers = window.game?.registry?.managers ?? [];
  const byKey = key => managers.find(manager => manager.key === key) ?? null;
  const transit = byKey('TransportationSystem');
  const traffic = byKey('TrafficSystem');
  const gameScene = window.game?.phaser?.scene?.getScene?.('GameScene') ?? null;
  const taxi = [...(transit?.taxis?.values?.() ?? [])].find(candidate => candidate.vehicle.id === TAXI_CAPTURE_ID) ?? null;
  const camera = gameScene?.cameras?.main ?? null;
  if (!taxi || !traffic || !camera) return null;
  traffic.setDriverStopped(taxi.vehicle, true);
  camera.stopFollow();
  camera.centerOn(taxi.vehicle.sprite.x, taxi.vehicle.sprite.y);
  return {
    active: taxi.vehicle.sprite.active,
    visible: taxi.vehicle.sprite.visible,
    speed: Math.abs(taxi.vehicle.movement.speed),
    x: Math.round(taxi.vehicle.sprite.x),
    y: Math.round(taxi.vehicle.sprite.y),
  };
})()
'@.Replace('TAXI_CAPTURE_ID', [string]$taxiPose.vehicleId)
    if ($taxiFrame -and $taxiFrame.active -and $taxiFrame.visible -and $taxiFrame.speed -lt 1.5) { break }
  }
  if (-not $taxiFrame -or -not $taxiFrame.active -or -not $taxiFrame.visible -or $taxiFrame.speed -ge 1.5) {
    throw "The Tehran taxi did not become a visible stopped live entity for capture: $($taxiFrame | ConvertTo-Json -Compress)"
  }
  $taxiCapture = Invoke-Cdp $socket 'Page.captureScreenshot' @{ format = 'png'; captureBeyondViewport = $false }
  $taxiScreen = Join-Path $PWD 'transit-tehran-taxi-smoke.png'
  [IO.File]::WriteAllBytes($taxiScreen, [Convert]::FromBase64String($taxiCapture.data))

  $cityScreens = [ordered]@{}
  foreach ($cityId in @('tehran', 'yazd', 'gilan')) {
    $movedToCity = Evaluate-Cdp $socket @"
(() => {
  const managers = window.game?.registry?.managers ?? [];
  const byKey = key => managers.find(manager => manager.key === key) ?? null;
  const world = byKey('WorldManager');
  const dayNight = byKey('DayNightSystem');
  const gameScene = window.game?.phaser?.scene?.getScene?.('GameScene') ?? null;
  const player = byKey('PlayerController')?.player;
  const city = world?.map?.cities?.find(candidate => candidate.id === '$cityId') ?? null;
  const camera = gameScene?.cameras?.main ?? null;
  if (!world || !player || !city || !camera) return false;
  const stop = [...world.map.busStops]
    .filter(candidate => candidate.cityId === city.id)
    .sort((left, right) =>
      Math.hypot(left.x - city.center.x, left.y - city.center.y) -
      Math.hypot(right.x - city.center.x, right.y - city.center.y)
    )[0] ?? city;
  player.sprite.setPosition(stop.x, stop.y);
  player.sprite.body?.reset?.(stop.x, stop.y);
  dayNight?.setTime?.(12, 0);
  camera.stopFollow();
  camera.centerOn(stop.x, stop.y);
  return { stopId: stop.id };
})()
"@
    if (-not $movedToCity) {
      throw "Could not center a visible $cityId bus-stop fixture for capture."
    }
    $fixtureFrame = $false
    for ($attempt = 0; $attempt -lt 12; $attempt++) {
      Start-Sleep -Milliseconds 200
      $fixtureFrame = Evaluate-Cdp $socket @"
(() => {
  const managers = window.game?.registry?.managers ?? [];
  const byKey = key => managers.find(manager => manager.key === key) ?? null;
  const world = byKey('WorldManager');
  const gameScene = window.game?.phaser?.scene?.getScene?.('GameScene') ?? null;
  const stop = [...(world?.map?.busStops ?? [])].find(candidate => candidate.id === '$($movedToCity.stopId)') ?? null;
  const camera = gameScene?.cameras?.main ?? null;
  if (!stop || !camera) return false;
  camera.stopFollow();
  camera.centerOn(stop.x, stop.y);
  return [...(world?.chunks?.values?.() ?? [])].some(chunk =>
    (chunk.objects ?? []).some(object => object.getData?.('busStopId') === stop.id && object.visible !== false)
  );
})()
"@
      if ($fixtureFrame) { break }
    }
    if (-not $fixtureFrame) {
      Write-Warning "The $cityId bus-stop fixture did not stream in time for optional visual capture."
      continue
    }
    $cityCapture = Invoke-Cdp $socket 'Page.captureScreenshot' @{ format = 'png'; captureBeyondViewport = $false }
    $cityPath = Join-Path $PWD "transit-$cityId-world-smoke.png"
    [IO.File]::WriteAllBytes($cityPath, [Convert]::FromBase64String($cityCapture.data))
    $cityScreens[$cityId] = $cityPath
  }

  $capture = Invoke-Cdp $socket 'Page.captureScreenshot' @{ format = 'png'; captureBeyondViewport = $false }
  [IO.File]::WriteAllBytes((Join-Path $PWD $Screenshot), [Convert]::FromBase64String($capture.data))

  [PSCustomObject]@{
    initial = $snapshot
    economy = $ride.economy
    cityPresence = $ride.cityPresence
    cityScreens = $cityScreens
    busScreens = $busScreens
    taxiScreen = $taxiScreen
    bus = $ride.bus
    taxi = $ride.taxi
    screenshot = (Join-Path $PWD $Screenshot)
  } | ConvertTo-Json -Depth 12
} finally {
  if ($socket) { $socket.Dispose() }
  if ($process) {
    if (-not $process.HasExited) { $process.Kill() }
    $process.WaitForExit(5000) | Out-Null
  }
  # Chromium can leave a cache-writer child alive briefly after the browser
  # process exits. Cleanup must never mask the actual gameplay assertion.
  for ($attempt = 0; $attempt -lt 12 -and (Test-Path -LiteralPath $profile); $attempt++) {
    try {
      Remove-Item -LiteralPath $profile -Recurse -Force -ErrorAction Stop
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }
  if (Test-Path -LiteralPath $profile) {
    Write-Warning "Could not immediately remove transient Chrome profile: $profile"
  }
}
