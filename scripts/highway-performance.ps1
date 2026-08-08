param(
  [string]$Url = 'http://127.0.0.1:5173',
  [string]$Output = 'highway-performance.json',
  [string]$ScreenshotPrefix = '',
  [ValidateRange(1000, 65000)]
  [int]$DebugPort = 9341
)

$ErrorActionPreference = 'Stop'
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path -LiteralPath $chrome)) { throw 'Google Chrome is not installed.' }

$profile = Join-Path $env:TEMP "pixel-city-highway-profile-$PID"
$process = $null
$socket = $null

function Receive-Cdp([System.Net.WebSockets.ClientWebSocket]$Socket, [int]$TimeoutMs = 10000) {
  $stream = [System.IO.MemoryStream]::new()
  $cts = [Threading.CancellationTokenSource]::new($TimeoutMs)
  try {
    do {
      $buffer = [byte[]]::new(1MB)
      $result = $Socket.ReceiveAsync(
        [ArraySegment[byte]]::new($buffer),
        $cts.Token
      ).GetAwaiter().GetResult()
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
  [int]$TimeoutMs = 10000
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
  do { $message = Receive-Cdp $Socket $TimeoutMs } while ($message.id -ne $id)
  if ($message.error) { throw "CDP $Method failed: $($message.error.message)" }
  return $message.result
}

function Evaluate-Cdp(
  [System.Net.WebSockets.ClientWebSocket]$Socket,
  [string]$Expression,
  [int]$TimeoutMs = 10000
) {
  $response = Invoke-Cdp $Socket 'Runtime.evaluate' @{
    expression = $Expression
    returnByValue = $true
    awaitPromise = $true
  } $TimeoutMs
  if ($response.exceptionDetails) {
    throw "Browser evaluation failed: $($response.exceptionDetails.text)"
  }
  return $response.result.value
}

function Get-Sample([System.Net.WebSockets.ClientWebSocket]$Socket, [string]$Label) {
  return Evaluate-Cdp $Socket @"
(() => {
  const managers = window.game?.registry?.managers ?? [];
  const byKey = key => managers.find(manager => manager.key === key);
  const world = byKey('WorldManager');
  const traffic = byKey('TrafficSystem')?.trafficDebugSnapshot?.() ?? null;
  const profiler = window.__engineProfiler?.() ?? null;
  const frames = (window.__highwayPerf?.frames ?? []).slice().sort((a, b) => a - b);
  const percentile = amount => frames.length
    ? frames[Math.min(frames.length - 1, Math.floor((frames.length - 1) * amount))]
    : 0;
  const sample = {
    label: '$Label',
    frames: {
      count: frames.length,
      averageMs: frames.length ? frames.reduce((sum, value) => sum + value, 0) / frames.length : 0,
      p95Ms: percentile(0.95),
      p99Ms: percentile(0.99),
      maxMs: frames.at(-1) ?? 0,
      over33Ms: frames.filter(value => value > 33.34).length,
      over50Ms: frames.filter(value => value > 50).length,
      over100Ms: frames.filter(value => value > 100).length,
    },
    longTasks: (window.__highwayPerf?.longTasks ?? []).slice(),
    probes: structuredClone(window.__highwayPerf?.probes ?? {}),
    profiler: profiler ? {
      fps: profiler.fps,
      frameMs: profiler.frameMs,
      cpuMs: profiler.cpuMs,
      gpuMs: profiler.gpuMs,
      renderMs: profiler.renderMs,
      physicsMs: profiler.physicsMs,
      memoryMb: profiler.memoryMb,
      drawCalls: profiler.drawCalls,
      pathfindingMs: profiler.pathfindingMs,
      streamingMs: profiler.streamingMs,
      loadedChunks: profiler.loadedChunks,
      loadedNpcs: profiler.loadedNpcs,
      activeNpcs: profiler.activeNpcs,
      sleepingNpcs: profiler.sleepingNpcs,
      loadedVehicles: profiler.loadedVehicles,
      activeVehicles: profiler.activeVehicles,
      sleepingVehicles: profiler.sleepingVehicles,
      physicsBodies: profiler.physicsBodies,
      nearEntities: profiler.nearEntities,
      mediumEntities: profiler.mediumEntities,
      farEntities: profiler.farEntities,
      veryFarEntities: profiler.veryFarEntities,
      dormantEntities: profiler.dormantEntities,
      trafficAiMs: profiler.trafficAiMs,
      trafficNavigationMs: profiler.trafficNavigationMs,
      trafficCollisionMs: profiler.trafficCollisionMs,
      highwayChunkBuildMs: profiler.highwayChunkBuildMs,
      highwayMaximumBuildMs: profiler.highwayMaximumBuildMs,
    } : null,
    traffic: traffic ? {
      schedulerCpuMs: traffic.stats?.trafficCpuMs ?? 0,
      navigationMs: traffic.stats?.navigationCpuMs ?? 0,
      collisionMs: traffic.stats?.collisionCpuMs ?? 0,
      activeDrivers: traffic.stats?.activeDrivers ?? 0,
      virtualVehicles: traffic.stats?.virtualVehicles ?? 0,
      nearVehicles: traffic.stats?.nearSimulationVehicles ?? 0,
      mediumVehicles: traffic.stats?.mediumSimulationVehicles ?? 0,
      farVehicles: traffic.stats?.farSimulationVehicles ?? 0,
      frozenVehicles: traffic.stats?.frozenSimulationVehicles ?? 0,
    } : null,
    highway: world?.highwayRenderStats ?? null,
    loadedRegions: world?.loadedRegionCounts ?? {},
  };
  window.__highwayPerf.frames.length = 0;
  window.__highwayPerf.longTasks.length = 0;
  for (const probe of Object.values(window.__highwayPerf.probes)) {
    probe.calls = 0;
    probe.totalMs = 0;
    probe.maxMs = 0;
  }
  return sample;
})()
"@
}

try {
  New-Item -ItemType Directory -Path $profile | Out-Null
  $process = Start-Process -FilePath $chrome -ArgumentList @(
    '--headless=new',
    '--hide-scrollbars',
    '--enable-gpu',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    "--remote-debugging-port=$DebugPort",
    "--user-data-dir=$profile",
    '--window-size=1280,720',
    'about:blank'
  ) -WindowStyle Hidden -PassThru

  $targets = $null
  for ($attempt = 0; $attempt -lt 80 -and -not $targets; $attempt++) {
    Start-Sleep -Milliseconds 100
    try { $targets = Invoke-RestMethod "http://127.0.0.1:$DebugPort/json" } catch { $targets = $null }
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
  Invoke-Cdp $socket 'Page.addScriptToEvaluateOnNewDocument' @{
    source = @'
window.__highwayPerf = { frames: [], longTasks: [], probes: {}, errors: [] };
let __highwayPreviousFrame = performance.now();
requestAnimationFrame(function __highwayFrame(now) {
  window.__highwayPerf.frames.push(now - __highwayPreviousFrame);
  __highwayPreviousFrame = now;
  requestAnimationFrame(__highwayFrame);
});
try {
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      window.__highwayPerf.longTasks.push({ startMs: entry.startTime, durationMs: entry.duration });
    }
  }).observe({ type: 'longtask', buffered: true });
} catch {}
window.addEventListener('error', event => window.__highwayPerf.errors.push(String(event.error?.stack || event.error || event.message)));
window.addEventListener('unhandledrejection', event => window.__highwayPerf.errors.push(String(event.reason?.stack || event.reason)));
'@
  } | Out-Null
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
  return true;
})()
'@ 60000 | Out-Null

  $ready = $false
  for ($attempt = 0; $attempt -lt 60 -and -not $ready; $attempt++) {
    Start-Sleep -Seconds 1
    $ready = Evaluate-Cdp $socket @'
(() => (window.game?.phaser?.scene?.getScenes(true) ?? []).some(scene => scene.scene.key === 'GameScene'))()
'@
  }
  if (-not $ready) { throw 'Game scene did not become ready.' }

  Evaluate-Cdp $socket @'
(() => {
  const world = (window.game?.registry?.managers ?? []).find(manager => manager.key === 'WorldManager');
  for (const name of ['buildChunk', 'paintHighwayChunk', 'decorateTile', 'isMainHighwayCorridor', 'isHighwayPavement']) {
    const original = world?.[name];
    if (typeof original !== 'function') continue;
    window.__highwayPerf.probes[name] = { calls: 0, totalMs: 0, maxMs: 0 };
    world[name] = function(...args) {
      const startedAt = performance.now();
      try { return original.apply(this, args); }
      finally {
        const elapsed = performance.now() - startedAt;
        const probe = window.__highwayPerf.probes[name];
        probe.calls += 1;
        probe.totalMs += elapsed;
        probe.maxMs = Math.max(probe.maxMs, elapsed);
      }
    };
  }
  window.__highwayPerf.frames.length = 0;
  window.__highwayPerf.longTasks.length = 0;
  return true;
})()
'@ | Out-Null

  Start-Sleep -Seconds 3
  $samples = @((Get-Sample $socket 'city-settled'))
  $routes = @('national-1-alborz', 'national-7-desert', 'national-22-caspian')
  foreach ($routeId in $routes) {
    Evaluate-Cdp $socket @"
(() => {
  const managers = window.game?.registry?.managers ?? [];
  const world = managers.find(manager => manager.key === 'WorldManager');
  const player = managers.find(manager => manager.key === 'PlayerController')?.player;
  const route = world?.map?.highways?.find(candidate => candidate.id === '$routeId');
  const point = route?.points?.[Math.floor((route?.points?.length ?? 1) / 2)];
  if (!player?.sprite || !point) return false;
  player.sprite.setPosition(point.x, point.y);
  player.sprite.body?.reset?.(point.x, point.y);
  return true;
})()
"@ | Out-Null
    Start-Sleep -Seconds 2
    $samples += Get-Sample $socket "$routeId-transition"
    Start-Sleep -Seconds 3
    $samples += Get-Sample $socket "$routeId-settled"
    if ($ScreenshotPrefix) {
      $screenshot = Invoke-Cdp $socket 'Page.captureScreenshot' @{ format = 'png'; fromSurface = $true }
      $path = Join-Path (Get-Location) "$ScreenshotPrefix-$routeId.png"
      [IO.File]::WriteAllBytes($path, [Convert]::FromBase64String($screenshot.data))
      if ($routeId -eq 'national-1-alborz') {
        Evaluate-Cdp $socket @'
(() => {
  const managers = window.game?.registry?.managers ?? [];
  const world = managers.find(manager => manager.key === 'WorldManager');
  const player = managers.find(manager => manager.key === 'PlayerController')?.player;
  const route = world?.map?.highways?.find(candidate => candidate.id === 'national-1-alborz');
  const point = route?.carriageways?.[0]?.points?.[0];
  if (!player?.sprite || !point) return false;
  player.sprite.setPosition(point.x, point.y);
  player.sprite.body?.reset?.(point.x, point.y);
  return true;
})()
'@ | Out-Null
        Start-Sleep -Seconds 4
        $rampShot = Invoke-Cdp $socket 'Page.captureScreenshot' @{ format = 'png'; fromSurface = $true }
        $rampPath = Join-Path (Get-Location) "$ScreenshotPrefix-$routeId-ramp.png"
        [IO.File]::WriteAllBytes($rampPath, [Convert]::FromBase64String($rampShot.data))
      }
    }
    if ($routeId -eq 'national-1-alborz') {
      Evaluate-Cdp $socket @'
(() => {
  const managers = window.game?.registry?.managers ?? [];
  const world = managers.find(manager => manager.key === 'WorldManager');
  const player = managers.find(manager => manager.key === 'PlayerController')?.player;
  const route = world?.map?.highways?.find(candidate => candidate.id === 'national-1-alborz');
  const middle = Math.floor((route?.points?.length ?? 1) / 2);
  const point = route?.points?.[Math.max(0, middle - 20)];
  if (!player?.sprite || !point) return false;
  player.sprite.setPosition(point.x, point.y);
  player.sprite.body?.reset?.(point.x, point.y);
  return true;
})()
'@ | Out-Null
      Start-Sleep -Seconds 2
      Get-Sample $socket 'driven-crossing-warmup' | Out-Null
      Evaluate-Cdp $socket @'
new Promise(resolve => {
  const managers = window.game?.registry?.managers ?? [];
  const world = managers.find(manager => manager.key === 'WorldManager');
  const player = managers.find(manager => manager.key === 'PlayerController')?.player;
  const route = world?.map?.highways?.find(candidate => candidate.id === 'national-1-alborz');
  const middle = Math.floor((route?.points?.length ?? 1) / 2);
  let index = Math.max(0, middle - 20);
  const end = Math.min((route?.points?.length ?? 1) - 1, middle + 28);
  const timer = setInterval(() => {
    const point = route?.points?.[index++];
    if (player?.sprite && point) {
      player.sprite.setPosition(point.x, point.y);
      player.sprite.body?.reset?.(point.x, point.y);
    }
    if (index > end) {
      clearInterval(timer);
      resolve(true);
    }
  }, 120);
})
'@ 10000 | Out-Null
      $samples += Get-Sample $socket 'national-1-alborz-driven-crossing'
    }
  }

  $report = [ordered]@{
    generatedAt = [DateTime]::UtcNow.ToString('o')
    url = $Url
    samples = $samples
    browserErrors = Evaluate-Cdp $socket 'window.__highwayPerf.errors'
  }
  $json = $report | ConvertTo-Json -Depth 20
  [IO.File]::WriteAllText((Join-Path (Get-Location) $Output), $json)
  Write-Output $json
  $unexpectedErrors = @($report.browserErrors | Where-Object { $_ -notlike '*pointer lock*' })
  if ($unexpectedErrors.Count -gt 0) { throw 'Browser errors occurred during profiling.' }
} finally {
  if ($socket) { $socket.Dispose() }
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force }
  if (Test-Path -LiteralPath $profile) {
    Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$profile*" } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 300
    Remove-Item -LiteralPath $profile -Recurse -Force -ErrorAction SilentlyContinue
  }
}
