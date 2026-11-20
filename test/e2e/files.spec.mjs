// Browser e2e (docs/plans/file-transfer.md A12, docs/plans/blob-v2.md section 7): text, passphrase and file links in
// Chromium, Firefox and WebKit against the self-host server started by run.mjs. Readers are tested with fixture links made
// by the real codec (the committed build still writes v1 text), so the create view is only exercised for v1 text.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { GONE_TITLE, ORIGIN, fileLink, launchBrowsers, session, statusOf, textLink } from "./helpers.mjs";

const PASS = "correct horse battery";
const bytesOf = (n, seed = 7) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed + (i >> 8)) & 255);

const browsers = await launchBrowsers({ chromium: {}, firefox: {}, webkit: {} });
after(async () => {
  for (const { browser } of browsers) await browser.close();
});

async function open(s, link) {
  const page = await s.context.newPage();
  await page.goto(link);
  return page;
}
const visible = (page, id) => page.locator(`#${id}`).waitFor({ state: "visible" });
const reveal = (page) => page.locator("#reveal").click();

/** After the page settled: the URL has no fragment (the key left the address bar). */
function assertKeyGone(page) {
  assert.equal(page.url(), `${ORIGIN}/`);
}

for (const { name, browser } of browsers) {
  describe(name, () => {
    it("v1 text: create in the UI, reveal in a second context, second open is gone, key leaves the address bar", async () => {
      const a = await session(browser);
      const b = await session(browser);
      const c = await session(browser);
      try {
        const page = await a.context.newPage();
        await page.goto("/");
        await visible(page, "view-create");
        await page.locator("#secret").fill("hunter2 ✓ <b>not html</b>");
        await page.locator("#create-submit").click();
        await visible(page, "view-created");
        const link = await page.locator("#link").inputValue();
        assert.match(link, /^http:\/\/127\.0\.0\.1:\d+\/#[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, "v1 link shape");
        const [id, key] = link.split("#")[1].split(".");
        a.watch(key);
        b.watch(key);

        const other = await b.context.newPage();
        await other.goto(link);
        await visible(other, "view-open");
        assert.equal(await statusOf(id), 200, "opening the link does not burn it");
        await reveal(other);
        await visible(other, "view-revealed");
        assert.equal(await other.locator("#revealed").inputValue(), "hunter2 ✓ <b>not html</b>");
        assertKeyGone(other);
        assert.equal(await other.evaluate(() => location.hash), "");
        assert.equal(await statusOf(id), 404);

        const third = await c.context.newPage();
        await third.goto(link);
        await visible(third, "view-gone"); // the page checks the row first, so a used link never shows Reveal
        assert.equal(await third.locator("#gone-title").textContent(), GONE_TITLE);
        await a.verify();
        await b.verify({ allowConsole: [/404/] });
        await c.verify({ allowConsole: [/404/] });
      } finally {
        await Promise.all([a.close(), b.close(), c.close()]);
      }
    });

    it("v2 text (2): reveals once", async () => {
      const f = await textLink({ text: "v2 secret äö 🔑" });
      assert.match(f.link, /#2\./);
      const s = await session(browser, { secrets: [f.key] });
      try {
        const page = await open(s, f.link);
        await visible(page, "view-open");
        assert.equal(await page.locator("#open-passphrase").isHidden(), true);
        await reveal(page);
        await visible(page, "view-revealed");
        assert.equal(await page.locator("#revealed").inputValue(), "v2 secret äö 🔑");
        assertKeyGone(page);
        const again = await open(s, f.link);
        await visible(again, "view-gone");
        await s.verify({ allowConsole: [/404/] });
      } finally {
        await s.close();
      }
    });

    it("2p: right passphrase reveals", async () => {
      const f = await textLink({ text: "protected", passphrase: PASS });
      assert.match(f.link, /#2p\./);
      const s = await session(browser, { secrets: [f.key, PASS] });
      try {
        const page = await open(s, f.link);
        await visible(page, "view-open");
        await page.locator("#open-pass").fill(PASS);
        await reveal(page);
        await visible(page, "view-revealed");
        assert.equal(await page.locator("#revealed").inputValue(), "protected");
        assertKeyGone(page);
        assert.equal(await page.locator("#open-pass").inputValue(), "");
        await s.verify();
      } finally {
        await s.close();
      }
    });

    it("2p: wrong passphrase shows the destroyed view and the row is gone", async () => {
      const f = await textLink({ text: "protected", passphrase: PASS });
      const wrong = "not the passphrase";
      const s = await session(browser, { secrets: [f.key, PASS, wrong] });
      try {
        const page = await open(s, f.link);
        await visible(page, "view-open");
        await page.locator("#open-pass").fill(wrong);
        await reveal(page);
        await visible(page, "view-gone");
        assert.equal(await page.locator("#gone-title").textContent(), "Wrong passphrase, or the link was changed");
        assert.equal(await statusOf(f.id), 404);
        await s.verify();
      } finally {
        await s.close();
      }
    });

    it("2p: an invalid entry sends no reveal request and keeps the secret", async () => {
      const f = await textLink({ text: "protected", passphrase: PASS });
      const s = await session(browser, { secrets: [f.key] });
      try {
        const page = await open(s, f.link);
        await visible(page, "view-open");
        const field = page.locator("#open-pass");
        await field.fill("short");
        const button = page.locator("#reveal");
        if (await button.isEnabled()) await button.click();
        await field.press("Enter");
        await field.fill("bad\u0007control chars");
        await field.press("Enter");
        // Settle: a round trip through the page, then look at what was sent.
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(0))));
        assert.equal(s.requests.filter((r) => r.url.includes("/reveal")).length, 0, "no reveal request");
        assert.equal(await page.locator("#view-open").isVisible(), true, "still on the open view");
        assert.equal(await statusOf(f.id), 200, "row still there");
        await s.verify();
      } finally {
        await s.close();
      }
    });

    it("2f: download event with the safe name, identical bytes, URL unchanged, no new page", async () => {
      const bytes = bytesOf(5000);
      const f = await fileLink({ name: "..\\evil/dir\\report_é.txt", type: "text/plain", bytes });
      const s = await session(browser, { secrets: [f.key] });
      try {
        const page = await open(s, f.link);
        await visible(page, "view-open");
        assert.equal(await page.locator("#open-title").textContent(), "Someone sent you a file");
        await reveal(page);
        await visible(page, "view-file");
        assertKeyGone(page);
        const shownName = await page.locator("#file-name").textContent();
        assert.ok(shownName && !/[\\/]/.test(shownName), `name shown without separators: ${shownName}`);
        assert.equal(await page.locator("#file-risky").isHidden(), true, "no risky warning for .txt");
        const pagesBefore = s.pageCount();
        const urlBefore = page.url();
        for (let round = 0; round < 2; round++) {
          const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#file-save").click()]);
          const name = download.suggestedFilename();
          assert.ok(name.endsWith(".txt") && !/[\\/]/.test(name), `safe name: ${name}`);
          assert.equal(name, (await page.locator("#file-save").getAttribute("download")), "name equals the anchor's download attribute");
          assert.deepEqual(new Uint8Array(readFileSync(await download.path())), bytes, `bytes identical (save ${round + 1})`);
          assert.equal(page.url(), urlBefore, "page URL unchanged");
        }
        assert.equal(s.pageCount(), pagesBefore, "no new page");
        assert.equal(await statusOf(f.id), 404);
        await s.verify();
      } finally {
        await s.close();
      }
    });

    for (const [fileName, mime, body] of [
      ["evil.html", "text/html", "<!doctype html><script>alert(document.domain)</script><h1 id=pwn>pwned</h1>"],
      ["evil.svg", "image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><rect width="9" height="9"/></svg>'],
      ["evil.xhtml", "application/xhtml+xml", '<html xmlns="http://www.w3.org/1999/xhtml"><script>alert(3)</script></html>'],
    ]) {
      it(`hostile ${fileName}: only downloaded, no dialog, no popup, no CSP violation`, async () => {
        const bytes = new TextEncoder().encode(body);
        const f = await fileLink({ name: fileName, type: mime, bytes });
        const s = await session(browser, { secrets: [f.key] });
        try {
          const page = await open(s, f.link);
          await visible(page, "view-open");
          await reveal(page);
          await visible(page, "view-file");
          assert.equal(await page.locator("#file-name").textContent(), fileName);
          assert.equal(await page.locator("#file-risky").isVisible(), true, "risky warning for script-capable files");
          const pagesBefore = s.pageCount();
          const urlBefore = page.url();
          const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#file-save").click()]);
          assert.equal(download.suggestedFilename(), fileName);
          assert.equal(Buffer.from(readFileSync(await download.path())).toString("utf8"), body);
          // Settle, then check nothing rendered and nothing executed.
          await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(0)))));
          assert.equal(page.url(), urlBefore);
          assert.equal(s.pageCount(), pagesBefore, "no popup");
          assert.equal(await page.locator("#pwn").count(), 0, "file content never rendered in the page");
          assert.equal(await page.evaluate(() => document.querySelectorAll("iframe, object, embed, script:not([src]):not([type=\"application/ld+json\"])").length), 0);
          await s.verify(); // includes: no dialog fired, no console error or CSP message
        } finally {
          await s.close();
        }
      });
    }

    it("risky warning for .exe, none for .pdf", async () => {
      for (const [fileName, risky] of [["setup.exe", true], ["notes.pdf", false]]) {
        const f = await fileLink({ name: fileName, bytes: bytesOf(300) });
        const s = await session(browser, { secrets: [f.key] });
        try {
          const page = await open(s, f.link);
          await visible(page, "view-open");
          await reveal(page);
          await visible(page, "view-file");
          assert.equal(await page.locator("#file-risky").isVisible(), risky, fileName);
          assert.match((await page.locator("#view-file").textContent()) ?? "", /not checked for viruses/);
          await s.verify();
        } finally {
          await s.close();
        }
      }
    });

    it("2fp: right passphrase gives the file, wrong one destroys it", async () => {
      const bytes = bytesOf(2048, 3);
      const good = await fileLink({ name: "secret.bin", bytes, passphrase: PASS });
      assert.match(good.link, /#2fp\./);
      const s = await session(browser, { secrets: [good.key, PASS] });
      try {
        const page = await open(s, good.link);
        await visible(page, "view-open");
        await page.locator("#open-pass").fill(PASS);
        await reveal(page);
        await visible(page, "view-file");
        const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#file-save").click()]);
        assert.equal(download.suggestedFilename(), "secret.bin");
        assert.deepEqual(new Uint8Array(readFileSync(await download.path())), bytes);
        await s.verify();
      } finally {
        await s.close();
      }
      const bad = await fileLink({ name: "secret.bin", bytes, passphrase: PASS });
      const t = await session(browser, { secrets: [bad.key, PASS, "wrong passphrase!"] });
      try {
        const page = await open(t, bad.link);
        await visible(page, "view-open");
        await page.locator("#open-pass").fill("wrong passphrase!");
        await reveal(page);
        await visible(page, "view-gone");
        assert.equal(await page.locator("#gone-title").textContent(), "Wrong passphrase, or the link was changed");
        assert.equal(await statusOf(bad.id), 404);
        assert.equal(await page.locator("#file-save").isVisible(), false);
        await t.verify();
      } finally {
        await t.close();
      }
    });

    it("CSP: no securitypolicyviolation event on any view (except WebKit's own select styling)", async () => {
      const f = await fileLink({ name: "a.html", type: "text/html", bytes: new TextEncoder().encode("<script>1</script>") });
      const s = await session(browser, { secrets: [f.key] });
      try {
        await s.context.addInitScript(() => {
          window.__violations = [];
          document.addEventListener("securitypolicyviolation", (e) => window.__violations.push({ d: e.violatedDirective, uri: e.blockedURI, file: e.sourceFile, sample: e.sample }));
        });
        const page = await s.context.newPage();
        const seen = [];
        const collect = async () => seen.push(...(await page.evaluate(() => window.__violations)));
        await page.goto("/");
        await visible(page, "view-create");
        await collect();
        await page.goto(f.link);
        await visible(page, "view-open");
        await reveal(page);
        await visible(page, "view-file");
        await Promise.all([page.waitForEvent("download"), page.locator("#file-save").click()]);
        await collect();
        const unexpected = seen.filter((v) => !(browser.browserType().name() === "webkit" && v.d === "style-src-attr" && v.uri === "inline" && v.file === ""));
        assert.deepEqual(unexpected, []);
        await s.verify();
      } finally {
        await s.close();
      }
    });

    it("320 px: no horizontal overflow on create, open, revealed, file, gone views", async () => {
      const longName = `${"very-long-file-name-".repeat(11)}.txt`.slice(0, 250);
      const text = await textLink({ text: "x".repeat(2000) });
      const pp = await textLink({ text: "y", passphrase: PASS });
      const file = await fileLink({ name: longName, type: "application/x-very-long-type", bytes: bytesOf(900) });
      const risky = await fileLink({ name: "run-me.exe", bytes: bytesOf(900) });
      const s = await session(browser, { viewport: { width: 320, height: 640 } });
      const noOverflow = async (page, label) => {
        const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth, iw: window.innerWidth }));
        assert.ok(m.sw <= m.iw && m.bw <= m.iw, `${label}: overflow ${JSON.stringify(m)}`);
      };
      try {
        const page = await s.context.newPage();
        await page.goto("/");
        await visible(page, "view-create");
        await noOverflow(page, "create");
        await page.locator("#secret").fill("w".repeat(5000));
        await page.locator("#create-submit").click();
        await visible(page, "view-created");
        await noOverflow(page, "created");

        await page.goto(text.link);
        await page.reload();
        await visible(page, "view-open");
        await noOverflow(page, "open");
        await reveal(page);
        await visible(page, "view-revealed");
        await noOverflow(page, "revealed");

        await page.goto(pp.link);
        await page.reload();
        await visible(page, "view-open");
        await noOverflow(page, "open with passphrase");
        await page.locator("#open-pass").fill("bad");
        await noOverflow(page, "open with passphrase and error");

        await page.goto(file.link);
        await page.reload();
        await visible(page, "view-open");
        await noOverflow(page, "open file");
        await reveal(page);
        await visible(page, "view-file");
        await noOverflow(page, "file (long name)");

        await page.goto(risky.link);
        await page.reload();
        await visible(page, "view-open");
        await reveal(page);
        await visible(page, "view-file");
        await noOverflow(page, "file (risky warning)");

        await page.goto(text.link);
        await page.reload();
        await visible(page, "view-gone");
        await noOverflow(page, "gone");
        await s.verify({ allowConsole: [/404/] });
      } finally {
        await s.close();
      }
    });
  });
}
