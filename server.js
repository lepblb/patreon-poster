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
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"]
    });

    const context = await browser.newContext({
      // a normal Chrome UA helps reduce anti-bot hiccups
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 768 }
    });
    context.setDefaultTimeout(60000); // default waits up to 60s

    // Use session cookie if provided (best for 2FA)
    if (SESSION_COOKIE) {
      const cookiePairs = SESSION_COOKIE.split(";").map(s => s.trim()).filter(Boolean);
      const cookies = cookiePairs.map(kv => {
        const [name, ...rest] = kv.split("=");
        return { name, value: rest.join("="), domain: ".patreon.com", path: "/" };
      });
      await context.addCookies(cookies);
    }

    const page = await context.newPage();

    // Helper: dismiss cookie banner if it appears
    const dismissCookieBanner = async () => {
      try {
        // OneTrust style
        const onetrust = page.locator("#onetrust-accept-btn-handler");
        if (await onetrust.isVisible({ timeout: 2000 }).catch(() => false)) {
          await onetrust.click();
        }
        // Generic “Accept all cookies”
        const acceptAll = page.getByRole("button", { name: /accept all/i });
        if (await acceptAll.isVisible({ timeout: 2000 }).catch(() => false)) {
          await acceptAll.click();
        }
      } catch {}
    };

    // 1) Go to home (more reliable entry)
    await page.goto("https://www.patreon.com/home", { waitUntil: "domcontentloaded", timeout: 90000 });
    await dismissCookieBanner();

    // 2) If not logged in, log in (only if EMAIL/PASSWORD provided)
    const loginLinkVisible = await page.getByRole("link", { name: /log in/i }).first().isVisible().catch(() => false);
    if (loginLinkVisible) {
      if (!EMAIL || !PASSWORD) {
        throw new Error("Not logged in and no credentials provided. Set PATREON_SESSION_COOKIE or PATREON_EMAIL+PATREON_PASSWORD.");
      }
      await page.goto("https://www.patreon.com/login", { waitUntil: "domcontentloaded", timeout: 90000 });
      await dismissCookieBanner();
      await page.fill('input[type="email"]', EMAIL, { timeout: 60000 });
      await page.fill('input[type="password"]', PASSWORD, { timeout: 60000 });
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 90000 }),
        page.click('button[type="submit"]')
      ]);
      // Back to home to stabilise session
      await page.goto("https://www.patreon.com/home", { waitUntil: "domcontentloaded", timeout: 90000 });
    }

    // 3) Open the text post composer (use domcontentloaded, not networkidle)
    // Try direct route first
    const composerUrls = [
      "https://www.patreon.com/posts/new?type=text",
      "https://www.patreon.com/posts/new"
    ];
    let composerLoaded = false;
    for (const url of composerUrls) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
        await dismissCookieBanner();
        // Wait for any of the known title/body selectors
        const titleSel = page.locator(
          [
            '[data-testid="post-title-input"]',
            'textarea[aria-label="Title"]',
            'input[placeholder*="Title"]',
            '[contenteditable="true"]'
          ].join(", ")
        );
        const bodySel = page.locator(
          [
            '[data-testid="post-body-editor"]',
            'div[role="textbox"][contenteditable="true"]',
            'textarea[aria-label*="Write"]'
          ].join(", ")
        );

        await Promise.race([
          titleSel.waitFor({ state: "visible", timeout: 60000 }),
          bodySel.waitFor({ state: "visible", timeout: 60000 })
        ]);
        composerLoaded = true;
        break;
      } catch {
        // try the next URL
      }
    }

    if (!composerLoaded) {
      throw new Error("Could not load the text post composer (timed out waiting for editor).");
    }

    // 4) Fill title & content
    const titleCandidates = [
      '[data-testid="post-title-input"]',
      'textarea[aria-label="Title"]',
      'input[placeholder*="Title"]',
      '[contenteditable="true"]'
    ];
    const bodyCandidates = [
      '[data-testid="post-body-editor"]',
      'div[role="textbox"][contenteditable="true"]',
      'textarea[aria-label*="Write"]'
    ];

    const clickAndType = async (selectors, text) => {
      for (const sel of selectors) {
        const loc = page.locator(sel).first();
        if (await loc.isVisible().catch(() => false)) {
          await loc.click();
          await page.keyboard.type(text);
          return true;
        }
      }
      return false;
    };

    const titleOk = await clickAndType(titleCandidates, title);
    const bodyOk = await clickAndType(bodyCandidates, content);
    if (!titleOk || !bodyOk) throw new Error("Could not find title/content fields on the composer.");

    // 5) Visibility (default patrons). Try to switch only if asked public.
    if (visibility === "public") {
      const visBtn = page.getByRole("button", { name: /public|patrons|members/i }).first();
      if (await visBtn.isVisible().catch(() => false)) {
        await visBtn.click();
        const publicOpt = page.getByRole("option", { name: /public/i }).first();
        if (await publicOpt.isVisible().catch(() => false)) await publicOpt.click();
      }
    }

    // 6) Publish (with generous timeout)
    const publishBtn = page.getByRole("button", { name: /publish/i }).first();
    if (!(await publishBtn.isVisible().catch(() => false))) {
      // sometimes it's “Post” or similar
      const postBtn = page.getByRole("button", { name: /post/i }).first();
      if (await postBtn.isVisible().catch(() => false)) {
        await Promise.all([page.waitForLoadState("load", { timeout: 90000 }), postBtn.click()]);
      } else {
        throw new Error("Publish/Post button not found.");
      }
    } else {
      await Promise.all([page.waitForLoadState("load", { timeout: 90000 }), publishBtn.click()]);
    }

    // Wait until it lands on the final post URL
    await page.waitForURL(/patreon\.com\/posts\//, { timeout: 120000 });
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
