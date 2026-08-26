# Traffic P0 — telemetry, replay و stress baseline

این سند نتیجه‌ی اجرای P0 است. P0 فقط مشاهده‌پذیری، replay، diagnostics و harness اضافه می‌کند؛ منطق حرکت، چراغ، reservation، spawn، virtualize و despawn عمداً tune یا بازنویسی نشده است.

## دامنه و source of truth

- implementation فعلی source of truth است؛ هر اختلاف مستندات با کد به P1 منتقل می‌شود.
- fixed step فعلی `50 ms` و سقف `5` step در frame حفظ شد.
- scheduler budget فعلی `3.5 ms` و فاصله‌های tier حفظ شد.
- seed پیش‌فرض `Random` به‌صورت صریح با همان مقدار قبلی (`0x9e3779b9`) در `TrafficSystem` ثبت شد؛ این تغییر فقط برای ثبت replay است و sequence رفتاری را تغییر نمی‌دهد.
- fixtureهای Node با `fixtureCoverage: "headless-network"` گزارش می‌شوند و جایگزین map کامل runtime نیستند.

## فایل‌های تغییرکرده

### instrumentation/runtime

- `src/gameplay/traffic/TrafficTelemetry.ts` — schema، collectorهای bounded، counter، percentile و snapshot JSON.
- `src/gameplay/traffic/TrafficDriver.ts` — مشاهده‌ی stop reason، state قبلی، downstream clearance و queue position؛ بدون تغییر تصمیم حرکتی.
- `src/gameplay/traffic/TrafficUpdateScheduler.ts` — آمار scheduled/deferred، age، fairness، catch-up، execution و CPU؛ queue، budget و cadence حفظ شد.
- `src/gameplay/traffic/IntersectionReservationController.ts` — شمارنده‌ی grant/deny/timeout، denial reason و snapshot junction؛ منطق تصمیم حفظ شد.
- `src/gameplay/traffic/ParkedVehicleManager.ts` — رخدادهای lifecycle پارک‌شده.
- `src/systems/TrafficSystem.ts` — frame/tick، replay sample، stop episode، lifecycle، virtual metadata loss، signal divergence و orphan hook.
- `src/systems/VehicleSystem.ts` — pool reuse و تشخیص حذف خودرو قبل از TrafficSystem.
- `src/gameplay/traffic/index.ts` — export telemetry.
- `scripts/browser-stress.ps1` — deadline و status مستقل، ذخیره‌ی tail و تفکیک infrastructure timeout.

### harness و commandها

- `scripts/traffic-stress.ts` و `scripts/run-traffic-stress.mjs` — runner قطعی Node و JSON جداگانه برای ۱۴ سناریو.
- `scripts/traffic-telemetry-validation.ts` و `scripts/run-traffic-telemetry-validation.mjs` — تست schema/serialization/stop/junction.
- `scripts/traffic-lifecycle-validation.ts` و `scripts/run-traffic-lifecycle-validation.mjs` — ده تست lifecycle موردنیاز.
- `package.json` — scriptهای `stress:traffic`، `validate:traffic-telemetry` و `validate:traffic-lifecycle`.
- `.gitignore` — خروجی‌های حجیم `.traffic-stress*/`.
- `docs/superpowers/plans/2026-08-26-traffic-p0-telemetry.md` — plan اجرایی.

## فایل‌های تغییرنکرده‌ی حساس

`src/gameplay/traffic/TrafficNetwork.ts`، `src/config/EngineLimits.ts`، `src/config/Constants.ts`، `src/entities/components/VehicleMovementComponent.ts`، `src/scenes/GameScene.ts`، `src/core/ManagerRegistry.ts` و منطق‌های اصلی movement/traffic در این phase تغییر نکردند. هیچ مقدار speed، `MAX_TRAFFIC`، مدت چراغ، timeout reservation/recovery یا distance threshold تغییر نکرده است.

## جریان telemetry نهایی

`ManagerRegistry` همان update order را اجرا می‌کند. `TrafficSystem.update` زمان واقعی frame را با `performance.now()` می‌گیرد، accumulator فعلی را مصرف می‌کند و برای هر fixed step به‌ترتیب `IntersectionReservationController.beginFrame`، perception، `TrafficUpdateScheduler.schedule`، `TrafficDriver.fixedUpdate` و resolve reservation را اجرا می‌کند. پس از آن، نمونه‌ی replay و stop episode ثبت و snapshot junction/lifecycle نگه‌داری می‌شود. `TrafficRuntimeStats.frameTimeMs` اکنون زمان واقعی اجرای update ترافیک است؛ delta شبیه‌سازی در `TrafficTelemetryFrame.simulationDeltaMs` جدا ثبت می‌شود.

## schema خروجی JSON

هر فایل سناریو یک `TrafficScenarioResult` شامل این بخش‌ها دارد:

```json
{
  "schemaVersion": 1,
  "scenario": { "id": "...", "city": "...", "district": "...", "density": "...", "seed": 0, "durationSeconds": 60 },
  "fixtureCoverage": "headless-network",
  "replay": {
    "header": { "schemaVersion": 1, "worldSeed": 1337, "simulationSeed": 0, "scenarioId": "..." },
    "samples": [
      {
        "fixedStep": 10, "simulationClockMs": 500,
        "city": "tehran", "district": "central",
        "vehicleId": 1, "driverId": 1, "laneId": "lane:...",
        "laneDistance": 42, "routeProgress": 0.5,
        "position": { "x": 0, "y": 0 }, "heading": 0,
        "speed": 20, "desiredSpeed": 22, "simulationTier": "near",
        "state": "Following Lane", "intention": "Cruise",
        "stopReason": null, "blockerId": null, "blockerType": null,
        "reservationId": null, "queuePosition": "unknown",
        "recoveryPhase": "none", "lastUpdateTimestamp": 500,
        "updateAgeMs": 0, "ownershipClass": "ambient"
      }
    ]
  },
  "stopEpisodes": [], "activeStops": [], "frames": [],
  "scheduler": [], "junctions": [], "lifecycle": [],
  "counters": {}, "percentiles": {}
}
```

مقادیر غیرقابل‌اندازه‌گیری دقیقاً `"unknown"` هستند. replay digest با FNV-1a روی payload قطعی محاسبه می‌شود و زمان wall-clock در digest وارد نمی‌شود.
در implementation فعلی `TrafficDriver.id` همان `Vehicle.id` است؛ بنابراین دو فیلد با یک مقدار ثبت می‌شوند و این موضوع به‌عنوان واقعیت implementation ثبت شده است.

## telemetryهای اضافه‌شده

- replay: seedهای world/simulation، fixed step، clock، city/district، vehicle/driver، lane/distance/progress، pose/heading، speed/desired speed، tier، state/intention، stop reason، blocker، reservation، queue، recovery، last update/age و ownership.
- stop episode: زمان شروع/پایان/مدت، lane/junction، علت، blocker، speedها، tier، scheduler age، reservation، downstream و state قبل/بعد. علت‌ها شامل red/yellow signal، queue، lead vehicle، yield، downstream blocked، obstacle، bus/taxi stop، collision avoidance، recovery و unexplained stop است.
- scheduler: scheduled/deferred بر tier، queue قبل/بعد، oldest deferred، max/avg/p95 age، fairness gap، near-deferred، catch-up raw values و histogram، execution time هر driver، traffic/navigation/steering/collision CPU.
- junction: phase/group/window، queue per incoming lane، oldest queue، grant/deny/denial reason، timeout، active reservation، connector/stop-box occupancy، downstream/spillback/deadlock (`unknown` در fixture)، و visual/logical divergence.
- lifecycle: spawn accepted/rejected با reason، materialize، virtualize/retire، despawn/protected rejection، pool reuse، orphan detection، ownership/state و metadata از دست‌رفته‌ی virtual record.
- frame: frame id، simulation clock/delta و real wall-clock duration.

## seed و تنظیمات سناریو

world seed همه‌ی سناریوها `1337` است. simulation seed و تنظیمات قطعی:

| سناریو | شهر/ناحیه | density | seed | مدت |
|---|---|---:|---:|---:|
| tehran-low | Tehran/central | low | 4097 | 60s |
| tehran-medium | Tehran/central | medium | 4098 | 60s |
| tehran-high | Tehran/central | high | 4099 | 60s |
| yazd | Yazd/market | medium | 8193 | 60s |
| gilan | Gilan/coastal | medium | 12289 | 60s |
| highway-transition | Tehran/arterial | medium | 16385 | 60s |
| multi-junction | Tehran/arterial | high | 16386 | 60s |
| wanted-high | Tehran/central | medium | 20481 | 60s |
| roadblock-obstacle | Tehran/industrial | medium | 20482 | 60s |
| bus-taxi | Tehran/commercial | medium | 24577 | 60s |
| fast-chunk-crossing | Gilan/intercity | medium | 28673 | 60s |
| pause-resume | Yazd/residential | medium | 28674 | 60s |
| idle-15-minute | Tehran/central | medium | 32769 | 900s |
| idle-30-minute | Tehran/central | medium | 32770 | 1800s |

## baseline اندازه‌گیری‌شده

آخرین اجرای کامل در `.traffic-stress-p0-final/` انجام شد. واحد speed، همان واحد fixture (px/s) است؛ زمان‌ها ms هستند. `median/p95 intersection delay` در fixture قابل‌اندازه‌گیری نبود و `unknown` باقی ماند.

| سناریو | avg speed | median | p95 | throughput/min | avg stop | p95 stop | reservation timeout | max queue age | real frame |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| tehran-low | 74.35 | 84.30 | 87.78 | 50.00 | 1207 | 3150 | 0 | 0 | 0.100 |
| tehran-medium | 47.76 | 57.85 | 87.73 | 61.00 | 3763 | 11550 | 4 | 1450 | 0.163 |
| tehran-high | 55.39 | 68.87 | 75.61 | 72.00 | 1718 | 5300 | 1 | 1650 | 0.109 |
| yazd | 52.84 | 69.36 | 87.74 | 70.00 | 3170 | 11100 | 5 | 2600 | 0.108 |
| gilan | 43.79 | 47.08 | 87.72 | 57.00 | 3350 | 9100 | 7 | 8050 | 0.072 |
| highway-transition | 54.64 | 71.60 | 87.74 | 71.00 | 2430 | 6300 | 8 | 4500 | 0.104 |
| multi-junction | 50.05 | 64.03 | 75.61 | 67.00 | 2632 | 9700 | 5 | 4150 | 0.093 |
| wanted-high | 52.00 | 67.98 | 87.74 | 67.00 | 3162 | 9850 | 4 | 8350 | 0.131 |
| roadblock-obstacle | 44.61 | 51.05 | 87.69 | 58.00 | 3286 | 10300 | 12 | 750 | 0.113 |
| bus-taxi | 59.19 | 73.95 | 87.74 | 79.00 | 1962 | 7300 | 1 | 0 | 0.117 |
| fast-chunk-crossing | 21.06 | 8.61e-9 | 87.07 | 26.00 | 4193 | 11800 | 19 | 44350 | 0.117 |
| pause-resume | 48.90 | 64.73 | 87.73 | 55.00 | 3192 | 8350 | 4 | 10000 | 0.108 |
| idle-15-minute | 46.29 | 53.96 | 87.74 | 62.60 | 3893 | 13450 | 94 | 3050 | 0.084 |
| idle-30-minute | 5.26 | 2.5e-323 | 69.02 | 7.07 | 2813 | 8900 | 773 | 1627500 | 0.099 |

سایر baseline fields: در همه‌ی ۱۴ fixture، `unexplainedStop=0`، `blockedIntersection=0`، `recovery=0`، `recoveryTimeout=0`، `wrongDirection=0`، `leftRoad=0` و `badSpawn=0` ثبت شد. `deferredUpdate`، `maximumUpdateAgeMs` و `trafficCpuMs` در Node fixture `unknown` هستند؛ `activeCount` برابر ۴ برای low و ۸ برای سایر سناریوها، `virtualCount=0` و `parkedCount=0` است؛ spawn/materialization rejection و lifecycle race/orphan نیز در fixture `unknown` هستند.

replay digest برای هر سناریو در JSON همان پوشه موجود است. اجرای مستقل دوم با `.traffic-stress-p0-a` برای هر ۱۴ سناریو digest یکسان داد؛ بنابراین replay deterministic است.

## top stop و throughput observations

- تنها stop reason شمارش‌شده در matrix fixture، `stop.queue` با مجموع **۹۲۸ episode** بود. علت‌های دیگر در این fixture رخ ندادند یا قابل‌تشخیص نبودند؛ از این نتیجه برای runtime map تعمیم داده نمی‌شود.
- بیشترین queue age برابر **1,627,500 ms** در `idle-30-minute` بود؛ این یک observation از fixture است و نشانه‌ی قفل queue/reservation در P1 است.
- پنج هم‌بستگی قابل‌مشاهده با throughput پایین (causality هنوز `unknown`): `reservation timeout` در idle-30 (773)، queue accumulation همان سناریو، downstream/roadblock در roadblock-obstacle (12 timeout)، fast-chunk traversal (26 vehicle/min و 44,350ms max queue age)، و pause/resume (55 vehicle/min با 4 timeout). این‌ها رتبه‌بندی علت قطعی نیستند؛ برای علت‌یابی P1 باید event-level attribution اضافه شود.
- بیشترین update age در Node fixture **unknown** است چون scheduler واقعی TrafficSystem در runner headless اجرا نمی‌شود؛ بیشترین queue age بالا ثبت شده است.
- signal visual/logical divergence مجموعاً **0**، lifecycle race **unknown** در baseline fixture، و orphan vehicle **unknown** ثبت شد. تست lifecycle synthetic ده case را پوشش داد.

## lifecycle tests

`validate:traffic-lifecycle` هر ۱۰ case را PASS کرد: connector/reservation قبل از virtualize، mission/emergency/pursuit protection، parked-to-player، pool reuse، stream-order race، materialize نزدیک خودرو و destruction/despawn race. این تست‌ها discovery-only هستند و lifecycle decision را اصلاح نمی‌کنند.

## browser harness

PowerShell parser PASS شد. اجرای کوتاه با dev server و Chrome در phase `navigate` روی `ReceiveAsync` با cancellation deadline شکست خورد و در فایل خروجی status=`infrastructure-timeout` ثبت شد؛ این failure به‌عنوان gameplay failure شمرده نشد. timeout بی‌نهایت نشده، phase مستقل و ذخیره‌ی telemetry tail برقرار است. در آن اجرا sampleی قبل از navigation موفق ثبت نشده بود.

## verification

- `npm run typecheck` — PASS.
- `npm run lint` — PASS.
- `npm run build` — PASS (`vite build`، 235 modules).
- `npm run validate:traffic-telemetry` — PASS (۱۱ assertion).
- `npm run validate:traffic-lifecycle` — PASS (۱۰ case).
- `npm run validate:traffic` — PASS (481,594 invariant checks، 96,000 agent-steps).
- `npm run validate:highways` — PASS (26,082 invariant checks، 397 graph edges).
- `npm run stress:traffic -- .traffic-stress-p0-final` — PASS، ۱۴ سناریو.
- deterministic replay comparison — PASS، ۱۴/۱۴ digest برابر.

## محدودیت‌های اندازه‌گیری

Node runner از شبکه‌ی کوچک headless استفاده می‌کند؛ map کامل Tehran/Yazd/Gilan، Phaser physics، chunk streaming واقعی، collider wiring، parked registry و scheduler budget واقعی در آن اجرا نمی‌شوند. بنابراین CPU واقعی traffic/navigation/steering/collision، deferred update، materialization/despawn واقعی، active/virtual/parked runtime count، race/orphan و intersection delay در baseline به‌درستی `unknown` هستند. `signalVisualLogicalDivergence=0` فقط برای junction/lightهای قابل‌مشاهده‌ی fixture است. زمان wall-clock Node برای مقایسه‌ی gameplay استفاده نمی‌شود.

## پیشنهاد دقیق P1 بر پایه‌ی داده

1. ابتدا روی `idle-30-minute` replay event-level trace بگیرید: هر reservation request/grant/timeout/release، queue insert/remove/stale prune و connector enter/exit را با vehicle id و junction id به یک timeline متصل کنید؛ هدف، توضیح 773 timeout و 1,627,500ms queue age است، نه tuning فوری.
2. scheduler واقعی را زیر بار نزدیک `3.5ms` با telemetry جدید اجرا کنید و p95/max update age و near-deferred را از runtime ثبت کنید؛ تا این داده نباشد تغییر budget یا cadence مجاز نیست.
3. در map واقعی downstream clearance، stop-box occupancy، spillback depth و deadlock duration را از collider/network query پر کنید؛ مقدارهای فعلی عمدی `unknown` هستند.
4. lifecycle eventها را به chunk id و stable virtual-record id متصل کنید تا materialize overlap، stream boundary و orphan race قابل‌اندازه‌گیری شوند.
5. browser harness را با deadline per-phase و telemetry tail روی CDP پایدار تکرار کنید؛ infrastructure failure فعلی باید جدا از gameplay baseline باقی بماند.

هیچ رفتار خودرو، چراغ، reservation، spawn، virtualize یا despawn در P0 اصلاح نشده است؛ هر tuning پس از این evidence باید در P1 با before/after baseline و acceptance criteria انجام شود.
