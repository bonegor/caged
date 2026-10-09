// Dev helper: opens the game in headless Chromium and saves screenshots.
// Usage: node tools/dev/shot.mjs <url> <out.png> [waitSeconds] [script.js]
import fs from 'node:fs';
import { chromium } from 'playwright';

const [url, out, waitArg = '3', scriptFile] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
await page.goto(url);
await page.waitForTimeout(parseFloat(waitArg) * 1000);
if (scriptFile) {
  const code = fs.readFileSync(scriptFile, 'utf8');
  const res = await page.evaluate(code);
  if (res !== undefined) console.log('script result:', JSON.stringify(res));
}
await page.screenshot({ path: out });
const fps = await page.evaluate(() => window.__app?.ticker?.FPS ?? null).catch(() => null);
console.log('fps', fps);
console.log(logs.filter((l) => !l.includes('[vite]')).slice(0, 30).join('\n'));
await browser.close();
