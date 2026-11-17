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
const proof = path.resolve(root, process.env.HMB_PROOF_DIR || path.join(".cache", "hybrid-proof"));
assert(path.relative(root, proof).startsWith(".cache" + path.sep), "Proof output must stay in the private project cache");
const requirements = JSON.parse(await fs.readFile(path.join(root, "tests", "requirements.json"), "utf8"));
const websitePhotos = ["reader-cover.webp", "reader-open.webp", "about-first-foods.webp"];
assert(websitePhotos.every(file => existsSync(path.join(root, "site", "assets", "images", file))), "Selected website-photo assets are missing");
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
assert.equal(readiness.demoPhotos, false, "Reader-photo checks must use the public static assets, not a private overlay");
const target = readiness.url;
const origin = new URL(target).origin;
let browser;
const errors = [];
const requestLog = [];
const mockedRequests = new WeakSet();
const formEndpoint = "https://formsubmit.co/ajax/info@happymangobooks.com";
const nativeFormEndpoint = "https://formsubmit.co/info@happymangobooks.com";
const formMock = { mode: "forbidden", requests: [], ready: null, release: null };
const report = { startedAt: new Date().toISOString(), target, cases: [], captures: [], errors };
const observation = {
  artifactSha256: fingerprint(files), requirementsSha256: fingerprint(requirements),
  base, direction: specification.direction, pages: [], captures: [], interactions: [],
  externalRequests: [], postRequests: [],
};

function watch(page) {
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => requestLog.push(request));
  page.on("response", response => {
    if (response.status() >= 400 && !mockedRequests.has(response.request())) errors.push(`${response.status()} ${response.url()}`);
  });
}

function actualRequests() {
  const real = requestLog.filter(request => !mockedRequests.has(request));
  return {
    external: real.filter(request => !request.url().startsWith(origin + "/") && !request.url().startsWith("data:")).map(request => request.url()),
    post: real.filter(request => request.method() !== "GET").map(request => ({ method: request.method(), url: request.url() })),
  };
}

async function testContext(options) {
  const context = await browser.newContext(options);
  await context.route("https://formsubmit.co/**", async route => {
    const request = route.request();
    mockedRequests.add(request);
    const headers = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type, accept" };
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers, body: "" });
      return;
    }
    if (formMock.mode === "forbidden" || request.method() !== "POST" || ![formEndpoint, nativeFormEndpoint].includes(request.url())) {
      errors.push("Unexpected provider request blocked by the test fixture");
      await route.abort();
      return;
    }
    const payload = request.headers()["content-type"]?.includes("application/json")
      ? request.postDataJSON() : Object.fromEntries(new URLSearchParams(request.postData() || ""));
    const mode = formMock.mode;
    formMock.requests.push({ url: request.url(), payload });
    if (mode === "hold") {
      await new Promise(resolve => { formMock.release = resolve; formMock.ready?.(); });
    }
    if (mode === "abort") {
      await route.abort();
      return;
    }
    if (mode === "native") {
      await route.fulfill({ status: 200, contentType: "text/html", body: '<!doctype html><html lang="en"><title>Mock provider</title><link rel="icon" href="data:,"><body><p>Mock provider handoff</p></body></html>' });
      return;
    }
    const result = mode === "reject" ? { success: false } : { success: "true" };
    await route.fulfill({ status: 200, contentType: "application/json", headers, body: JSON.stringify(result) });
  });
  return context;
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
  assert.equal(await page.locator("[data-book-thumb], [data-book-thumbnails], #book-sample-note").count(), 0);
  assert.equal(await page.locator(".hb-toolbar, .hb-step, .hb-close").count(), 0);
  assert(await page.locator(".hb-access-key").evaluateAll(buttons => buttons.every(button => {
    const box = button.getBoundingClientRect();
    return button.matches(":focus-visible") || box.width <= 1 && box.height <= 1;
  })), "Keyboard-only controls should not leave a visible control strip");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Horizontal overflow");
  assert(await page.evaluate(() => [...document.images].filter(image => image.getClientRects().length).every(image => image.complete && image.naturalWidth)), "A visible image is broken");
  assert(await page.evaluate(() => {
    const plate = document.querySelector(".hb-enhanced .hb-plate");
    if (!plate) return true;
    const rim = plate.getBoundingClientRect();
    return [...document.querySelectorAll(".hb-food")].every(food => {
      const art = food.getBoundingClientRect();
      return art.left >= 0 && art.right <= innerWidth && art.right > rim.left && art.left < rim.right;
    });
  }), "Food artwork must stay close to the plate and inside the viewport");
}

async function bookState(page, state, index) {
  await page.waitForFunction(([expectedState, expectedIndex]) => {
    const book = document.querySelector("[data-hero-book]");
    return book?.dataset.state === expectedState && (expectedIndex === null || book.dataset.page === String(expectedIndex));
  }, [state, index ?? null]);
}

async function turnOnPage(page, direction, touch = false) {
  const spread = await page.locator("[data-hero-book]").getAttribute("data-layout") === "spread";
  const pages = page.locator(".hb-pages > [data-reader-page]:visible");
  const leaf = spread ? pages.nth(direction > 0 ? 1 : 0) : pages.first();
  const box = await leaf.boundingBox();
  const options = { position: { x: box.width * (direction > 0 ? .8 : .2), y: box.height * .4 } };
  if (touch) await leaf.tap(options);
  else await leaf.click(options);
}

async function closeOnPlate(page, touch = false) {
  const stage = page.locator(".hb-stage");
  await stage.scrollIntoViewIfNeeded();
  const box = await stage.boundingBox();
  const options = { position: { x: box.width / 2, y: 24 } };
  if (touch) await stage.tap(options);
  else await stage.click(options);
}

async function plateOpeningMotion(page, closedWidth) {
  await page.waitForFunction(() => document.querySelector(".hb-plate").getAnimations().length > 0);
  const samples = await page.evaluate(async () => {
    const root = document.querySelector("[data-hero-book]");
    const animations = root.getAnimations({ subtree: true }).filter(animation => animation.effect.getTiming().iterations !== Infinity);
    animations.forEach(animation => animation.pause());
    const samples = [];
    for (const phase of [0, .14, .35, .63, .82, 1]) {
      animations.forEach(animation => { animation.currentTime = Number(animation.effect.getTiming().duration) * phase; });
      await new Promise(requestAnimationFrame);
      const plate = root.querySelector(".hb-plate");
      const material = getComputedStyle(plate);
      const matrix = new DOMMatrixReadOnly(material.transform);
      const box = plate.getBoundingClientRect();
      samples.push({
        phase, width: parseFloat(material.width),
        foodWidth: parseFloat(getComputedStyle(root.querySelector(".hb-foods")).width),
        scale: Math.hypot(matrix.a, matrix.b), angle: Math.atan2(matrix.b, matrix.a) * 180 / Math.PI,
        withinViewport: box.left >= 0 && box.right <= innerWidth,
      });
    }
    animations.forEach(animation => animation.finish());
    return samples;
  });
  assert(Math.abs(samples[0].width - closedWidth) < 1, "The expanding plate must begin at its closed size");
  assert(samples[2].width > samples[0].width && samples[2].width < samples.at(-1).width, "The plate must actually grow through intermediate sizes");
  assert(samples.some(sample => sample.scale < .99) && samples.some(sample => sample.scale > 1.01), "The plate must stretch and gently overshoot");
  assert(Math.abs(samples.at(-1).scale - 1) < .001, "The plate must settle to its normal shape");
  assert(samples.every(sample => sample.withinViewport && Math.abs(sample.width - sample.foodWidth) < .1), "Food placement must follow the plate without viewport overflow");
  await fs.writeFile(path.join(proof, "plate-opening-motion.json"), JSON.stringify(samples, null, 2) + "\n");
}

async function bookImageAlignment(page) {
  const layout = await page.locator("[data-hero-book]").getAttribute("data-layout");
  const snapshot = () => page.evaluate(() => {
    const root = document.querySelector("[data-hero-book]");
    const anchor = root.querySelector(".hb-layout").getBoundingClientRect();
    return {
      page: root.dataset.page, height: anchor.height, top: anchor.y + scrollY,
      images: [...root.querySelectorAll(".hb-page img")].filter(image => image.getClientRects().length && !image.closest(".hb-measure")).map(image => {
        const box = image.getBoundingClientRect();
        return {
          src: image.getAttribute("src"),
          owner: image.closest(".hb-underlay") ? "underlay" : image.closest(".hb-turn-front") ? "front" : image.closest(".hb-turn-back") ? "back" : "real",
          x: box.x - anchor.x, y: box.y - anchor.y, width: box.width, height: box.height,
        };
      }),
    };
  });
  const compare = (copy, originals) => {
    const original = originals.find(image => image.owner === "real" && image.src === copy.src);
    assert(original, "Animated imagery needs a matching real page");
    const delta = Object.fromEntries(["x", "y", "width", "height"].map(key => [key, Math.abs(copy[key] - original[key])]));
    // The thin 3D leaf has subpixel projection depth; its content box must otherwise match.
    assert(Math.max(...Object.values(delta)) < .6, `Image jumps at page handoff: ${copy.src} ${JSON.stringify(delta)}`);
    return { src: copy.src, owner: copy.owner, delta };
  };
  const records = [];
  for (const direction of layout === "spread" ? [1, -1] : [1, 1, 1, -1, -1, -1]) {
    const before = await snapshot();
    await page.locator("[data-reader-panel]").press(direction > 0 ? "ArrowRight" : "ArrowLeft");
    await page.waitForFunction(() => !document.querySelector("[data-page-turn]").hidden);
    await page.evaluate(() => {
      const animations = document.querySelector("[data-hero-book]").getAnimations({ subtree: true }).filter(animation => animation.effect.getTiming().iterations !== Infinity);
      animations.forEach(animation => { animation.pause(); animation.currentTime = 0; });
    });
    await page.waitForTimeout(20);
    const start = await snapshot();
    const sourceOwners = direction > 0 ? ["front"] : layout === "spread" ? ["back"] : [];
    const source = start.images.filter(image => sourceOwners.includes(image.owner)).map(image => compare(image, before.images));
    await page.evaluate(() => {
      document.querySelector("[data-hero-book]").getAnimations({ subtree: true }).filter(animation => animation.effect.getTiming().iterations !== Infinity)
        .forEach(animation => { animation.currentTime = Number(animation.effect.getTiming().duration) - .01; });
    });
    await page.waitForTimeout(20);
    const end = await snapshot();
    await page.evaluate(() => {
      document.querySelector("[data-hero-book]").getAnimations({ subtree: true }).filter(animation => animation.effect.getTiming().iterations !== Infinity)
        .forEach(animation => animation.finish());
    });
    await bookState(page, "open");
    const after = await snapshot();
    const destinationOwners = direction < 0 ? ["underlay", "front"] : layout === "spread" ? ["underlay", "back"] : ["underlay"];
    const destination = end.images.filter(image => destinationOwners.includes(image.owner)).map(image => compare(image, after.images));
    assert(Math.abs(before.height - after.height) < .1 && Math.abs(start.height - after.height) < .1, "Open-book height must not change between leaves");
    assert(Math.abs(before.top - after.top) < .1, "Page changes must not move the book in document flow");
    records.push({ layout, from: before.page, to: after.page, height: after.height, source, destination });
  }
  return records;
}

async function cornerNotes(page) {
  const checks = await page.locator(".hb-pages > .hb-sample:visible").evaluateAll(pages => pages.map(page => {
    const image = page.querySelector(".hb-sample-art");
    const note = page.querySelector(".hb-corner-note");
    const imageBox = image.getBoundingClientRect();
    if (getComputedStyle(note).position === "static") {
      // Adjacent 3D-projected rectangles can differ by a fraction of a CSS pixel.
      return { text: note.textContent, inFlow: note.getBoundingClientRect().top >= imageBox.bottom - .01, overlap: 0 };
    }
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const alpha = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const walker = document.createTreeWalker(note, NodeFilter.SHOW_TEXT);
    let text, overlap = 0;
    while ((text = walker.nextNode())) {
      if (!text.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(text);
      for (const box of range.getClientRects()) {
        const x0 = Math.floor((box.left - imageBox.left) * canvas.width / imageBox.width);
        const x1 = Math.ceil((box.right - imageBox.left) * canvas.width / imageBox.width);
        const y0 = Math.floor((box.top - imageBox.top) * canvas.height / imageBox.height);
        const y1 = Math.ceil((box.bottom - imageBox.top) * canvas.height / imageBox.height);
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height || alpha[(y * canvas.width + x) * 4 + 3] > 16) overlap++;
        }
      }
    }
    return { text: note.textContent, inFlow: true, overlap };
  }));
  for (const check of checks) {
    assert(check.inFlow, "Large-text and fallback notes must follow the artwork");
    assert.equal(check.overlap, 0, `Corner copy covers real artwork: ${normalize(check.text)}`);
  }
}

async function figureAndUnitCapture(page, required) {
  const unit = units.find(item => item.id === required.visibleUnitIds[0]);
  const node = page.locator(`[data-unit-id="${unit.id}"]`);
  await node.evaluate(element => window.scrollTo({
    top: Math.max(0, element.getBoundingClientRect().top + scrollY - 24), behavior: "instant",
  }));
  const visible = await node.evaluate(element => {
    const nodes = element.querySelectorAll(".unit-heading,.unit-paragraph,.unit-qualification");
    return [...nodes].every(child => {
      const box = child.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && box.top >= -1 && box.bottom <= innerHeight + 1;
    });
  });
  assert(visible, "Required content does not fit the actual viewport: " + unit.id);
  const relative = path.relative(root, path.join(proof, required.id + ".png"));
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

async function reviewState(page, expected) {
  await page.waitForFunction(index => {
    const root = document.querySelector("[data-reader-stories]");
    const card = root.querySelector("[aria-current='true']");
    if (root.dataset.selectedIndex !== String(index) || !card) return false;
    const a = card.getBoundingClientRect();
    const b = root.querySelector("[data-carousel-viewport]").getBoundingClientRect();
    return Math.abs(a.left + a.width / 2 - b.left - b.width / 2) < 1;
  }, expected, { timeout: 5000 });
}

async function reviewSide(page, direction, touch = false) {
  const viewport = page.locator("[data-carousel-viewport]");
  await viewport.scrollIntoViewIfNeeded();
  const box = await viewport.boundingBox();
  const options = { position: { x: box.width * (direction > 0 ? .8 : .2), y: box.height - 28 } };
  if (touch) await viewport.tap(options);
  else await viewport.click(options);
}

async function reviewCenter(page, touch = false) {
  const viewport = page.locator("[data-carousel-viewport]");
  await viewport.scrollIntoViewIfNeeded();
  const box = await viewport.boundingBox();
  const options = { position: { x: box.width / 2, y: box.height - 28 } };
  if (touch) await viewport.tap(options);
  else await viewport.click(options);
}

async function carousel(page) {
  const root = page.locator("[data-reader-stories]");
  const viewport = root.locator("[data-carousel-viewport]");
  assert.equal(await root.locator(".reader-story__rating, .reader-story__score, .reader-story__rating-note").count(), 0, "Unverified review scores must be removed");
  assert(!/5\s*\/\s*5|Demo rating/.test(await root.innerText()));
  assert.equal(await root.locator(".reader-story__stamp, .reader-story__masthead, .reader-story__signature").count(), 0);
  await viewport.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => document.querySelector("[data-reader-stories]").dataset.carouselState === "playing");
  let index = Number(await root.getAttribute("data-selected-index"));
  const automatic = (index + 1) % 3;
  await page.waitForFunction(expected => document.querySelector("[data-reader-stories]").dataset.selectedIndex === String(expected), automatic, { timeout: 11000 });
  await reviewState(page, automatic);
  index = automatic;
  assert.equal(await root.locator(".reader-stories__controls, .reader-stories__arrows, [data-carousel-position], [data-carousel-note]").count(), 0);
  const levelCards = async () => assert(await root.locator("[data-story-card]").evaluateAll(cards => {
    const centers = cards.map(card => {
      const box = card.getBoundingClientRect();
      const matrix = new DOMMatrixReadOnly(getComputedStyle(card).transform);
      return { y: box.y + box.height / 2, upright: Math.abs(matrix.b) < .00001 && Math.abs(matrix.c) < .00001 };
    });
    return centers.every(card => card.upright && Math.abs(card.y - centers[0].y) < .1);
  }), "The review bubbles must remain upright and centered on a level plane");
  await levelCards();
  assert(await viewport.evaluate(node => {
    const front = node.querySelector("[data-story-card][aria-current='true']");
    const current = front.getBoundingClientRect();
    const back = [...node.querySelectorAll("[data-story-card]:not([aria-current])")];
    return back.every(card => Number(getComputedStyle(card).zIndex) < Number(getComputedStyle(front).zIndex)) &&
      back.some(card => {
        const bounds = card.getBoundingClientRect();
        return bounds.left < current.left - 24 && bounds.right > current.left;
      }) && back.some(card => {
        const bounds = card.getBoundingClientRect();
        return bounds.right > current.right + 24 && bounds.left < current.right;
      });
  }), "The actual review notes must form a visible layered fan, not a clipped strip");
  for (let count = 0; count < 3; count++) {
    await reviewSide(page, 1);
    index = (index + 1) % 3;
    await reviewState(page, index);
  }
  await reviewSide(page, -1);
  index = (index + 2) % 3;
  await reviewState(page, index);
  const box = await viewport.boundingBox();
  const draggedCard = root.locator("[data-story-card]").nth(index);
  const beforeDrag = await draggedCard.boundingBox();
  await page.mouse.move(box.x + box.width * .78, box.y + box.height - 28);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .16, box.y + box.height - 28, { steps: 12 });
  await page.waitForTimeout(50);
  const duringDrag = await draggedCard.boundingBox();
  await levelCards();
  assert(Math.abs(duringDrag.x + duringDrag.width / 2 - beforeDrag.x - beforeDrag.width / 2) > box.width * .15, "The actual note must follow held input before release");
  await page.screenshot({ path: path.join(proof, "review-during-drag.png") });
  await page.mouse.up();
  index = (index + 1) % 3;
  await reviewState(page, index);
  for (let count = 0; count < 3; count++) await reviewSide(page, 1);
  await reviewState(page, index);
  const quote = await root.locator("[aria-current='true'] blockquote p").boundingBox();
  await page.mouse.move(quote.x + 8, quote.y + 22);
  await page.mouse.down();
  await page.mouse.move(quote.x + 130, quote.y + 22, { steps: 10 });
  await page.mouse.up();
  assert(await page.evaluate(() => getSelection().toString().length > 0), "Review text should remain selectable");
  await reviewState(page, index);
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => document.querySelector("[data-reader-stories]").dataset.carouselState === "playing");
  const resumed = (index + 1) % 3;
  await page.waitForFunction(expected => document.querySelector("[data-reader-stories]").dataset.selectedIndex === String(expected), resumed, { timeout: 11000 });
  await reviewState(page, resumed);
  index = resumed;
  await reviewCenter(page);
  await page.mouse.move(0, 0);
  assert.equal(await root.getAttribute("data-carousel-state"), "paused");
  await page.waitForTimeout(8300);
  await reviewState(page, index);
  await reviewSide(page, 1);
  index = (index + 1) % 3;
  await reviewState(page, index);
  await page.mouse.move(0, 0);
  assert.equal(await root.getAttribute("data-carousel-state"), "paused", "Browsing must respect an intentional pause");
  await reviewCenter(page);
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => document.querySelector("[data-reader-stories]").dataset.carouselState === "playing");
  await viewport.press("ArrowLeft");
  index = (index + 2) % 3;
  await reviewState(page, index);
  await page.waitForTimeout(8300);
  await reviewState(page, index);
  await page.keyboard.press("Tab");
  assert(await root.locator("[data-carousel-prev]").evaluate(node => document.activeElement === node));
  await page.keyboard.press("Tab");
  const pause = root.locator("[data-carousel-pause]");
  assert(await pause.evaluate(node => document.activeElement === node));
  const pauseBox = await pause.boundingBox();
  assert(pauseBox.width > 40 && pauseBox.height >= 44, "Keyboard controls must become visible when focused");
  const label = await pause.textContent();
  await page.keyboard.press("Enter");
  assert.notEqual(await pause.textContent(), label);
  await page.keyboard.press("Enter");
  assert.equal(await pause.textContent(), label);
  await reviewSide(page, 1);
  index = (index + 1) % 3;
  await reviewState(page, index);
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => document.querySelector("[data-reader-stories]").dataset.carouselState === "playing");
  assert(await root.locator(".reader-stories__key").evaluateAll(buttons => buttons.every(button => {
    const box = button.getBoundingClientRect();
    return box.width <= 1 && box.height <= 1;
  })), "No visible buttons should remain in the pointer presentation");
  assert.equal(await root.locator("[data-story-card][aria-hidden='false']").count(), 1);
  assert.equal(await root.locator("[data-story-card]").count(), 3);
  assert.deepEqual((await root.locator("blockquote").allTextContents()).map(normalize), [
    "So colorful and with amazing tips and information.",
    "Just finished reading READY TO EAT, it is very informative and good!",
    "We love your book",
  ]);
  await page.screenshot({ path: path.join(proof, "review-natural-desktop.png") });
  await page.evaluate(() => window.HappyMangoReaderStories.destroy(document.querySelector("[data-reader-stories]")));
  assert.equal(await root.getAttribute("data-carousel-ready"), null);
  assert(await root.locator("[data-story-card]").evaluateAll(cards => cards.every(card => !card.style.transform && !card.inert && !card.hasAttribute("aria-hidden"))));
  await page.evaluate(() => {
    const root = document.querySelector("[data-reader-stories]");
    window.HappyMangoReaderStories.init(root);
    window.HappyMangoReaderStories.init(root);
  });
  await reviewState(page, 0);
  await reviewSide(page, 1);
  await reviewState(page, 1);
  assert.equal(await root.locator("[data-story-card]").count(), 3);
  return { next: true, previous: true, pause: true, automatic: true, resumeAfterInteraction: true };
}

async function touchAutoplay(page) {
  const root = page.locator("[data-reader-stories]");
  await root.locator("[data-carousel-viewport]").scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector("[data-reader-stories]").dataset.carouselState === "playing");
  const start = Number(await root.getAttribute("data-selected-index"));
  await reviewCenter(page, true);
  assert.equal(await root.getAttribute("data-carousel-state"), "paused");
  await reviewState(page, start);
  await reviewSide(page, 1, true);
  await reviewState(page, (start + 1) % 3);
  assert.equal(await root.getAttribute("data-carousel-state"), "paused");
  await reviewCenter(page, true);
  await page.waitForFunction(() => document.querySelector("[data-reader-stories]").dataset.carouselState === "playing");
  await page.waitForFunction(expected => document.querySelector("[data-reader-stories]").dataset.selectedIndex === String(expected), (start + 2) % 3, { timeout: 11000 });
  await reviewState(page, (start + 2) % 3);
  await reviewSide(page, -1, true);
  await reviewState(page, (start + 1) % 3);
  await page.waitForFunction(() => document.querySelector("[data-reader-stories]").dataset.carouselState === "playing");
}

async function touchCarousel(page, context) {
  const root = page.locator("[data-reader-stories]");
  const viewport = root.locator("[data-carousel-viewport]");
  await viewport.scrollIntoViewIfNeeded();
  await reviewState(page, 0);
  const touch = await context.newCDPSession(page);
  const swipe = async (dx, dy) => {
    const box = await viewport.boundingBox();
    const start = { x: box.x + box.width * .72, y: box.y + box.height * .65 };
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
    for (let step = 1; step <= 8; step++) {
      await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: start.x + dx * step / 8, y: start.y + dy * step / 8 }] });
      await page.waitForTimeout(25);
    }
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  await swipe(-200, 0);
  await reviewState(page, 1);
  await reviewSide(page, -1, true);
  await reviewState(page, 0);
  await reviewSide(page, -1, true);
  await reviewState(page, 2);
  await reviewSide(page, 1, true);
  await reviewState(page, 0);
  const beforeScroll = await page.evaluate(() => scrollY);
  await swipe(0, -140);
  // Chromium can suppress the first emulated tap immediately after a native scroll.
  await page.waitForTimeout(750);
  assert(await page.evaluate(() => scrollY) > beforeScroll, "Vertical swipes must scroll the document");
  await reviewState(page, 0);
  assert.equal(await root.getAttribute("data-carousel-state"), "reduced-motion");
  await reviewSide(page, 1, true);
  await reviewState(page, 1);
  await page.setViewportSize({ width: 860, height: 1000 });
  await reviewState(page, 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await reviewState(page, 1);
  await viewport.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(proof, "review-natural-mobile.png") });
  await page.evaluate(() => document.documentElement.style.fontSize = "200%");
  await reviewState(page, 1);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Enlarged note text must not create document overflow");
  await viewport.press("ArrowRight");
  await reviewState(page, 2);
  await page.screenshot({ path: path.join(proof, "review-large-text.png"), fullPage: true });
  await touch.detach();
}

try {
  browser = await chromium.launch({ headless: true });
  for (const pathname of [".git/config", ".cache/hybrid-control/demo-media.json", "client-materials/", "__demo__/not-allowed.webp"]) {
    assert.equal((await fetch(new URL(pathname, target))).status, 404);
  }
  for (const photo of websitePhotos) {
    const response = await fetch(new URL(`assets/images/${photo}`, target));
    assert.equal(response.status, 200);
    assert.equal(sha(Buffer.from(await response.arrayBuffer())), sha(await fs.readFile(path.join(root, "site", "assets", "images", photo))));
    assert.equal((await fetch(new URL(`__demo__/${photo}`, target))).status, 404, "Public-photo checks must not depend on private overlay routes");
  }

  for (const viewport of specification.viewports) {
    const context = await testContext({ viewport: { width: viewport[0], height: viewport[1] }, reducedMotion: "reduce", deviceScaleFactor: 1 });
    for (const route of ["/", "/about/", "/contact/"]) {
      const page = await context.newPage();
      watch(page);
      await page.goto(origin + base.replace(/\/$/, "") + route);
      await settled(page);
      await layout(page);
      const actual = await pageUnits(page, route);
      if (route === "/about/") {
        assert(await page.locator(".about-life img").isVisible(), "About should use the existing life photo");
        assert.equal(await page.locator(".about-life img").getAttribute("alt"), "A baby smiling at the table during a meal.");
        assert.equal(await page.locator(".about-portrait img").count(), 0, "A child photo must not stand in for the missing author portrait");
        assert.match(await page.locator(".about-portrait figcaption").innerText(), /Final photograph pending/);
      }
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

  for (const width of [1920, 2560]) {
    const wide = await testContext({ viewport: { width, height: 1080 }, reducedMotion: "reduce" });
    const widePage = await wide.newPage();
    watch(widePage);
    for (const route of ["", "about/", "contact/"]) {
      await widePage.goto(new URL(route, target).href);
      await settled(widePage);
      await layout(widePage);
      assert(await widePage.locator(".site-header, .site-footer").evaluateAll(nodes => nodes.every(node => {
        const box = node.getBoundingClientRect();
        return box.left >= 16 && box.left <= 50 && innerWidth - box.right >= 16 && innerWidth - box.right <= 50;
      })), "Wide layouts must use the viewport with small, retained side gutters");
      await widePage.screenshot({ path: path.join(proof, `wide-${route ? route.split("/")[0] : "home"}-${width}.png`), fullPage: true });
      if (route === "about/") {
        await widePage.evaluate(() => document.documentElement.style.fontSize = "200%");
        await layout(widePage);
      }
      report.cases.push({ case: "fluid-wide-layout", route: route || "/", width, status: "passed" });
    }
    await wide.close();
  }

  const desktop = await testContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  const page = await desktop.newPage();
  watch(page);
  await page.goto(target);
  await settled(page);
  assert.equal(await page.locator("[data-hero-book]").count(), 1);
  assert.equal(await page.locator("#inside [data-hero-book]").count(), 1, "The one interactive book belongs in What's inside");
  assert.equal(await page.locator(".home-opening [data-hero-book], .hero-static-cover button").count(), 0, "The introductory cover is not a second reader");
  assert.equal(await page.locator(".hero-static-cover img").count(), 1);
  assert.match(await page.locator(".hero-positioning").innerText(), /Part storybook\.[\s\S]*Part first-foods guide\./);
  assert.match(await page.locator(".hero-introduction").innerText(), /fictional story grounded in facts[\s\S]*reading together/);
  await page.getByRole("link", { name: "Peek inside", exact: true }).click();
  await page.waitForURL(target + "#inside");
  assert.equal(await page.locator("[data-reader-page]").count(), 4);
  assert.equal(await page.locator("[data-ideas-page]").count(), 1);
  assert.equal(await page.locator("[data-book-toggle]").count(), 0);
  assert(await page.locator("[data-book-close]").isHidden());
  assert.equal((await page.locator("[data-book-open]").textContent()).trim(), "");
  const invitation = page.getByRole("button", { name: "Open me: Ready to Eat book preview", exact: true });
  assert(await invitation.isVisible());
  await invitation.click();
  await bookState(page, "open", 0);
  assert(await invitation.isHidden(), "The sticker should disappear while the book is in use");
  assert.equal(await page.locator(".hb-plate").evaluate(node => node.getAnimations().length), 0, "Reduced motion should not animate the plate");
  assert(await page.locator("[data-reader-panel]").evaluate(node => document.activeElement === node));
  await layout(page);
  await cornerNotes(page);
  assert.equal(normalize(await page.locator(".hb-pages .hb-corner-story").textContent()), "A story for them.");
  assert.deepEqual((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations.map(item => item.id), []);
  await turnOnPage(page, -1);
  await bookState(page, "closed", 0);
  assert(await page.locator("[data-book-open]").evaluate(node => document.activeElement === node));
  assert(await invitation.isVisible());
  await invitation.focus();
  await page.keyboard.press("Space");
  await bookState(page, "open", 0);
  assert(await invitation.isHidden());
  await turnOnPage(page, 1);
  await bookState(page, "open", 2);
  await layout(page);
  const ideas = await page.locator('[data-reader-page="2"]').boundingBox();
  const photo = await page.locator('[data-reader-page="3"]').boundingBox();
  assert(ideas && photo && ideas.x < photo.x, "Ideas must face the reader photo from the left");
  assert.equal(await page.locator('[data-reader-page="3"] [data-reader-photo]').count(), 2);
  assert(await page.locator('[data-reader-page="3"] [data-reader-photo]').first().isVisible());
  assert.equal(await page.locator('[data-reader-page="3"] .photo-placeholder, [data-local-demo-image]').count(), 0);
  await page.screenshot({ path: path.join(proof, "desktop-ideas-photo.png"), fullPage: true });
  await turnOnPage(page, 1);
  await bookState(page, "closed", 2);
  assert(await page.locator("[data-book-open]").evaluate(node => document.activeElement === node));
  await page.keyboard.press("Enter");
  await bookState(page, "open", 0);
  const statusBox = await page.locator("[data-book-status]").boundingBox();
  assert(statusBox.width <= 1 && statusBox.height <= 1, "Page status should not occupy visible space");
  assert.equal(await page.locator("[data-book-status]").getAttribute("aria-live"), "polite");
  await page.keyboard.press("ArrowRight");
  await bookState(page, "open", 2);
  await page.keyboard.press("Tab");
  assert(await page.locator("[data-book-prev]").evaluate(node => document.activeElement === node));
  const keyboardControl = await page.locator("[data-book-prev]").boundingBox();
  assert(keyboardControl.width > 40 && keyboardControl.height >= 44, "Keyboard focus must reveal its control");
  await page.keyboard.press("Enter");
  await bookState(page, "open", 0);
  await page.keyboard.press("Escape");
  await bookState(page, "closed");
  await page.keyboard.press("Space");
  await bookState(page, "open", 0);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  assert(await page.locator("[data-book-close]").evaluate(node => document.activeElement === node));
  await page.keyboard.press("Enter");
  await bookState(page, "closed");
  await page.keyboard.press("Enter");
  await bookState(page, "open", 0);
  const selectedPage = page.locator('[data-reader-page="1"]');
  await selectedPage.evaluate(node => {
    const range = document.createRange();
    range.selectNodeContents(node.querySelector(".hb-corner-note"));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    node.click();
  });
  await bookState(page, "open", 0);
  await page.evaluate(() => getSelection().removeAllRanges());
  const drag = await selectedPage.boundingBox();
  await page.mouse.move(drag.x + 80, drag.y + 120);
  await page.mouse.down();
  await page.mouse.move(drag.x + 80, drag.y + 175, { steps: 8 });
  await page.mouse.up();
  await bookState(page, "open", 0);
  await page.locator(".preview-caption").click();
  await bookState(page, "closed", 0);
  await page.locator("[data-book-open]").click();
  await bookState(page, "open", 0);
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
  await page.locator("[data-inquiry-form]").evaluate(form => form.requestSubmit());
  assert.equal(await page.locator("[data-inquiry-form]").getAttribute("data-inquiry-state"), "error");
  assert.equal(formMock.requests.length, 0, "Invalid inquiries must not contact the provider");
  await page.locator('[name="_honey"]').evaluate(node => { node.value = "fixture bot"; });
  await page.locator("[data-inquiry-form]").evaluate(form => form.requestSubmit());
  assert.equal(formMock.requests.length, 0, "The honeypot must block delivery");
  await page.locator('[name="_honey"]').evaluate(node => { node.value = ""; });
  await page.getByRole("textbox", { name: "Your name", exact: true }).fill("Sample Reader");
  await page.getByRole("textbox", { name: "Your email", exact: true }).fill("reader@example.invalid");
  await page.getByRole("textbox", { name: "Your message", exact: true }).fill("A local-only fixture inquiry.");
  assert.equal(await page.locator("[data-inquiry-form]").getAttribute("action"), nativeFormEndpoint);
  formMock.mode = "hold";
  const requestStarted = new Promise(resolve => { formMock.ready = resolve; });
  await page.locator("[data-inquiry-form]").evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
  await requestStarted;
  assert.equal(formMock.requests.length, 1, "Duplicate submit must not dispatch another inquiry");
  assert(await page.locator("[data-send-inquiry]").isDisabled());
  assert(await page.getByRole("textbox", { name: "Your message", exact: true }).evaluate(node => node.readOnly));
  assert.equal(formMock.requests[0].url, formEndpoint);
  assert.equal(formMock.requests[0].payload._subject, "Happy Mango Books - General inquiry");
  assert.equal(formMock.requests[0].payload._template, "table");
  assert(!("organization" in formMock.requests[0].payload));
  assert(!("_captcha" in formMock.requests[0].payload), "Provider CAPTCHA defaults must not be disabled");
  formMock.release();
  await page.waitForFunction(() => document.querySelector("[data-inquiry-form]").dataset.inquiryState === "accepted");
  assert(/accepted/i.test(await page.locator("[data-form-status]").innerText()));
  await page.locator("[data-inquiry-form]").evaluate(form => form.requestSubmit());
  assert.equal(formMock.requests.length, 1);
  assert.equal(await page.getByRole("textbox", { name: "Your message", exact: true }).inputValue(), "A local-only fixture inquiry.");
  await page.locator("#inquiry-type").selectOption("bulk");
  await page.locator("#inquiry-organization").fill("Sample reading group");
  await page.locator("#inquiry-copies").fill("24");
  formMock.mode = "success";
  await page.locator("[data-send-inquiry]").click();
  await page.waitForFunction(() => document.querySelector("[data-inquiry-form]").dataset.inquiryState === "accepted");
  assert.equal(formMock.requests.length, 2);
  assert.equal(formMock.requests[1].payload._subject, "Happy Mango Books - Bulk order inquiry");
  assert.equal(formMock.requests[1].payload.organization, "Sample reading group");
  assert.equal(formMock.requests[1].payload.estimated_copies, "24");
  await page.getByRole("textbox", { name: "Your message", exact: true }).fill("A rejected fixture inquiry.");
  formMock.mode = "reject";
  await page.locator("[data-send-inquiry]").click();
  await page.waitForFunction(() => document.querySelector("[data-inquiry-form]").dataset.inquiryState === "error");
  assert(await page.locator("[data-send-inquiry]").isEnabled());
  formMock.mode = "abort";
  await page.locator("[data-send-inquiry]").click();
  await page.waitForFunction(() => document.querySelector("[data-inquiry-form]").dataset.inquiryState === "uncertain");
  assert(await page.locator("[data-send-inquiry]").isDisabled());
  assert.equal(await page.getByRole("textbox", { name: "Your message", exact: true }).inputValue(), "A rejected fixture inquiry.");
  await page.locator("[data-inquiry-form]").evaluate(form => form.requestSubmit());
  assert.equal(formMock.requests.length, 4, "An uncertain send must not be replayed");
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  formMock.mode = "forbidden";
  observation.interactions.push({ id: "bulk-inquiry", actual: { bulk: true, general: true, mockedDelivery: true, duplicateGuard: true, uncertainNotRetried: true, realEmailSent: false } });
  await desktop.close();

  const storiesContext = await testContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "no-preference" });
  const storiesPage = await storiesContext.newPage();
  watch(storiesPage);
  await storiesPage.goto(target);
  await settled(storiesPage);
  await storiesPage.locator("[data-hero-book]").scrollIntoViewIfNeeded();
  await storiesPage.waitForFunction(() => document.querySelector("[data-hero-book]").dataset.motion === "running");
  const cue = storiesPage.locator(".hb-cover-cue");
  const firstCue = await cue.evaluate(node => getComputedStyle(node).transform);
  await storiesPage.waitForTimeout(1300);
  assert.notEqual(await cue.evaluate(node => getComputedStyle(node).transform), firstCue, "The cover opening cue is static");
  const coverBox = await storiesPage.locator("[data-book-open]").boundingBox();
  const closedPlateWidth = await storiesPage.locator(".hb-plate").evaluate(node => parseFloat(getComputedStyle(node).width));
  await storiesPage.mouse.click(coverBox.x + coverBox.width / 2, coverBox.y + coverBox.height / 2);
  await plateOpeningMotion(storiesPage, closedPlateWidth);
  await bookState(storiesPage, "open", 0);
  assert.equal(await storiesPage.locator(".hb-plate").evaluate(node => node.getAnimations().length), 0, "The plate flourish must finish with the opening hinge");
  await turnOnPage(storiesPage, 1);
  await storiesPage.waitForFunction(() => {
    const leaf = document.querySelector("[data-page-turn]");
    return !leaf.hidden && getComputedStyle(leaf).transform.startsWith("matrix3d(");
  });
  assert.equal(await storiesPage.locator(".hb-plate").evaluate(node => node.getAnimations().length), 0, "Ordinary page turns must not replay the plate flourish");
  await storiesPage.waitForTimeout(400);
  await storiesPage.screenshot({ path: path.join(proof, "direct-page-turn.png") });
  await turnOnPage(storiesPage, -1);
  await bookState(storiesPage, "open", 0);
  await turnOnPage(storiesPage, 1);
  await bookState(storiesPage, "open", 2);
  await closeOnPlate(storiesPage);
  await bookState(storiesPage, "closed");
  assert(await storiesPage.locator("[data-book-open]").evaluate(node => document.activeElement === node));
  await storiesPage.keyboard.press("Enter");
  await storiesPage.waitForFunction(() => document.querySelector("[data-hero-book]").dataset.state === "opening");
  await storiesPage.locator("[data-reader-panel]").press("ArrowRight");
  await bookState(storiesPage, "open", 0);
  await turnOnPage(storiesPage, 1);
  await bookState(storiesPage, "open", 2);
  await turnOnPage(storiesPage, -1);
  await storiesPage.waitForFunction(() => !document.querySelector("[data-page-turn]").hidden);
  await storiesPage.waitForTimeout(150);
  await storiesPage.locator(".preview-caption").click();
  await storiesPage.locator(".hb-cover-back > .hb-copy").waitFor({ state: "attached" });
  assert.equal(await storiesPage.locator(".hb-cover-back > .hb-ideas").count(), 1, "Closing during a turn must use the last readable spread");
  await bookState(storiesPage, "closed");
  assert.equal(await storiesPage.locator("[data-hero-book]").getAttribute("data-page"), "2");
  await storiesPage.locator("[data-book-open]").focus();
  await storiesPage.keyboard.press("Enter");
  await storiesPage.locator(".hb-cover-back > .hb-sample-left").waitFor({ state: "attached" });
  await storiesPage.locator(".preview-caption").click();
  await bookState(storiesPage, "closed");
  assert.equal(await storiesPage.locator(".hb-copy").count(), 0, "Outside dismissal during opening must clear transitional copies");
  assert.equal(await storiesPage.locator(".hb-plate").evaluate(node => node.getAnimations().length), 0, "Interrupted opening must not leave the plate animation running");
  assert(Math.abs(await storiesPage.locator(".hb-plate").evaluate(node => parseFloat(getComputedStyle(node).width)) - closedPlateWidth) < 1);
  report.cases.push({ case: "cover-invitation-and-direct-turn-reversal", status: "passed" });
  observation.interactions.push({ id: "reader-carousel", actual: await carousel(storiesPage) });
  await storiesPage.locator("[data-book-open]").focus();
  await storiesPage.keyboard.press("Enter");
  await bookState(storiesPage, "open", 0);
  const reviewIndex = Number(await storiesPage.locator("[data-reader-stories]").getAttribute("data-selected-index"));
  await reviewSide(storiesPage, 1);
  await reviewState(storiesPage, (reviewIndex + 1) % 3);
  await bookState(storiesPage, "closed", 0);
  assert(await storiesPage.locator("[data-carousel-viewport]").evaluate(node => document.activeElement === node), "Closing the book must not steal focus from an outside control");
  report.cases.push({ case: "first-page-reopen-and-document-click-away", status: "passed" });
  await storiesContext.close();

  const touchStories = await testContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce", hasTouch: true });
  const touchStoriesPage = await touchStories.newPage();
  watch(touchStoriesPage);
  await touchStoriesPage.goto(target);
  await settled(touchStoriesPage);
  await touchCarousel(touchStoriesPage, touchStories);
  await touchStories.close();

  const autoTouch = await testContext({ viewport: { width: 390, height: 844 }, reducedMotion: "no-preference", hasTouch: true });
  const autoTouchPage = await autoTouch.newPage();
  watch(autoTouchPage);
  await autoTouchPage.goto(target);
  await settled(autoTouchPage);
  await touchAutoplay(autoTouchPage);
  report.cases.push({ case: "touch-center-pause-resume-and-automatic-reviews", status: "passed" });
  await autoTouch.close();

  const mobile = await testContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce", hasTouch: true });
  const phone = await mobile.newPage();
  watch(phone);
  await phone.goto(target);
  await settled(phone);
  await phone.getByRole("link", { name: "Peek inside", exact: true }).tap();
  await phone.waitForURL(target + "#inside");
  await phone.locator("[data-book-invitation]").tap();
  await bookState(phone, "open", 0);
  assert(await phone.locator("[data-book-invitation]").isHidden());
  assert.equal(await phone.locator("[data-hero-book]").getAttribute("data-layout"), "single");
  await cornerNotes(phone);
  await turnOnPage(phone, -1, true);
  await bookState(phone, "closed", 0);
  await phone.locator("[data-book-open]").tap();
  await bookState(phone, "open", 0);
  const touch = await mobile.newCDPSession(phone);
  const touchBox = await phone.locator('[data-reader-page="0"]').boundingBox();
  const scrollBefore = await phone.evaluate(() => scrollY);
  const touchStart = { x: touchBox.x + touchBox.width * .75, y: touchBox.y + touchBox.height * .7 };
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touchStart] });
  for (let step = 1; step <= 6; step++) {
    await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: touchStart.x, y: touchStart.y - step * 20 }] });
    await phone.waitForTimeout(25);
  }
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await phone.waitForTimeout(250);
  assert(await phone.evaluate(() => scrollY) > scrollBefore, "Touch dragging should scroll the page");
  await bookState(phone, "open", 0);
  await touch.detach();
  const order = [0];
  for (const index of [1, 2, 3]) {
    await turnOnPage(phone, 1, true);
    await bookState(phone, "open", index);
    await layout(phone);
    await cornerNotes(phone);
    order.push(Number(await phone.locator("[data-hero-book]").getAttribute("data-page")));
    assert((await phone.locator("[data-reader-panel]").boundingBox()).y >= -1, "The newly selected page is above the readable viewport");
  }
  await turnOnPage(phone, 1, true);
  await bookState(phone, "closed", 3);
  await phone.locator("[data-book-open]").tap();
  await bookState(phone, "open", 0);
  await phone.locator(".preview-caption").tap();
  await bookState(phone, "closed", 0);
  await phone.locator("[data-book-open]").tap();
  await bookState(phone, "open", 0);
  for (const index of [1, 2, 3]) {
    await turnOnPage(phone, 1, true);
    await bookState(phone, "open", index);
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
  for (const index of [2, 1, 0]) {
    await phone.locator("[data-reader-panel]").press("ArrowLeft");
    await bookState(phone, "open", index);
    await layout(phone);
    await cornerNotes(phone);
  }
  await phone.screenshot({ path: path.join(proof, "large-text-sample-note.png"), fullPage: true });
  await mobile.close();

  const alignment = [];
  for (const width of [1440, 390]) {
    const context = await testContext({ viewport: { width, height: width === 1440 ? 1000 : 844 }, reducedMotion: "no-preference" });
    const alignmentPage = await context.newPage();
    watch(alignmentPage);
    await alignmentPage.goto(target);
    await settled(alignmentPage);
    await alignmentPage.locator("[data-hero-book]").scrollIntoViewIfNeeded();
    const cover = await alignmentPage.locator("[data-book-open]").boundingBox();
    await alignmentPage.mouse.click(cover.x + cover.width / 2, cover.y + cover.height / 2);
    await bookState(alignmentPage, "open", 0);
    alignment.push(...await bookImageAlignment(alignmentPage));
    await alignmentPage.locator("[data-reader-panel]").press("ArrowLeft");
    await bookState(alignmentPage, "closed", 0);
    assert(await alignmentPage.locator("[data-book-open]").evaluate(node => document.activeElement === node));
    await context.close();
  }
  await fs.writeFile(path.join(proof, "book-image-alignment.json"), JSON.stringify(alignment, null, 2) + "\n");
  report.cases.push({ case: "aligned-animated-page-handoffs-and-stable-book-height", status: "passed" });

  const narrow = await testContext({ viewport: { width: 320, height: 760 }, reducedMotion: "reduce" });
  const narrowPage = await narrow.newPage();
  watch(narrowPage);
  for (const route of ["", "about/", "contact/"]) {
    await narrowPage.goto(new URL(route, target).href);
    await settled(narrowPage);
    await layout(narrowPage);
    if (!route) {
      await narrowPage.locator("[data-book-open]").click();
      await bookState(narrowPage, "open", 0);
      await cornerNotes(narrowPage);
      await turnOnPage(narrowPage, 1);
      await bookState(narrowPage, "open", 1);
      await cornerNotes(narrowPage);
      await turnOnPage(narrowPage, 1);
      await bookState(narrowPage, "open", 2);
      await narrowPage.evaluate(() => document.documentElement.style.fontSize = "200%");
      await layout(narrowPage);
    }
  }
  await narrow.close();

  const noJs = await testContext({ viewport: { width: 390, height: 844 }, javaScriptEnabled: false });
  const noPage = await noJs.newPage();
  watch(noPage);
  await noPage.goto(target);
  await settled(noPage);
  await layout(noPage);
  assert(await noPage.locator('[data-reader-page="0"]').isVisible());
  assert(await noPage.locator('[data-reader-page="2"]').isVisible());
  assert(await noPage.locator("[data-book-open]").isHidden());
  assert(await noPage.locator("[data-book-invitation]").isHidden(), "A nonfunctional invitation must not appear without JavaScript");
  assert.equal(await noPage.locator("[data-carousel-ready]").count(), 0);
  assert.equal(await noPage.locator("[data-story-card]:visible").count(), 3);
  await cornerNotes(noPage);
  await noPage.goto(new URL("contact/", target).href);
  await noPage.getByRole("textbox", { name: "Your name", exact: true }).fill("Sample Reader");
  await noPage.getByRole("textbox", { name: "Your name", exact: true }).press("Enter");
  assert(await noPage.locator("[data-send-inquiry]").isEnabled());
  assert.equal(formMock.requests.length, 4, "Native required-field validation must prevent empty submissions");
  await noPage.getByRole("textbox", { name: "Your email", exact: true }).fill("reader@example.invalid");
  await noPage.getByRole("textbox", { name: "Your message", exact: true }).fill("A native fallback fixture.");
  formMock.mode = "native";
  await noPage.locator("[data-send-inquiry]").click();
  await noPage.waitForURL(nativeFormEndpoint);
  assert.equal(formMock.requests.length, 5);
  assert.equal(formMock.requests[4].url, nativeFormEndpoint);
  assert.equal(formMock.requests[4].payload.message, "A native fallback fixture.");
  formMock.mode = "forbidden";
  await noJs.close();

  const missingCarousel = await testContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  await missingCarousel.route("**/assets/js/vendor/embla-carousel-8.6.0.umd.js", route => route.abort());
  const fallbackReviews = await missingCarousel.newPage();
  await fallbackReviews.goto(target);
  await settled(fallbackReviews);
  assert.equal(await fallbackReviews.locator("[data-carousel-ready]").count(), 0);
  assert.equal(await fallbackReviews.locator("[data-story-card]:visible").count(), 3);
  await missingCarousel.close();

  const failedImages = await testContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  await failedImages.route("**/assets/images/sample-left*.webp", route => route.abort());
  const errorPage = await failedImages.newPage();
  await errorPage.goto(target);
  await errorPage.locator("[data-book-open]").click();
  await bookState(errorPage, "error");
  const errorBox = await errorPage.locator("[data-book-status]").boundingBox();
  assert(errorBox.width > 1 && errorBox.height > 1, "Actual image-load errors must remain readable");
  assert(await errorPage.locator("[data-book-retry]").isVisible());
  assert(await errorPage.locator("[data-book-open]").isEnabled());
  await failedImages.unroute("**/assets/images/sample-left*.webp");
  await errorPage.locator("[data-book-retry]").click();
  await bookState(errorPage, "open", 0);
  assert(await errorPage.locator("[data-reader-panel]").evaluate(node => document.activeElement === node));
  assert(await errorPage.locator("[data-book-retry]").isHidden());
  await failedImages.close();

  const failedFuture = await testContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  await failedFuture.route("**/assets/images/reader-cover.webp", route => route.abort());
  const futurePage = await failedFuture.newPage();
  await futurePage.goto(target);
  await futurePage.locator("[data-book-open]").click();
  await bookState(futurePage, "open", 0);
  await turnOnPage(futurePage, 1);
  await bookState(futurePage, "error", 0);
  assert(await futurePage.locator('[data-reader-page="0"]').isVisible(), "A failed later image must not remove the last readable spread");
  await failedFuture.unroute("**/assets/images/reader-cover.webp");
  await futurePage.locator("[data-book-retry]").click();
  await bookState(futurePage, "open", 2);
  await failedFuture.close();
  const requests = actualRequests();
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
  report.requests = actualRequests();
  report.mockedFormRequests = formMock.requests;
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(proof, "checks.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ status: report.status, cases: report.cases.length, failure: report.failure, proof }, null, 2));
}
