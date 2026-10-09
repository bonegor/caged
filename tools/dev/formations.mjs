// Dev helper: scripted formation checks in the real renderer.
// Usage: node tools/dev/formations.mjs <outdir>
import { chromium } from 'playwright';
const out = process.argv[2];
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto('http://localhost:5173/?battle=open-field');
await page.waitForFunction(() => window.__battle, null, { timeout: 60000 });
await page.waitForTimeout(1500);

// Helpers inside the page.
await page.evaluate(() => {
  const b = window.__battle;
  b.world.controllers.length = 0; // no AI: we only test movement
  b.paused = true;
  window.T = {
    own: () => b.world.units.filter((u) => u.alive && u.team === 0),
    step(sec) {
      for (let i = 0; i < sec * 30; i++) { b.world.step(1 / 30); b.renderer.consumeEvents(); b.world.events = []; }
    },
    centre() {
      const o = this.own();
      return o.reduce((a, u) => ({ x: a.x + u.pos.x / o.length, y: a.y + u.pos.y / o.length }), { x: 0, y: 0 });
    },
    look(z = 0.85) { b.renderer.camera.centerOn(this.centre()); b.renderer.camera.zoom = z; },
    info() { const f = this.own()[0].formation; return { phase: f?.phase, mode: f?.mode, layout: f?.layoutMode, t: b.world.time.toFixed(1) }; },
  };
});
const shot = async (name, label) => {
  await page.evaluate(() => window.T.look());
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(name, label ?? '', JSON.stringify(await page.evaluate(() => window.T.info())));
};

// 1. Turn 90 degrees to the right and move 50 u: re-form with synchronized arrival.
await page.evaluate(() => {
  const c = window.T.centre();
  window.__battle.world.commandMove(window.T.own(), { x: c.x + 35, y: c.y + 35 });
});
await page.evaluate(() => window.T.step(1.2));
await shot('f1_reforming', 'mid re-form (sync)');
await page.evaluate(() => window.T.step(14));
await shot('f2_reformed', 'after re-form');

// 2. Long move: marching column.
await page.evaluate(() => {
  window.__battle.world.commandMove(window.T.own(), { x: 255, y: 250 });
});
await page.evaluate(() => window.T.step(14));
await shot('f3_column', 'marching column');
await page.evaluate(() => window.T.step(45));
await shot('f4_deployed', 'deployed after march');

// 3. Staggered and box.
await page.evaluate(() => window.__battle.world.setShape(window.T.own(), 'staggered'));
await page.evaluate(() => window.T.step(10));
await shot('f5_staggered');
await page.evaluate(() => window.__battle.world.setShape(window.T.own(), 'box'));
await page.evaluate(() => window.T.step(12));
await shot('f6_box');
await page.evaluate(() => window.__battle.world.setShape(window.T.own(), 'flank'));
await page.evaluate(() => window.T.step(12));
await shot('f7_flank');
console.log(logs.filter((l) => !l.includes('[vite]')).slice(0, 20).join('\n'));
await browser.close();
