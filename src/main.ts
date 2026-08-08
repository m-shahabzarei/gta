/**
 * Application entry point.
 *
 * Referenced by `index.html` as a module script. It simply boots the {@link Game}
 * and surfaces any fatal boot error. All real wiring lives in `Game.ts`.
 */
import { Game } from '@/Game';
import { registerPwaServiceWorker } from '@/platform';
import { Logger } from '@/utils/Logger';

const log = Logger.create('main');

registerPwaServiceWorker();

Game.boot()
  .then((game) => {
    // Expose the instance in dev for debugging from the browser console.
    if (import.meta.env.DEV) {
      (window as unknown as { game: Game }).game = game;
    }
  })
  .catch((error: unknown) => {
    log.error('Fatal error during boot:', error);
  });
