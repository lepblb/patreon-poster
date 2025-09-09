import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "1mb" }));

const SESSION_COOKIE = process.env.PATREON_SESSION_COOKIE;
const EMAIL = process.env.PATREON_EMAIL;
const PASSWORD = process.env.PATREON_PASSWORD;

app.post("/create-patreon-post", async (req, res) => {
  const { title, content, visibility = "patrons" } = req.body || {};
  if (!title || !content) return res.status(400).json({ error: "title and content required" });

  let browser;
  try {
    browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      headless: true
    });
    const context = await browser.newContext();

    if (SESSION_COOKIE) {
      const cookiePairs = SESSION_COOKIE.split(";").map(s => s.trim()).filter(Boolean);
      const cookies = cookiePairs.map(kv => {
        const [name, ...rest] = kv.split("=");
        return { name, value: rest.join("="), domain: ".patreon.com", path: "/" };
      });
      await context.addCookies(cookies);
    }

    const page = await context.newPage();
    await page.goto("https://www.patreon.com/home", { waitUntil: "domcontentloaded" });

    const needsLogin = await page.locator('text=Log in').first().isVisible().catch(() => false);
    if (needsLogin) {
      if (!EMAIL || !PASSWORD) {
        throw new Error("Not logged in and no credentials provided. Set PATREON_SESSION_COOKIE or PATREON_EMAIL+PATREON_PASSWORD.");
      }
      await page.goto("https://www.patreon.com/login", { waitUntil: "domcontentloaded" });
      await page.fill('input[type="email"]', EMAIL);
      await page.fill('input[type="password"]', PASSWORD);
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle" }),
        page.click('button[type="submit"]')
      ]);
    }

    await page.goto("https://www.patreon.com/posts/new?type=text", { waitUntil: "networkidle" });

    const titleSel = [
      '[data-testid="post-title-input"]',
      'textarea[aria-label="Title"]',
      'input[placeholder*="Title"]',
      '[contenteditable="true"]'
    ].join(", ");
    await page.locator(titleSel).first().click({ timeout: 15000 });
    await page.keyboard.type(title);

    const contentSel = [
      '[data-testid="post-body-editor"]',
      'div[role="textbox"][contenteditable="true"]',
      'textarea[aria-label*="Write"]'
    ].join(", ");
    await page.locator(contentSel).first().click({ timeout: 15000 });
    await page.keyboard.type(content);

    if (visibility !== "public") {
      const visBtn = page.getByRole("button", { name: /public|patrons/i }).first();
      if (await visBtn.isVisible().catch(() => false)) {
        await visBtn.click();
        const patronsOpt = page.getByRole("option", { name: /patrons only|members/i }).first();
        if (await patronsOpt.isVisible().catch(() => false)) await patronsOpt.click();
      }
    }

    const publishBtn = page.getByRole("button", { name: /publish/i }).first();
    await Promise.all([
      page.waitForLoadState("networkidle"),
      publishBtn.click({ timeout: 20000 })
    ]);

    await page.waitForURL(/patreon\.com\/posts\//, { timeout: 60000 });
    const patreonUrl = page.url();

    res.json({ patreonUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err?.message || err) });
  } finally {
    try { await browser?.close(); } catch {}
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`patreon-poster listening on :${port}`));
