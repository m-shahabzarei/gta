import { Logger } from '@/utils/Logger';

const log = Logger.create('PWA');
const SERVICE_WORKER_FILE = 'sw.js';
const CACHE_PREFIX = 'pixel-city-';
const TOAST_STYLE_ID = 'pixel-city-pwa-toast-style';
const controllerState = { refreshing: false };

interface BeforeInstallPromptChoice {
  outcome: 'accepted' | 'dismissed';
  platform: string;
}

interface BeforeInstallPromptEvent extends Event {
  readonly userChoice: Promise<BeforeInstallPromptChoice>;
  prompt(): Promise<void>;
}

interface ToastOptions {
  id: string;
  title: string;
  message: string;
  actionLabel: string;
  onAction: () => Promise<void> | void;
}

let deferredInstallPrompt: BeforeInstallPromptEvent | null = null;

/** Register production PWA behavior and clean stale local workers during dev. */
export function registerPwaServiceWorker(): void {
  if (!canUseServiceWorker()) return;

  if (import.meta.env.DEV) {
    whenWindowLoaded(removeDevelopmentServiceWorkers);
    return;
  }

  wireInstallPrompt();
  whenWindowLoaded(registerProductionServiceWorker);
}

function canUseServiceWorker(): boolean {
  return typeof window !== 'undefined' && typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

function whenWindowLoaded(task: () => Promise<void>): void {
  if (document.readyState === 'complete') {
    void task();
    return;
  }

  window.addEventListener(
    'load',
    () => {
      void task();
    },
    { once: true },
  );
}

async function registerProductionServiceWorker(): Promise<void> {
  const baseUrl = new URL(import.meta.env.BASE_URL, window.location.href);
  const workerUrl = new URL(SERVICE_WORKER_FILE, baseUrl);

  try {
    const registration = await navigator.serviceWorker.register(workerUrl, {
      scope: baseUrl.pathname,
      updateViaCache: 'none',
    });

    watchForServiceWorkerUpdates(registration);
    void registration.update();
    log.info('Service worker registered.');
  } catch (error: unknown) {
    log.warn('Service worker registration failed:', error);
  }
}

async function removeDevelopmentServiceWorkers(): Promise<void> {
  const appBaseUrl = new URL(import.meta.env.BASE_URL, window.location.href);

  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(
      registrations
        .filter((registration) => isRegistrationForCurrentApp(registration, appBaseUrl))
        .map((registration) => registration.unregister()),
    );

    if ('caches' in window) {
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.filter((name) => name.startsWith(CACHE_PREFIX)).map((name) => caches.delete(name)));
    }
  } catch (error: unknown) {
    log.debug('Development service worker cleanup skipped:', error);
  }
}

function isRegistrationForCurrentApp(registration: ServiceWorkerRegistration, appBaseUrl: URL): boolean {
  const scopeUrl = new URL(registration.scope);
  if (scopeUrl.origin !== appBaseUrl.origin) return false;
  if (scopeUrl.pathname === '/') return appBaseUrl.pathname === '/';
  return appBaseUrl.pathname.startsWith(scopeUrl.pathname);
}

function watchForServiceWorkerUpdates(registration: ServiceWorkerRegistration): void {
  if (registration.waiting && navigator.serviceWorker.controller) {
    showUpdateReadyToast(registration);
  }

  registration.addEventListener('updatefound', () => {
    const installingWorker = registration.installing;
    if (!installingWorker) return;

    installingWorker.addEventListener('statechange', () => {
      if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
        showUpdateReadyToast(registration);
      }
    });
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (controllerState.refreshing) return;
    controllerState.refreshing = true;
    window.location.reload();
  });
}

function wireInstallPrompt(): void {
  window.addEventListener('beforeinstallprompt', (event: Event) => {
    event.preventDefault();
    deferredInstallPrompt = event as BeforeInstallPromptEvent;

    showPwaToast({
      id: 'install',
      title: 'Install Pixel City',
      message: 'Play fullscreen and keep the city shell cached for offline sessions.',
      actionLabel: 'Install',
      onAction: async () => {
        const promptEvent = deferredInstallPrompt;
        hidePwaToast('install');
        if (!promptEvent) return;

        await promptEvent.prompt();
        await promptEvent.userChoice.catch(() => ({ outcome: 'dismissed', platform: 'unknown' }));
        deferredInstallPrompt = null;
      },
    });
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    hidePwaToast('install');
    log.info('Application installed.');
  });
}

function showUpdateReadyToast(registration: ServiceWorkerRegistration): void {
  showPwaToast({
    id: 'update',
    title: 'Update ready',
    message: 'A newer Pixel City build is cached and ready to activate.',
    actionLabel: 'Reload',
    onAction: () => {
      registration.waiting?.postMessage({ type: 'SKIP_WAITING' });
      hidePwaToast('update');
    },
  });
}

function showPwaToast(options: ToastOptions): void {
  if (typeof document === 'undefined') return;

  ensureToastStyles();
  hidePwaToast(options.id);

  const toast = document.createElement('aside');
  toast.id = toastElementId(options.id);
  toast.className = 'pwa-toast';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');

  const copy = document.createElement('div');
  copy.className = 'pwa-toast__copy';

  const title = document.createElement('strong');
  title.textContent = options.title;

  const message = document.createElement('span');
  message.textContent = options.message;

  copy.append(title, message);

  const actions = document.createElement('div');
  actions.className = 'pwa-toast__actions';

  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'pwa-toast__button pwa-toast__button--primary';
  action.textContent = options.actionLabel;
  action.addEventListener('click', () => {
    void options.onAction();
  });

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'pwa-toast__button';
  dismiss.textContent = 'Dismiss';
  dismiss.addEventListener('click', () => hidePwaToast(options.id));

  actions.append(action, dismiss);
  toast.append(copy, actions);
  document.body.appendChild(toast);
}

function hidePwaToast(id: string): void {
  document.getElementById(toastElementId(id))?.remove();
}

function toastElementId(id: string): string {
  return `pixel-city-pwa-toast-${id}`;
}

function ensureToastStyles(): void {
  if (document.getElementById(TOAST_STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = TOAST_STYLE_ID;
  style.textContent = `
    .pwa-toast {
      position: fixed;
      top: max(16px, env(safe-area-inset-top));
      right: max(16px, env(safe-area-inset-right));
      z-index: 10001;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 16px;
      width: min(460px, calc(100vw - 32px));
      padding: 14px;
      color: #f4f4f8;
      background: rgba(10, 10, 15, 0.92);
      border: 2px solid rgba(255, 204, 51, 0.42);
      border-radius: 14px;
      box-shadow: 0 18px 44px rgba(0, 0, 0, 0.36);
      font-family: "Courier New", Courier, monospace;
      backdrop-filter: blur(10px);
    }

    .pwa-toast__copy {
      display: grid;
      gap: 4px;
      min-width: 0;
    }

    .pwa-toast__copy strong {
      color: #ffcc33;
      font-size: 14px;
      line-height: 1.2;
      text-transform: uppercase;
    }

    .pwa-toast__copy span {
      color: #c7cad6;
      font-size: 13px;
      line-height: 1.35;
    }

    .pwa-toast__actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .pwa-toast__button {
      border: 1px solid #3d4355;
      border-radius: 10px;
      padding: 9px 10px;
      color: #f4f4f8;
      background: #141824;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }

    .pwa-toast__button--primary {
      border-color: #ffcc33;
      color: #10131a;
      background: #ffcc33;
    }

    .pwa-toast__button:focus-visible {
      outline: 3px solid #75e6ff;
      outline-offset: 2px;
    }

    @media (max-width: 720px) {
      .pwa-toast {
        grid-template-columns: 1fr;
        left: max(16px, env(safe-area-inset-left));
      }

      .pwa-toast__actions {
        justify-content: flex-end;
      }
    }
  `;
  document.head.appendChild(style);
}
