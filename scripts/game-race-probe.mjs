// Simulate the laya fast-path click pattern: re-resolve the element rect per
// click (like clickElement does), ~650ms cadence — prove 10 clean hits.
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
await page.goto("http://127.0.0.1:3001/laya-game.html");
await page.click("#start");
for (let i = 0; i < 10; i++) {
  const box = await page.locator("#pulse").boundingBox(); // fresh resolution per click
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(650);
}
const state = await page.evaluate(() => ({
  hits: document.getElementById("hits").textContent,
  misses: document.getElementById("misses").textContent,
  size: document.getElementById("pulse").style.width
}));
console.log(JSON.stringify(state));
await browser.close();
