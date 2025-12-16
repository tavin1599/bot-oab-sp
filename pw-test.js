const playwright = require("playwright");

(async () => {
  try {
    console.log("Inicializando Chromium...");
    const browser = await playwright.chromium.launch({
      headless: false,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    });

    console.log("Abrindo página...");
    const page = await browser.newPage();

    await page.goto("https://google.com");
    console.log("Página aberta com sucesso!");

    await page.waitForTimeout(5000);
    await browser.close();
    console.log("Finalizado.");
  } catch (err) {
    console.error("ERRO NO PLAYWRIGHT:", err);
  }
})();