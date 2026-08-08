param(
  [string]$Url = 'http://127.0.0.1:5173',
  [string]$Screenshot = 'police-browser-smoke.png',
  [int]$Width = 1280,
  [int]$Height = 720
)

$ErrorActionPreference = 'Stop'
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path -LiteralPath $chrome)) { throw 'Google Chrome is not installed.' }

$debugPort = Get-Random -Minimum 9320 -Maximum 9390
$profile = Join-Path $env:TEMP "pixel-city-police-smoke-$PID-$debugPort"
$process = $null

function Receive-Cdp([System.Net.WebSockets.ClientWebSocket]$socket) {
  $stream = [System.IO.MemoryStream]::new()
  try {
    do {
      $buffer = [byte[]]::new(1MB)
      $result = $socket.ReceiveAsync(
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
    '--disable-extensions',
    "--remote-debugging-port=$debugPort",
    "--user-data-dir=$profile",
    "--window-size=$Width,$Height",
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
  ).GetAwaiter().GetResult()
  Invoke-Cdp $socket 'Page.enable' | Out-Null
  Invoke-Cdp $socket 'Runtime.enable' | Out-Null
  Invoke-Cdp $socket 'Page.addScriptToEvaluateOnNewDocument' @{
    source = @'
window.__policeSmokeErrors = [];
window.addEventListener('error', event => window.__policeSmokeErrors.push(String(event.error || event.message)));
window.addEventListener('unhandledrejection', event => window.__policeSmokeErrors.push(String(event.reason)));
const originalError = console.error;
console.error = (...args) => { window.__policeSmokeErrors.push(args.map(String).join(' ')); originalError(...args); };
'@
  } | Out-Null
  Invoke-Cdp $socket 'Page.navigate' @{ url = $Url } | Out-Null
  Start-Sleep -Seconds 5

  Evaluate-Cdp $socket @'
(() => {
  const menu = window.game?.phaser?.scene?.getScene('MainMenuScene');
  menu?.onNewGame?.();
  return true;
})()
'@ | Out-Null

  $ready = $false
  for ($attempt = 0; $attempt -lt 60 -and -not $ready; $attempt++) {
    Start-Sleep -Seconds 1
    $ready = Evaluate-Cdp $socket @'
(() => {
  const scenes = window.game?.phaser?.scene?.getScenes(true)?.map(scene => scene.scene.key) ?? [];
  const managers = window.game?.registry?.managers ?? [];
  return scenes.includes('GameScene') && managers.some(manager => manager.key === 'CrimeSystem');
})()
'@
  }
  if (-not $ready) { throw 'Game scene did not become ready.' }
  Start-Sleep -Seconds 7

  $vitalsArmor = Evaluate-Cdp $socket @'
(() => {
  const managers = window.game.registry.managers;
  const controller = managers.find(manager => manager.key === 'PlayerController');
  const player = controller.player;
  const ui = window.game.phaser.scene.getScene('UIScene');
  player.restoreVitals(100, 50);
  const result = player.applyDamage({ amount: 30, type: 'bullet', sourceFaction: 'police', fromPlayer: false });
  return {
    result,
    vitals: player.vitals,
    healthRatio: ui.hud.healthBar.fill.width / ui.hud.healthBar.barWidth,
    armorRatio: ui.hud.armorBar.fill.width / ui.hud.armorBar.barWidth
  };
})()
'@

  $vitalsOverflow = Evaluate-Cdp $socket @'
(() => {
  const managers = window.game.registry.managers;
  const player = managers.find(manager => manager.key === 'PlayerController').player;
  const ui = window.game.phaser.scene.getScene('UIScene');
  const result = player.applyDamage({ amount: 45, type: 'bullet', sourceFaction: 'police', fromPlayer: false });
  return {
    result,
    vitals: player.vitals,
    healthRatio: ui.hud.healthBar.fill.width / ui.hud.healthBar.barWidth,
    armorRatio: ui.hud.armorBar.fill.width / ui.hud.armorBar.barWidth
  };
})()
'@

  $death = Evaluate-Cdp $socket @'
(() => {
  const managers = window.game.registry.managers;
  const player = managers.find(manager => manager.key === 'PlayerController').player;
  player.applyDamage({ amount: 500, type: 'bullet', sourceFaction: 'police', fromPlayer: false });
  return { vitals: player.vitals, bodyEnabled: player.sprite.body.enable };
})()
'@
  Start-Sleep -Seconds 3

  $respawn = Evaluate-Cdp $socket @'
(() => {
  const managers = window.game.registry.managers;
  const player = managers.find(manager => manager.key === 'PlayerController').player;
  const ui = window.game.phaser.scene.getScene('UIScene');
  ui.gameplayDebug.toggle();
  return {
    vitals: player.vitals,
    bodyEnabled: player.sprite.body.enable,
    healthRatio: ui.hud.healthBar.fill.width / ui.hud.healthBar.barWidth,
    debugText: document.getElementById('gameplay-debug-overlay')?.textContent ?? ''
  };
})()
'@

  $before = Evaluate-Cdp $socket @'
(() => {
  const managers = window.game.registry.managers;
  const crime = managers.find(manager => manager.key === 'CrimeSystem');
  const wanted = managers.find(manager => manager.key === 'WantedSystem');
  const occupants = managers.find(manager => manager.key === 'VehicleOccupantSystem');
  crime.bus.emit('crime:committed', {
    crime: 'murder',
    position: { x: 32, y: 32 },
    attribution: { source: 'weapon', time: Date.now(), playerResponsible: true }
  });
  return {
    wanted: wanted.debugSnapshot(),
    occupants: occupants.debugSnapshot(),
    crime: crime.debugSnapshot()
  };
})()
'@
  Start-Sleep -Seconds 5

  $unwitnessed = Evaluate-Cdp $socket @'
(() => {
  const managers = window.game.registry.managers;
  return {
    wanted: managers.find(manager => manager.key === 'WantedSystem').debugSnapshot(),
    crime: managers.find(manager => manager.key === 'CrimeSystem').debugSnapshot()
  };
})()
'@

  $policeTriggered = $null
  for ($attempt = 0; $attempt -lt 16; $attempt++) {
    $policeTriggered = Evaluate-Cdp $socket @'
(() => {
  const managers = window.game.registry.managers;
  const crime = managers.find(manager => manager.key === 'CrimeSystem');
  const wanted = managers.find(manager => manager.key === 'WantedSystem');
  const unit = [...wanted.units.values()].find(candidate => candidate.state === 'patrol');
  if (!unit) return { triggered: false, patrols: wanted.debugSnapshot().patrols };
  crime.bus.emit('crime:committed', {
    crime: 'police-assault',
    position: { x: unit.vehicle.sprite.x, y: unit.vehicle.sprite.y },
    attribution: { source: 'weapon', time: Date.now(), playerResponsible: true }
  });
  return { triggered: true, vehicleId: unit.vehicle.id };
})()
'@
    if ($policeTriggered.triggered) { break }
    Start-Sleep -Milliseconds 500
  }
  Start-Sleep -Seconds 1

  $reported = Evaluate-Cdp $socket @'
(() => {
  const managers = window.game.registry.managers;
  return managers.find(manager => manager.key === 'WantedSystem').debugSnapshot();
})()
'@
  $deployed = $null
  for ($attempt = 0; $attempt -lt 32; $attempt++) {
    Start-Sleep -Milliseconds 250
    $deployed = Evaluate-Cdp $socket @'
(() => {
  const managers = window.game.registry.managers;
  return managers.find(manager => manager.key === 'WantedSystem').debugSnapshot();
})()
'@
    if ($deployed.deployedOfficers -ge 1) { break }
  }

  $combatStarted = Evaluate-Cdp $socket @'
(() => {
  const managers = window.game.registry.managers;
  const wanted = managers.find(manager => manager.key === 'WantedSystem');
  const controller = managers.find(manager => manager.key === 'PlayerController');
  const navigation = managers.find(manager => manager.key === 'NavigationSystem');
  const deployed = [...wanted.deployed.values()].find(candidate => candidate.actor.isAlive);
  window.__policeShots = 0;
  window.__policeDeaths = 0;
  window.__policeFires = [];
  wanted.bus.on('weapon:fired', payload => {
    if (payload.fromPlayer) return;
    window.__policeShots += 1;
    window.__policeFires.push(payload);
  });
  wanted.bus.on('player:died', () => { window.__policeDeaths += 1; });
  if (!deployed) return { started: false };
  const origin = deployed.actor.position;
  deployed.cover = { x: origin.x, y: origin.y };
  const candidates = Array.from({ length: 8 }, (_, index) => {
    const angle = index * Math.PI / 4;
    return { x: origin.x + Math.cos(angle) * 120, y: origin.y + Math.sin(angle) * 120 };
  });
  const target = candidates.find(point =>
    navigation.hasLineOfSight(origin, point) && navigation.isClearLine(origin, point, 'police')
  );
  if (!target) return { started: false, reason: 'no-clear-firing-lane' };
  controller.player.sprite.setPosition(target.x, target.y);
  controller.player.sprite.body.reset(target.x, target.y);
  controller.player.stopMoving();
  for (const other of wanted.deployed.values()) {
    if (other.actor.id === deployed.actor.id) continue;
    const x = origin.x - (target.x - origin.x) * 2;
    const y = origin.y - (target.y - origin.y) * 2;
    other.actor.sprite.setPosition(x, y);
    other.actor.sprite.body.reset(x, y);
  }
  controller.player.restoreVitals(100, 0);
  wanted.deserialize({ level: 3, heat: 250, lastKnownX: target.x, lastKnownY: target.y });
  wanted.reportOfficerSighting(deployed.actor.id, target);
  return { started: true, target, officerId: deployed.actor.id };
})()
'@
  $combat = $null
  for ($attempt = 0; $attempt -lt 32; $attempt++) {
    Start-Sleep -Milliseconds 250
    $combat = Evaluate-Cdp $socket @'
(() => {
  const managers = window.game.registry.managers;
  const wanted = managers.find(manager => manager.key === 'WantedSystem');
  const player = managers.find(manager => manager.key === 'PlayerController').player;
  const combat = managers.find(manager => manager.key === 'CombatSystem');
  const result = {
    wanted: wanted.debugSnapshot(),
    vitals: player.vitals,
    damage: combat.debugSnapshot(),
    policeShots: window.__policeShots ?? 0,
    policeFires: (window.__policeFires ?? []).slice(-6),
    policeDeaths: window.__policeDeaths ?? 0,
    activeBullets: combat.activeBullets.filter(projectile => projectile.isActive).length,
    projectiles: combat.activeBullets.filter(projectile => projectile.isActive).slice(-6).map(projectile => ({
      x: projectile.sprite.x,
      y: projectile.sprite.y,
      velocityX: projectile.sprite.body.velocity.x,
      velocityY: projectile.sprite.body.velocity.y,
      traveled: projectile._traveled,
      shooterId: projectile.shooterId
    })),
    playerBody: {
      x: player.sprite.body.x,
      y: player.sprite.body.y,
      width: player.sprite.body.width,
      height: player.sprite.body.height,
      enabled: player.sprite.body.enable,
      active: player.sprite.active
    },
    officers: [...wanted.deployed.values()].map(record => ({
      id: record.actor.id,
      state: record.actor.ai.currentState,
      x: record.actor.position.x,
      y: record.actor.position.y,
      distanceToPlayer: Math.hypot(
        record.actor.position.x - player.position.x,
        record.actor.position.y - player.position.y
      ),
      seesPlayer: record.actor.ai.sees(player.position),
      friendlyFireBlocked: record.actor.ai.hasFriendlyInLine(player.position),
      weapon: record.actor.weaponComp.weapon?.id ?? null,
      cooldownMs: record.actor.weaponComp.cooldownMs,
      reloadMs: record.actor.weaponComp.reloadRemainingMs,
      magazine: record.actor.weaponComp.internalMag
    }))
  };
  return result;
})()
'@
    $responseReady = $combat.wanted.activeResponders -ge 2
    $damageApplied = $combat.vitals.currentHP -lt 100
    if ($responseReady -and $damageApplied) { break }
  }

  if ($combat.vitals.currentHP -ge 100) {
    $combatDiagnostic = $combat | ConvertTo-Json -Depth 8 -Compress
    throw "Police entered combat but their bullets did not reduce unarmored player HP: $combatDiagnostic"
  }
  if ($combat.damage.appliedDamage -le 0 -or $combat.damage.lastDamageSource -notmatch '^police:bullet') {
    $combatDiagnostic = $combat | ConvertTo-Json -Depth 8 -Compress
    throw "Combat telemetry did not attribute applied HP damage to a police bullet: $combatDiagnostic"
  }

  $lethal = $null
  for ($attempt = 0; $attempt -lt 48; $attempt++) {
    Start-Sleep -Milliseconds 250
    $lethal = Evaluate-Cdp $socket @'
(() => {
  const managers = window.game.registry.managers;
  const player = managers.find(manager => manager.key === 'PlayerController').player;
  const wanted = managers.find(manager => manager.key === 'WantedSystem');
  return {
    vitals: player.vitals,
    policeDeaths: window.__policeDeaths ?? 0,
    wanted: wanted.debugSnapshot()
  };
})()
'@
    if ($lethal.policeDeaths -ge 1) { break }
  }

  Evaluate-Cdp $socket @'
(() => {
  const managers = window.game.registry.managers;
  managers.find(manager => manager.key === 'WantedSystem').clearWanted();
  return true;
})()
'@ | Out-Null
  $returned = $null
  for ($attempt = 0; $attempt -lt 80; $attempt++) {
    Start-Sleep -Milliseconds 250
    $returned = Evaluate-Cdp $socket @'
(() => {
  const managers = window.game.registry.managers;
  return managers.find(manager => manager.key === 'WantedSystem').debugSnapshot();
})()
'@
    if ($returned.level -eq 0 -and $returned.deployedOfficers -eq 0 -and $returned.states.patrol -ge 1) {
      break
    }
  }

  $roadblockStarted = Evaluate-Cdp $socket @'
(() => {
  const managers = window.game.registry.managers;
  const wanted = managers.find(manager => manager.key === 'WantedSystem');
  const world = managers.find(manager => manager.key === 'WorldManager');
  const controller = managers.find(manager => manager.key === 'PlayerController');
  const position = controller.playerPosition;
  const edgesByNode = new Map();
  for (const edge of world.map.roadEdges) {
    for (const nodeId of [edge.fromNodeId, edge.toNodeId]) {
      const edges = edgesByNode.get(nodeId) ?? [];
      edges.push(edge);
      edgesByNode.set(nodeId, edges);
    }
  }
  const routeNode = world.map.roadNodes
    .map(node => ({ node, distance: Math.hypot(node.x - position.x, node.y - position.y) }))
    .filter(({ node, distance }) => {
      const major = (edgesByNode.get(node.id) ?? []).some(edge =>
        edge.roadClass === 'highway' || edge.roadClass === 'arterial' ||
        edge.highwayComponent === 'entry-ramp' || edge.highwayComponent === 'exit-ramp'
      );
      return distance >= 500 && distance <= 880 && (node.neighbours.length >= 3 || major);
    })
    .sort((a, b) => a.distance - b.distance)[0]?.node ?? null;
  controller.player.restoreVitals(100, 100);
  controller.player.healthComp.setInvulnerable(30000);
  wanted.deserialize({ level: 4, heat: 450, lastKnownX: position.x, lastKnownY: position.y });
  if (routeNode) {
    const dx = routeNode.x - position.x;
    const dy = routeNode.y - position.y;
    const length = Math.max(1, Math.hypot(dx, dy));
    wanted.lastKnownVelocity = { x: dx / length * 150, y: dy / length * 150 };
  } else {
    wanted.lastKnownVelocity = { x: 150, y: 0 };
  }
  wanted.nextWaveAt = 0;
  return { position, routeNode };
})()
'@

  $roadblock = $null
  for ($attempt = 0; $attempt -lt 32; $attempt++) {
    Start-Sleep -Milliseconds 250
    $roadblock = Evaluate-Cdp $socket @'
(() => {
  const wanted = window.game.registry.managers.find(manager => manager.key === 'WantedSystem');
  const unit = [...wanted.units.values()].find(candidate => candidate.role === 'roadblock');
  if (unit?.target && unit.roadblockSpikes.length === 0) {
    unit.vehicle.sprite.setPosition(unit.target.x, unit.target.y);
    unit.vehicle.sprite.body.reset(unit.target.x, unit.target.y);
  }
  return {
    assigned: Boolean(unit),
    target: unit?.target ?? null,
    snapshot: wanted.debugSnapshot(),
    spikes: wanted.hazardGroup.countActive(true),
    barriers: wanted.blockadeGroup.countActive(true)
  };
})()
'@
    if ($roadblock.snapshot.roadblocksActive -ge 1) { break }
  }

  $helicopter = $null
  Evaluate-Cdp $socket @'
(() => {
  const managers = window.game.registry.managers;
  const wanted = managers.find(manager => manager.key === 'WantedSystem');
  const position = managers.find(manager => manager.key === 'PlayerController').playerPosition;
  wanted.deserialize({ level: 5, heat: 700, lastKnownX: position.x, lastKnownY: position.y });
  wanted.lastKnownVelocity = { x: 150, y: 0 };
  wanted.nextWaveAt = 0;
  return true;
})()
'@ | Out-Null
  for ($attempt = 0; $attempt -lt 32; $attempt++) {
    Start-Sleep -Milliseconds 250
    $helicopter = Evaluate-Cdp $socket @'
(() => {
  const managers = window.game.registry.managers;
  const wanted = managers.find(manager => manager.key === 'WantedSystem');
  const controller = managers.find(manager => manager.key === 'PlayerController');
  const navigation = managers.find(manager => manager.key === 'NavigationSystem');
  const heli = wanted.helicopter;
  const target = controller.playerPosition;
  if (heli && target && heli.state !== 'tracking') {
    const candidates = Array.from({ length: 8 }, (_, index) => {
      const angle = index * Math.PI / 4;
      return { x: target.x + Math.cos(angle) * 180, y: target.y + Math.sin(angle) * 180 };
    });
    const point = candidates.find(candidate => navigation.hasLineOfSight(candidate, target));
    if (point) {
      heli.sprite.setPosition(point.x, point.y);
      heli.sprite.body.reset(point.x, point.y);
    }
  }
  return wanted.debugSnapshot();
})()
'@
    if ($helicopter.helicopterState -eq 'tracking') { break }
  }

  Evaluate-Cdp $socket @'
(() => {
  const managers = window.game.registry.managers;
  const wanted = managers.find(manager => manager.key === 'WantedSystem');
  const target = managers.find(manager => manager.key === 'PlayerController').playerPosition;
  const heli = wanted.helicopter;
  if (heli && target) {
    heli.sprite.setPosition(target.x + 900, target.y);
    heli.sprite.body.reset(target.x + 900, target.y);
  }
  return true;
})()
'@ | Out-Null
  Start-Sleep -Milliseconds 500
  $helicopterLost = Evaluate-Cdp $socket @'
(() => window.game.registry.managers.find(manager => manager.key === 'WantedSystem').debugSnapshot())()
'@

  Evaluate-Cdp $socket @'
(() => {
  const wanted = window.game.registry.managers.find(manager => manager.key === 'WantedSystem');
  wanted.clearWanted();
  return true;
})()
'@ | Out-Null
  Start-Sleep -Seconds 2
  $highResponseCleared = Evaluate-Cdp $socket @'
(() => window.game.registry.managers.find(manager => manager.key === 'WantedSystem').debugSnapshot())()
'@

  $entryStarted = Evaluate-Cdp $socket @'
(() => {
  const managers = window.game.registry.managers;
  const player = managers.find(manager => manager.key === 'PlayerController');
  const vehicles = managers.find(manager => manager.key === 'VehicleSystem');
  const traffic = managers.find(manager => manager.key === 'TrafficSystem');
  const occupants = managers.find(manager => manager.key === 'VehicleOccupantSystem');
  const pos = player.playerPosition;
  const candidates = vehicles.vehicles
    .filter(vehicle => !vehicle.isDestroyed && !vehicle.isPlayerDriven && !vehicle.def.isEmergency)
    .sort((a, b) => {
      const adx = a.sprite.x - pos.x; const ady = a.sprite.y - pos.y;
      const bdx = b.sprite.x - pos.x; const bdy = b.sprite.y - pos.y;
      return adx * adx + ady * ady - (bdx * bdx + bdy * bdy);
    });
  const vehicle = candidates[0];
  if (!vehicle) return { started: false };
  traffic.setDriverStopped(vehicle, true);
  vehicle.movement.stopImmediately();
  const door = occupants.doorWorldPosition(vehicle, 'driver', 2);
  player.player.sprite.setPosition(door.x, door.y);
  player.tryEnterVehicle(player.player);
  return {
    started: Boolean(player.entryTransition),
    vehicleId: vehicle.id,
    playerDrivenImmediately: vehicle.isPlayerDriven,
    occupants: occupants.debugSnapshot()
  };
})()
'@
  Start-Sleep -Milliseconds 650

  $capture = Invoke-Cdp $socket 'Page.captureScreenshot' @{
    format = 'png'
    captureBeyondViewport = $false
  }
  [IO.File]::WriteAllBytes(
    (Join-Path (Get-Location) $Screenshot),
    [Convert]::FromBase64String($capture.data)
  )
  Start-Sleep -Seconds 2

  $final = Evaluate-Cdp $socket @'
(() => {
  const managers = window.game.registry.managers;
  const player = managers.find(manager => manager.key === 'PlayerController');
  const occupants = managers.find(manager => manager.key === 'VehicleOccupantSystem');
  return {
    currentVehicleId: player.currentVehicle?.id ?? null,
    entryActive: Boolean(player.entryTransition),
    playerDriven: player.currentVehicle?.isPlayerDriven ?? false,
    driverId: player.currentVehicle?.driverId ?? null,
    playerId: player.player?.id ?? null,
    occupants: occupants.debugSnapshot(),
    fps: window.game.phaser.loop.actualFps,
    errors: window.__policeSmokeErrors
  };
})()
'@

  if ($vitalsArmor.vitals.currentHP -ne 100 -or $vitalsArmor.vitals.armor -ne 20) {
    throw 'Armor-only bullet damage did not preserve HP and drain armor.'
  }
  if ([Math]::Abs($vitalsArmor.healthRatio - 1) -gt 0.001 -or [Math]::Abs($vitalsArmor.armorRatio - 0.2) -gt 0.001) {
    throw 'HUD bars did not synchronize after armor-only damage.'
  }
  if ($vitalsOverflow.vitals.currentHP -ne 75 -or $vitalsOverflow.vitals.armor -ne 0) {
    throw 'Overflow bullet damage did not reach HP after armor.'
  }
  if ([Math]::Abs($vitalsOverflow.healthRatio - 0.75) -gt 0.001 -or $vitalsOverflow.armorRatio -ne 0) {
    throw 'HUD bars did not synchronize after HP damage.'
  }
  if (-not $death.vitals.dead -or $death.bodyEnabled) { throw 'Death did not disable the player body.' }
  if ($respawn.vitals.dead -or $respawn.vitals.currentHP -ne $respawn.vitals.maxHP -or -not $respawn.bodyEnabled) {
    throw 'Respawn did not restore authoritative health and controls.'
  }
  if ($respawn.debugText -notmatch 'HP\s+100 / 100' -or $respawn.debugText -notmatch 'WANTED') {
    throw 'F8 gameplay overlay is not synchronized with live vitals/wanted data.'
  }
  if ($before.occupants.movingWithoutDriver -ne 0) { throw 'Moving traffic without drivers was detected.' }
  if ($before.occupants.policeWithoutCrew -ne 0) { throw 'A patrol vehicle had no police crew.' }
  if ($unwitnessed.wanted.level -ne 0) { throw 'An unwitnessed desert crime raised wanted level.' }
  if (-not $policeTriggered.triggered) { throw 'No real patrol existed for direct-witness validation.' }
  if ($reported.level -lt 1) { throw 'A police-witnessed crime was not reported.' }
  if ($deployed.deployedOfficers -lt 1) { throw 'Responding police did not physically disembark.' }
  if ($deployed.primaryOfficerState -eq 'Patrol' -or $deployed.primaryOfficerState -eq 'None') {
    throw 'A deployed response officer was LOD-frozen outside the response AI state.'
  }
  if (-not $combatStarted.started) { throw 'No deployed officer was available for combat validation.' }
  if ($combat.wanted.activeResponders -lt 2) {
    $combatDiagnostic = $combat | ConvertTo-Json -Depth 8 -Compress
    throw "Three stars did not create the first multi-unit reinforcement wave: $combatDiagnostic"
  }
  if ($combat.vitals.currentHP -ge 100) {
    $combatDiagnostic = $combat | ConvertTo-Json -Depth 8 -Compress
    throw "Police entered combat but their bullets did not reduce unarmored player HP: $combatDiagnostic"
  }
  if ($combat.damage.appliedDamage -le 0 -or $combat.damage.lastDamageSource -notmatch '^police:bullet') {
    $combatDiagnostic = $combat | ConvertTo-Json -Depth 8 -Compress
    throw "Combat telemetry did not attribute applied HP damage to a police bullet: $combatDiagnostic"
  }
  if ($lethal.policeDeaths -lt 1) {
    throw 'Sustained police projectile fire did not kill the player.'
  }
  if ($returned.level -ne 0 -or $returned.deployedOfficers -ne 0 -or $returned.states.patrol -lt 1) {
    throw 'Police did not board and return to patrol after awareness cleared.'
  }
  if (-not $roadblock.assigned -or $roadblock.snapshot.roadblocksActive -lt 1 -or $roadblock.barriers -lt 2) {
    throw 'Four stars did not deploy a physical strategic roadblock.'
  }
  $roadblockDistance = [Math]::Sqrt(
    [Math]::Pow($roadblock.target.x - $roadblockStarted.position.x, 2) +
    [Math]::Pow($roadblock.target.y - $roadblockStarted.position.y, 2)
  )
  if ($roadblockDistance -lt 460) { throw 'Roadblock appeared inside the player safety radius.' }
  if (-not $helicopter.helicopterActive -or $helicopter.helicopterState -ne 'tracking') {
    throw 'Five stars did not dispatch a line-of-sight tracking helicopter.'
  }
  if ($helicopterLost.helicopterState -ne 'searching') {
    throw 'Helicopter retained magical tracking after visual contact was lost.'
  }
  if ($highResponseCleared.helicopterActive -or $highResponseCleared.roadblocksActive -ne 0) {
    throw 'High-level response assets were not recalled after wanted clear.'
  }
  if (-not $entryStarted.started -or $entryStarted.playerDrivenImmediately) {
    throw 'Carjacking skipped its physical transition.'
  }
  if ($final.entryActive -or -not $final.playerDriven -or $final.driverId -ne $final.playerId) {
    throw 'Carjacking did not finish with the player in the driver seat.'
  }
  if ($final.occupants.movingWithoutDriver -ne 0) { throw 'Post-carjack moving vehicle lacks a driver.' }
  if ($final.errors.Count -gt 0) { throw "Browser errors: $($final.errors -join '; ')" }
  [ordered]@{
    policeDamage = $combat.damage
    hpAfterPoliceFire = $combat.vitals.currentHP
    policeShots = $combat.policeShots
    policeDeaths = $lethal.policeDeaths
    roadblocks = $roadblock.snapshot.roadblocksActive
    barriers = $roadblock.barriers
    helicopterTracked = $helicopter.helicopterState
    helicopterLost = $helicopterLost.helicopterState
    responseCleared = $highResponseCleared.level -eq 0
    fps = $final.fps
    browserErrors = $final.errors.Count
  } | ConvertTo-Json -Depth 4
} finally {
  if ($socket) { $socket.Dispose() }
  if ($process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force
    Wait-Process -Id $process.Id -Timeout 5 -ErrorAction SilentlyContinue
  }
  for ($attempt = 0; $attempt -lt 10 -and (Test-Path -LiteralPath $profile); $attempt++) {
    try {
      Remove-Item -LiteralPath $profile -Recurse -Force
    } catch {
      if ($attempt -ge 9) { Write-Warning "Could not remove browser profile: $profile" }
      else { Start-Sleep -Milliseconds 150 }
    }
  }
}
