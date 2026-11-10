import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", String(e).slice(0, 200)));
await page.goto("http://127.0.0.1:3001/laya-game.html");
await page.click("#start");
await page.waitForTimeout(300);
const state1 = await page.evaluate(() => ({ hidden: document.getElementById("pulse").hidden, hits: document.getElementById("hits").textContent, time: document.getElementById("time").textContent }));
// click the pulse at its CURRENT coords
const box1 = await page.locator("#pulse").boundingBox();
await page.mouse.click(box1.x + box1.width / 2, box1.y + box1.height / 2);
const state2 = await page.evaluate(() => ({ hits: document.getElementById("hits").textContent, size: document.getElementById("pulse").style.width }));
// STALE-COORDS click: re-click where the button WAS (fast-path burst simulation)
await page.mouse.click(box1.x + box1.width / 2, box1.y + box1.height / 2);
const state3 = await page.evaluate(() => ({ hits: document.getElementById("hits").textContent, misses: document.getElementById("misses").textContent }));
console.log(JSON.stringify({ state1, afterFreshClick: state2, afterStaleClick: state3 }, null, 1));
await browser.close();
