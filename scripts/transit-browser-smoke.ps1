param(
  [string]$Url = 'http://127.0.0.1:5173',
  [string]$Screenshot = 'transit-browser-smoke.png'
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
  const result = { bus: {}, taxi: {}, transitFixtures: false, errors: [] };
  if (!transit || !traffic || !world || !occupants || !playerController || !player) {
    result.errors.push('required runtime managers unavailable');
    return result;
  }

  const bus = [...transit.buses.values()].find(candidate => candidate.state === 'dwelling') ?? null;
  result.bus.initialDwell = Boolean(bus && bus.dwellRemainingMs > 0);
  if (bus) {
    const seat = occupants.availablePassengerSeats(bus.vehicle)[0] ?? null;
    const door = seat ? occupants.doorWorldPosition(bus.vehicle, seat, 4) : null;
    movePlayer(door);
    result.transitFixtures = await waitFor(
      () => (world.vehicleOnlyCollisionLayers ?? []).some(layer =>
        String(layer.layer?.name ?? layer.name ?? '').startsWith('transit-stop:')
      ),
      2500,
    );
    result.bus.entryStarted = Boolean(transit.requestBusBoarding(bus.vehicle.id));
    result.bus.boarded = await waitFor(
      () => playerController.playerIsTransitPassenger && playerController.currentVehicle?.id === bus.vehicle.id,
      4500,
    );
    result.bus.hud = transit.playerRide ?? null;
    result.bus.exitStarted = Boolean(result.bus.boarded && transit.exitPlayerTransit());
    result.bus.exited = await waitFor(() => !playerController.playerIsTransitPassenger, 4500);
    await pause(4200);
    const driver = traffic.driverFor(bus.vehicle);
    result.bus.resumed = bus.state === 'approaching' && Boolean(driver?.debug?.route?.length);
    result.bus.routeLegal = legalRoute(driver?.debug?.route ?? []);
  } else {
    result.errors.push('no bus was dwelling for the initial passenger test');
  }

  const taxi = [...transit.taxis.values()].find(candidate => candidate.state === 'AVAILABLE') ?? null;
  if (!taxi) {
    result.errors.push('no available taxi for passenger test');
    return result;
  }
  traffic.setDriverStopped(taxi.vehicle, true);
  await waitFor(() => Math.abs(taxi.vehicle.movement.speed) < 1.5, 4000);
  const taxiSeat = occupants.availablePassengerSeats(taxi.vehicle)[0] ?? null;
  movePlayer(taxiSeat ? occupants.doorWorldPosition(taxi.vehicle, taxiSeat, 4) : null);
  result.taxi.entryStarted = Boolean(transit.requestTaxiBoarding(taxi.vehicle.id));
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
  const candidates = destinationOptions
    .map(destination => ({ destination, route: traffic.routePreview(taxi.vehicle.position, destination.position) }))
    .filter(candidate => candidate.route && candidate.route.distancePx > 160)
    .sort((left, right) => left.route.distancePx - right.route.distancePx);
  const roadNetwork = traffic.roadNetwork;
  const manualCandidates = (traffic.driverFor(taxi.vehicle)?.debug?.route ?? [])
    .map(laneId => roadNetwork?.lane(laneId) ?? null)
    .filter(lane => lane?.kind === 'travel')
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
    : candidates[0]
      ? { kind: 'named', destination: candidates[0].destination, route: candidates[0].route }
      : null;
  if (!selected) {
    result.errors.push('no road-reachable taxi destination');
    return result;
  }
  const quote = selected.kind === 'map'
    ? transit.previewTaxiMapPoint(selected.point, 'Map pin')
    : transit.previewTaxiDestination(selected.destination);
  result.taxi.quote = quote;
  result.taxi.selectionSource = selected.kind;
  result.taxi.quoteRouteLegal = legalRoute(quote?.route?.laneIds ?? []);
  player.inventory.setMoney(0);
  result.taxi.insufficient = transit.confirmTaxiFare();
  result.taxi.moneyAfterRejectedFare = player.inventory.money;
  player.inventory.setMoney((quote?.total ?? 0) + 40);
  const beforePayment = player.inventory.money;
  result.taxi.paid = transit.confirmTaxiFare();
  const afterPayment = player.inventory.money;
  result.taxi.debitedExactlyOnce = Boolean(
    quote && beforePayment - afterPayment === quote.total && transit.confirmTaxiFare() !== 'paid' && player.inventory.money === afterPayment
  );
  gameManager?.resumeGame?.();
  await pause(1000);
  const taxiDriver = traffic.driverFor(taxi.vehicle);
  result.taxi.driverRouteLegal = legalRoute(taxiDriver?.debug?.route ?? []);
  result.taxi.inService = taxi.state === 'IN_SERVICE';
  result.taxi.arrived = await waitFor(() => taxi.state === 'ARRIVING', 45000);
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
    result.taxi.exitStarted = Boolean(transit.exitPlayerTransit());
    result.taxi.exited = await waitFor(() => !playerController.playerIsTransitPassenger, 4500);
    await pause(800);
    result.taxi.returnedToService = taxi.state === 'AVAILABLE';
  }
  return result;
})()
'@

  $capture = Invoke-Cdp $socket 'Page.captureScreenshot' @{ format = 'png'; captureBeyondViewport = $false }
  [IO.File]::WriteAllBytes((Join-Path $PWD $Screenshot), [Convert]::FromBase64String($capture.data))

  $fatalErrors = @($snapshot.errors | Where-Object { $_ -notlike '*pointer lock*' })
  if ($fatalErrors.Count -gt 0) { throw "Browser errors: $($fatalErrors -join '; ')" }
  $busOk = $ride.bus.initialDwell -and $ride.bus.entryStarted -and $ride.bus.boarded -and $ride.bus.exitStarted -and $ride.bus.exited -and $ride.bus.resumed -and $ride.bus.routeLegal
  if (-not $busOk) { throw "Bus passenger/runtime check failed: $($ride.bus | ConvertTo-Json -Depth 8 -Compress)" }
  $taxiOk = $ride.taxi.entryStarted -and $ride.taxi.boarded -and $ride.taxi.destinationMap -and $ride.taxi.destinationOptions.landmarks -gt 0 -and $ride.taxi.destinationOptions.busStops -gt 0 -and $ride.taxi.quoteRouteLegal -and $ride.taxi.insufficient -eq 'insufficient-funds' -and $ride.taxi.moneyAfterRejectedFare -eq 0 -and $ride.taxi.paid -eq 'paid' -and $ride.taxi.debitedExactlyOnce -and $ride.taxi.driverRouteLegal -and $ride.taxi.inService -and $ride.taxi.arrived -and $ride.taxi.exitStarted -and $ride.taxi.exited -and $ride.taxi.returnedToService
  if (-not $taxiOk) { throw "Taxi passenger/runtime check failed: $($ride.taxi | ConvertTo-Json -Depth 8 -Compress)" }
  if (-not $ride.transitFixtures) { throw 'Streamed bus-stop collision fixture did not materialize.' }
  if ($ride.errors.Count -gt 0) { throw "Transit ride errors: $($ride.errors -join '; ')" }

  [PSCustomObject]@{
    initial = $snapshot
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
