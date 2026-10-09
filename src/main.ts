import { Application } from 'pixi.js';
import './ui/style.css';
import { App } from './app';

async function boot(): Promise<void> {
  const app = new Application();
  await app.init({
    resizeTo: window,
    background: '#13150f',
    antialias: false,
    preference: 'webgl',
    roundPixels: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
  });
  document.getElementById('game')!.appendChild(app.canvas);
  const game = new App(app, document.getElementById('ui')!);
  // Handy for debugging from the console.
  (window as unknown as { __game: App; __app: Application }).__game = game;
  (window as unknown as { __app: Application }).__app = app;
  // ?battle=<scenario id> jumps straight into a battle (handy for testing and sharing).
  const direct = new URLSearchParams(location.search).get('battle');
  if (direct) await game.quickBattle(direct);
  else await game.mainMenu();
}

boot().catch((e) => {
  console.error(e);
  document.getElementById('ui')!.innerHTML = `<div style="padding:40px;color:#fff;font:18px sans-serif">Failed to start: ${String(e)}</div>`;
});
