// server.js — full replacement
import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ===== ENV =====
const SESSION_COOKIE =
  process.env.PATREON_SESSION_COOKIE || process.env.PATREON_COOKIE || "";
const EMAIL = process.env.PATREON_EMAIL || "";
const PASSWORD = process.env.PATREON_PASSWORD || ""; // only if no 2FA
const CAMPAIGN_ID = process.env.PATREON_CAMPAIGN_ID || ""; // e.g. "13804237"

// ===== BROWSER HELPERS =====
function launchBrowser() {
  return chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}

function newContext(browser) {
  return browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });
}

async function applySessionCookie(context) {
  if (!SESSION_COOKIE) return { added: 0 };
  const pairs = SESSION_COOKIE.split(";").map((s) => s.trim()).filter(Boolean);
  const cookies = pairs
    .map((kv) => {
      const i = kv.indexOf("=");
      if (i < 0) return null;
      return {
        name: kv.slice(0, i).trim(),
        value: kv.slice(i + 1).trim(),
        domain: ".patreon.com",
        path: "/",
      };
    })
    .filter(Boolean);
  if (cookies.length) await context.addCookies(cookies);
  return { added: cookies.length };
}

async function dismissBanners(page) {
  try {
    const ot = page.locator("#onetrust-accept-btn-handler");
    if (await ot.isVisible({ timeout: 800 }).catch(() => false)) await ot.click();
  } catch {}
  try {
    const accept = page.getByRole("button", { name: /accept all/i }).first();
    if (await accept.isVisible({ timeout: 800 }).catch(() => false)) await accept.click();
  } catch {}
}

async function clickFirstVisible(page, locs) {
  for (const l of locs) {
    try {
      if (await l.isVisible().catch(() => false)) {
        await l.click();
        return true;
      }
    } catch {}
  }
  return false;
}

async function findEditor(page) {
  const titleSel = [
    '[data-testid="post-title-input"]',
    'textarea[aria-label="Title"]',
    'input[placeholder*="Title"]',
    '[contenteditable="true"]',
    'div[role="textbox"][data-slate-editor="true"]',
  ];
  const bodySel = [
    '[data-testid="post-body-editor"]',
    'div[role="textbox"][contenteditable="true"]',
    'textarea[aria-label*="Write"]',
    'div[contenteditable="true"]',
    'div[role="textbox"][data-slate-editor="true"]',
  ];

  // main frame
  for (const t of titleSel) {
    const tl = page.locator(t).first();
    if (await tl.isVisible().catch(() => false)) {
      for (const b of bodySel) {
        const bl = page.locator(b).first();
        if (await bl.isVisible().catch(() => false)) return { title: tl, body: bl };
      }
      return { title: tl, body: null };
    }
  }
  // iframes
  for (const f of page.frames()) {
    for (const t of titleSel) {
      const tl = f.locator(t).first();
      if (await tl.isVisible().catch(() => false)) {
        for (const b of bodySel) {
          const bl = f.locator(b).first();
          if (await bl.isVisible().catch(() => false)) return { title: tl, body: bl };
        }
        return { title: tl, body: null };
      }
    }
  }
  return { title: null, body: null };
}

// ===== DEBUG ROUTES =====
app.get("/debug-auth", async (_req, res) => {
  let browser;
  try {
    browser = await launchBrowser();
    const context = await newContext(browser);
    context.setDefaultTimeout(60000);
    await applySessionCookie(context);
    const page = await context.newPage();
    await page.goto("https://www.patreon.com/home", { waitUntil: "domcontentloaded", timeout: 60000 });
    await dismissBanners(page);
    const currentUrl = page.url();
    const title = await page.title().catch(() => "");
    const loggedIn = !/\/login/.test(currentUrl) && !/log in/i.test(title);
    res.json({ loggedIn, currentUrl, title, hasCookie: !!SESSION_COOKIE });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  } finally {
    try { await browser?.close(); } catch {}
  }
});

app.get("/debug-cookie-load-lite", (req, res) => {
  try {
    const raw = SESSION_COOKIE;
    const envPreview = raw ? `${raw.slice(0, 48)}...(${raw.length})` : "";
    const pairs = raw.split(";").map((s) => s.trim()).filter(Boolean);
    const names = pairs
      .map((kv) => {
        const i = kv.indexOf("="); if (i < 0) return null;
        return kv.slice(0, i).trim();
      })
      .filter(Boolean);
    res.json({
      hasEnv: !!raw,
      envPreview,
      parsedCookieNames: names.slice(0, 30),
      parsedCount: names.length,
      note: "No browser launched here; only env parsing.",
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get("/debug-cookie-load", async (_req, res) => {
  let browser;
  try {
    const raw = SESSION_COOKIE;
    const envPreview = raw ? `${raw.slice(0, 48)}...(${raw.length})` : "";

    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      timeout: 45000,
    });
    const context = await newContext(browser);
    const { added } = await applySessionCookie(context);
    const applied = await context.cookies("https://www.patreon.com").catch(() => []);
    const cookiesApplied = (applied || []).slice(0, 30).map((c) => ({ name: c.name, domain: c.domain }));

    const page = await context.newPage();
    await page.goto("https://www.patreon.com/home", { waitUntil: "domcontentloaded", timeout: 45000 });
    const currentUrl = page.url();
    const title = await page.title().catch(() => "");

    res.json({
      hasEnv: !!raw,
      envPreview,
      cookiesAddedFromEnv: added,
      cookiesAppliedCount: applied?.length || 0,
      cookiesApplied,
      currentUrl,
      title,
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  } finally {
    try { await browser?.close(); } catch {}
  }
});

app.get("/warmup", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ===== CORE: CREATE POST =====
let busy = false;

async function createPostOnce({ title, content, visibility }) {
  const browser = await launchBrowser();
  const context = await newContext(browser);
  context.setDefaultTimeout(90000);
  await applySessionCookie(context);
  const page = await context.newPage();

  try {
    // Go home, dismiss modals
    await page.goto("https://www.patreon.com/home", { waitUntil: "domcontentloaded", timeout: 90000 });
    await dismissBanners(page);

    // If we see login and creds provided, attempt email login (no 2FA)
    const looksLogin =
      /\/login/.test(page.url()) || /log in/i.test(await page.title().catch(() => ""));
    if (looksLogin && EMAIL && PASSWORD) {
      await page.goto("https://www.patreon.com/login", { waitUntil: "domcontentloaded", timeout: 90000 });
      await dismissBanners(page);
      await page.fill('input[type="email"]', EMAIL, { timeout: 60000 });
      await page.fill('input[type="password"]', PASSWORD, { timeout: 60000 });
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 90000 }),
        page.click('button[type="submit"]'),
      ]);
    }

    // === Campaign-aware composer navigation ===
    const targets = [
      CAMPAIGN_ID
        ? `https://www.patreon.com/posts/new?type=text&campaign_id=${encodeURIComponent(
            CAMPAIGN_ID
          )}`
        : null,
      "https://www.patreon.com/creator-home",
      "https://www.patreon.com/posts/new?type=text",
      "https://www.patreon.com/posts/new",
    ].filter(Boolean);

    let landed = false;
    for (const u of targets) {
      try {
        await page.goto(u, { waitUntil: "domcontentloaded", timeout: 90000 });
        await dismissBanners(page);
        if (/\/login/.test(page.url())) continue; // bounced → try next

        // If we’re on creator-home, click Create → Text
        if (/creator-home/.test(page.url())) {
          const clicked = await clickFirstVisible(page, [
            page.getByRole("button", { name: /create/i }).first(),
            page.getByRole("link", { name: /create/i }).first(),
            page.locator('[data-testid="create-post-button"]').first(),
          ]);
          if (clicked) {
            await clickFirstVisible(page, [
              page.getByRole("button", { name: /^text$/i }).first(),
              page.getByRole("link", { name: /^text$/i }).first(),
              page.locator('[data-testid="post-type-text"]').first(),
            ]);
          }
        }

        await page.waitForTimeout(1200);
        const probe = await findEditor(page);
        if (probe.title || probe.body) {
          landed = true;
          break;
        }
      } catch {}
    }

    if (!landed) {
      throw new Error(
        `Editor not found after navigation. At: ${page.url()} [${await page.title().catch(
          () => ""
        )}]`
      );
    }

    // Find editor (again on the final page)
    const editor = await findEditor(page);
    if (!editor.title && !editor.body)
      throw new Error(`Editor not found at ${page.url()} [${await page.title().catch(() => "")}]`);

    // Fill title
    if (editor.title) {
      await editor.title.click();
      await page.keyboard.type(title);
    }

    // Fill body
    const body =
      editor.body && (await editor.body.isVisible().catch(() => false))
        ? editor.body
        : page.locator('div[contenteditable="true"]').first();
    if (await body.isVisible().catch(() => false)) {
      await body.click();
      await page.keyboard.type(content);
    }

    // Visibility (simple attempt; UI varies)
    if (/public/i.test(visibility)) {
      const visBtn = page.getByRole("button", { name: /public|patrons|members/i }).first();
      if (await visBtn.isVisible().catch(() => false)) {
        await visBtn.click();
        const publicOpt = page.getByRole("option", { name: /public/i }).first();
        if (await publicOpt.isVisible().catch(() => false)) await publicOpt.click();
      }
    }

    // Publish
    const publish = page.getByRole("button", { name: /publish/i }).first();
    const postBtn = page.getByRole("button", { name: /^post$/i }).first();
    if (await publish.isVisible().catch(() => false)) {
      await Promise.all([page.waitForLoadState("load", { timeout: 120000 }), publish.click()]);
    } else if (await postBtn.isVisible().catch(() => false)) {
      await Promise.all([page.waitForLoadState("load", { timeout: 120000 }), postBtn.click()]);
    } else {
      throw new Error("Publish/Post button not found");
    }

    await page.waitForURL(/patreon\.com\/posts\//, { timeout: 120000 });
    return { patreonUrl: page.url() };
  } finally {
    try { await browser.close(); } catch {}
  }
}

app.post("/create-patreon-post", async (req, res) => {
  if (busy) return res.status(429).json({ error: "Busy, try again in a few seconds." });
  busy = true;

  const { title, content, visibility = "patrons" } = req.body || {};
  if (!title || !content) {
    busy = false;
    return res.status(400).json({ error: "title and content required" });
  }

  try {
    await new Promise((r) => setTimeout(r, 200)); // tiny warmup
    try {
      const out = await createPostOnce({ title, content, visibility });
      busy = false;
      return res.json(out);
    } catch (e1) {
      await new Promise((r) => setTimeout(r, 1500)); // retry once
      const out2 = await createPostOnce({ title, content, visibility });
      busy = false;
      return res.json(out2);
    }
  } catch (e) {
    busy = false;
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// ===== SERVER =====
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`patreon-poster listening on :${port}`));
