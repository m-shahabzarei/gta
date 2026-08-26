param(
  [string]$Url = 'http://127.0.0.1:5173',
  [ValidateSet('phone', 'interact', 'enter-vehicle')]
  [string]$BoardingPath = 'phone'
)

$ErrorActionPreference = 'Stop'
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path -LiteralPath $chrome)) { throw 'Google Chrome is not installed.' }

$debugPort = 9231
$profile = Join-Path $env:TEMP "pixel-city-snapp-smoke-$PID"
$process = $null
$socket = $null

function Receive-Cdp([System.Net.WebSockets.ClientWebSocket]$connection) {
  $stream = [System.IO.MemoryStream]::new()
  try {
    do {
      $buffer = [byte[]]::new(1MB)
      $segment = [ArraySegment[byte]]::new($buffer)
      $result = $connection.ReceiveAsync(
        $segment,
        [Threading.CancellationToken]::None
      ).GetAwaiter().GetResult()
      $stream.Write($buffer, 0, $result.Count)
    } while (-not $result.EndOfMessage)
    return [Text.Encoding]::UTF8.GetString($stream.ToArray()) | ConvertFrom-Json
  } finally {
    $stream.Dispose()
  }
}

$script:cdpId = 0
function Invoke-Cdp(
  [System.Net.WebSockets.ClientWebSocket]$connection,
  [string]$method,
  [hashtable]$params = @{}
) {
  $script:cdpId += 1
  $id = $script:cdpId
  $payload = @{ id = $id; method = $method; params = $params } |
    ConvertTo-Json -Depth 16 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
  $connection.SendAsync(
    [ArraySegment[byte]]::new($bytes),
    [Net.WebSockets.WebSocketMessageType]::Text,
    $true,
    [Threading.CancellationToken]::None
  ).GetAwaiter().GetResult() | Out-Null
  do { $message = Receive-Cdp $connection } while ($message.id -ne $id)
  if ($message.error) { throw "CDP $method failed: $($message.error.message)" }
  return $message.result
}

function Evaluate-Cdp(
  [System.Net.WebSockets.ClientWebSocket]$connection,
  [string]$expression
) {
  $response = Invoke-Cdp $connection 'Runtime.evaluate' @{
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
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
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
  Invoke-Cdp $socket 'Page.bringToFront' | Out-Null
  Invoke-Cdp $socket 'Page.navigate' @{ url = $Url } | Out-Null

  $menuReady = $false
  for ($attempt = 0; $attempt -lt 180 -and -not $menuReady; $attempt++) {
    Start-Sleep -Milliseconds 500
    $menuReady = Evaluate-Cdp $socket @'
(() => window.game?.phaser?.scene?.getScenes(true)?.some(
  scene => scene.scene.key === 'MainMenuScene'
) ?? false)()
'@
  }
  if (-not $menuReady) { throw 'Main menu did not become ready.' }
  Evaluate-Cdp $socket @'
(() => {
  const scene = window.game?.phaser?.scene?.getScene?.('MainMenuScene');
  scene?.onNewGame?.();
  return Boolean(scene);
})()
'@ | Out-Null

  $ready = $false
  for ($attempt = 0; $attempt -lt 70 -and -not $ready; $attempt++) {
    Start-Sleep -Milliseconds 500
    $ready = Evaluate-Cdp $socket @'
(() => {
  const managers = window.game?.registry?.managers ?? [];
  const transit = managers.find(manager => manager.key === 'TransportationSystem');
  const player = managers.find(manager => manager.key === 'PlayerController')?.player;
  const snapshot = transit?.debugSnapshot?.();
  return Boolean(player && snapshot && snapshot.taxis?.length >= 16);
})()
'@
  }
  if (-not $ready) { throw 'Snapp runtime did not become ready.' }

  $runtimeExpression = @'
(async () => {
  const managers = window.game?.registry?.managers ?? [];
  const byKey = key => managers.find(manager => manager.key === key) ?? null;
  const transit = byKey('TransportationSystem');
  const traffic = byKey('TrafficSystem');
  const world = byKey('WorldManager');
  const occupants = byKey('VehicleOccupantSystem');
  const playerController = byKey('PlayerController');
  const gameManager = byKey('GameManager');
  const player = playerController?.player ?? null;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const movePlayer = point => {
    if (!player || !point) return false;
    player.sprite.setPosition(point.x, point.y);
    player.sprite.body?.reset?.(point.x, point.y);
    return true;
  };
  const result = {
    errors: [],
    pickup: {},
    dispatch: {},
    arrival: {},
    boarding: {},
  };
  const boardingPath = '__BOARDING_PATH__';
  if (!transit || !traffic || !world || !occupants || !playerController || !player) {
    result.errors.push('required managers unavailable');
    return result;
  }

  gameManager?.resumeGame?.();
  player.inventory.setMoney(Math.max(5000, player.inventory.money));
  const pickupSamples = [];
  const sampledRoads = new Set();
  const sampleStops = [...world.map.busStops]
    .filter(stop => stop.cityId === 'tehran')
    .sort((left, right) => left.id.localeCompare(right.id));
  for (const stop of sampleStops) {
    const request = { x: stop.x, y: stop.y };
    const nearestLane = traffic.roadNetwork?.nearestLane?.(request, undefined, true) ?? null;
    if (!nearestLane?.roadSegmentId || sampledRoads.has(nearestLane.roadSegmentId)) continue;
    const anchor = transit.resolveSnappPickupAnchor?.(request, 'tehran') ?? null;
    if (!anchor) continue;
    sampledRoads.add(nearestLane.roadSegmentId);
    pickupSamples.push({
      stopId: stop.id,
      nearestRoadSegmentId: nearestLane.roadSegmentId,
      anchorRoadSegmentId: anchor.roadSegmentId,
      laneId: anchor.laneId,
      displacementPx: Math.round(anchor.displacementPx * 10) / 10,
    });
    if (pickupSamples.length >= 10) break;
  }
  result.pickup.samples = pickupSamples;
  result.pickup.sampleMaximumDisplacementPx = pickupSamples.reduce(
    (maximum, sample) => Math.max(maximum, sample.displacementPx),
    0,
  );
  result.pickup.samplesValid =
    pickupSamples.length >= 10 &&
    pickupSamples.every(sample =>
      sample.nearestRoadSegmentId === sample.anchorRoadSegmentId &&
      sample.displacementPx <= 88
    );
  result.pickup.requestPosition = {
    x: Math.round(player.sprite.x * 10) / 10,
    y: Math.round(player.sprite.y * 10) / 10,
  };
  result.pickup.selectionStarted = transit.beginSnappSelection();
  let booking = transit.snappBooking;
  if (!result.pickup.selectionStarted || !booking?.pickupStop) {
    result.errors.push(`pickup selection failed: ${transit.snappError ?? 'unknown'}`);
    return result;
  }
  result.pickup.bookingId = booking.id;
  result.pickup.roadSegmentId = booking.pickupStop.roadSegmentId;
  result.pickup.laneId = booking.pickupStop.laneId;
  result.pickup.laneDistance = Math.round(booking.pickupStop.laneDistance * 10) / 10;
  result.pickup.displacementPx = Math.round(booking.pickupStop.displacementPx * 10) / 10;
  const pickupLane = traffic.roadNetwork?.lane?.(booking.pickupStop.laneId) ?? null;
  const behindDistance = pickupLane
    ? Math.min(pickupLane.spline.length - 1, booking.pickupStop.laneDistance + 80)
    : 0;
  const behindPose = pickupLane && behindDistance > booking.pickupStop.laneDistance + 2
    ? traffic.roadNetwork.pointAt(pickupLane, behindDistance)
    : null;
  const behindRoute = behindPose
    ? traffic.routePreviewToLaneStop(behindPose.point, {
        laneId: booking.pickupStop.laneId,
        laneDistance: booking.pickupStop.laneDistance,
        position: booking.pickupStop.position,
        heading: booking.pickupStop.heading,
      })
    : null;
  result.pickup.sameLaneBehindRouteLoops = Boolean(
    behindRoute &&
    behindRoute.distancePx > 0 &&
    behindRoute.laneIds.length > 1 &&
    behindRoute.laneIds[0] === booking.pickupStop.laneId &&
    behindRoute.laneIds[behindRoute.laneIds.length - 1] === booking.pickupStop.laneId
  );

  let quote = null;
  for (const destination of transit.snappDestinations(booking.cityId)) {
    quote = transit.previewSnappDestination(destination);
    if (quote) break;
  }
  if (!quote) {
    result.errors.push(`quote failed: ${transit.snappError ?? transit.snappBooking?.error ?? 'unknown'}`);
    return result;
  }
  const storedBeforePayment = transit.snappBooking?.pickupStop;
  result.pickup.anchorStableBeforePayment = Boolean(
    storedBeforePayment &&
    storedBeforePayment.roadSegmentId === booking.pickupStop.roadSegmentId &&
    storedBeforePayment.laneId === booking.pickupStop.laneId &&
    Math.abs(storedBeforePayment.laneDistance - booking.pickupStop.laneDistance) < 0.01
  );
  result.dispatch.payment = transit.confirmSnappBooking();
  booking = transit.snappBooking;
  if (result.dispatch.payment !== 'paid' || !booking?.assignedVehicleId) {
    result.errors.push(`dispatch failed: ${booking?.error ?? result.dispatch.payment}`);
    return result;
  }
  const bookingId = booking.id;
  const vehicleId = booking.assignedVehicleId;
  const taxi = transit.taxis?.get?.(vehicleId) ?? null;
  result.dispatch.bookingId = bookingId;
  result.dispatch.vehicleId = vehicleId;
  result.dispatch.state = booking.state;
  result.dispatch.turquoise = taxi?.vehicle?.sprite?.getData?.('serviceLivery') === 'snapp';
  result.dispatch.anchorStableAfterDispatch = Boolean(
    taxi?.pickupLaneStop &&
    taxi.pickupLaneStop.laneId === booking.pickupStop?.laneId &&
    Math.abs(taxi.pickupLaneStop.laneDistance - (booking.pickupStop?.laneDistance ?? -1)) < 0.01
  );
  if (!taxi) {
    result.errors.push('assigned taxi entity is missing');
    return result;
  }

  const arrivalDeadline = performance.now() + 100000;
  while (performance.now() < arrivalDeadline) {
    booking = transit.snappBooking;
    if (booking?.state !== 'DRIVER_EN_ROUTE') break;
    // Keep the real assigned entity in the live traffic tier without changing
    // the stored passenger pickup pose or the taxi's traffic-controlled pose.
    movePlayer({ x: taxi.vehicle.sprite.x + 120, y: taxi.vehicle.sprite.y + 120 });
    await pause(100);
  }
  booking = transit.snappBooking;
  const driver = traffic.driverFor(taxi.vehicle);
  const debug = driver?.debug ?? null;
  result.arrival.state = booking?.state ?? null;
  result.arrival.vehicleState = taxi.state;
  result.arrival.driverArrived = driver?.arrived ?? false;
  result.arrival.actualLaneId = debug?.laneId ?? null;
  result.arrival.actualLaneDistance = debug
    ? Math.round(debug.laneDistance * 10) / 10
    : null;
  result.arrival.speed = Math.round(Math.abs(taxi.vehicle.movement.speed) * 100) / 100;
  result.arrival.anchorErrorPx = booking?.pickupStop
    ? Math.round(Math.hypot(
        taxi.vehicle.sprite.x - booking.pickupStop.position.x,
        taxi.vehicle.sprite.y - booking.pickupStop.position.y,
      ) * 10) / 10
    : null;
  if (booking?.state !== 'DRIVER_ARRIVED') {
    result.errors.push(`driver did not arrive: ${booking?.state ?? 'missing booking'} / ${booking?.error ?? 'no error'}`);
    return result;
  }

  const actualApproach = transit.resolveActualSnappBoardingApproach?.(taxi) ?? null;
  if (!actualApproach?.ok) {
    result.errors.push(`actual rear-right approach unavailable: ${actualApproach?.reason ?? 'unknown'}`);
    return result;
  }
  movePlayer({ x: actualApproach.position.x + 180, y: actualApproach.position.y + 180 });
  await pause(100);
  result.boarding.farResult = transit.requestSnappBoarding(vehicleId);
  result.boarding.stateAfterFarAttempt = transit.snappBooking?.state ?? null;

  movePlayer(actualApproach.position);
  await pause(100);
  result.boarding.prompt = transit.interactionAt(player.position)?.prompt ?? null;
  result.boarding.path = boardingPath;
  if (boardingPath === 'interact') {
    transit.handlePlayerInteraction(player.position);
    result.boarding.accepted = {
      ok: transit.snappBooking?.state === 'PASSENGER_BOARDING',
    };
  } else if (boardingPath === 'enter-vehicle') {
    playerController.tryEnterVehicle(player);
    result.boarding.accepted = {
      ok: transit.snappBooking?.state === 'PASSENGER_BOARDING',
    };
  } else {
    result.boarding.accepted = transit.requestSnappBoarding(vehicleId);
  }
  result.boarding.immediateState = transit.snappBooking?.state ?? null;

  const boardingDeadline = performance.now() + 7000;
  while (performance.now() < boardingDeadline) {
    if (
      transit.snappBooking?.state === 'RIDING' &&
      playerController.playerIsTransitPassenger &&
      playerController.currentVehicle?.id === vehicleId
    ) break;
    await pause(50);
  }
  const finalBooking = transit.snappBooking;
  result.boarding.finalState = finalBooking?.state ?? null;
  result.boarding.sameBookingId = finalBooking?.id === bookingId;
  result.boarding.sameVehicleId = finalBooking?.assignedVehicleId === vehicleId;
  result.boarding.passenger = playerController.playerIsTransitPassenger;
  result.boarding.passengerVehicleId = playerController.currentVehicle?.id ?? null;
  result.boarding.passengerSeat = playerController.currentPassengerSeat ?? null;
  result.boarding.driverControl = playerController.playerIsDriving;
  return result;
})()
'@
  $runtimeExpression = $runtimeExpression.Replace('__BOARDING_PATH__', $BoardingPath)
  $result = Evaluate-Cdp $socket $runtimeExpression

  $farFailureCorrect =
    $result.boarding.farResult.ok -eq $false -and
    $result.boarding.farResult.reason -eq 'too-far-from-door' -and
    $result.boarding.stateAfterFarAttempt -eq 'DRIVER_ARRIVED'
  $boardingCorrect =
    $result.boarding.accepted.ok -eq $true -and
    $result.boarding.immediateState -eq 'PASSENGER_BOARDING' -and
    $result.boarding.finalState -eq 'RIDING' -and
    $result.boarding.sameBookingId -and
    $result.boarding.sameVehicleId -and
    $result.boarding.passenger -and
    $result.boarding.passengerVehicleId -eq $result.dispatch.vehicleId -and
    $result.boarding.passengerSeat -eq 'rear-right' -and
    -not $result.boarding.driverControl
  $pickupCorrect =
    $result.pickup.selectionStarted -and
    $result.pickup.samplesValid -and
    $result.pickup.displacementPx -le 88 -and
    $result.pickup.sameLaneBehindRouteLoops -and
    $result.pickup.anchorStableBeforePayment -and
    $result.dispatch.anchorStableAfterDispatch -and
    $result.dispatch.turquoise
  $arrivalCorrect =
    $result.arrival.state -eq 'DRIVER_ARRIVED' -and
    $result.arrival.actualLaneId -eq $result.pickup.laneId -and
    $result.arrival.anchorErrorPx -le 30 -and
    $result.arrival.speed -le 3.5

  if (@($result.errors).Count -gt 0) {
    throw "Snapp runtime errors: $($result.errors -join '; ')"
  }
  if (-not $pickupCorrect) {
    throw "Snapp pickup persistence check failed: $($result | ConvertTo-Json -Depth 10 -Compress)"
  }
  if (-not $arrivalCorrect) {
    throw "Snapp exact-arrival check failed: $($result | ConvertTo-Json -Depth 10 -Compress)"
  }
  if (-not $farFailureCorrect -or -not $boardingCorrect) {
    throw "Snapp transactional boarding check failed: $($result | ConvertTo-Json -Depth 10 -Compress)"
  }
  $result | ConvertTo-Json -Depth 10
} finally {
  if ($socket) {
    try { $socket.Dispose() } catch {}
  }
  if ($process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $profile) {
    $resolvedProfile = [IO.Path]::GetFullPath($profile)
    $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($resolvedProfile.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $resolvedProfile -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}
