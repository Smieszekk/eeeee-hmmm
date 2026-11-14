const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");

const DEFAULT_TARGET_URL = "https://tnstats.dev/web-grind";
const DEFAULT_NAVIGATION_TIMEOUT_MS = 60_000;
const HEARTBEAT_MS = 60_000;
// End gracefully before the workflow's 355-minute job timeout.
const RUNTIME_MINUTES = 345;
const GRACEFUL_RUNTIME_MS = RUNTIME_MINUTES * 60 * 1000;
// script2.js is no longer injected: the runner clicks with real mouse/keyboard events instead
const SCRIPT_FILES = ["script.js"];

async function readScripts() {
  return Promise.all(
    SCRIPT_FILES.map(async (filename) => ({
      filename,
      source: await fs.readFile(path.join(__dirname, filename), "utf8")
    }))
  );
}

function getTargetUrl() {
  const url = new URL(process.env.TARGET_URL || DEFAULT_TARGET_URL);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("TARGET_URL must use http or https.");
  }
  return url.toString();
}

function getLocalStorageData() {
  let parsed;
  try {
    parsed = JSON.parse(process.env.LOCAL_STORAGE_JSON || "{}");
  } catch (error) {
    throw new Error(`LOCAL_STORAGE_JSON must be valid JSON: ${error.message}`);
  }

  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("LOCAL_STORAGE_JSON must be a JSON object of key/value pairs.");
  }

  return Object.fromEntries(
    Object.entries(parsed).map(([key, value]) => [
      key,
      typeof value === "string" ? value : JSON.stringify(value)
    ])
  );
}

async function main() {
  const targetUrl = getTargetUrl();
  const scripts = await readScripts();
  const localStorageData = getLocalStorageData();

  console.log(`Launching Chromium for ${targetUrl}`);
  console.log(`LOCAL_STORAGE_JSON provided keys: ${Object.keys(localStorageData).length}`);

  const browser = await chromium.launch({ headless: true });
  // Normal desktop user agent (without "HeadlessChrome") and a regular window size
  const context = await browser.newContext({
    userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`,
    viewport: { width: 1366, height: 768 },
    locale: "en-US"
  });
  const page = await context.newPage();

  page.on("console", (message) => {
    console.log(`[page:${message.type()}] ${message.text()}`);
  });

  page.on("pageerror", (error) => {
    console.error("[pageerror]", error);
  });

  // Log failed requests (400+) with the start of the server's message,
  // plus the first 40 normal tnstats responses to see what the page loads
  let netLogged = 0;
  page.on("response", async (response) => {
    const status = response.status();
    const url = response.url().split("?")[0];
    if (status >= 400) {
      let body = "";
      try {
        body = (await response.text()).slice(0, 200).replace(/\s+/g, " ");
      } catch {}
      console.log(`[http] ${status} ${response.request().method()} ${url} ${body}`);
    } else if (netLogged < 40 && url.includes("tnstats.dev")) {
      netLogged++;
      console.log(`[net] ${status} ${response.request().method()} ${url}`);
    }
  });

  page.setDefaultNavigationTimeout(DEFAULT_NAVIGATION_TIMEOUT_MS);

  // Initialize localStorage for the target origin before the site loads.
  await page.addInitScript((storage) => {
    for (const [key, value] of Object.entries(storage)) {
      window.localStorage.setItem(key, value);
    }
  }, localStorageData);

  // Per-account collab target channel (from COLLAB_CHANNEL_ID)
  const collabTarget = process.env.COLLAB_CHANNEL_ID || "";
  await page.addInitScript((id) => {
    if (id) window.COLLAB_TARGET_CHANNEL_ID = id;
  }, collabTarget);
  if (collabTarget) {
    console.log(`Collab target channel for this job: ${collabTarget}`);
  }

  // Inject the scripts into EVERY frame at document start (the grind panel may live in an iframe)
  for (const { filename, source } of scripts) {
    await context.addInitScript({ content: `${source}\n//# sourceURL=${filename}` });
    console.log(`Injecting ${filename} into all frames.`);
  }

  // Open the page, retrying a few times on temporary network/DNS errors
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
      break;
    } catch (error) {
      if (attempt >= 5) throw error;
      console.log(`goto failed (attempt ${attempt}): ${error.message.split("\n")[0]}. Retrying in 20s...`);
      await new Promise((r) => setTimeout(r, 20_000));
    }
  }
  console.log("Page loaded. Evaluating scripts in the same page.");

  // (scripts were already injected into all frames before navigation)

  console.log("Scripts evaluated. Keeping the workflow alive.");

  // ---- Native grinding loops (real mouse/keyboard events, not synthetic JS clicks) ----
  const CLICKS = [{ name: "Music Video", everyMs: 6300 }];      // tile name as shown on the page
  const BOOST = { name: "Boost", everyMs: 152500 };              // page shows 2m 30s cooldown
  const COLLAB = { everyMs: 602000, target: collabTarget };      // channel name or ID
  const DISSTRACK = { everyMs: 602000, target: process.env.DISSTRACK_CHANNEL_ID || "" };

  // Actions run one after another so they never fight over focus
  let queue = Promise.resolve();
  const enqueue = (label, fn) => {
    queue = queue.then(fn).catch((e) => {
      console.log(`[grind] ${label} failed: ${e.message.split("\n")[0]}`);
    });
  };

  // The grind panel can be inside an iframe, so search every frame of the page
  async function findFrame(getLocator) {
    for (const f of page.frames()) {
      try {
        if ((await getLocator(f).count()) > 0) return f;
      } catch {}
    }
    return null;
  }

  async function waitForFrame(getLocator, timeoutMs) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const f = await findFrame(getLocator);
      if (f) return f;
      await page.waitForTimeout(1000);
    }
    return null;
  }

  const tileLocator = (name) => (f) => f.getByText(name, { exact: true });
  const fieldLocator = () => (f) => f.locator('input[placeholder="Channel name or ID"]');

  const clickTile = (name) => async () => {
    const f = await findFrame(tileLocator(name));
    if (!f) throw new Error(`"${name}" not found in any frame`);
    await f.getByText(name, { exact: true }).first().click({ timeout: 5000 });
  };

  // index 0 = Collab field, index 1 = Disstrack field
  const useField = (label, index, target) => async () => {
    const f = await findFrame(fieldLocator());
    if (!f) throw new Error("channel field not found in any frame");
    await f.locator('input[placeholder="Channel name or ID"]').nth(index).fill(target, { timeout: 5000 });
    await page.waitForTimeout(1500);
    await f.getByRole("button", { name: label, exact: true }).click({ timeout: 5000 });
    console.log(`[grind] ${label} clicked for ${target}`);
  };

  const every = (ms, label, fn, delayMs = 0) => {
    setTimeout(() => {
      enqueue(label, fn);
      setInterval(() => enqueue(label, fn), ms);
    }, delayMs);
  };

  const readyFrame = await waitForFrame(tileLocator(CLICKS[0].name), 120_000);
  if (readyFrame) {
    console.log(`[grind] "${CLICKS[0].name}" found in frame: ${readyFrame.url()}`);
  } else {
    console.log(`[grind] "${CLICKS[0].name}" did not appear within 2 minutes, starting anyway`);
  }

  CLICKS.forEach((c) => every(c.everyMs, c.name, clickTile(c.name)));
  every(BOOST.everyMs, BOOST.name, clickTile(BOOST.name));
  if (COLLAB.target) every(COLLAB.everyMs, "Collab", useField("Collab", 0, COLLAB.target), 5_000);
  if (DISSTRACK.target) every(DISSTRACK.everyMs, "Disstrack", useField("Disstrack", 1, DISSTRACK.target), 15_000);
  console.log("[grind] native loops started");

  // DEBUG: after 45s print what the page looks like (key/cookie NAMES only, no values)
  // and save a screenshot to debug.png
  setTimeout(async () => {
    try {
      console.log("DEBUG url:", page.url());
      console.log("DEBUG frames:", page.frames().map((f) => f.url()));
      console.log("DEBUG localStorage keys:", await page.evaluate(() => Object.keys(localStorage)));
      const text = await page.evaluate(() => document.body.innerText);
      console.log("DEBUG page text:", text.slice(0, 800).replace(/\n+/g, " | "));
      await page.screenshot({ path: "debug.png", fullPage: true });
      console.log("DEBUG screenshot saved to debug.png");
    } catch (error) {
      console.error("DEBUG failed:", error);
    }
  }, 45_000);

  let shuttingDown = false;
  let heartbeatTimer;
  let runtimeTimer;

  const shutdown = async (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${reason}. Closing browser and exiting successfully.`);

    clearInterval(heartbeatTimer);
    clearTimeout(runtimeTimer);

    try {
      await browser.close();
    } catch (error) {
      console.error("Error while closing browser:", error);
    }

    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("Received SIGTERM"));
  process.on("SIGINT", () => shutdown("Received SIGINT"));

  heartbeatTimer = setInterval(() => {
    console.log(`Heartbeat: browser still running on ${page.url()}`);
  }, HEARTBEAT_MS);

  runtimeTimer = setTimeout(() => {
    shutdown(`Reached planned ${RUNTIME_MINUTES}-minute runtime`);
  }, GRACEFUL_RUNTIME_MS);

  await new Promise(() => {});
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
