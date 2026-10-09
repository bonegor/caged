// Dev helper: clicks through the menus and screenshots each step.
// Usage: node tools/dev/flow.mjs <outdir>
import { chromium } from 'playwright';
const out = process.argv[2];
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto('http://localhost:5173/');
await page.waitForTimeout(5000);
await page.click('text=Choose a Battle');
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/flow_scenarios.png` });
await page.click('text=Prepare Army');
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/flow_setup.png` });
await page.click('text=Begin Battle');
await page.waitForTimeout(15000);
await page.screenshot({ path: `${out}/flow_battle.png` });
// Select the army with a box drag and screenshot the HUD.
await page.mouse.move(150, 200);
await page.mouse.down();
await page.mouse.move(1400, 700, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/flow_selected.png` });
console.log(logs.filter((l) => !l.includes('[vite]')).slice(0, 20).join('\n'));
await browser.close();
