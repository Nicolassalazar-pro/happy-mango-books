import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const site = path.join(root, "site");
const localBrowsers = path.join(root, ".cache", "playwright");
if (existsSync(localBrowsers)) process.env.PLAYWRIGHT_BROWSERS_PATH ??= localBrowsers;
const { chromium } = await import("playwright");
const { default: AxeBuilder } = await import("@axe-core/playwright");
const sha = data => crypto.createHash("sha256").update(data).digest("hex");
const files = new Map();
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

async function collect(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    assert(!entry.isSymbolicLink(), "Site must not contain links to private files");
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(file);
    else files.set(path.relative(site, file).split(path.sep).join("/"), await fs.readFile(file));
  }
}
await collect(site);
const html = files.get("index.html").toString("utf8");
assert(!/data:[^;]+;base64,|\{\{|client-materials|localhost|127\.0\.0\.1|<form|<dialog/i.test(html));
assert(!/(?:src|href)=["']\//.test(html), "Root-relative URLs break project Pages");
assert(html.includes('name="robots" content="noindex,nofollow"'));
assert(!/data-open-preview|data-close-preview|showModal/.test(files.get("assets/js/site.js").toString("utf8")));

const prefix = "/happy-mango-books/";
const server = process.env.SITE_URL ? null : http.createServer((request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const key = pathname.startsWith(prefix) ? pathname.slice(prefix.length) || "index.html" : null;
  const body = files.get(key);
  if (request.method !== "GET" || !body) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  response.writeHead(200, {
    "Content-Type": types[path.extname(key)] || "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  });
  response.end(body);
});
if (server) await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const target = process.env.SITE_URL
  ? new URL(process.env.SITE_URL).href.replace(/\/?$/, "/")
  : `http://127.0.0.1:${server.address().port}${prefix}`;
const proof = path.join(root, ".cache", "site-checks", server ? "local" : "live");
await fs.mkdir(proof, { recursive: true });
const results = { target, checkedAt: new Date().toISOString(), cases: [], assets: [], errors: [] };
let browser;

async function settle(page) {
  for (const image of await page.locator('img[loading="lazy"]').all()) {
    await image.scrollIntoViewIfNeeded();
  }
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map(image => image.decode()));
    window.scrollTo({ top: 0, behavior: "instant" });
  });
}

function watch(page) {
  page.on("pageerror", error => results.errors.push(error.message));
  page.on("requestfailed", request => results.errors.push(`${request.url()}: ${request.failure()?.errorText}`));
  page.on("response", response => {
    if (response.status() >= 400) results.errors.push(`${response.status()} ${response.url()}`);
  });
}

async function checkPage(page) {
  assert.equal(await page.title(), "Ready to Eat | Happy Mango Books");
  assert.equal(await page.locator("h1").count(), 1);
  assert.equal(await page.locator("dialog, [role='dialog'], [data-open-preview], [data-close-preview], .image-expand, header nav, header a, .purchase-panel, .text-action, .study-label").count(), 0);
  assert.equal(await page.locator(".site-credit").innerText(), "Designed by A1 Sites & Designs");
  assert.equal(await page.locator("button").count(), 1);
  assert.equal(await page.locator("[data-wiggle]").count(), 1);
  assert.equal(await page.locator("#readers img").count(), 0);
  assert.deepEqual(await page.locator("#readers blockquote").allTextContents(), [
    "So colorful and with amazing tips and information.",
    "Just finished reading READY TO EAT, it is very informative and good!",
    "We love your book",
  ]);
  assert.deepEqual(await page.locator("a").evaluateAll(nodes => nodes.map(node => node.getAttribute("href"))), ["#main"]);
  const images = page.locator(".book-cover img, .inside-image img");
  assert.equal(await images.count(), 2);
  assert(await images.evaluateAll(nodes => nodes.every(node => !node.closest("a, button, [role='button'], [tabindex]"))));
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Horizontal overflow");
  assert(await page.evaluate(() => [...document.images].every(image => image.complete && image.naturalWidth)), "Broken image");
  const footer = await page.locator(".site-credit").evaluate(node => {
    const box = node.getBoundingClientRect();
    const parent = node.parentElement.getBoundingClientRect();
    return Math.abs(box.right - parent.right);
  });
  assert(footer < 1, "Designer credit lost its bottom-right alignment");
}

try {
  for (const [name, bytes] of files) {
    if (name === ".nojekyll") continue;
    const response = await fetch(new URL(name, target));
    assert.equal(response.status, 200, `Missing deployed asset: ${name}`);
    const digest = sha(Buffer.from(await response.arrayBuffer()));
    assert.equal(digest, sha(bytes), `Deployed bytes differ: ${name}`);
    results.assets.push({ path: name, sha256: digest });
  }
  for (const name of ["client-materials/", "archive/", ".git/config"]) {
    assert.equal((await fetch(new URL(name, target))).status, 404, `Private path is exposed: ${name}`);
  }
  browser = await chromium.launch({ headless: true });
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 1000 }],
    ["mobile", { width: 390, height: 844 }],
    ["narrow", { width: 320, height: 760 }],
    ["intermediate", { width: 860, height: 900 }],
  ]) {
    const context = await browser.newContext({ viewport, hasTouch: name !== "desktop" });
    const page = await context.newPage();
    watch(page);
    await page.goto(target);
    await settle(page);
    await checkPage(page);
    if (name === "desktop" || name === "mobile") {
      await page.screenshot({ path: path.join(proof, `${name}.png`), fullPage: true, animations: "disabled" });
      const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      assert.deepEqual(accessibility.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) })), []);
    }
    for (const image of await page.locator(".book-cover img, .inside-image img").all()) {
      if (name === "mobile") await image.tap();
      else await image.click();
      assert.equal(page.url(), target);
      assert.equal(await page.locator("dialog, [role='dialog']").count(), 0);
    }
    await page.locator("[data-wiggle]").focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("[data-wiggle-status]").innerText(), "Nom, nom!");
    await page.waitForTimeout(720);
    assert.equal(await page.evaluate(() => document.getAnimations().filter(animation => animation.playState === "running").length), 0);
    if (name === "desktop") {
      await page.locator(".book-cover img").evaluate(image => {
        image.dispatchEvent(new Event("error"));
        image.dispatchEvent(new Event("error"));
      });
      assert.equal(await page.locator(".book-cover .error-message").count(), 1);
      assert(await page.locator(".book-cover img").isHidden());
    }
    results.cases.push({ name, result: "passed" });
    await context.close();
  }
  const quiet = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const quietPage = await quiet.newPage();
  watch(quietPage);
  await quietPage.goto(target);
  await settle(quietPage);
  await quietPage.locator("[data-wiggle]").click();
  assert.equal(await quietPage.evaluate(() => document.getAnimations().filter(animation => animation.playState === "running").length), 0);
  await quietPage.evaluate(() => document.documentElement.style.fontSize = "200%");
  await checkPage(quietPage);
  results.cases.push({ name: "reduced-motion-and-reflow", result: "passed" });
  await quiet.close();

  const noScript = await browser.newContext({ viewport: { width: 390, height: 844 }, javaScriptEnabled: false });
  const noPage = await noScript.newPage();
  watch(noPage);
  await noPage.goto(target);
  await noPage.locator("#inside img").scrollIntoViewIfNeeded();
  await settle(noPage);
  await checkPage(noPage);
  assert.equal(await noPage.locator("[data-wiggle]").isVisible(), false);
  assert(await noPage.locator("#inside img").isVisible());
  results.cases.push({ name: "no-javascript", result: "passed" });
  await noScript.close();
  assert.deepEqual(results.errors, []);
  results.result = "passed";
} catch (error) {
  results.result = "failed";
  results.failure = error.stack;
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await fs.writeFile(path.join(proof, "checks.json"), JSON.stringify(results, null, 2) + "\n");
  console.log(JSON.stringify({ result: results.result, cases: results.cases.length, assets: results.assets.length, failure: results.failure, proof: path.relative(root, proof) }, null, 2));
}
