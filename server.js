import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "1mb" }));

const SESSION_COOKIE = process.env.PATREON_SESSION_COOKIE;
const EMAIL = process.env.PATREON_EMAIL;
const PASSWORD = process.env.PATREON_PASSWORD;

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
    if (await oneTrust.isVisible({ timeout: 1200 }).catch(() => false)) await oneTrust.click();
    const acceptAll = page.getByRole("button", { name: /accept all/i }).first();
    if (await acceptAll.isVisible({ timeout: 1200 }).catch(() => false)) await acceptAll.click();
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
async function findEditorTargets(page) {
  // selectors to try for title/body in a given frame-like context
  const titleSelectors = [
    '[data-testid="post-title-input"]',
    'textarea[aria-label="Title"]',
    'input[placeholder*="Title"]',
    '[contenteditable="true"]',
    'div[role="textbox"][data-slate-editor="true"]' // some rich editors
  ];
  const bodySelectors = [
    '[data-testid="post-body-editor"]',
    'div[role="textbox"][contenteditable="true"]',
    'textarea[aria-label*="Write"]',
    'div[contenteditable="true"]',
    'div[role="textbox"][data-slate-editor="true"]'
  ];

  // 1) try in the main page
  for (const t of titleSelectors) {
    const tl = page.locator(t).first();
    if (await tl.isVisible().catch(() => false)) {
      // find a matching body in page too
      for (const b of bodySelectors) {
        const bl = page.locator(b).first();
        if (await bl.isVisible().catch(() => false)) return { title: tl, body: bl };
      }
      // if no body found yet, still return title; we'll probe body later
      return { title: tl, body: null };
    }
  }

  // 2) try inside iframes
  const frames = page.frames();
  for (const f of frames) {
    try {
      for (const t of titleSelectors) {
        const tl = f.locator(t).first();
        if (await tl.isVisible().catch(() => false)) {
          for (const b of bodySelectors) {
            const bl = f.locator(b).first();
            if (await bl.isVisible().catch(() => false)) return { title: tl, body: bl };
          }
          return { title: tl, body: null };
        }
      }
    } catch {}
  }

  return { title: null, body: null };
}

// ---------------- DEBUG AUTH ----------------
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

// --------------- CREATE POST ----------------
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

    // 1) Home
    await page.goto("https://www.patreon.com/home", { waitUntil: "domcontentloaded", timeout: 90000 });
    await dismissCookieBanner(page);

    // 2) Login if needed (only works when 2FA is OFF)
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
      await page.goto("https://www.patreon.com/home", { waitUntil: "domcontentloaded", timeout: 90000 });
    }

    // 3) Open composer (UI first; then URL fallback)
    await page.goto("https://www.patreon.com/home", { waitUntil: "domcontentloaded", timeout: 90000 });
    await dismissCookieBanner(page);

    const clickedCreate = await clickFirstVisible(page, [
      page.getByRole("button", { name: /create/i }).first(),
      page.getByRole("link", { name: /create/i }).first(),
      page.locator('[data-testid="create-post-button"]').first(),
      page.locator('a[href*="/posts/new"]').first(),
    ]);

    if (!clickedCreate) {
      const tries = [
        "https://www.patreon.com/posts/new?type=text",
        "https://www.patreon.com/posts/new"
      ];
      let ok = false;
      for (const u of tries) {
        try {
          await page.goto(u, { waitUntil: "domcontentloaded", timeout: 90000 });
          await dismissCookieBanner(page);
          ok = true; break;
        } catch {}
      }
      if (!ok) {
        return res.status(500).json({
          error: "Could not navigate to composer.",
          currentUrl: page.url(),
          title: await page.title().catch(() => "")
        });
      }
    } else {
      // if a drawer opens with "Text" choice, click it
      await clickFirstVisible(page, [
        page.getByRole("button", { name: /^text$/i }).first(),
        page.getByRole("link", { name: /^text$/i }).first(),
        page.locator('[data-testid="post-type-text"]').first()
      ]);
    }

    // 4) Wait for editor fields (main page or iframe)
    let editor;
    try {
      editor = await Promise.race([
        (async () => {
          const sel = page.locator('[data-testid="post-title-input"], textarea[aria-label="Title"], input[placeholder*="Title"], [contenteditable="true"]').first();
          await sel.waitFor({ state: "visible", timeout: 60000 });
          return await findEditorTargets(page);
        })(),
        (async () => {
          // give iframes a moment to mount
          await page.waitForTimeout(1500);
          return await findEditorTargets(page);
        })()
      ]);
    } catch {}

    if (!editor || (!editor.title && !editor.body)) {
      return res.status(500).json({
        error: "Could not load the text post composer (timed out waiting for editor).",
        currentUrl: page.url(),
        title: await page.title().catch(() => "")
      });
    }

    // 5) Type title & body
    if (editor.title) {
      await editor.title.click();
      await page.keyboard.type(title);
    }
    if (editor.body) {
      await editor.body.click();
      await page.keyboard.type(content);
    } else {
      // if only a single contenteditable exists, try it
      const fallbackBody = page.locator('div[contenteditable="true"]').first();
      if (await fallbackBody.isVisible().catch(() => false)) {
        await fallbackBody.click();
        await page.keyboard.type(content);
      }
    }

    // 6) Visibility (only toggle if public requested)
    if (visibility === "public") {
      const visBtn = page.getByRole("button", { name: /public|patrons|members/i }).first();
      if (await visBtn.isVisible().catch(() => false)) {
        await visBtn.click();
        const publicOpt = page.getByRole("option", { name: /public/i }).first();
        if (await publicOpt.isVisible().catch(() => false)) await publicOpt.click();
      }
    }

    // 7) Publish/Post
    const publishBtn = page.getByRole("button", { name: /publish/i }).first();
    const postBtn = page.getByRole("button", { name: /^post$/i }).first();

    if (await publishBtn.isVisible().catch(() => false)) {
      await Promise.all([page.waitForLoadState("load", { timeout: 90000 }), publishBtn.click()]);
    } else if (await postBtn.isVisible().catch(() => false)) {
      await Promise.all([page.waitForLoadState("load", { timeout: 90000 }), postBtn.click()]);
    } else {
      return res.status(500).json({
        error: "Publish/Post button not found.",
        currentUrl: page.url(),
        title: await page.title().catch(() => "")
      });
    }

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
