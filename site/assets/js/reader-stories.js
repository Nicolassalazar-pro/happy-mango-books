(() => {
  if (window.HappyMangoReaderStories) {
    window.HappyMangoReaderStories.init();
    return;
  }

  const instances = new Map();
  const interval = 8000;

  function create(root) {
    const track = root.querySelector("[data-carousel-track]");
    const cards = Array.from(root.querySelectorAll("[data-story-card]"));
    const controls = root.querySelector("[data-carousel-controls]");
    const previous = root.querySelector("[data-carousel-prev]");
    const next = root.querySelector("[data-carousel-next]");
    const pause = root.querySelector("[data-carousel-pause]");
    const position = root.querySelector("[data-carousel-position]");
    const note = root.querySelector("[data-carousel-note]");
    const announcement = root.querySelector("[data-carousel-announcement]");
    if (!track || cards.length < 2 || !controls || !previous || !next || !pause || !position || !note || !announcement) return null;

    const events = new AbortController();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let index = 0;
    let timer = null;
    let paused = root.contains(document.activeElement);
    let hovered = false;
    let visible = false;
    let destroyed = false;
    let pointerPauseIntent = null;
    const listen = (target, name, handler) => target.addEventListener(name, handler, { signal: events.signal });

    function show(requested, manual = false) {
      index = (requested + cards.length) % cards.length;
      root.dataset.selectedIndex = String(index);
      cards.forEach((card, item) => {
        const current = item === index;
        card.setAttribute("aria-hidden", String(!current));
        card.inert = !current;
        if (current) card.setAttribute("aria-current", "true");
        else card.removeAttribute("aria-current");
      });
      position.textContent = `${index + 1} / ${cards.length}`;
      if (manual) {
        const name = cards[index].querySelector(".reader-story__author strong")?.textContent || "";
        announcement.textContent = `Story ${index + 1} of ${cards.length}${name ? `, ${name}` : ""}.`;
      } else announcement.textContent = "";
    }

    function schedule() {
      window.clearTimeout(timer);
      timer = null;
      if (destroyed) return;
      if (!root.isConnected) {
        destroy();
        instances.delete(root);
        return;
      }
      const state = reduced.matches ? "reduced-motion" : document.hidden ? "hidden" :
        paused ? "paused" : !visible ? "offscreen" : hovered ? "hover-paused" : "playing";
      root.dataset.carouselState = state;
      pause.disabled = reduced.matches;
      pause.textContent = reduced.matches ? "Auto-play off" : paused ? "Resume" : "Pause";
      pause.setAttribute("aria-label", reduced.matches ? "Auto-play off for reduced motion" :
        `${paused ? "Resume" : "Pause"} automatic reader stories`);
      note.textContent = reduced.matches ? "Automatic advance is off for reduced motion. Browse at your own pace." :
        paused ? "Automatic advance paused. Browse at your own pace." :
        hovered ? "Paused while your pointer is here. Browse at your own pace." :
        "A new story every 8 seconds. Pause or browse at your own pace.";
      if (state === "playing") {
        timer = window.setTimeout(() => {
          timer = null;
          if (!destroyed && !paused && !hovered && visible && !reduced.matches && !document.hidden && root.isConnected) show(index + 1);
          schedule();
        }, interval);
      }
    }

    function manualStep(direction) {
      paused = true;
      show(index + direction, true);
      schedule();
    }

    const observer = "IntersectionObserver" in window ? new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting && entry.intersectionRatio >= .5);
      schedule();
    }, { threshold: [0, .5] }) : null;

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      window.clearTimeout(timer);
      timer = null;
      events.abort();
      observer?.disconnect();
      controls.hidden = true;
      note.hidden = true;
      announcement.textContent = "";
      track.removeAttribute("role");
      root.removeAttribute("aria-roledescription");
      delete root.dataset.carouselReady;
      delete root.dataset.selectedIndex;
      delete root.dataset.carouselState;
      cards.forEach(card => {
        card.inert = false;
        for (const attribute of ["aria-hidden", "aria-current", "aria-roledescription", "aria-label", "role"]) card.removeAttribute(attribute);
      });
    }

    root.dataset.carouselReady = "true";
    root.setAttribute("aria-roledescription", "carousel");
    track.setAttribute("role", "presentation");
    cards.forEach((card, item) => {
      card.setAttribute("role", "group");
      card.setAttribute("aria-roledescription", "slide");
      card.setAttribute("aria-label", `${item + 1} of ${cards.length}`);
    });
    controls.hidden = false;
    note.hidden = false;
    show(0);
    listen(previous, "click", () => manualStep(-1));
    listen(next, "click", () => manualStep(1));
    listen(root, "focusin", () => {
      paused = true;
      schedule();
    });
    listen(root, "pointerenter", event => {
      if (event.pointerType === "touch") return;
      hovered = true;
      schedule();
    });
    listen(root, "pointerleave", () => {
      hovered = false;
      schedule();
    });
    listen(root, "pointerdown", event => {
      if (event.target.closest("[data-carousel-pause]")) return;
      paused = true;
      schedule();
    });
    // Preserve the release action when pointer focus pauses before the click.
    listen(pause, "pointerdown", () => { pointerPauseIntent = !paused; });
    listen(pause, "pointercancel", () => { pointerPauseIntent = null; });
    listen(pause, "click", event => {
      paused = event.detail > 0 && pointerPauseIntent !== null ? pointerPauseIntent : !paused;
      pointerPauseIntent = null;
      if (!paused) hovered = false;
      schedule();
    });
    listen(document, "visibilitychange", schedule);
    listen(reduced, "change", schedule);
    observer?.observe(track);
    schedule();
    return { destroy };
  }

  function init(scope = document) {
    const roots = Array.from(scope.querySelectorAll("[data-reader-stories]"));
    if (scope.matches?.("[data-reader-stories]")) roots.unshift(scope);
    for (const root of roots) {
      if (instances.has(root)) continue;
      const instance = create(root);
      if (instance) instances.set(root, instance);
    }
  }

  function destroy(scope = document) {
    for (const [root, instance] of instances) {
      if (scope !== document && scope !== root && !scope.contains(root)) continue;
      instance.destroy();
      instances.delete(root);
    }
  }

  window.HappyMangoReaderStories = { init, destroy };
  window.addEventListener("pagehide", () => destroy());
  window.addEventListener("pageshow", () => init());
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => init(), { once: true });
  else init();
})();
