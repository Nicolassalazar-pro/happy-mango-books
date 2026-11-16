(() => {
  if (window.HappyMangoReaderStories) {
    window.HappyMangoReaderStories.init();
    return;
  }

  const instances = new Map();
  const interval = 8000;

  function create(root) {
    const viewport = root.querySelector("[data-carousel-viewport]");
    const track = root.querySelector("[data-carousel-track]");
    const cards = Array.from(root.querySelectorAll("[data-story-card]"));
    const controls = root.querySelector("[data-carousel-controls]");
    const previous = root.querySelector("[data-carousel-prev]");
    const next = root.querySelector("[data-carousel-next]");
    const pause = root.querySelector("[data-carousel-pause]");
    const announcement = root.querySelector("[data-carousel-announcement]");
    if (!viewport || !track || cards.length < 2 || !controls || !previous || !next || !pause || !announcement ||
        typeof window.EmblaCarousel !== "function" || !window.ResizeObserver || !window.IntersectionObserver) return null;

    const events = new AbortController();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let index = 0;
    let timer = null;
    let paused = root.contains(document.activeElement);
    let hovered = false;
    let visible = false;
    let destroyed = false;
    let pointerPauseIntent = null;
    let manualSelection = false;
    let tapGesture = null;
    let deck = null;
    const listen = (target, name, handler) => target.addEventListener(name, handler, { signal: events.signal });
    root.dataset.carouselReady = "true";
    const carousel = window.EmblaCarousel(viewport, {
      loop: true,
      align: "center",
      duration: reduced.matches ? 0 : 25,
      watchDrag: (_api, event) => !(event.type === "mousedown" && event.target.closest?.("blockquote, .reader-story__author")),
    });

    function renderDeck() {
      if (destroyed || !deck) return;
      const engine = carousel.internalEngine();
      const distance = ((engine.scrollSnaps[0] - engine.offsetLocation.get()) % deck.cycle + deck.cycle) % deck.cycle;
      let segment = deck.stops.findLastIndex(stop => stop <= distance);
      segment = Math.max(0, segment);
      const end = deck.stops[segment + 1] ?? deck.cycle;
      const phase = segment + (distance - deck.stops[segment]) / (end - deck.stops[segment]);
      cards.forEach((card, item) => {
        const angle = (item - phase) * Math.PI * 2 / cards.length;
        const front = Math.cos(angle);
        const side = Math.sin(angle);
        const scale = .92 + .08 * front;
        const lift = Math.max(0, front + .5);
        const x = side * (deck.spread + deck.travel * lift * lift) - deck.origins[item];
        card.style.transform = `translate3d(${x}px, 0, 0) scale(${scale})`;
        card.style.zIndex = String(100 + Math.round(front * 50));
      });
    }

    function measureDeck() {
      if (destroyed) return;
      const engine = carousel.internalEngine();
      // Embla owns input and loop physics; this renderer owns the real card transforms.
      engine.translate.clear();
      engine.translate.toggleActive(false);
      engine.slideLooper.loopPoints.forEach(point => {
        point.translate.clear();
        point.translate.toggleActive(false);
      });
      const width = cards[0].offsetWidth;
      const sceneWidth = root.querySelector(".reader-stories__window").clientWidth;
      const sideHalf = .92 * width / 2;
      const spread = Math.max(20, Math.min(width * .55, (sceneWidth / 2 - sideHalf - 9) / Math.sin(Math.PI * 2 / 3)));
      deck = {
        spread, travel: width * (sceneWidth < 560 ? .34 : .06), origins: cards.map(card => card.offsetLeft),
        stops: engine.scrollSnaps.map(snap => engine.scrollSnaps[0] - snap), cycle: engine.limit.length,
      };
      renderDeck();
    }

    function show(requested, manual = false) {
      if (destroyed) return;
      index = (requested + cards.length) % cards.length;
      root.dataset.selectedIndex = String(index);
      cards.forEach((card, item) => {
        const current = item === index;
        card.setAttribute("aria-hidden", String(!current));
        card.inert = false;
        if (current) card.setAttribute("aria-current", "true");
        else card.removeAttribute("aria-current");
      });
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
      if (state === "playing") {
        timer = window.setTimeout(() => {
          timer = null;
          if (!destroyed && !paused && !hovered && visible && !reduced.matches && !document.hidden && root.isConnected) {
            manualSelection = false;
            carousel.scrollNext();
          }
          schedule();
        }, interval);
      }
    }

    function manualStep(direction, from = carousel.selectedScrollSnap()) {
      paused = true;
      if (from !== carousel.selectedScrollSnap()) carousel.scrollTo(from, reduced.matches);
      manualSelection = true;
      if (direction > 0) {
        if (carousel.canScrollNext()) carousel.scrollNext(reduced.matches);
        else carousel.scrollTo(0, reduced.matches);
      } else if (carousel.canScrollPrev()) carousel.scrollPrev(reduced.matches);
      else carousel.scrollTo(cards.length - 1, reduced.matches);
      schedule();
    }

    const observer = "IntersectionObserver" in window ? new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting && entry.intersectionRatio >= .5);
      schedule();
    }, { threshold: [0, .5] }) : null;
    const sceneObserver = new ResizeObserver(measureDeck);

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      window.clearTimeout(timer);
      timer = null;
      events.abort();
      observer?.disconnect();
      sceneObserver.disconnect();
      carousel.destroy();
      cards.forEach(card => {
        card.style.removeProperty("transform");
        card.style.removeProperty("z-index");
      });
      controls.hidden = true;
      announcement.textContent = "";
      viewport.tabIndex = -1;
      viewport.removeAttribute("aria-keyshortcuts");
      track.removeAttribute("role");
      root.removeAttribute("aria-roledescription");
      delete root.dataset.carouselReady;
      delete root.dataset.selectedIndex;
      delete root.dataset.carouselState;
      delete root.dataset.carouselDragging;
      cards.forEach(card => {
        card.inert = false;
        for (const attribute of ["aria-hidden", "aria-current", "aria-roledescription", "aria-label", "role"]) card.removeAttribute(attribute);
      });
    }

    root.setAttribute("aria-roledescription", "carousel");
    viewport.tabIndex = 0;
    viewport.setAttribute("aria-keyshortcuts", "ArrowLeft ArrowRight");
    track.setAttribute("role", "presentation");
    cards.forEach((card, item) => {
      card.setAttribute("role", "group");
      card.setAttribute("aria-roledescription", "slide");
      card.setAttribute("aria-label", `${item + 1} of ${cards.length}`);
    });
    controls.hidden = false;
    measureDeck();
    show(carousel.selectedScrollSnap());
    carousel.on("select", () => {
      show(carousel.selectedScrollSnap(), manualSelection);
      manualSelection = false;
      schedule();
    });
    carousel.on("scroll", renderDeck);
    carousel.on("settle", () => {
      renderDeck();
      schedule();
    });
    carousel.on("reInit", () => {
      if (tapGesture) tapGesture.cancelled = true;
      delete root.dataset.carouselDragging;
      measureDeck();
      show(carousel.selectedScrollSnap());
      schedule();
    });
    carousel.on("pointerDown", () => {
      paused = true;
      manualSelection = true;
      root.dataset.carouselDragging = "true";
      schedule();
    });
    carousel.on("pointerUp", () => {
      delete root.dataset.carouselDragging;
      if (reduced.matches) carousel.scrollTo(carousel.selectedScrollSnap(), true);
    });
    listen(viewport, "pointerdown", event => {
      if (!event.isPrimary || event.button !== 0) {
        if (tapGesture) tapGesture.cancelled = true;
        return;
      }
      // A press can settle an in-flight slide before click; retain the intended index.
      tapGesture = { id: event.pointerId, x: event.clientX, y: event.clientY, index: carousel.selectedScrollSnap(), cancelled: false };
    });
    listen(viewport, "pointermove", event => {
      if (tapGesture?.id === event.pointerId && Math.hypot(event.clientX - tapGesture.x, event.clientY - tapGesture.y) > 10) tapGesture.cancelled = true;
    });
    listen(viewport, "pointercancel", () => {
      if (tapGesture) tapGesture.cancelled = true;
    });
    listen(viewport, "click", event => {
      const gesture = tapGesture;
      tapGesture = null;
      if (event.defaultPrevented || gesture?.cancelled || event.button !== 0 ||
          event.target.closest("a, button, input, textarea, select, [contenteditable='true']") ||
          !window.getSelection()?.isCollapsed) return;
      const bounds = viewport.getBoundingClientRect();
      viewport.focus({ preventScroll: true });
      const from = gesture?.index ?? carousel.selectedScrollSnap();
      manualStep(event.clientX < bounds.left + bounds.width / 2 ? -1 : 1, from);
    });
    listen(root, "keydown", event => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
          event.target.closest("input, textarea, select, [contenteditable='true']")) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        manualStep(event.key === "ArrowRight" ? 1 : -1);
      }
    });
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
      if (!paused) {
        hovered = false;
        manualSelection = false;
      }
      schedule();
    });
    listen(document, "visibilitychange", schedule);
    listen(reduced, "change", () => {
      carousel.reInit({ duration: reduced.matches ? 0 : 25 });
      carousel.scrollTo(index, true);
      schedule();
    });
    observer?.observe(viewport);
    sceneObserver.observe(root.querySelector(".reader-stories__window"));
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
