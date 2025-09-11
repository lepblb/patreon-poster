import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "1mb" }));

// --- Auth via env vars ---
const SESSION_COOKIE = process.env.PATREON_SESSION_COOKIE; // "name1=value1; name2=value2; ..."
const EMAIL = process.env.PATREON_EMAIL;
const PASSWORD = process.env.PATREON_PASSWORD;

// ---- helpers ----
async function addSessionCookies(context) {
  if (!SESSION_COOKIE) return;
  const cookiePairs = SESSION_COOKIE.split(";").map(s => s.trim()).filter(Boolean);
  const cookies = cookiePairs.map(kv => {
    const [name, ...rest] = kv.split("=");
    return { name, value: rest.join("="), domain: ".patreon.com", path: "/" };
  });
  await context.addCookies(cookies);
}

async function dismissCookieBanner(page) {
  try {
    const oneTrust = page.locator("#onetrust-accept-btn-handler");
    if (await oneTrust.isVisible({ timeout: 1500 }).catch(() => false)) {
      await oneTrust.click();
    }
    const acceptAll = page.getByRole("button", { name: /accept all/i }).first();
    if (await acceptAll.isVisible({ timeout: 1500 }).catch(() => false)) {
      await acceptAll.click();
    }
  } catch {}
}

async function clickFirstVisible(page, locators = []) {
  for (const loc of locators) {
    try {
      if (await loc.isVisible().catch(() => false)) {
        await loc.click();
        return true;
      }
    } catch {}
  }
  return false;
}

function buildBrowser() {
  return chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}

function buildContext(browser) {
  return browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 768 },
  });
}

// ---- DEBUG: check if we're logged in ----
// GET https://<your-url>/debug-auth
app.get("/debug-auth", async (_req, res) => {
  let browser;
  try {
    browser = await buildBrowser();
    const context = await buildContext(browser);
    context.setDefaultTimeout(60000);

    await addSessionCookies(context);

    const page = await context.newPage();
    await page.goto("https://www.patreon.com/home", { waitUntil: "domcontentloaded", timeout: 60000 });
    await dismissCookieBanner(page);

    const currentUrl = page.url();
    const title = await page.title();
    const looksLoggedOut = /login|log in/i.test(title) || /\/login/.test(currentUrl);

    res.json({ currentUrl, title, loggedIn: !looksLoggedOut });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  } finally {
    try { await browser?.close(); } catch {}
  }
});

// ---- MAIN: create patreon post ----
// POST https://<your-url>/create-patreon-post
// { "title":"...", "content":"...", "visibility":"patrons" | "public" }
app.post("/create-patreon-post", async (req, res) => {
  const { title, content, visibility = "patrons" } = req.body || {};
  if (!title || !content) return res.status(400).json({ error: "title and content required" });

  let browser;
  try {
    browser = await buildBrowser();
    const context = await buildContext(browser);
    context.setDefaultTimeout(60000);

    await addSessionCookies(context);

    const page = await context.newPage();

    // 1) Land on home
    await page.goto("https://www.patreon.com/home", { waitUntil: "domcontentloaded", timeout: 90000 });
    await dismissCookieBanner(page);

    // 2) If logged out, attempt email+password login (works only if 2FA is off)
    const loginLinkVisible = await page.getByRole("link", { name: /log in/i }).first().isVisible().catch(() => false);
    if (loginLinkVisible) {
      if (!EMAIL || !PASSWORD) {
        throw new Error("Not logged in and no credentials provided. Set PATREON_SESSION_COOKIE or PATREON_EMAIL+PATREON_PASSWORD.");
      }
      await page.goto("https://www.patreon.com/login", { waitUntil: "domcontentloaded", timeout: 90000 });
      await dismissCookieBanner(page);

      await page.fill('input[type="email"]', EMAIL, { timeout: 60000 });
      await page.fill('input[type="password"]', PASSWORD, { timeout: 60000 });
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 90000 }),
        page.click('button[type="submit"]'),
      ]);

      // Stabilize
      await page.goto("https://www.patreon.com/home", { waitUntil: "domcontentloaded", timeout: 90000 });
    }

    // 3) Open text composer — try UI first
    await page.goto("https://www.patreon.com/home", { waitUntil: "domcontentloaded", timeout: 90000 });
    await dismissCookieBanner(page);

    const createLocators = [
      page.getByRole("button", { name: /create/i }).first(),
      page.getByRole("link", { name: /create/i }).first(),
      page.locator('[data-testid="create-post-button"]').first(),
      page.locator('a[href*="/posts/new"]').first(),
    ];
    const clickedCreate = await clickFirstVisible(page, createLocators);

    if (!clickedCreate) {
      // Fallback to direct composer URL(s)
      const composerUrls = [
        "https://www.patreon.com/posts/new?type=text",
        "https://www.patreon.com/posts/new",
      ];
      let ok = false;
      for (const u of composerUrls) {
        try {
          await page.goto(u, { waitUntil: "domcontentloaded", timeout: 90000 });
          await dismissCookieBanner(page);
          ok = true;
          break;
        } catch {}
      }
      if (!ok) throw new Error("Could not navigate to composer.");
    }

    // 4) Wait for editor fields by selector (no networkidle)
    const titleSel = page.locator(
      [
        '[data-testid="post-title-input"]',
        'textarea[aria-label="Title"]',
        'input[placeholder*="Title"]',
        '[contenteditable="true"]',
      ].join(", ")
    );
    const bodySel = page.locator(
      [
        '[data-testid="post-body-editor"]',
        'div[role="textbox"][contenteditable="true"]',
        'textarea[aria-label*="Write"]',
      ].join(", ")
    );

    await Promise.race([
      titleSel.waitFor({ state: "visible", timeout: 60000 }),
      bodySel.waitFor({ state: "visible", timeout: 60000 }),
    ]);

    // 5) Fill title & content (try candidates)
    const titleCandidates = [
      '[data-testid="post-title-input"]',
      'textarea[aria-label="Title"]',
      'input[placeholder*="Title"]',
      '[contenteditable="true"]',
    ];
    const bodyCandidates = [
      '[data-testid="post-body-editor"]',
      'div[role="textbox"][contenteditable="true"]',
      'textarea[aria-label*="Write"]',
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

    // 6) Visibility (default = patrons). Only switch if "public" requested.
    if (visibility === "public") {
      const visBtn = page.getByRole("button", { name: /public|patrons|members/i }).first();
      if (await visBtn.isVisible().catch(() => false)) {
        await visBtn.click();
        const publicOpt = page.getByRole("option", { name: /public/i }).first();
        if (await publicOpt.isVisible().catch(() => false)) {
          await publicOpt.click();
        }
      }
    }

    // 7) Publish/Post with generous timeout
    const publishBtn = page.getByRole("button", { name: /publish/i }).first();
    const postBtn = page.getByRole("button", { name: /^post$/i }).first();

    if (await publishBtn.isVisible().catch(() => false)) {
      await Promise.all([
        page.waitForLoadState("load", { timeout: 90000 }),
        publishBtn.click(),
      ]);
    } else if (await postBtn.isVisible().catch(() => false)) {
      await Promise.all([
        page.waitForLoadState("load", { timeout: 90000 }),
        postBtn.click(),
      ]);
    } else {
      throw new Error("Publish/Post button not found.");
    }

    // 8) Wait until final post URL
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
