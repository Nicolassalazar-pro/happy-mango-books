import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const project = path.dirname(root);
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(existsSync(path.join(root, ".cache", "playwright")) ? root : project, ".cache", "playwright");
const { chromium } = await import("playwright");
const { default: AxeBuilder } = await import("@axe-core/playwright");
const control = path.join(root, ".cache", "hybrid-control");
const proof = path.join(root, ".cache", "hybrid-proof");
const requirements = JSON.parse(await fs.readFile(path.join(root, "tests", "requirements.json"), "utf8"));
const demoManifest = path.join(control, "demo-media.json");
const hasDemoPhotos = existsSync(demoManifest);
assert(!process.argv.includes("--require-demo-photos") || hasDemoPhotos, "The required private local-demo manifest is missing");
const { units, specification } = requirements;
const base = specification.baseUrl;
const sha = body => crypto.createHash("sha256").update(body).digest("hex");
const normalize = text => text.replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
const fingerprint = value => sha(JSON.stringify(ordered(value)).replace(/[\u007f-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`) + "\n");
const files = [];

async function walk(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    assert(!entry.isSymbolicLink(), "Unexpected linked site file");
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(file);
    else files.push({ path: path.relative(path.join(root, "site"), file), sha256: sha(await fs.readFile(file)) });
  }
}
await walk(path.join(root, "site"));
files.sort((a, b) => a.path.toLowerCase() < b.path.toLowerCase() ? -1 : a.path.toLowerCase() > b.path.toLowerCase() ? 1 : 0);
await fs.mkdir(proof, { recursive: true });

const server = spawn("python", [
  "-B", path.join(root, "scripts", "preview.py"), "--workspace", root,
  "--prefix", base.replace(/\/$/, ""),
  ...(hasDemoPhotos ? ["--media-manifest", demoManifest] : []),
], { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let serverError = "";
server.stderr.on("data", chunk => { serverError += chunk.toString(); });
const readiness = await new Promise((resolve, reject) => {
  let output = "";
  const timer = setTimeout(() => { server.kill(); reject(new Error("Local preview did not start: " + serverError)); }, 20000);
  server.on("error", error => { clearTimeout(timer); reject(error); });
  server.on("exit", code => {
    if (!output.includes("\n")) { clearTimeout(timer); reject(new Error(`Local preview exited ${code}: ${serverError}`)); }
  });
  server.stdout.on("data", chunk => {
    output += chunk.toString();
    if (output.includes("\n")) {
      clearTimeout(timer);
      try { resolve(JSON.parse(output.split("\n")[0])); } catch (error) { server.kill(); reject(error); }
    }
  });
});
const target = readiness.url;
const origin = new URL(target).origin;
let browser;
const errors = [];
const requests = { external: [], post: [] };
const report = { startedAt: new Date().toISOString(), target, cases: [], captures: [], errors };
const observation = {
  artifactSha256: fingerprint(files), requirementsSha256: fingerprint(requirements),
  base, direction: specification.direction, pages: [], captures: [], interactions: [],
  externalRequests: [], postRequests: [],
};

function watch(page) {
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    const url = request.url();
    if (!url.startsWith(origin + "/") && !url.startsWith("data:")) requests.external.push(url);
    if (request.method() !== "GET") requests.post.push({ method: request.method(), url });
  });
  page.on("response", response => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
}

async function settled(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].filter(image => image.getClientRects().length).map(image => image.decode()));
  });
}

async function layout(page) {
  assert.equal(await page.locator("h1").count(), 1);
  assert.equal(await page.locator("dialog, [role='dialog'], iframe, a[href^='tel:'], input[type='tel']").count(), 0);
  assert.equal(await page.locator(".site-credit").innerText(), "Designed by A1 Sites & Designs");
  assert.equal(await page.locator(".site-nav [aria-current='page']").count(), 1);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Horizontal overflow");
  assert(await page.evaluate(() => [...document.images].filter(image => image.getClientRects().length).every(image => image.complete && image.naturalWidth)), "A visible image is broken");
}

async function bookState(page, state, index) {
  await page.waitForFunction(([expectedState, expectedIndex]) => {
    const book = document.querySelector("[data-hero-book]");
    return book?.dataset.state === expectedState && (expectedIndex === null || book.dataset.page === String(expectedIndex));
  }, [state, index ?? null]);
}

async function figureAndUnitCapture(page, required) {
  const unit = units.find(item => item.id === required.visibleUnitIds[0]);
  const node = page.locator(`[data-unit-id="${unit.id}"]`);
  await node.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy({ top: -24, behavior: "instant" }));
  const visible = await node.evaluate(element => {
    const nodes = element.querySelectorAll(".unit-heading,.unit-paragraph,.unit-qualification");
    return [...nodes].every(child => {
      const box = child.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && box.top >= -1 && box.bottom <= innerHeight + 1;
    });
  });
  assert(visible, "Required content does not fit the actual viewport: " + unit.id);
  const relative = path.join(".cache", "hybrid-proof", required.id + ".png");
  const file = path.join(root, relative);
  await page.screenshot({ path: file });
  observation.captures.push({
    id: required.id, route: required.route, viewport: required.viewport,
    urlPath: new URL(page.url()).pathname, visibleUnitIds: [unit.id],
    file: relative, sha256: sha(await fs.readFile(file)), captureMode: "full-viewport",
    deviceScaleFactor: 1, zoom: 1, reducedMotion: true, scrollY: await page.evaluate(() => scrollY),
  });
}

async function pageUnits(page, route) {
  const actual = [];
  for (const expected of units.filter(unit => unit.route === route)) {
    const node = page.locator(`[data-unit-id="${expected.id}"]`);
    assert.equal(await node.count(), 1);
    assert(await node.isVisible());
    const heading = normalize(await node.locator(".unit-heading").textContent());
    const paragraphs = (await node.locator(".unit-paragraph").allTextContents()).map(normalize);
    const qualification = normalize(await node.locator(".unit-qualification").textContent());
    assert.equal(heading, expected.heading);
    assert.deepEqual(paragraphs, expected.paragraphs);
    assert.equal(qualification, expected.qualification);
    actual.push({ ...expected, heading, paragraphs, qualification });
  }
  return actual;
}

async function carousel(page) {
  const root = page.locator("[data-reader-stories]");
  assert.equal(await root.count(), 1);
  const track = root.locator("[data-carousel-track]");
  const current = async () => root.evaluate(node => ({
    index: node.dataset.selectedIndex ?? node.dataset.index ?? node.dataset.current ?? null,
    left: node.querySelector("[data-carousel-track]").scrollLeft,
    transform: getComputedStyle(node.querySelector("[data-carousel-track]")).transform,
    text: node.querySelector("[data-story-card][aria-current='true']")?.textContent.trim(),
  }));
  const before = await current();
  await root.locator("[data-carousel-next]").click();
  await page.waitForTimeout(450);
  const after = await current();
  assert.notDeepEqual(after, before, "Next story did not change");
  await root.locator("[data-carousel-prev]").click();
  await page.waitForTimeout(450);
  const back = await current();
  assert.notDeepEqual(back, after, "Previous story did not change");
  const pause = root.locator("[data-carousel-pause]");
  const label = await pause.innerText();
  await pause.click();
  assert.notEqual(await pause.innerText(), label);
  assert(await track.isVisible());
  assert.equal(await root.locator("[data-story-card][aria-hidden='false']").count(), 1);
  assert.deepEqual((await root.locator("blockquote").allTextContents()).map(normalize), [
    "So colorful and with amazing tips and information.",
    "Just finished reading READY TO EAT, it is very informative and good!",
    "We love your book",
  ]);
  return { next: true, previous: true, pause: true };
}

try {
  browser = await chromium.launch({ headless: true });
  for (const pathname of [".git/config", ".cache/hybrid-control/demo-media.json", "client-materials/", "__demo__/not-allowed.webp"]) {
    assert.equal((await fetch(new URL(pathname, target))).status, 404);
  }
  const demo = hasDemoPhotos ? JSON.parse(await fs.readFile(demoManifest, "utf8")) : { photos: [] };
  for (const photo of demo.photos) {
    const response = await fetch(new URL(`__demo__/${photo.id}.webp`, target));
    assert.equal(response.status, 200);
    assert.equal(sha(Buffer.from(await response.arrayBuffer())), photo.sha256);
    assert(!files.some(file => file.sha256 === photo.sha256), "Local reader photo leaked into site");
  }

  for (const viewport of specification.viewports) {
    const context = await browser.newContext({ viewport: { width: viewport[0], height: viewport[1] }, reducedMotion: "reduce", deviceScaleFactor: 1 });
    for (const route of ["/", "/about/", "/contact/"]) {
      const page = await context.newPage();
      watch(page);
      await page.goto(origin + base.replace(/\/$/, "") + route);
      await settled(page);
      await layout(page);
      const actual = await pageUnits(page, route);
      observation.pages.push({
        route, viewport, urlPath: new URL(page.url()).pathname, units: actual,
        hiddenUnitIds: [], horizontalOverflow: false, pageErrors: [],
      });
      for (const required of specification.captures.filter(item => item.route === route && item.viewport[0] === viewport[0])) {
        await figureAndUnitCapture(page, required);
      }
      await page.screenshot({ path: path.join(proof, `${route === "/" ? "home" : route.split("/")[1]}-${viewport[0]}-full.png`), fullPage: true });
      const violations = (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze()).violations;
      assert.deepEqual(violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) })), []);
      report.cases.push({ case: "route-content-layout-and-axe", route, viewport, status: "passed" });
      await page.close();
    }
    await context.close();
  }

  const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  const page = await desktop.newPage();
  watch(page);
  await page.goto(target);
  await settled(page);
  assert.equal(await page.locator("[data-hero-book]").count(), 1);
  assert.equal(await page.locator("[data-reader-page]").count(), 4);
  assert.equal(await page.locator("[data-ideas-page]").count(), 1);
  await page.locator("[data-book-toggle]").click();
  await bookState(page, "open", 0);
  await page.locator("[data-book-next]").click();
  await bookState(page, "open", 2);
  const ideas = await page.locator('[data-reader-page="2"]').boundingBox();
  const photo = await page.locator('[data-reader-page="3"]').boundingBox();
  assert(ideas && photo && ideas.x < photo.x, "Ideas must face the reader photo from the left");
  assert(await page.locator(`[data-reader-page="3"] ${hasDemoPhotos ? "[data-local-demo-image]" : ".photo-placeholder"}`).first().isVisible());
  await page.screenshot({ path: path.join(proof, "desktop-ideas-photo.png"), fullPage: true });
  await page.locator("[data-book-toggle]").click();
  await bookState(page, "closed");
  await page.locator("[data-book-toggle]").click();
  await bookState(page, "open", 2);
  assert.equal(await page.locator("[data-book-thumb]").count(), 4);
  await page.locator('[data-book-thumb="0"]').click();
  await bookState(page, "open", 0);
  await page.locator('[data-book-thumb="1"]').click();
  await bookState(page, "open", 1);
  assert.equal(await page.locator('[data-book-thumb="1"]').getAttribute("aria-current"), "page");
  observation.interactions.push({ id: "hero-read", actual: { singleHero: true, opened: true, turned: true, ideasLeft: true, photoRight: true, reopened: true } });
  await page.getByRole("link", { name: "About", exact: true }).click();
  assert(new URL(page.url()).pathname.endsWith("/about/"));
  await page.getByRole("link", { name: "Contact", exact: true }).click();
  assert(new URL(page.url()).pathname.endsWith("/contact/"));
  await page.getByRole("link", { name: "The book", exact: true }).click();
  assert.equal(page.url(), target);
  observation.interactions.push({ id: "site-navigation", actual: { about: true, contact: true, home: true } });
  await page.getByRole("link", { name: /Ask about bulk orders/ }).click();
  await page.waitForURL(new URL("contact/?type=bulk", target).href);
  await page.locator("[data-send-inquiry]:enabled").waitFor();
  assert.equal(await page.locator("#inquiry-type").inputValue(), "bulk");
  assert(await page.locator("[data-bulk-fields]").isVisible());
  await page.locator("#inquiry-type").selectOption("general");
  assert(await page.locator("[data-bulk-fields]").isHidden());
  await page.getByRole("textbox", { name: "Your name", exact: true }).fill("Sample Reader");
  await page.getByRole("textbox", { name: "Your email", exact: true }).fill("reader@example.invalid");
  await page.getByRole("textbox", { name: "Your message", exact: true }).fill("A local-only fixture inquiry.");
  await page.locator("[data-inquiry-form]").evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
  assert(/not sent|nothing.*sent|has not sent|not.*saved|not.*send/i.test(await page.locator("[data-form-status]").innerText()));
  assert.equal(await page.getByRole("textbox", { name: "Your message", exact: true }).inputValue(), "A local-only fixture inquiry.");
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  observation.interactions.push({ id: "bulk-inquiry", actual: { bulk: true, general: true, sent: false } });
  await desktop.close();

  const storiesContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "no-preference" });
  const storiesPage = await storiesContext.newPage();
  watch(storiesPage);
  await storiesPage.goto(target);
  await settled(storiesPage);
  observation.interactions.push({ id: "reader-carousel", actual: await carousel(storiesPage) });
  await storiesContext.close();

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce", hasTouch: true });
  const phone = await mobile.newPage();
  watch(phone);
  await phone.goto(target);
  await settled(phone);
  await phone.locator("[data-book-toggle]").tap();
  await bookState(phone, "open", 0);
  assert.equal(await phone.locator("[data-hero-book]").getAttribute("data-layout"), "single");
  const order = [0];
  for (const index of [1, 2, 3]) {
    await phone.locator("[data-book-next]").tap();
    await bookState(phone, "open", index);
    order.push(Number(await phone.locator("[data-hero-book]").getAttribute("data-page")));
    assert((await phone.locator("[data-reader-panel]").boundingBox()).y >= -1, "The newly selected page is above the readable viewport");
  }
  await phone.setViewportSize({ width: 1440, height: 1000 });
  await phone.waitForTimeout(250);
  await phone.setViewportSize({ width: 390, height: 844 });
  await bookState(phone, "open", 3);
  observation.interactions.push({ id: "mobile-reader", actual: { layout: "single", order, resizePreservesPage: true } });
  await phone.screenshot({ path: path.join(proof, "mobile-reader-photo.png"), fullPage: true });
  await phone.evaluate(() => document.documentElement.style.fontSize = "200%");
  await layout(phone);
  await phone.screenshot({ path: path.join(proof, "large-text.png"), fullPage: true });
  await mobile.close();

  const narrow = await browser.newContext({ viewport: { width: 320, height: 760 }, reducedMotion: "reduce" });
  const narrowPage = await narrow.newPage();
  watch(narrowPage);
  for (const route of ["", "about/", "contact/"]) {
    await narrowPage.goto(new URL(route, target).href);
    await settled(narrowPage);
    await layout(narrowPage);
    if (!route) {
      await narrowPage.locator("[data-book-toggle]").click();
      await bookState(narrowPage, "open", 0);
      await narrowPage.locator("[data-book-next]").click();
      await narrowPage.locator("[data-book-next]").click();
      await bookState(narrowPage, "open", 2);
      await narrowPage.evaluate(() => document.documentElement.style.fontSize = "200%");
      await layout(narrowPage);
    }
  }
  await narrow.close();

  const noJs = await browser.newContext({ viewport: { width: 390, height: 844 }, javaScriptEnabled: false });
  const noPage = await noJs.newPage();
  watch(noPage);
  await noPage.goto(target);
  await settled(noPage);
  await layout(noPage);
  assert(await noPage.locator('[data-reader-page="0"]').isVisible());
  assert(await noPage.locator('[data-reader-page="2"]').isVisible());
  await noPage.goto(new URL("contact/", target).href);
  await noPage.getByRole("textbox", { name: "Your name", exact: true }).fill("Sample Reader");
  await noPage.getByRole("textbox", { name: "Your name", exact: true }).press("Enter");
  assert(await noPage.locator("[data-send-inquiry]").isDisabled());
  await noJs.close();
  assert.deepEqual(requests.external, []);
  assert.deepEqual(requests.post, []);
  assert.deepEqual(errors, []);
  report.status = "passed";
  report.cases.push({ case: "single-hero-geometry-mobile-order-navigation-carousel-form-and-fallback", status: "passed" });
  observation.externalRequests = requests.external;
  observation.postRequests = requests.post;
  await fs.writeFile(path.join(proof, "rendered.json"), JSON.stringify(observation, null, 2) + "\n");
  console.log("A1_RENDERED_OBSERVATION_SHA256 " + sha(await fs.readFile(path.join(proof, "rendered.json"))));
} catch (error) {
  report.status = "failed";
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill();
  report.requests = requests;
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(proof, "checks.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ status: report.status, cases: report.cases.length, failure: report.failure, proof }, null, 2));
}
