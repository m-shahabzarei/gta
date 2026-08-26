param(
  [string]$Url = 'http://127.0.0.1:5173',
  [ValidateRange(5, 3600)]
  [int]$DurationSeconds = 60,
  [ValidateRange(1, 240)]
  [int]$SimulatedMinutes = 30,
  [ValidateRange(0.25, 10)]
  [double]$SimulatedSecondsPerTick = 3,
  [ValidateRange(1000, 65000)]
  [int]$DebugPort = 9333,
  [string]$OutputPath = '.traffic-stress/browser-stress.json',
  [switch]$DisableGpu
)

$ErrorActionPreference = 'Stop'
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path -LiteralPath $chrome)) { throw 'Google Chrome is not installed.' }

$profile = Join-Path $env:TEMP "pixel-city-stress-$PID"
$process = $null
$socket = $null
$targetTicks = [int][Math]::Ceiling(($SimulatedMinutes * 60) / $SimulatedSecondsPerTick)
$phase = 'not-started'
$status = 'not-started'
$samples = New-Object System.Collections.Generic.List[object]

function Save-StressTelemetry(
  [string]$FinalStatus,
  [string]$ErrorMessage = $null
) {
  $resolvedOutput = [IO.Path]::GetFullPath($OutputPath)
  $outputDirectory = Split-Path -Parent $resolvedOutput
  if ($outputDirectory) { New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null }
  $payload = @{
    status = $FinalStatus
    phase = $phase
    error = $ErrorMessage
    targetSimulatedMinutes = $SimulatedMinutes
    samples = $samples.ToArray()
  }
  Set-Content -LiteralPath $resolvedOutput -Value ($payload | ConvertTo-Json -Depth 30) -Encoding UTF8
}

function Receive-Cdp(
  [System.Net.WebSockets.ClientWebSocket]$Socket,
  [int]$TimeoutMs = 8000
) {
  $stream = [System.IO.MemoryStream]::new()
  $cts = [Threading.CancellationTokenSource]::new($TimeoutMs)
  try {
    do {
      $buffer = [byte[]]::new(1MB)
      $segment = [ArraySegment[byte]]::new($buffer)
      $result = $Socket.ReceiveAsync($segment, $cts.Token).GetAwaiter().GetResult()
      $stream.Write($buffer, 0, $result.Count)
    } while (-not $result.EndOfMessage)
    return [Text.Encoding]::UTF8.GetString($stream.ToArray()) | ConvertFrom-Json
  } finally {
    $cts.Dispose()
    $stream.Dispose()
  }
}

$script:cdpId = 0
function Invoke-Cdp(
  [System.Net.WebSockets.ClientWebSocket]$Socket,
  [string]$Method,
  [hashtable]$Params = @{},
  [int]$TimeoutMs = 8000
) {
  $script:cdpId += 1
  $id = $script:cdpId
  $payload = @{ id = $id; method = $Method; params = $Params } |
    ConvertTo-Json -Depth 20 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
  $Socket.SendAsync(
    [ArraySegment[byte]]::new($bytes),
    [Net.WebSockets.WebSocketMessageType]::Text,
    $true,
    [Threading.CancellationToken]::None
  ).GetAwaiter().GetResult() | Out-Null
  do {
    $message = Receive-Cdp $Socket $TimeoutMs
  } while ($message.id -ne $id)
  if ($message.error) { throw "CDP $Method failed: $($message.error.message)" }
  return $message.result
}

function Evaluate-Cdp(
  [System.Net.WebSockets.ClientWebSocket]$Socket,
  [string]$Expression,
  [int]$TimeoutMs = 8000
) {
  $response = Invoke-Cdp $Socket 'Runtime.evaluate' @{
    expression = $Expression
    returnByValue = $true
    awaitPromise = $true
  } $TimeoutMs
  return $response.result.value
}

try {
  $phase = 'chrome-startup'
  New-Item -ItemType Directory -Path $profile | Out-Null
  $args = @(
    '--headless=new',
    '--hide-scrollbars',
    "--remote-debugging-port=$DebugPort",
    "--user-data-dir=$profile",
    '--window-size=1280,720',
    'about:blank'
  )
  if ($DisableGpu) { $args = @('--disable-gpu') + $args }
  $process = Start-Process -FilePath $chrome -ArgumentList $args -WindowStyle Hidden -PassThru

  $targets = $null
  for ($attempt = 0; $attempt -lt 80 -and -not $targets; $attempt++) {
    Start-Sleep -Milliseconds 100
    try {
      $targets = Invoke-RestMethod "http://127.0.0.1:$DebugPort/json"
    } catch {
      $targets = $null
    }
  }
  $target = $targets | Where-Object { $_.type -eq 'page' } | Select-Object -First 1
  if (-not $target) { throw 'Chrome DevTools target did not start.' }

  $phase = 'cdp-connect'
  $socket = [System.Net.WebSockets.ClientWebSocket]::new()
  $socket.ConnectAsync(
    [Uri]$target.webSocketDebuggerUrl,
    [Threading.CancellationToken]::None
  ).GetAwaiter().GetResult()
  Invoke-Cdp $socket 'Page.enable' | Out-Null
  Invoke-Cdp $socket 'Runtime.enable' | Out-Null
  Invoke-Cdp $socket 'Page.addScriptToEvaluateOnNewDocument' @{
    source = @'
window.__stressErrors = [];
window.addEventListener('error', event => {
  window.__stressErrors.push(String(event.error?.stack || event.error || event.message));
});
window.addEventListener('unhandledrejection', event => {
  window.__stressErrors.push(String(event.reason?.stack || event.reason));
});
const __stressConsoleError = console.error;
console.error = (...args) => {
  window.__stressErrors.push(args.map(String).join(' '));
  __stressConsoleError(...args);
};
'@
  } | Out-Null

  $phase = 'navigate'
  Invoke-Cdp $socket 'Page.navigate' @{ url = $Url } | Out-Null
  Start-Sleep -Seconds 4
  Invoke-Cdp $socket 'Input.dispatchMouseEvent' @{
    type = 'mousePressed'
    x = 640
    y = 432
    button = 'left'
    clickCount = 1
  } | Out-Null
  Invoke-Cdp $socket 'Input.dispatchMouseEvent' @{
    type = 'mouseReleased'
    x = 640
    y = 432
    button = 'left'
    clickCount = 1
  } | Out-Null
  Start-Sleep -Seconds 1
  Evaluate-Cdp $socket @'
(() => {
  const active = window.game?.phaser?.scene?.getScenes(true)?.map(scene => scene.scene.key) ?? [];
  if (active.includes('MainMenuScene')) window.game.phaser.scene.getScene('MainMenuScene').onNewGame();
  return active;
})()
'@ | Out-Null

  $phase = 'wait-game-ready'
  $ready = $false
  for ($attempt = 0; $attempt -lt 30 -and -not $ready; $attempt++) {
    Start-Sleep -Seconds 1
    $ready = Evaluate-Cdp $socket @'
(() => {
  const game = window.game;
  const scenes = game?.phaser?.scene?.getScenes(true)?.map(scene => scene.scene.key) ?? [];
  const managers = game?.registry?.managers ?? [];
  return scenes.includes('GameScene') && managers.some(manager => manager.key === 'TrafficSystem');
})()
'@
  }
  if (-not $ready) { throw 'Game scene did not become ready.' }

  $phase = 'stress-setup'
  Evaluate-Cdp $socket @'
(() => {
  const managers = window.game.registry.managers;
  const byKey = key => managers.find(manager => manager.key === key);
  const playerCtrl = byKey('PlayerController');
  const world = byKey('WorldManager');
  const traffic = byKey('TrafficSystem');
  const pedestrians = byKey('PedestrianSystem');
  const wanted = byKey('WantedSystem');
  const weather = byKey('WeatherSystem');
  weather?.setWeather?.('storm');
  wanted?.deserialize?.({ level: 6 });
  window.__stressTick = 0;
  const cityCenters = world.map.cities.map(city => city.center);
  const sampledRoads = world.map.roadSpawns.filter((_, index) => index % 250 === 0).slice(0, 18);
  const route = [world.map.playerStart, ...cityCenters, ...sampledRoads];
  window.__stressRoutePoint = route[0];
  clearInterval(window.__stressInterval);
  window.__stressInterval = setInterval(() => {
    try {
      window.__stressTick += 1;
      if (window.__stressTick === 1 || window.__stressTick % 50 === 0) {
        window.__stressRoutePoint =
          route[Math.floor(window.__stressTick / 50) % route.length] || world.map.playerStart;
      }
      const point = window.__stressRoutePoint || world.map.playerStart;
      const player = playerCtrl?.player;
      if (player?.sprite) {
        player.sprite.setPosition(point.x, point.y);
        player.sprite.body?.reset?.(point.x, point.y);
      }
      weather?.setWeather?.(window.__stressTick % 3 === 0 ? 'storm' : 'rain');
      wanted?.deserialize?.({ level: 6 });
      const pos = playerCtrl?.playerPosition || point;
      for (let i = 0; i < 3; i += 1) {
        const p =
          world.randomSidewalkPointNear?.(pos.x, pos.y, 760) ||
          world.randomSidewalkPoint?.();
        if (p) pedestrians?.spawnAt?.(p.x, p.y);
      }
      for (let i = 0; i < 3; i += 1) {
        const r =
          world.randomRoadPointNear?.(pos.x, pos.y, 1100) ||
          world.randomRoadPoint?.();
        if (r) {
          traffic?.spawnServiceVehicle?.(
            i === 0 ? 'ambulance' : i === 1 ? 'police' : 'taxi',
            r,
            () => playerCtrl?.playerPosition ?? null,
            64,
          );
        }
      }
    } catch (error) {
      window.__stressErrors.push(String(error?.stack || error));
    }
  }, 100);
  return true;
})()
'@ | Out-Null

  $phase = 'sampling'
  for ($second = 0; $second -lt $DurationSeconds; $second++) {
    Start-Sleep -Seconds 1
    try {
      $sample = Evaluate-Cdp $socket @'
(() => {
  const game = window.game;
  const managers = game?.registry?.managers ?? [];
  const byKey = key => managers.find(manager => manager.key === key);
  const traffic = byKey('TrafficSystem');
  const entity = byKey('EntityManager');
  const profiler = byKey('ProfilerSystem');
  const trafficSnapshot = traffic?.trafficDebugSnapshot?.() || null;
  const profilerSnapshot = profiler?.snapshot || null;
  const diagnostics = window.__engineDiagnostics?.() || profilerSnapshot?.engineDiagnostics || null;
  return {
    tick: window.__stressTick || 0,
    frame: game?.phaser?.loop?.frame || 0,
    fps: game?.phaser?.loop?.actualFps || 0,
    errors: (window.__stressErrors || []).slice(-8),
    traffic: trafficSnapshot ? {
      phase: trafficSnapshot.phase,
      stats: trafficSnapshot.stats,
      validationPassed: trafficSnapshot.validation?.passed === true,
      validationFailures: trafficSnapshot.validation?.failures?.length || 0,
      selected: trafficSnapshot.selected ? {
        vehicleId: trafficSnapshot.selected.vehicleId,
        state: trafficSnapshot.selected.state,
        laneId: trafficSnapshot.selected.laneId,
        routeLength: trafficSnapshot.selected.route?.length || 0,
      } : null,
    } : null,
    profiler: profilerSnapshot ? {
      fps: profilerSnapshot.fps,
      frameMs: profilerSnapshot.frameMs,
      cpuMs: profilerSnapshot.cpuMs,
      memoryMb: profilerSnapshot.memoryMb,
      loadedChunks: profilerSnapshot.loadedChunks,
      loadedNpcs: profilerSnapshot.loadedNpcs,
      activeNpcs: profilerSnapshot.activeNpcs,
      loadedVehicles: profilerSnapshot.loadedVehicles,
      activeVehicles: profilerSnapshot.activeVehicles,
      particleCount: profilerSnapshot.particleCount,
      queuedPaths: profilerSnapshot.queuedPaths,
      gameState: profilerSnapshot.gameState,
      trafficState: profilerSnapshot.trafficState,
      aiSchedulerState: profilerSnapshot.aiSchedulerState,
    } : null,
    diagnostics: diagnostics ? {
      engineState: diagnostics.engineState,
      currentUpdatePhase: diagnostics.currentUpdatePhase,
      currentSystem: diagnostics.currentSystem,
      lastCompletedSystem: diagnostics.lastCompletedSystem,
      blockingSystem: diagnostics.blockingSystem,
      recentErrors: diagnostics.recentErrors?.length || 0,
      recentLimits: diagnostics.recentLimits?.length || 0,
      eventDrops: diagnostics.eventBus?.droppedEvents || 0,
      listenerErrors: diagnostics.eventBus?.listenerErrors || 0,
    } : null,
    entities: entity?.stats || null,
  };
})()
'@ 5000
      $samples.Add($sample) | Out-Null
      $unexpectedSampleErrors = @($sample.errors | Where-Object { $_ -notlike '*pointer lock*' })
      if ($unexpectedSampleErrors.Count -gt 0) { break }
      if (($sample.tick -as [int]) -ge $targetTicks) { break }
    } catch {
      $tail = $samples.ToArray() | Select-Object -Last 5
      $status = 'infrastructure-timeout'
      Save-StressTelemetry $status $_.Exception.Message
      Write-Output (@{
        status = $status
        frozen = $true
        freezeAtSecond = $second
        error = $_.Exception.Message
        samples = $tail
      } | ConvertTo-Json -Depth 20)
      throw
    }
  }

  $phase = 'finalize'
  $final = Evaluate-Cdp $socket @'
(() => {
  clearInterval(window.__stressInterval);
  return {
    errors: window.__stressErrors || [],
    tick: window.__stressTick || 0,
    frame: window.game?.phaser?.loop?.frame || 0,
  };
})()
'@ 5000
  $tail = $samples.ToArray() | Select-Object -Last 5
  $simulatedMinutesCompleted = [Math]::Round((($final.tick -as [double]) * $SimulatedSecondsPerTick) / 60, 2)
  $status = 'passed'
  Write-Output (@{
    status = $status
    frozen = $false
    targetSimulatedMinutes = $SimulatedMinutes
    simulatedMinutesCompleted = $simulatedMinutesCompleted
    final = $final
    samples = $tail
  } | ConvertTo-Json -Depth 20)

  if (($final.tick -as [int]) -lt $targetTicks) {
    $status = 'gameplay-failure'
    Save-StressTelemetry $status "Stress did not reach target simulated time: $simulatedMinutesCompleted of $SimulatedMinutes minutes."
    throw "Stress did not reach target simulated time: $simulatedMinutesCompleted of $SimulatedMinutes minutes."
  }

  $unexpectedErrors = @($final.errors | Where-Object { $_ -notlike '*pointer lock*' })
  if ($unexpectedErrors.Count -gt 0) {
    $status = 'gameplay-failure'
    Save-StressTelemetry $status "Stress errors: $($unexpectedErrors -join '; ')"
    throw "Stress errors: $($unexpectedErrors -join '; ')"
  }
  $phase = 'complete'
  Save-StressTelemetry $status $null
} catch {
  if ($status -eq 'not-started') {
    $message = $_.Exception.Message
    $status = if ($message -match 'ReceiveAsync|WebSocket|CDP|timeout|operation was canceled|operation has been canceled|target did not start|did not become ready') {
      'infrastructure-timeout'
    } else {
      'infrastructure-failure'
    }
    Save-StressTelemetry $status $message
  }
  throw
} finally {
  if ($socket) { $socket.Dispose() }
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force }
  $resolvedProfile = [IO.Path]::GetFullPath($profile)
  $resolvedTemp = [IO.Path]::GetFullPath($env:TEMP)
  if (
    $resolvedProfile.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -and
    (Test-Path -LiteralPath $resolvedProfile)
  ) {
    Get-CimInstance Win32_Process |
      Where-Object { $_.CommandLine -like "*$resolvedProfile*" } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500
    Remove-Item -LiteralPath $resolvedProfile -Recurse -Force -ErrorAction SilentlyContinue
  }
}
