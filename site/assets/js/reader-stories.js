(() => {
  if (window.HappyMangoReaderStories) {
    window.HappyMangoReaderStories.init();
    return;
  }

  const instances = new Map();
  const interval = 8000;
  let instructionId = 0;
  let keyboardInput = false;

  function create(root) {
    const scene = root.querySelector(".reader-stories__window");
    const viewport = root.querySelector("[data-carousel-viewport]");
    const track = root.querySelector("[data-carousel-track]");
    const cards = Array.from(root.querySelectorAll("[data-story-card]"));
    const controls = root.querySelector("[data-carousel-controls]");
    const previous = root.querySelector("[data-carousel-prev]");
    const next = root.querySelector("[data-carousel-next]");
    const pause = root.querySelector("[data-carousel-pause]");
    const announcement = root.querySelector("[data-carousel-announcement]");
    if (!scene || !viewport || !track || cards.length < 2 || !controls || !previous || !next || !pause || !announcement ||
        typeof window.EmblaCarousel !== "function" || !window.ResizeObserver || !window.IntersectionObserver) return null;

    const events = new AbortController();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const originalAttributes = [
      [root, ["aria-roledescription"]],
      [viewport, ["tabindex", "aria-keyshortcuts", "aria-describedby"]],
      [track, ["role", "style"]],
      ...cards.map(card => [card, ["role", "aria-hidden", "aria-current", "aria-roledescription", "aria-label", "inert", "style"]]),
    ].flatMap(([node, names]) => names.map(name => [node, name, node.getAttribute(name)]));
    const originalPause = { text: pause.textContent, label: pause.getAttribute("aria-label"), disabled: pause.disabled };
    const controlsHidden = controls.hidden;
    let index = 0;
    let timer = null;
    let hintTimer = null;
    let userPaused = false;
    let hovered = false;
    let keyboardFocused = keyboardInput && root.contains(document.activeElement);
    let pointerHeld = false;
    let dragging = false;
    let selecting = false;
    let visible = false;
    let destroyed = false;
    let hinted = false;
    let manualSelection = false;
    let tapGesture = null;
    let deck = null;
    const listen = (target, name, handler, options = {}) => target.addEventListener(name, handler, { ...options, signal: events.signal });
    root.dataset.carouselReady = "true";
    const carousel = window.EmblaCarousel(viewport, {
      loop: true,
      align: "center",
      duration: reduced.matches ? 0 : 25,
      watchDrag: (_api, event) => !(event.type === "mousedown" && event.target.closest?.("blockquote, .reader-story__author")),
    });
    const instructions = document.createElement("p");
    instructions.className = "sr-only";
    instructions.dataset.carouselInstructions = "";
    instructions.id = `reader-stories-instructions-${++instructionId}`;
    const hint = document.createElement("p");
    hint.className = "reader-stories__hint";
    hint.dataset.carouselHint = "";
    hint.setAttribute("aria-hidden", "true");
    hint.hidden = true;
    scene.append(instructions, hint);
    viewport.setAttribute("aria-describedby", [viewport.getAttribute("aria-describedby"), instructions.id].filter(Boolean).join(" "));

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
      const sceneWidth = scene.clientWidth;
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
      }
    }

    function currentState() {
      return reduced.matches ? "reduced-motion" : document.hidden ? "hidden" :
        userPaused ? "paused" : !visible ? "offscreen" : pointerHeld || dragging ? "dragging" :
        keyboardFocused ? "focus-paused" : selecting ? "selection-paused" : hovered ? "hover-paused" : "playing";
    }

    function hideHint() {
      window.clearTimeout(hintTimer);
      hintTimer = null;
      hint.hidden = true;
    }

    function showHint(text) {
      hideHint();
      if (destroyed || !visible || document.hidden || keyboardFocused) return;
      hint.textContent = text;
      hint.hidden = false;
      hintTimer = window.setTimeout(hideHint, 5000);
    }

    function hasSelection() {
      const selection = window.getSelection();
      return Boolean(selection && !selection.isCollapsed && selection.rangeCount &&
        selection.getRangeAt(0).intersectsNode(viewport));
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
      const state = currentState();
      root.dataset.carouselState = state;
      root.dataset.carouselUserPaused = String(userPaused);
      root.dataset.carouselKeyboardFocus = String(keyboardFocused);
      pause.disabled = reduced.matches;
      pause.textContent = reduced.matches ? "Auto-play off" : userPaused ? "Resume" : "Pause";
      pause.setAttribute("aria-label", reduced.matches ? "Auto-play off for reduced motion" :
        `${userPaused ? "Resume" : "Pause"} automatic reader stories`);
      instructions.textContent = (reduced.matches ? "Automatic rotation is off for reduced motion. " :
        userPaused ? "Automatic rotation is paused. Tap the bottom center of the front card or use Resume to enable it. " :
        "Reviews rotate every eight seconds. Tap the bottom center of the front card or use Pause to stop rotation. Hover, text selection and keyboard focus pause it temporarily. ") +
        "Tap either edge, swipe horizontally, or use the Left and Right Arrow keys to browse. Review controls appear when reached with Tab.";
      if (!visible || document.hidden || keyboardFocused) hideHint();
      if (state === "playing") {
        timer = window.setTimeout(() => {
          timer = null;
          if (!destroyed && currentState() === "playing" && root.isConnected) {
            manualSelection = false;
            carousel.scrollNext();
          }
          schedule();
        }, interval);
      }
    }

    function manualStep(direction, from = carousel.selectedScrollSnap()) {
      if (from !== carousel.selectedScrollSnap()) carousel.scrollTo(from, reduced.matches);
      manualSelection = true;
      if (direction > 0) {
        if (carousel.canScrollNext()) carousel.scrollNext(reduced.matches);
        else carousel.scrollTo(0, reduced.matches);
      } else if (carousel.canScrollPrev()) carousel.scrollPrev(reduced.matches);
      else carousel.scrollTo(cards.length - 1, reduced.matches);
      schedule();
    }

    function togglePause() {
      if (reduced.matches) return;
      userPaused = !userPaused;
      announcement.textContent = userPaused ? "Automatic reader stories paused." :
        "Automatic reader stories enabled. Rotation resumes after you leave the reviews and finish selecting text.";
      schedule();
      showHint(userPaused ? "Paused — tap bottom center to resume." : "Auto-play on — tap bottom center to pause.");
    }

    const observer = new IntersectionObserver(entries => {
      const nextVisible = entries.some(entry => entry.isIntersecting && entry.intersectionRatio >= .5);
      if (visible !== nextVisible) {
        visible = nextVisible;
        schedule();
      }
      if (visible && !hinted) {
        hinted = true;
        showHint(reduced.matches ? "Tap the edges or swipe to browse." : "Tap bottom center to pause · edges to browse.");
      }
    }, { threshold: [0, .5] });
    const sceneObserver = new ResizeObserver(measureDeck);

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      window.clearTimeout(timer);
      timer = null;
      hideHint();
      events.abort();
      observer.disconnect();
      sceneObserver.disconnect();
      carousel.destroy();
      instructions.remove();
      hint.remove();
      originalAttributes.forEach(([node, name, value]) => {
        if (value === null) node.removeAttribute(name);
        else node.setAttribute(name, value);
      });
      controls.hidden = controlsHidden;
      pause.textContent = originalPause.text;
      pause.disabled = originalPause.disabled;
      if (originalPause.label === null) pause.removeAttribute("aria-label");
      else pause.setAttribute("aria-label", originalPause.label);
      announcement.textContent = "";
      delete root.dataset.carouselReady;
      delete root.dataset.selectedIndex;
      delete root.dataset.carouselState;
      delete root.dataset.carouselUserPaused;
      delete root.dataset.carouselKeyboardFocus;
      delete root.dataset.carouselDragging;
      tapGesture = null;
    }

    root.setAttribute("aria-roledescription", "carousel");
    viewport.tabIndex = 0;
    viewport.setAttribute("aria-keyshortcuts", "ArrowLeft ArrowRight");
    cards.forEach((card, item) => {
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
      pointerHeld = false;
      dragging = false;
      delete root.dataset.carouselDragging;
      measureDeck();
      show(carousel.selectedScrollSnap());
      schedule();
    });
    carousel.on("pointerDown", () => {
      dragging = true;
      manualSelection = true;
      root.dataset.carouselDragging = "true";
      schedule();
    });
    carousel.on("pointerUp", () => {
      dragging = false;
      delete root.dataset.carouselDragging;
      if (reduced.matches) {
        carousel.scrollTo(carousel.selectedScrollSnap(), true);
        // A release can already target this snap; Embla skips rendering a zero-distance jump.
        const animation = carousel.internalEngine().animation;
        animation.update();
        animation.render(1);
        animation.stop();
      }
      schedule();
    });
    listen(viewport, "mousedown", event => {
      // Quote starts remain native selections; only an engine-owned mouse drag suppresses selection.
      if (event.button === 0 && dragging && event.cancelable) event.preventDefault();
    });
    listen(viewport, "pointerdown", event => {
      if (!event.isPrimary || event.button !== 0) {
        if (tapGesture) tapGesture.cancelled = true;
        return;
      }
      // A press can settle an in-flight slide before click; retain the intended index.
      tapGesture = {
        id: event.pointerId, pointerType: event.pointerType, x: event.clientX, y: event.clientY,
        index: carousel.selectedScrollSnap(), started: performance.now(), ended: false,
        cancelled: hasSelection() || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey,
      };
      pointerHeld = true;
      schedule();
    });
    listen(window, "pointermove", event => {
      if (tapGesture?.id === event.pointerId && Math.hypot(event.clientX - tapGesture.x, event.clientY - tapGesture.y) > 10) tapGesture.cancelled = true;
    }, { passive: true });
    listen(window, "pointerup", event => {
      if (tapGesture?.id !== event.pointerId) return;
      tapGesture.ended = true;
      if (Math.hypot(event.clientX - tapGesture.x, event.clientY - tapGesture.y) > 10) tapGesture.cancelled = true;
      pointerHeld = false;
      schedule();
    }, { passive: true });
    listen(window, "pointercancel", event => {
      if (tapGesture?.id !== event.pointerId) return;
      tapGesture.cancelled = true;
      pointerHeld = false;
      schedule();
    }, { passive: true });
    listen(document, "scroll", () => {
      if (tapGesture) tapGesture.cancelled = true;
    }, { capture: true, passive: true });
    listen(viewport, "contextmenu", () => {
      if (tapGesture) tapGesture.cancelled = true;
    });
    listen(viewport, "click", event => {
      const gesture = tapGesture;
      tapGesture = null;
      if (!gesture || !gesture.ended || gesture.cancelled || performance.now() - gesture.started > 500 ||
          event.defaultPrevented || event.button !== 0 || (gesture.pointerType !== "touch" && event.detail > 1) ||
          event.target.closest("a, button, input, textarea, select, [contenteditable='true']") ||
          (gesture.pointerType === "mouse" && event.target.closest("blockquote, .reader-story__author")) ||
          hasSelection()) return;
      const card = event.target.closest("[data-story-card]");
      if (!card || !cards.includes(card)) return;
      const bounds = viewport.getBoundingClientRect();
      const position = (event.clientX - bounds.left) / bounds.width;
      const startPosition = (gesture.x - bounds.left) / bounds.width;
      const zone = position < .3 ? -1 : position > .7 ? 1 : 0;
      const startZone = startPosition < .3 ? -1 : startPosition > .7 ? 1 : 0;
      // The middle 40% is pause-only; both outer zones are navigation-only.
      if (zone !== startZone || (zone === 0 && card !== cards[gesture.index])) return;
      viewport.focus({ preventScroll: true });
      if (zone) manualStep(zone, gesture.index);
      else togglePause();
    });
    listen(document, "keydown", event => {
      if (event.altKey || event.ctrlKey || event.metaKey || ["Alt", "Control", "Meta", "Shift"].includes(event.key)) return;
      keyboardInput = true;
      if (root.contains(document.activeElement) && !keyboardFocused) {
        keyboardFocused = true;
        schedule();
      }
    }, { capture: true });
    listen(document, "pointerdown", () => {
      keyboardInput = false;
      if (keyboardFocused) {
        keyboardFocused = false;
        schedule();
      }
    }, { capture: true, passive: true });
    listen(document, "selectionchange", () => {
      const nextSelecting = hasSelection();
      if (nextSelecting && tapGesture) tapGesture.cancelled = true;
      if (selecting !== nextSelecting) {
        selecting = nextSelecting;
        schedule();
      }
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
      keyboardFocused = keyboardInput;
      schedule();
    });
    listen(root, "focusout", event => {
      if (root.contains(event.relatedTarget)) return;
      keyboardFocused = false;
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
    listen(pause, "click", togglePause);
    listen(document, "visibilitychange", () => {
      if (document.hidden && (pointerHeld || dragging)) carousel.reInit();
      if (document.hidden && tapGesture) tapGesture.cancelled = true;
      schedule();
    });
    listen(reduced, "change", () => {
      carousel.reInit({ duration: reduced.matches ? 0 : 25 });
      carousel.scrollTo(index, true);
      schedule();
    });
    selecting = hasSelection();
    observer.observe(viewport);
    sceneObserver.observe(scene);
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
