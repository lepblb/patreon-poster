// server.js — full replacement (supports /posts/{id}/edit)
import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ===== ENV =====
const RAW_COOKIE =
  process.env.PATREON_SESSION_COOKIE || process.env.PATREON_COOKIE || "";
const EMAIL = process.env.PATREON_EMAIL || "";
const PASSWORD = process.env.PATREON_PASSWORD || ""; // only if no 2FA
const CAMPAIGN_ID = process.env.PATREON_CAMPAIGN_ID || ""; // e.g. "55146412"
const COMPOSER_URL = process.env.PATREON_COMPOSER_URL || ""; // e.g. "https://www.patreon.com/posts/138897888/edit"
const PORT = process.env.PORT || 8080;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function launchBrowser() {
  return chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}

function newContext(browser) {
  return browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent: UA,
  });
}

// apply cookie to BOTH apex + www domains
async function applySessionCookie(context) {
  if (!RAW_COOKIE) return { added: 0, names: [] };
  const pairs = RAW_COOKIE.split(";").map((s) => s.trim()).filter(Boolean);
  const names = [];
  const cookies = [];
  for (const kv of pairs) {
    const i = kv.indexOf("=");
    if (i < 0) continue;
    const name = kv.slice(0, i).trim();
    const value = kv.slice(i + 1).trim();
    names.push(name);
    cookies.push({ name, value, domain: ".patreon.com", path: "/" });
    cookies.push({ name, value, domain: "www.patreon.com", path: "/" });
  }
  if (cookies.length) await context.addCookies(cookies);
  return { added: cookies.length, names };
}

async function dismissBanners(page) {
  try {
    const c = page.locator("#onetrust-accept-btn-handler");
    if (await c.isVisible({ timeout: 800 }).catch(() => false)) await c.click();
  } catch {}
  try {
    const b = page.getByRole("button", { name: /accept all/i }).first();
    if (await b.isVisible({ timeout: 800 }).catch(() => false)) await b.click();
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

// ===== DEBUG =====
app.get("/diag", (_req, res) => {
  const preview = RAW_COOKIE ? `${RAW_COOKIE.slice(0, 48)}...(${RAW_COOKIE.length})` : "";
  res.json({
    hasCookieEnv: !!RAW_COOKIE,
    cookiePreview: preview,
    campaignId: CAMPAIGN_ID || null,
    composerUrl: COMPOSER_URL || null,
  });
});

app.get("/debug-cookie-load-lite", (_req, res) => {
  try {
    const preview = RAW_COOKIE ? `${RAW_COOKIE.slice(0, 48)}...(${RAW_COOKIE.length})` : "";
    const names = RAW_COOKIE
      ? RAW_COOKIE.split(";").map((s) => s.trim()).filter(Boolean).map((kv) => kv.slice(0, kv.indexOf("=")).trim())
      : [];
    res.json({ hasEnv: !!RAW_COOKIE, envPreview: preview, parsedCookieNames: names, parsedCount: names.length });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get("/debug-auth", async (_req, res) => {
  let browser;
  const trace = [];
  try {
    browser = await launchBrowser();
    const context = await newContext(browser);
    const applied = await applySessionCookie(context);
    const page = await context.newPage();

    await page.goto("https://www.patreon.com/home", { waitUntil: "domcontentloaded", timeout: 60000 });
    await dismissBanners(page);
    trace.push({ step: "home", url: page.url(), title: await page.title().catch(() => "") });

    const loggedIn = !/\/login/.test(page.url());
    res.json({ loggedIn, currentUrl: page.url(), title: await page.title().catch(() => ""), cookieApplied: applied, trace });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e), trace });
  } finally {
    try { await browser?.close(); } catch {}
  }
});

// Try composer (supports ?campaign= and ?url= overrides)
app.get("/try-composer", async (req, res) => {
  let browser;
  const trace = [];
  try {
    const urlOverride = req.query.url || COMPOSER_URL || null;
    const campaignOverride = req.query.campaign || CAMPAIGN_ID || null;

    browser = await launchBrowser();
    const context = await newContext(browser);
    await applySessionCookie(context);
    const page = await context.newPage();

    // home
    await page.goto("https://www.patreon.com/home", { waitUntil: "domcontentloaded", timeout: 90000 });
    await dismissBanners(page);
    trace.push({ step: "home", url: page.url(), title: await page.title().catch(() => "") });

    // targets (priority: explicit URL, then campaign composer, then creator-home, then generic)
    const targets = [
      urlOverride,
      campaignOverride ? `https://www.patreon.com/posts/new?type=text&campaign_id=${encodeURIComponent(campaignOverride)}` : null,
      "https://www.patreon.com/creator-home",
      "https://www.patreon.com/posts/new?type=text",
      "https://www.patreon.com/posts/new",
    ].filter(Boolean);

    let landed = false;
    for (const u of targets) {
      await page.goto(u, { waitUntil: "domcontentloaded", timeout: 90000 });
      await dismissBanners(page);
      trace.push({ step: "goto", target: u, url: page.url(), title: await page.title().catch(() => "") });

      if (/\/login/.test(page.url())) continue;

      if (/creator-home/.test(page.url())) {
        const clicked = await clickFirstVisible(page, [
          page.getByRole("button", { name: /create/i }).first(),
          page.getByRole("link", { name: /create/i }).first(),
          page.locator('[data-testid="create-post-button"]').first(),
        ]);
        trace.push({ step: "creator-home-click", clicked });
        if (clicked) {
          await clickFirstVisible(page, [
            page.getByRole("button", { name: /^text$/i }).first(),
            page.getByRole("link", { name: /^text$/i }).first(),
            page.locator('[data-testid="post-type-text"]').first(),
          ]);
          trace.push({ step: "creator-home-select-text" });
        }
      }

      await page.waitForTimeout(1200);
      const probe = await findEditor(page);
      const seen = { hasTitle: !!probe.title, hasBody: !!probe.body };
      trace.push({ step: "probe", url: page.url(), title: await page.title().catch(() => ""), seen });
      if (probe.title || probe.body) { landed = true; break; }
    }

    res.json({ landed, trace });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e), trace });
  } finally {
    try { await browser?.close(); } catch {}
  }
});

// ===== CREATE POST =====
let busy = false;

async function createPostOnce({ title, content, visibility, urlOverride, campaignOverride }, trace) {
  const browser = await launchBrowser();
  const context = await newContext(browser);
  context.setDefaultTimeout(90000);
  await applySessionCookie(context);
  const page = await context.newPage();

  try {
    await page.goto("https://www.patreon.com/home", { waitUntil: "domcontentloaded", timeout: 90000 });
    await dismissBanners(page);
    trace.push({ step: "home", url: page.url(), title: await page.title().catch(() => "") });

    const looksLogin = /\/login/.test(page.url());
    if (looksLogin && EMAIL && PASSWORD) {
      await page.goto("https://www.patreon.com/login", { waitUntil: "domcontentloaded", timeout: 90000 });
      await dismissBanners(page);
      await page.fill('input[type="email"]', EMAIL, { timeout: 60000 });
      await page.fill('input[type="password"]', PASSWORD, { timeout: 60000 });
      await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 90000 }), page.click('button[type="submit"]')]);
      trace.push({ step: "email-login", url: page.url(), title: await page.title().catch(() => "") });
    }

    const targets = [
      urlOverride || COMPOSER_URL || null,
      (campaignOverride || CAMPAIGN_ID) ? `https://www.patreon.com/posts/new?type=text&campaign_id=${encodeURIComponent(campaignOverride || CAMPAIGN_ID)}` : null,
      "https://www.patreon.com/creator-home",
      "https://www.patreon.com/posts/new?type=text",
      "https://www.patreon.com/posts/new",
    ].filter(Boolean);

    let landed = false;
    for (const u of targets) {
      await page.goto(u, { waitUntil: "domcontentloaded", timeout: 90000 });
      await dismissBanners(page);
      trace.push({ step: "goto", target: u, url: page.url(), title: await page.title().catch(() => "") });

      if (/\/login/.test(page.url())) continue;

      if (/creator-home/.test(page.url())) {
        const clicked = await clickFirstVisible(page, [
          page.getByRole("button", { name: /create/i }).first(),
          page.getByRole("link", { name: /create/i }).first(),
          page.locator('[data-testid="create-post-button"]').first(),
        ]);
        trace.push({ step: "creator-home-click", clicked });
        if (clicked) {
          await clickFirstVisible(page, [
            page.getByRole("button", { name: /^text$/i }).first(),
            page.getByRole("link", { name: /^text$/i }).first(),
            page.locator('[data-testid="post-type-text"]').first(),
          ]);
          trace.push({ step: "creator-home-select-text" });
        }
      }

      await page.waitForTimeout(1200);
      const probe = await findEditor(page);
      const seen = { hasTitle: !!probe.title, hasBody: !!probe.body };
      trace.push({ step: "probe", url: page.url(), title: await page.title().catch(() => ""), seen });
      if (probe.title || probe.body) { landed = true; break; }
    }

    if (!landed) throw new Error("Editor not found after navigation");

    const editor = await findEditor(page);
    if (editor.title) { await editor.title.click(); await page.keyboard.type(title); }
    const body = editor.body && (await editor.body.isVisible().catch(() => false))
      ? editor.body
      : page.locator('div[contenteditable="true"]').first();
    if (await body.isVisible().catch(() => false)) { await body.click(); await page.keyboard.type(content); }

    if (/public/i.test(visibility)) {
      const visBtn = page.getByRole("button", { name: /public|patrons|members/i }).first();
      if (await visBtn.isVisible().catch(() => false)) {
        await visBtn.click();
        const publicOpt = page.getByRole("option", { name: /public/i }).first();
        if (await publicOpt.isVisible().catch(() => false)) await publicOpt.click();
      }
    }

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
    trace.push({ step: "posted", url: page.url(), title: await page.title().catch(() => "") });
    return { patreonUrl: page.url() };
  } finally {
    try { await browser.close(); } catch {}
  }
}

let busy = false;

app.post("/create-patreon-post", async (req, res) => {
  if (busy) return res.status(429).json({ error: "Busy, try again in a few seconds." });
  busy = true;

  const trace = [];
  const { title, content, visibility = "patrons", composerUrl, campaignId } = req.body || {};
  if (!title || !content) { busy = false; return res.status(400).json({ error: "title and content required" }); }

  try {
    try {
      const out = await createPostOnce(
        { title, content, visibility, urlOverride: composerUrl || null, campaignOverride: campaignId || null },
        trace
      );
      busy = false; return res.json(out);
    } catch (e1) {
      trace.push({ retrying: true, err: String(e1?.message || e1) });
      await new Promise(r => setTimeout(r, 1200));
      const out2 = await createPostOnce(
        { title, content, visibility, urlOverride: composerUrl || null, campaignOverride: campaignId || null },
        trace
      );
      busy = false; return res.json(out2);
    }
  } catch (e) {
    busy = false;
    return res.status(500).json({ error: String(e?.message || e), trace });
  }
});

app.get("/warmup", (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.listen(PORT, () => console.log(`patreon-poster listening on :${PORT}`));
