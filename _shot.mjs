import { chromium } from "@playwright/test";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });
await p.goto("file:///tmp/ossclip-card/card.html");
await p.waitForTimeout(600);
await p.screenshot({ path: "/Users/amu1o5/personal/open-clip/docs/site/assets/social-card.png" });
await b.close();
