// server.js
import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---- ENV (uses PATREON_SESSION_COOKIE, falls back to PATREON_COOKIE) ----
const SESSION_COOKIE =
  process.env.PATREON_SESSION_COOKIE || process.env.PATREON_COOKIE || "";
const EMAIL = process.env.PATREON_EMAIL || "";
const PASSWORD = process.env.PATREON_PASSWORD || "";

// ---- Playwright helpers ----
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
  // Accept either a raw "Cookie" header string or semi-colon separated pairs.
  const pairs = SESSION_COOKIE.split(";").map((s) => s.trim()).filter(Boolean);
  if (!pairs.length) return;
  // Turn "name=value" into cookie objects for .patreon.com
  const cookies = pairs
    .map((kv) => {
      const idx = kv.indexOf("=");
      if (idx < 0) return null;
      const name = kv.slice(0, idx).trim();
      const value = kv.slice(idx + 1).trim();
      if (!name || value == null) return null;
      return { name, value, domain: ".patreon.com", path: "/" };
    })
    .filter(Boolean);
  if (cookies.length) await context.addCookies(cookies);
}
async function dismissCookieBanner(page) {
  try {
    const oneTrust = page.locator("#onetrust-accept-btn-handler");
    if (await oneTrust.isVisible({ timeout: 1000 }).catch(() => false)) {
      await oneTrust.click();
    }
    const acceptAll = page.getByRole("button", { name: /accept all/i }).first();
    if (await acceptAll.isVisible({ timeout: 1000 }).catch(() => false)) {
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
async function findEditorTargets(page) {
  const titleSelectors = [
    '[data-testid="post-title-input"]',
    'textarea[aria-label="Title"]',
    'input[placeholder*="Title"]',
    '[contenteditable="true"]',
    'div[role="textbox"][data-slate-editor="true"]',
  ];
  const bodySelectors = [
    '[data-testid="post-body-editor"]',
    'div[role="textbox"][contenteditable="true"]',
    'textarea[aria-label*="Write"]',
    'div[contenteditable="true"]',
    'div[role="textbox"][data-slate-editor="true"]',
  ];

  // Main page first
  for (const t of titleSelectors) {
    const tl = page.locator(t).first();
    if (await tl.isVisible().catch(() => false)) {
      for (const b of bodySelectors) {
        const bl = page.locator(b).first();
        if (await bl.isVisible().catch(() => false)) return { title: tl, body: bl };
      }
      return { title: tl, body: null };
  }}

  // Then iframes
  for (const f of page.frames()) {
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
  }
  return { title: null, body: null };
}

// ---- Debug + Warmup ----
app.get("/debug-auth", async (_req, res) => {
  let browser;
  try {
    browser = await buildBrowser();
    const context = await buildContext(browser);
    context.setDefaultTimeout(60000);
    await addSessionCookies(context);

    const page = await context.newPage();
    await page.goto("https://www.patreon.com/home", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await dismissCookieBanner(page);

    const currentUrl = page.url();
    const title = await page.title();
    const looksLoggedOut = /login|log in/i.test(title) || /\/login/.test(currentUrl);
    res.json({ loggedIn: !looksLoggedOut, currentUrl, title, hasCookie: !!SESSION_COOKIE });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  } finally {
    try { await browser?.close(); } catch {}
  }
});

app.get("/warmup", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ---- Single-flight lock to avoid overlap on tiny instances ----
let busy = false;

// ---- Core posting attempt (one try) ----
async function tryCreatePostOnce({ title, content, visibility }) {
  const browser = await buildBrowser();
  const context = await buildContext(browser);
  context.setDefaultTimeout(60000);
  await addSessionCookies(context);

  const page = await context.newPage();
  try {
    // Home
    await page.goto("https://www.patreon.com/home", { waitUntil: "domcontentloaded", timeout: 90000 });
    await dismissCookieBanner(page);

    // If not logged in and EMAIL/PASSWORD provided (works only w/o 2FA)
    const loginLinkVisible = await page.getByRole("link", { name: /log in/i }).first().isVisible().catch(() => false);
    if (loginLinkVisible && EMAIL && PASSWORD) {
      await page.goto("https://www.patreon.com/login", { waitUntil: "domcontentloaded", timeout: 90000 });
      await dismissCookieBanner(page);
      await page.fill('input[type="email"]', EMAIL, { timeout: 60000 });
      await page.fill('input[type="password"]', PASSWORD, { timeout: 60000 });
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 90000 }),
        page.click('button[type="submit"]'),
      ]);
    }

    // Go to composer: UI first, then fallback URL
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
        "https://www.patreon.com/posts/new",
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
        throw new Error(`Could not navigate to composer. At: ${page.url()} [${await page.title().catch(()=> "")}]`);
      }
    } else {
      await clickFirstVisible(page, [
        page.getByRole("button", { name: /^text$/i }).first(),
        page.getByRole("link", { name: /^text$/i }).first(),
        page.locator('[data-testid="post-type-text"]').first(),
      ]);
    }

    // Find editor (main or iframe)
    await page.waitForTimeout(1200);
    const editor = await findEditorTargets(page);
    if (!editor || (!editor.title && !editor.body)) {
      throw new Error(`Editor not found at ${page.url()} [${await page.title().catch(()=> "")}]`);
    }

    if (editor.title) { await editor.title.click(); await page.keyboard.type(title); }
    const bodyTarget =
      editor.body && (await editor.body.isVisible().catch(() => false))
        ? editor.body
        : page.locator('div[contenteditable="true"]').first();

    if (await bodyTarget.isVisible().catch(() => false)) {
      await bodyTarget.click();
      await page.keyboard.type(content);
    }

    if (visibility === "public") {
      const visBtn = page.getByRole("button", { name: /public|patrons|members/i }).first();
      if (await visBtn.isVisible().catch(() => false)) {
        await visBtn.click();
        const publicOpt = page.getByRole("option", { name: /public/i }).first();
        if (await publicOpt.isVisible().catch(() => false)) await publicOpt.click();
      }
    }

    const publishBtn = page.getByRole("button", { name: /publish/i }).first();
    const postBtn = page.getByRole("button", { name: /^post$/i }).first();
    if (await publishBtn.isVisible().catch(() => false)) {
      await Promise.all([page.waitForLoadState("load", { timeout: 90000 }), publishBtn.click()]);
    } else if (await postBtn.isVisible().catch(() => false)) {
      await Promise.all([page.waitForLoadState("load", { timeout: 90000 }), postBtn.click()]);
    } else {
      throw new Error("Publish/Post button not found.");
    }

    await page.waitForURL(/patreon\.com\/posts\//, { timeout: 120000 });
    return { patreonUrl: page.url() };
  } finally {
    try { await browser.close(); } catch {}
  }
}

// ---- Route with warmup + single-flight + retry ----
app.post("/create-patreon-post", async (req, res) => {
  if (busy) return res.status(429).json({ error: "Busy, try again in a few seconds." });
  busy = true;

  const { title, content, visibility = "patrons" } = req.body || {};
  if (!title || !content) {
    busy = false;
    return res.status(400).json({ error: "title and content required" });
  }

  try {
    // Warmup delay helps cold starts on free dynos
    await new Promise((r) => setTimeout(r, 300));

    try {
      const out = await tryCreatePostOnce({ title, content, visibility });
      busy = false; return res.json(out);
    } catch (e1) {
      // Retry once (fresh browser/context) after a brief delay
      console.log("Attempt 1 failed:", e1?.message || e1);
      await new Promise((r) => setTimeout(r, 2500));
      const out2 = await tryCreatePostOnce({ title, content, visibility });
      busy = false; return res.json(out2);
    }
  } catch (err) {
    busy = false;
    console.error(err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`patreon-poster listening on :${port}`));
