# Pixel City — Gameplay Guide

A top-down open-world sandbox inspired by GTA 1 & 2. Roam a procedurally
generated city on foot or by car, cause chaos, dodge the police, and run
missions for cash.

## Controls

| Action | Keys |
| --- | --- |
| Move | **W A S D** or **Arrow keys** |
| Run | **Shift** (hold) |
| Aim | **Mouse** (the player faces the cursor) |
| Shoot | **Space** or **Left Mouse** (hold for automatic weapons) |
| Enter / exit vehicle | **F** or **Enter** |
| Next weapon | **X** |
| Previous weapon | **Z** / **Q** |
| Interact / start mission | **E** |
| Pause menu | **P** or **Esc** |
| Inventory | open from the pause menu |
| Quick save / load | **F5** / **F9** |

While **driving**: steer with **A/D** (or ←/→), accelerate with **W/↑**, reverse
with **S/↓**. Press **F** to jump out.

## On foot

- **Health** regenerates only via respawns; it drops from bullets, explosions
  and being run over. At **0 HP** you die and respawn at the nearest **hospital**
  after a short delay with a few seconds of invulnerability.
- **Weapons**: Fists, Pistol, SMG, Shotgun and Rifle. Each has its own damage,
  fire-rate, spread and magazine. Fists never run out of ammo. Switch with X/Z.
- **Money** is earned from missions. It shows on the HUD and in the inventory.

## Vehicles

- Walk up to any car and press **F** to hijack it. Civilian cars are free to
  take (though stealing one is a minor crime); traffic cars can be pulled from
  the flow of traffic.
- Cars take **damage** from collisions and gunfire. Enough damage and the car
  **explodes**, hurting everything nearby — including you if you linger.
- **Running people over** at speed injures or kills them (and raises your wanted
  level if you're driving).
- Kinds: Sedan, Taxi, Sports, Truck (civilian), plus Police and Ambulance
  (emergency).

## The city

- Roads, sidewalks, buildings, water, trees and street lights are laid out on a
  block grid by the **city generator** (deterministic per seed).
- **Traffic lights** cycle at intersections; AI traffic stops on red.
- **Pedestrians** wander the sidewalks, chat, and flee from gunfire, explosions
  and death nearby.
- The world contains four **hospitals** and four **police stations** distributed
  across Tehran, Yazd, and Gilan. Each has a city-specific exterior, parking,
  service vehicles, and a physical cutaway interior.
- Walk through a marked service entrance to enter. Hospitals provide treatment,
  medkits, and save access; police desks can resolve an active wanted record.
  Use **E** at the relevant counter or station.
- Doctors, nurses, patients, paramedics, detectives, desk officers, and custody
  officers use the shared pedestrian AI and remain inside their assigned rooms.
- Hospital-cross and police-badge POIs on the world map and minimap use the same
  world coordinates as the actual entrances.

## Wanted level & police

- Committing crimes (firing guns in public, assault, murder, car theft,
  hit-and-run) raises your **wanted level** (up to **6 stars**, shown on the HUD).
- Police **spawn near you**, **chase**, **shoot**, and — if they corner you on
  foot — **arrest** you (a "bust" that clears your stars and costs you).
- Stars **decay** over time if you avoid fresh crimes and stay clear of the law.

## Missions

- Look for the pulsing **mission marker**. Stand on it and press **E** to start.
- Missions chain objectives: reach a location, eliminate targets, steal a
  vehicle, or survive the heat. The current objective shows on the HUD banner.
- Completing a mission pays a **cash reward**. Dying or getting busted fails the
  active mission.

## HUD & minimap

- **Top-left**: health bar and money. **Top-right**: wanted stars and the clock.
- **Bottom-right**: current weapon icon, name and ammo. **Bottom-left**: the
  **minimap** with the city layout, police (red) and vehicle (grey) blips.
- A **day/night cycle** runs in real time and dynamically re-tints the world;
  optional **weather** (rain / fog) can be toggled in Settings.

## Settings

Open **Settings** from the pause menu to adjust:

- **Audio** — master / music / effects volumes and mute.
- **Graphics** — quality preset (particle density), weather mode, screen shake.
- **Display** — fullscreen, VSync.
- **Language** — English / Spanish / French for the UI chrome.

## Tips

- Keep moving when wanted — cops converge on your last position.
- A fast car is the best weapon *and* the best escape.
- Explosions chain: shoot a car near a crowd of police.
