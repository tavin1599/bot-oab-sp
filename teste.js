const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://www.google.com');
  console.log('OK - Chromium abriu');
  await browser.close();
})();
