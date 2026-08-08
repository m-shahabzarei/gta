param(
  [string]$Url = 'http://127.0.0.1:5173',
  [string]$Screenshot = 'mobile-landscape-smoke.png'
)

$ErrorActionPreference = 'Stop'
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path -LiteralPath $chrome)) { throw 'Google Chrome is not installed.' }

$debugPort = 9320 + ($PID % 200)
$profile = Join-Path $env:TEMP "pixel-city-mobile-smoke-$PID"
$process = $null
$socket = $null

function Receive-Cdp([System.Net.WebSockets.ClientWebSocket]$ws) {
  $stream = [IO.MemoryStream]::new()
  try {
    do {
      $buffer = [byte[]]::new(1MB)
      $result = $ws.ReceiveAsync(
        [ArraySegment[byte]]::new($buffer),
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
  [System.Net.WebSockets.ClientWebSocket]$ws,
  [string]$method,
  [hashtable]$params = @{}
) {
  $script:cdpId += 1
  $id = $script:cdpId
  $payload = @{ id = $id; method = $method; params = $params } | ConvertTo-Json -Depth 20 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
  $ws.SendAsync(
    [ArraySegment[byte]]::new($bytes),
    [Net.WebSockets.WebSocketMessageType]::Text,
    $true,
    [Threading.CancellationToken]::None
  ).GetAwaiter().GetResult() | Out-Null
  do { $message = Receive-Cdp $ws } while ($message.id -ne $id)
  if ($message.error) { throw "CDP $method failed: $($message.error.message)" }
  return $message.result
}

function Evaluate-Cdp([System.Net.WebSockets.ClientWebSocket]$ws, [string]$expression) {
  $response = Invoke-Cdp $ws 'Runtime.evaluate' @{
    expression = $expression
    returnByValue = $true
    awaitPromise = $true
  }
  if ($response.exceptionDetails) { throw "Browser evaluation failed: $($response.exceptionDetails.text)" }
  return $response.result.value
}

function Set-MobileMetrics(
  [System.Net.WebSockets.ClientWebSocket]$ws,
  [int]$width,
  [int]$height,
  [string]$orientation
) {
  Invoke-Cdp $ws 'Emulation.setDeviceMetricsOverride' @{
    width = $width
    height = $height
    deviceScaleFactor = 2
    mobile = $true
    screenOrientation = @{
      type = $orientation
      angle = $(if ($orientation -eq 'landscapePrimary') { 90 } else { 0 })
    }
  } | Out-Null
}

function Capture-Cdp([System.Net.WebSockets.ClientWebSocket]$ws, [string]$path) {
  $capture = Invoke-Cdp $ws 'Page.captureScreenshot' @{ format = 'png'; fromSurface = $true }
  [IO.File]::WriteAllBytes((Join-Path (Get-Location) $path), [Convert]::FromBase64String($capture.data))
}

function Touch-Point([int]$id, [double]$x, [double]$y) {
  return @{ id = $id; x = $x; y = $y; radiusX = 10; radiusY = 10; force = 1 }
}

try {
  New-Item -ItemType Directory -Path $profile | Out-Null
  $process = Start-Process -FilePath $chrome -ArgumentList @(
    '--headless=new',
    '--hide-scrollbars',
    "--remote-debugging-port=$debugPort",
    "--user-data-dir=$profile",
    '--window-size=844,390',
    'about:blank'
  ) -WindowStyle Hidden -PassThru

  $targets = $null
  for ($attempt = 0; $attempt -lt 80 -and -not $targets; $attempt++) {
    Start-Sleep -Milliseconds 100
    try { $targets = Invoke-RestMethod "http://127.0.0.1:$debugPort/json" } catch { $targets = $null }
  }
  $target = $targets | Where-Object { $_.type -eq 'page' } | Select-Object -First 1
  if (-not $target) { throw 'Chrome DevTools target did not start.' }

  $socket = [System.Net.WebSockets.ClientWebSocket]::new()
  $socket.ConnectAsync([Uri]$target.webSocketDebuggerUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult() | Out-Null
  Invoke-Cdp $socket 'Page.enable' | Out-Null
  Invoke-Cdp $socket 'Runtime.enable' | Out-Null
  Invoke-Cdp $socket 'Input.setIgnoreInputEvents' @{ ignore = $false } | Out-Null
  Set-MobileMetrics $socket 844 390 'landscapePrimary'
  Invoke-Cdp $socket 'Emulation.setTouchEmulationEnabled' @{ enabled = $true; maxTouchPoints = 6 } | Out-Null
  Invoke-Cdp $socket 'Emulation.setUserAgentOverride' @{
    userAgent = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36'
    platform = 'Android'
  } | Out-Null
  Invoke-Cdp $socket 'Page.addScriptToEvaluateOnNewDocument' @{
    source = @'
window.__mobileSmokeErrors = [];
window.addEventListener('error', event => window.__mobileSmokeErrors.push(String(event.error || event.message)));
window.addEventListener('unhandledrejection', event => window.__mobileSmokeErrors.push(String(event.reason)));
const originalError = console.error;
console.error = (...args) => { window.__mobileSmokeErrors.push(args.map(String).join(' ')); originalError(...args); };
'@
  } | Out-Null
  Invoke-Cdp $socket 'Page.navigate' @{ url = $Url } | Out-Null

  $menuReady = $false
  for ($attempt = 0; $attempt -lt 240 -and -not $menuReady; $attempt++) {
    Start-Sleep -Milliseconds 500
    $menuReady = Evaluate-Cdp $socket "window.game?.phaser?.scene?.isActive('MainMenuScene') ?? false"
  }
  if (-not $menuReady) { throw 'Mobile main menu did not become ready.' }

  $menuState = Evaluate-Cdp $socket @'
(() => {
  const platform = window.game.registry.managers.find(manager => manager.key === 'MobilePlatform');
  const scene = window.game.phaser.scene.getScene('MainMenuScene');
  return {
    mobile: platform?.isMobile ?? false,
    portrait: platform?.isPortrait ?? true,
    gameWidth: scene.scale.gameSize.width,
    gameHeight: scene.scale.gameSize.height,
    canvasWidth: scene.game.canvas.getBoundingClientRect().width,
    canvasHeight: scene.game.canvas.getBoundingClientRect().height,
    errors: window.__mobileSmokeErrors
  };
})()
'@
  if (-not $menuState.mobile -or $menuState.portrait) { throw "Mobile detection failed: $($menuState | ConvertTo-Json -Compress)" }
  if ($menuState.errors.Count -gt 0) { throw "Errors during mobile boot: $($menuState.errors -join '; ')" }
  Capture-Cdp $socket 'mobile-menu-smoke.png'

  Evaluate-Cdp $socket @'
(() => {
  window.game.phaser.scene.getScene('MainMenuScene').onNewGame();
  return true;
})()
'@ | Out-Null

  $gameReady = $false
  for ($attempt = 0; $attempt -lt 180 -and -not $gameReady; $attempt++) {
    Start-Sleep -Seconds 1
    $gameReady = Evaluate-Cdp $socket @'
(() => {
  const game = window.game;
  const ui = game?.phaser?.scene?.getScene('UIScene');
  const controls = ui?.mobileControls;
  const player = game?.registry?.managers?.find(manager => manager.key === 'PlayerController');
  return Boolean(ui?.scene?.isActive() && controls?.visible && player?.playerAlive);
})()
'@
  }
  if (-not $gameReady) { throw 'Mobile gameplay/HUD did not become ready.' }

  Start-Sleep -Seconds 2
  $layout = Evaluate-Cdp $socket @'
(() => {
  const game = window.game;
  const ui = game.phaser.scene.getScene('UIScene');
  const controls = ui.mobileControls;
  const platform = game.registry.managers.find(manager => manager.key === 'MobilePlatform');
  const canvas = game.phaser.canvas;
  const rect = canvas.getBoundingClientRect();
  const width = ui.scale.gameSize.width;
  const height = ui.scale.gameSize.height;
  const visible = [...controls.buttons.entries()]
    .filter(([, button]) => button.visible)
    .map(([name, button]) => ({ name, x: button.x, y: button.y, diameter: button.diameter }));
  const joystick = controls.joystick;
  const minCssTarget = Math.min(...visible.map(button => button.diameter * rect.width / width));
  const inside = visible.every(button => {
    const r = button.diameter / 2;
    return button.x - r >= 0 && button.y - r >= 0 && button.x + r <= width && button.y + r <= height;
  });
  const attack = controls.buttons.get('attack');
  const css = (x, y) => ({ x: rect.left + x * rect.width / width, y: rect.top + y * rect.height / height });
  return {
    width, height, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    safe: platform.layout(ui).safe,
    visible,
    inside,
    minCssTarget,
    joystick: { ...css(joystick.x, joystick.y), radiusCss: joystick.radius * rect.width / width },
    attack: css(attack.x, attack.y),
    errors: window.__mobileSmokeErrors
  };
})()
'@
  if (-not $layout.inside) { throw 'One or more mobile controls are outside the landscape canvas.' }
  if ($layout.minCssTarget -lt 44) { throw "Smallest touch target is $([Math]::Round($layout.minCssTarget, 1)) CSS px; expected at least 44." }
  if ($layout.errors.Count -gt 0) { throw "Runtime errors: $($layout.errors -join '; ')" }

  $joyStart = Touch-Point 1 $layout.joystick.x $layout.joystick.y
  $attackTouch = Touch-Point 2 $layout.attack.x $layout.attack.y
  Invoke-Cdp $socket 'Input.dispatchTouchEvent' @{ type = 'touchStart'; touchPoints = @($joyStart, $attackTouch) } | Out-Null
  $joyMoved = Touch-Point 1 ($layout.joystick.x + $layout.joystick.radiusCss * 0.78) $layout.joystick.y
  Invoke-Cdp $socket 'Input.dispatchTouchEvent' @{ type = 'touchMove'; touchPoints = @($joyMoved, $attackTouch) } | Out-Null
  Start-Sleep -Milliseconds 300
  $held = Evaluate-Cdp $socket @'
(() => {
  const input = window.game.registry.managers.find(manager => manager.key === 'InputManager');
  return { axis: input.getAxis(), attack: input.isDown('attack') };
})()
'@
  if ($held.axis.x -lt 0.35 -or -not $held.attack) {
    throw "Two-thumb move+shoot failed: $($held | ConvertTo-Json -Compress)"
  }

  Invoke-Cdp $socket 'Input.dispatchTouchEvent' @{ type = 'touchEnd'; touchPoints = @() } | Out-Null
  Start-Sleep -Milliseconds 300
  $released = Evaluate-Cdp $socket @'
(() => {
  const input = window.game.registry.managers.find(manager => manager.key === 'InputManager');
  return { axis: input.getAxis(), attack: input.isDown('attack') };
})()
'@
  if ([Math]::Abs($released.axis.x) -gt 0.01 -or [Math]::Abs($released.axis.y) -gt 0.01 -or $released.attack) {
    throw "Touch release did not return to neutral: $($released | ConvertTo-Json -Compress)"
  }

  $vehicleMode = Evaluate-Cdp $socket @'
(() => {
  const controls = window.game.phaser.scene.getScene('UIScene').mobileControls;
  controls.resetAll();
  controls.inVehicle = true;
  controls.refreshMode();
  const visible = [...controls.buttons.entries()].filter(([, b]) => b.visible).map(([name]) => name);
  return visible;
})()
'@
  foreach ($required in @('accelerate', 'reverse', 'handbrake', 'horn', 'context')) {
    if ($vehicleMode -notcontains $required) { throw "Vehicle control mode is missing $required." }
  }
  if ($vehicleMode -contains 'attack') { throw 'On-foot attack control remained visible in vehicle mode.' }

  $vehiclePoints = Evaluate-Cdp $socket @'
(() => {
  const game = window.game;
  const ui = game.phaser.scene.getScene('UIScene');
  const controls = ui.mobileControls;
  const rect = game.phaser.canvas.getBoundingClientRect();
  const width = ui.scale.gameSize.width;
  const height = ui.scale.gameSize.height;
  const css = (x, y) => ({ x: rect.left + x * rect.width / width, y: rect.top + y * rect.height / height });
  const joystick = controls.joystick;
  const accelerate = controls.buttons.get('accelerate');
  return {
    joystick: { ...css(joystick.x, joystick.y), radiusCss: joystick.radius * rect.width / width },
    accelerate: css(accelerate.x, accelerate.y)
  };
})()
'@
  $steerStart = Touch-Point 3 $vehiclePoints.joystick.x $vehiclePoints.joystick.y
  $gasTouch = Touch-Point 4 $vehiclePoints.accelerate.x $vehiclePoints.accelerate.y
  Invoke-Cdp $socket 'Input.dispatchTouchEvent' @{ type = 'touchStart'; touchPoints = @($steerStart, $gasTouch) } | Out-Null
  $steerMoved = Touch-Point 3 ($vehiclePoints.joystick.x + $vehiclePoints.joystick.radiusCss * 0.78) $vehiclePoints.joystick.y
  Invoke-Cdp $socket 'Input.dispatchTouchEvent' @{ type = 'touchMove'; touchPoints = @($steerMoved, $gasTouch) } | Out-Null
  Start-Sleep -Milliseconds 300
  $driving = Evaluate-Cdp $socket @'
(() => {
  const input = window.game.registry.managers.find(manager => manager.key === 'InputManager');
  return input.getAxis();
})()
'@
  if ($driving.x -lt 0.35 -or $driving.y -gt -0.7) {
    throw "Two-thumb steer+accelerate failed: $($driving | ConvertTo-Json -Compress)"
  }
  Capture-Cdp $socket 'mobile-vehicle-controls-smoke.png'
  Invoke-Cdp $socket 'Input.dispatchTouchEvent' @{ type = 'touchEnd'; touchPoints = @() } | Out-Null
  Start-Sleep -Milliseconds 200
  Evaluate-Cdp $socket @'
(() => {
  const controls = window.game.phaser.scene.getScene('UIScene').mobileControls;
  controls.resetAll();
  controls.inVehicle = false;
  controls.refreshMode();
  return true;
})()
'@ | Out-Null

  Capture-Cdp $socket $Screenshot

  $entrySetup = Evaluate-Cdp $socket @'
(() => {
  const managers = window.game.registry.managers;
  const player = managers.find(manager => manager.key === 'PlayerController');
  const vehicles = managers.find(manager => manager.key === 'VehicleSystem');
  const occupants = managers.find(manager => manager.key === 'VehicleOccupantSystem');
  const world = managers.find(manager => manager.key === 'WorldManager');
  if (!player?.player || !vehicles || !occupants || !world) return null;

  const anchor = { ...player.player.position };
  const vehicle = vehicles.spawnVehicle('sedan', anchor.x, anchor.y, 0, 0x3b6cc2);
  vehicle.movement.stopImmediately();
  vehicle.sprite.body?.setVelocity(0, 0);

  let door = null;
  for (const heading of [0, Math.PI * 0.5, Math.PI, Math.PI * 1.5]) {
    vehicle.sprite.setPosition(anchor.x, anchor.y).setRotation(heading + Math.PI * 0.5);
    const offsetDoor = occupants.doorWorldPosition(vehicle, 'driver', 4);
    vehicle.sprite.setPosition(
      anchor.x - (offsetDoor.x - anchor.x),
      anchor.y - (offsetDoor.y - anchor.y)
    );
    const candidateDoor = occupants.doorWorldPosition(vehicle, 'driver', 4);
    const seat = occupants.seatWorldPosition(vehicle, 'driver');
    if (
      world.isPedestrianClearAtWorld(candidateDoor.x, candidateDoor.y, 9) &&
      world.isPedestrianSegmentClear(candidateDoor, seat, 9)
    ) {
      door = candidateDoor;
      break;
    }
  }
  if (!door) {
    vehicles.removeVehicle(vehicle);
    return null;
  }

  vehicle.sprite.body?.reset(vehicle.sprite.x, vehicle.sprite.y);
  player.player.sprite.setPosition(door.x, door.y);
  return { vehicleId: vehicle.id };
})()
'@
  if (-not $entrySetup) { throw 'No runtime vehicle was available for the mobile entry/exit test.' }
  Start-Sleep -Milliseconds 300
  Evaluate-Cdp $socket @'
(() => {
  const input = window.game.registry.managers.find(manager => manager.key === 'InputManager');
  input.setTouchAction('enter-vehicle', true);
  return true;
})()
'@ | Out-Null
  Start-Sleep -Milliseconds 180
  Evaluate-Cdp $socket @'
(() => {
  window.game.registry.managers.find(manager => manager.key === 'InputManager').setTouchAction('enter-vehicle', false);
  return true;
})()
'@ | Out-Null
  Start-Sleep -Seconds 3
  $enteredVehicle = Evaluate-Cdp $socket "window.game.registry.managers.find(manager => manager.key === 'PlayerController').playerInVehicle"
  if (-not $enteredVehicle) { throw "Mobile vehicle entry failed for vehicle $($entrySetup.vehicleId)." }
  Evaluate-Cdp $socket @'
(() => {
  const input = window.game.registry.managers.find(manager => manager.key === 'InputManager');
  input.setTouchAction('enter-vehicle', true);
  return true;
})()
'@ | Out-Null
  Start-Sleep -Milliseconds 180
  Evaluate-Cdp $socket @'
(() => {
  window.game.registry.managers.find(manager => manager.key === 'InputManager').setTouchAction('enter-vehicle', false);
  return true;
})()
'@ | Out-Null
  Start-Sleep -Seconds 2
  $exitedVehicle = -not (Evaluate-Cdp $socket "window.game.registry.managers.find(manager => manager.key === 'PlayerController').playerInVehicle")
  if (-not $exitedVehicle) { throw "Mobile vehicle exit failed for vehicle $($entrySetup.vehicleId)." }

  $performance = Evaluate-Cdp $socket @'
(() => {
  const profile = window.__engineProfiler?.();
  return {
    frameTimeMs: profile?.engineDiagnostics?.frameTimeMs ?? null,
    slowSystemCount: profile?.engineDiagnostics?.slowSystemCount ?? 0,
    blockingSystem: profile?.blockingSystem ?? null,
    errors: window.__mobileSmokeErrors.length
  };
})()
'@
  if ($performance.errors -gt 0) { throw 'Browser errors were recorded during the mobile performance pass.' }

  Evaluate-Cdp $socket @'
(() => {
  window.game.registry.managers.find(manager => manager.key === 'GameManager').pauseGame();
  return true;
})()
'@ | Out-Null
  Start-Sleep -Milliseconds 500
  $pauseReady = Evaluate-Cdp $socket "window.game.phaser.scene.isActive('PauseScene')"
  if (-not $pauseReady) { throw 'Mobile pause menu did not open.' }
  Capture-Cdp $socket 'mobile-pause-smoke.png'
  Evaluate-Cdp $socket @'
(() => {
  const pause = window.game.phaser.scene.getScene('PauseScene');
  pause.scene.launch('SettingsScene');
  pause.scene.bringToTop('SettingsScene');
  return true;
})()
'@ | Out-Null
  Start-Sleep -Milliseconds 500
  if (-not (Evaluate-Cdp $socket "window.game.phaser.scene.isActive('SettingsScene')")) {
    throw 'Mobile settings menu did not open.'
  }
  Capture-Cdp $socket 'mobile-settings-smoke.png'
  Evaluate-Cdp $socket "window.game.phaser.scene.getScene('SettingsScene').scene.stop(); true" | Out-Null
  Evaluate-Cdp $socket "window.game.phaser.scene.getScene('PauseScene').onMap(); true" | Out-Null
  Start-Sleep -Milliseconds 700
  if (-not (Evaluate-Cdp $socket "window.game.phaser.scene.isActive('MapScene')")) {
    throw 'Mobile map overlay did not open.'
  }
  Capture-Cdp $socket 'mobile-map-smoke.png'
  Evaluate-Cdp $socket "window.game.phaser.scene.getScene('MapScene').closeMap(); true" | Out-Null
  Start-Sleep -Milliseconds 300
  Evaluate-Cdp $socket @'
(() => {
  window.game.registry.managers.find(manager => manager.key === 'GameManager').resumeGame();
  return true;
})()
'@ | Out-Null
  Start-Sleep -Milliseconds 400

  $aspectResults = @()
  foreach ($aspect in @(
    @{ width = 1280; height = 720; name = '16:9' },
    @{ width = 896; height = 384; name = '21:9' }
  )) {
    Set-MobileMetrics $socket $aspect.width $aspect.height 'landscapePrimary'
    Start-Sleep -Milliseconds 600
    $aspectState = Evaluate-Cdp $socket @'
(() => {
  const game = window.game;
  const ui = game.phaser.scene.getScene('UIScene');
  const controls = ui.mobileControls;
  const rect = game.phaser.canvas.getBoundingClientRect();
  const width = ui.scale.gameSize.width;
  const height = ui.scale.gameSize.height;
  const visible = [...controls.buttons.values()].filter(button => button.visible);
  return {
    logicalWidth: width,
    logicalHeight: height,
    inside: visible.every(button => {
      const r = button.diameter / 2;
      return button.x - r >= 0 && button.y - r >= 0 && button.x + r <= width && button.y + r <= height;
    }),
    minCssTarget: Math.min(...visible.map(button => button.diameter * rect.width / width))
  };
})()
'@
    if (-not $aspectState.inside -or $aspectState.minCssTarget -lt 44) {
      throw "Responsive control layout failed at $($aspect.name): $($aspectState | ConvertTo-Json -Compress)"
    }
    $aspectResults += "$($aspect.name)=$([Math]::Round($aspectState.logicalWidth))x$([Math]::Round($aspectState.logicalHeight))/$([Math]::Round($aspectState.minCssTarget, 1))px"
  }
  Set-MobileMetrics $socket 844 390 'landscapePrimary'
  Start-Sleep -Milliseconds 500

  Set-MobileMetrics $socket 390 844 'portraitPrimary'
  Start-Sleep -Seconds 1
  $portrait = Evaluate-Cdp $socket @'
(() => {
  const platform = window.game.registry.managers.find(manager => manager.key === 'MobilePlatform');
  return {
    portrait: platform.isPortrait,
    blocked: platform.isGameplayBlocked,
    overlay: document.querySelector('.orientation-overlay')?.classList.contains('visible') ?? false
  };
})()
'@
  if (-not $portrait.portrait -or -not $portrait.blocked -or -not $portrait.overlay) {
    throw "Portrait orientation block failed: $($portrait | ConvertTo-Json -Compress)"
  }
  Capture-Cdp $socket 'mobile-portrait-smoke.png'

  Set-MobileMetrics $socket 844 390 'landscapePrimary'
  Start-Sleep -Seconds 1
  $recovered = Evaluate-Cdp $socket @'
(() => {
  const platform = window.game.registry.managers.find(manager => manager.key === 'MobilePlatform');
  return !platform.isPortrait && !platform.isGameplayBlocked && !document.querySelector('.orientation-overlay')?.classList.contains('visible');
})()
'@
  if (-not $recovered) { throw 'The game did not recover after returning to landscape.' }

  Write-Output 'Mobile browser smoke PASSED'
  Write-Output "  logical viewport: $([Math]::Round($layout.width))x$([Math]::Round($layout.height))"
  Write-Output "  canvas CSS viewport: $([Math]::Round($layout.rect.width))x$([Math]::Round($layout.rect.height))"
  Write-Output "  smallest touch target: $([Math]::Round($layout.minCssTarget, 1)) CSS px"
  Write-Output "  visible on-foot controls: $((($layout.visible | ForEach-Object { $_.name }) -join ', '))"
  Write-Output "  vehicle controls: $(($vehicleMode -join ', '))"
  Write-Output "  profiler frame: $($performance.frameTimeMs) ms; slow systems: $($performance.slowSystemCount); blocker: $($performance.blockingSystem)"
  Write-Output "  responsive matrix: $(($aspectResults -join ', '))"
  Write-Output '  move+shoot, steer+accelerate, real vehicle entry/exit, neutral reset, portrait block, and landscape recovery passed'
} finally {
  if ($socket) { $socket.Dispose() }
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $profile) { Remove-Item -LiteralPath $profile -Recurse -Force -ErrorAction SilentlyContinue }
}
