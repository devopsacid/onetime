// Back/forward cache: the page clears plaintext, files, links and passphrases on `pagehide` and re-routes on a persisted
// `pageshow`. Each flow leaves for another URL and presses Back, then checks that nothing readable came back.
// "Restored" is proven by a JS marker that survives plus a `pageshow` event with persisted === true (a reload loses both).
//
// Two variants per browser:
//  * "real headers": the app as served (Cache-Control: no-store). Current Chromium does not cache such a page once it made a
//    fetch (notRestoredReasons: response-cache-control-no-store-with-js-network-request), so Back reloads it. The assertions
//    must hold either way; the `# bfcache` lines say what happened.
//  * "no Cache-Control proxy": a test-only proxy removes Cache-Control so the browser really restores the page. This is the
//    proof that the app's own pagehide/pageshow code clears everything in a true restore. Chromium must restore here.
// Chromium needs the new headless mode (channel "chromium") without Playwright's --disable-back-forward-cache; Firefox needs prefs.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { ORIGIN, fileLink, launchBrowsers, session, startNoStoreProxy, textLink } from "./helpers.mjs";

const browsers = await launchBrowsers({
  chromium: { channel: "chromium", ignoreDefaultArgs: ["--disable-back-forward-cache"] },
  firefox: { firefoxUserPrefs: { "fission.bfcacheInParent": true, "browser.sessionhistory.max_total_viewers": 8 } },
  webkit: {},
});
const proxy = await startNoStoreProxy();
after(async () => {
  for (const { browser } of browsers) await browser.close();
  await proxy.close();
});

const SECRET = "bfcache-secret-åäö-9f3a";
const TYPED = "typed but never sent";
const visible = (page, id) => page.locator(`#${id}`).waitFor({ state: "visible" });

async function prepare(s) {
  await s.context.addInitScript(() => {
    (window.__log ||= []);
    window.addEventListener("pageshow", (e) => window.__log.push(e.persisted));
  });
  return s.context.newPage();
}

/** Leaves for /how-it-works, comes back with history.back(); true when the page was restored from the cache. */
async function leaveAndBack(page, label) {
  await page.evaluate(() => { window.__marker = "alive"; });
  await page.goto("/how-it-works");
  await page.evaluate(() => void setTimeout(() => history.back(), 0));
  await page.waitForFunction(() => location.pathname === "/" && ((window.__log?.length ?? 0) >= 2 || window.__marker === undefined), null, { timeout: 15_000 });
  const restored = await page.evaluate(() => window.__marker === "alive" && window.__log.at(-1) === true);
  const reasons = restored ? "" : await page.evaluate(() => JSON.stringify((performance.getEntriesByType("navigation")[0]?.notRestoredReasons?.reasons ?? []).map((r) => r.reason))).catch(() => "n/a");
  console.log(`# bfcache ${label}: restored from the cache = ${restored}${restored ? "" : ` (notRestoredReasons ${reasons})`}`);
  return restored;
}

/** Everything a person or a script could read from the page: text, form values, links, download names. */
const readable = (page) =>
  page.evaluate(() => JSON.stringify({
    text: document.body.innerText + document.body.textContent,
    values: [...document.querySelectorAll("input, textarea")].map((e) => e.value),
    hrefs: [...document.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? ""),
    hash: location.hash,
    download: [...document.querySelectorAll("a[download]")].map((a) => a.getAttribute("download")),
  }));

for (const { name, browser } of browsers) {
  for (const viaProxy of [false, true]) {
    const variant = viaProxy ? "no Cache-Control proxy" : "real headers";
    const origin = viaProxy ? proxy.origin : ORIGIN;
    const label = (what) => `${name} / ${variant} / ${what}`;
    const mustRestore = viaProxy && name === "chromium";
    // Playwright's Firefox (Juggler) cannot observe a bfcache restore: page.waitForFunction times out after history.back()
    // (reproduced with a plain page too), so a restore cannot be asserted there. The real-headers variant still runs.
    const skip = viaProxy && name === "firefox" ? "Playwright's Firefox cannot observe a bfcache restore (page evaluation hangs after history.back())" : false;
    describe(`${name} bfcache, ${variant}`, { skip }, () => {
      it("revealed text is cleared after Back", async () => {
        const text = await textLink({ text: SECRET });
        const s = await session(browser, { secrets: [text.key, SECRET], origin });
        try {
          const page = await prepare(s);
          await page.goto(text.link.replace(ORIGIN, origin));
          await visible(page, "view-open");
          await page.locator("#reveal").click();
          await visible(page, "view-revealed");
          assert.equal(await page.locator("#revealed").inputValue(), SECRET);
          const restored = await leaveAndBack(page, label("revealed text"));
          if (mustRestore) assert.equal(restored, true, "this variant must be a real bfcache restore, or the test proves nothing");
          const after = await readable(page);
          assert.ok(!after.includes(SECRET), `secret still readable after Back: ${after.slice(0, 300)}`);
          assert.equal(await page.locator("#view-revealed").isVisible(), false);
          await s.verify({ allowConsole: [/404/] });
        } finally {
          await s.close();
        }
      });

      it("a typed passphrase is cleared after Back", async () => {
        const protectedLink = await textLink({ text: "x", passphrase: TYPED });
        const s = await session(browser, { secrets: [protectedLink.key], origin });
        try {
          const page = await prepare(s);
          await page.goto(protectedLink.link.replace(ORIGIN, origin));
          await visible(page, "view-open");
          await page.locator("#open-pass").fill(TYPED);
          const restored = await leaveAndBack(page, label("typed passphrase"));
          if (mustRestore) assert.equal(restored, true);
          assert.ok(!(await readable(page)).includes(TYPED), "typed passphrase still readable after Back");
          await s.verify();
        } finally {
          await s.close();
        }
      });

      // WebKit restores form state (the hidden #link input) after Back even though pagehide cleared it: the fields are autocomplete=off and pageshow clears them again.
      it("a typed secret and the created link are cleared after Back", async () => {
        const s = await session(browser, { secrets: [SECRET], origin });
        try {
          const page = await prepare(s);
          await page.goto("/");
          await visible(page, "view-create");
          await page.locator("#secret").fill(SECRET);
          await page.locator("#create-submit").click();
          await visible(page, "view-created");
          const key = (await page.locator("#link").inputValue()).split(".").pop();
          s.watch(key);
          const restored = await leaveAndBack(page, label("typed secret and created link"));
          if (mustRestore) assert.equal(restored, true);
          const after = await readable(page);
          assert.ok(!after.includes(SECRET), "typed secret still readable after Back");
          assert.ok(!after.includes(key), `link key still readable after Back: ${after.slice(Math.max(0, after.indexOf(key) - 120), after.indexOf(key) + 60)}`);
          await s.verify();
        } finally {
          await s.close();
        }
      });

      it("a revealed file: name, size and download anchor are gone after Back", async () => {
        const f = await fileLink({ name: "bf-secret-name.txt", bytes: new TextEncoder().encode(SECRET) });
        const s = await session(browser, { secrets: [f.key], origin });
        try {
          const page = await prepare(s);
          await page.goto(f.link.replace(ORIGIN, origin));
          await visible(page, "view-open");
          await page.locator("#reveal").click();
          await visible(page, "view-file");
          assert.match((await page.locator("#file-save").getAttribute("href")) ?? "", /^blob:/);
          const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#file-save").click()]);
          assert.equal(download.suggestedFilename(), "bf-secret-name.txt", "saving works before leaving");
          const restored = await leaveAndBack(page, label("file"));
          if (mustRestore) assert.equal(restored, true);
          const after = await readable(page);
          assert.ok(!after.includes("bf-secret-name"), `file name still readable after Back: ${after.slice(0, 300)}`);
          assert.ok(!after.includes(SECRET));
          assert.ok(!after.includes("blob:"), "a blob: link survived");
          assert.equal(await page.locator("#view-file").isVisible(), false);
          assert.equal((await page.locator("#file-save").getAttribute("href")) ?? "", "", "the anchor was released");
          await s.verify({ allowConsole: [/404/] });
        } finally {
          await s.close();
        }
      });
    });
  }
}
