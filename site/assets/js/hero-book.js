(() => {
  "use strict";
  const instances = new WeakMap();
  const pair = page => page - page % 2;
  const visiblePages = (page, layout) => layout === "spread" ? [pair(page), pair(page) + 1] : [page];
  const sameView = (a, b, layout) => layout === "spread" ? pair(a) === pair(b) : a === b;
  const abortError = () => new DOMException("Book operation superseded", "AbortError");
  const titles = ["Left book sample", "Right book sample", "Ways to share the book", "Reader moments"];

  class HeroBook {
    constructor(root) {
      this.root = root;
      this.pages = [...root.querySelectorAll("[data-reader-page]")];
      this.panel = root.querySelector("[data-reader-panel]");
      this.openButton = root.querySelector("[data-book-open]");
      this.closeButton = root.querySelector("[data-book-close]");
      this.keyboardControls = root.querySelector(".hb-access");
      this.prev = root.querySelector("[data-book-prev]");
      this.next = root.querySelector("[data-book-next]");
      this.retry = root.querySelector("[data-book-retry]");
      this.status = root.querySelector("[data-book-status]");
      this.cover = root.querySelector(".hb-cover");
      this.coverCue = root.querySelector(".hb-cover-cue");
      this.coverArt = this.cover.querySelector("img");
      this.coverBack = root.querySelector(".hb-cover-back");
      this.leaf = root.querySelector("[data-page-turn]");
      this.front = root.querySelector(".hb-turn-front");
      this.back = root.querySelector(".hb-turn-back");
      this.underlay = root.querySelector(".hb-underlay");
      this.measure = root.querySelector(".hb-measure");
      this.layoutNode = root.querySelector(".hb-layout");
      this.object = root.querySelector(".hb-object");
      this.plate = root.querySelector(".hb-plate");
      this.foods = root.querySelector(".hb-foods");
      this.casts = [...root.querySelectorAll(".hb-cast")];
      this.life = new AbortController();
      this.motionQuery = matchMedia("(prefers-reduced-motion: reduce)");
      this.reduced = this.motionQuery.matches;
      this.desiredOpen = false;
      this.committedOpen = false;
      this.requested = 0;
      this.displayed = 0;
      this.layout = this.requestedLayout = this.chooseLayout();
      this.active = null;
      this.work = null;
      this.revision = 0;
      this.disposed = false;
      this.inView = true;
      this.failedImages = new WeakSet();
      this.ready = false;
      this.boot();
    }

    chooseLayout() {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      return innerWidth <= 760 || this.root.clientWidth < 780 || rem > 20 ? "single" : "spread";
    }

    width(layout) {
      return layout === "spread" ? Math.min(450, Math.max(100, (this.root.clientWidth - 112) / 2)) : Math.min(450, this.root.clientWidth - 24);
    }

    async boot() {
      try {
        await this.decodeImage(this.coverArt, this.life.signal);
        if (this.disposed) return;
        this.root.classList.add("hb-enhanced");
        this.ready = true;
        this.paint();
        const options = { signal: this.life.signal };
        this.openButton.addEventListener("click", () => this.intent(true, 0), options);
        this.closeButton.addEventListener("click", () => this.close(), options);
        this.prev.addEventListener("click", () => this.step(-1), options);
        this.next.addEventListener("click", () => this.step(1), options);
        this.retry.addEventListener("click", () => {
          if (this.failedIntent) this.intent(this.failedIntent.open, this.failedIntent.page, true);
        }, options);
        this.listenBookInteractions(options);
        this.root.addEventListener("keydown", event => {
          if (!this.desiredOpen || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
              event.target.closest("input, textarea, select, [contenteditable='true']")) return;
          if (event.key === "Escape") {
            event.preventDefault();
            this.close();
          } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
            event.preventDefault();
            this.step(event.key === "ArrowRight" ? 1 : -1);
          }
        }, options);
        this.motionQuery.addEventListener("change", () => {
          this.reduced = this.motionQuery.matches;
          this.motion();
          if (this.reduced && this.active) this.complete(this.active, this.active.target);
          if (this.work) this.instant = true;
        }, options);
        document.addEventListener("visibilitychange", () => {
          this.motion();
          if (document.hidden && this.active) this.complete(this.active, this.active.target);
        }, options);
        window.addEventListener("pagehide", event => {
          if (!event.persisted) this.destroy();
          else {
            this.root.dataset.motion = "paused";
            if (this.active) this.complete(this.active, this.active.target);
          }
        }, options);
        window.addEventListener("pageshow", () => this.motion(), options);
        this.lastSize = `${this.root.clientWidth}:${getComputedStyle(document.documentElement).fontSize}`;
        this.resizeObserver = new ResizeObserver(() => {
          const size = `${this.root.clientWidth}:${getComputedStyle(document.documentElement).fontSize}`;
          if (this.disposed || size === this.lastSize) return;
          this.lastSize = size;
          this.revealTarget = null;
          this.requestedLayout = this.chooseLayout();
          this.cancel();
          this.paint();
          this.run(true);
        });
        this.resizeObserver.observe(this.root);
        this.resizeObserver.observe(this.root.querySelector(".hb-type-meter"));
        this.intersectionObserver = new IntersectionObserver(entries => {
          this.inView = entries[0].isIntersecting;
          this.motion();
        }, { rootMargin: "40px" });
        this.intersectionObserver.observe(this.root);
        document.fonts?.addEventListener("loadingdone", () => {
          if (this.committedOpen) {
            this.cancel();
            this.run(true);
          }
        }, options);
        this.motion();
      } catch (error) {
        if (this.disposed || error.name === "AbortError") return;
        this.root.dataset.state = "error";
        this.status.textContent = "The cover could not load. All four preview pages remain available below.";
      }
    }

    motion() {
      if (!this.disposed) this.root.dataset.motion = !this.reduced && !document.hidden && this.inView ? "running" : "paused";
    }

    listenBookInteractions(options) {
      document.addEventListener("pointerdown", event => {
        if (!this.desiredOpen) {
          this.pageGesture = null;
          return;
        }
        if (!event.isPrimary) {
          if (this.pageGesture) this.pageGesture.cancelled = true;
          return;
        }
        this.pageGesture = event.button === 0
          ? { id: event.pointerId, x: event.clientX, y: event.clientY, cancelled: false } : null;
      }, options);
      document.addEventListener("pointermove", event => {
        const gesture = this.pageGesture;
        if (gesture?.id === event.pointerId && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 10) {
          gesture.cancelled = true;
        }
      }, options);
      document.addEventListener("pointercancel", event => {
        if (this.pageGesture?.id === event.pointerId) this.pageGesture.cancelled = true;
      }, options);
      document.addEventListener("click", event => {
        const gesture = this.pageGesture;
        this.pageGesture = null;
        if (!this.desiredOpen || event.button !== 0 || event.detail > 0 && gesture?.cancelled) return;
        if (!this.object.contains(event.target)) {
          if (!this.keyboardControls.contains(event.target) && !this.retry.contains(event.target)) {
            if (this.root.contains(event.target)) this.panel.focus({ preventScroll: true });
            this.close();
          }
          return;
        }
        const page = event.target.closest("[data-reader-page]");
        if (!this.committedOpen || !this.desiredOpen || this.active?.kind === "hinge" ||
            !this.pages.includes(page) || page.hidden ||
            event.target.closest("a, button, input, textarea, select, [contenteditable='true']") ||
            !getSelection()?.isCollapsed) return;
        const bounds = page.getBoundingClientRect();
        const direction = this.layout === "spread" ? this.pages.indexOf(page) % 2 ? 1 : -1
          : event.clientX < bounds.left + bounds.width / 2 ? -1 : 1;
        this.panel.focus({ preventScroll: true });
        this.step(direction);
      }, options);
    }

    step(direction) {
      if (!this.desiredOpen || !this.committedOpen) return;
      const target = this.requestedLayout === "spread" ? pair(this.requested) + direction * 2 : this.requested + direction;
      if (target >= 0 && target <= 3) this.intent(true, target);
      else if (!this.active && !this.work) this.close();
    }

    close() {
      if (this.desiredOpen) this.intent(false, this.committedOpen ? this.displayed : this.requested);
    }

    intent(open, page, retry = false) {
      if (this.disposed || !this.ready) return;
      this.revealTarget = open ? document.activeElement : null;
      this.desiredOpen = open;
      this.requested = Math.max(0, Math.min(3, page));
      this.failedIntent = null;
      this.hideRetry();
      const active = this.active;
      if (active && active.layout === this.requestedLayout) {
        let endpoint = null;
        if (active.kind === "hinge" && sameView(this.requested, active.to, active.layout)) endpoint = open ? 1 : 0;
        if (active.kind === "turn" && open) {
          if (sameView(this.requested, active.from, active.layout)) endpoint = 0;
          if (sameView(this.requested, active.to, active.layout)) endpoint = 1;
        }
        if (endpoint !== null) {
          active.target = endpoint;
          this.root.dataset.state = active.kind === "turn" ? "turning" : open ? "opening" : "closing";
          this.status.textContent = active.kind === "turn" ? "Turning to your selected preview…" : open ? "Opening the book…" : "Closing the book…";
          for (const animation of active.animations) {
            animation.updatePlaybackRate(endpoint ? 1 : -1);
            animation.play();
          }
          this.controls();
          return;
        }
      }
      this.cancel();
      this.paint();
      this.run(false, retry);
    }

    cancel() {
      ++this.revision;
      this.work?.abort();
      this.work = null;
      if (this.active) {
        const active = this.active;
        this.active = null;
        active.animations.forEach(animation => animation.cancel());
      }
      this.clearCopies();
    }

    clearCopies() {
      this.front.replaceChildren();
      this.back.replaceChildren();
      this.underlay.replaceChildren();
      this.coverBack.replaceChildren();
      this.coverCue.style.removeProperty("transform");
      this.measure.replaceChildren();
      this.underlay.classList.remove("hb-on-left");
      this.leaf.hidden = true;
      this.casts.forEach(cast => { cast.style.opacity = "0"; });
    }

    hideRetry() {
      if (document.activeElement === this.retry) (this.committedOpen ? this.panel : this.openButton).focus({ preventScroll: true });
      this.retry.hidden = true;
    }

    controls(focused = document.activeElement) {
      const coverHidden = this.root.dataset.presentation === "open";
      const closed = !coverHidden && !this.desiredOpen;
      if (!coverHidden) {
        this.cover.inert = false;
        this.openButton.disabled = false;
      }
      if (coverHidden && this.cover.contains(focused)) {
        this.panel.focus({ preventScroll: true });
        if (this.revealTarget === focused) this.revealTarget = this.panel;
      } else if (closed && (focused === this.panel || this.keyboardControls.contains(focused))) {
        this.openButton.focus({ preventScroll: true });
      }
      this.openButton.disabled = coverHidden;
      this.openButton.setAttribute("aria-expanded", String(this.committedOpen || this.active?.kind === "hinge" && this.desiredOpen));
      this.cover.inert = coverHidden;
      this.cover.setAttribute("aria-hidden", String(coverHidden));
      this.keyboardControls.hidden = closed;
      const group = this.requestedLayout === "spread" ? pair(this.requested) : this.requested;
      const first = group === 0;
      const last = group >= (this.requestedLayout === "spread" ? 2 : 3);
      this.prev.setAttribute("aria-disabled", String(!this.desiredOpen));
      this.next.setAttribute("aria-disabled", String(!this.desiredOpen));
      this.prev.setAttribute("aria-label", first ? "Close the book at the beginning" : this.requestedLayout === "spread" ? "Previous preview spread" : "Previous preview page");
      this.next.setAttribute("aria-label", last ? "Close the book at the end" : this.requestedLayout === "spread" ? "Next preview spread" : "Next preview page");
      this.prev.textContent = first ? "Close book" : "Previous page";
      this.next.textContent = last ? "Close book" : "Next page";
      this.prev.inert = this.next.inert = closed;
      this.panel.tabIndex = closed ? -1 : 0;
      this.panel.setAttribute("aria-busy", String(Boolean(this.work || this.active)));
    }

    geometry(height, layout = this.layout) {
      const width = this.width(layout);
      this.root.style.setProperty("--hb-width", `${width}px`);
      this.root.style.setProperty("--hb-height", `${height || width * 825 / 840}px`);
    }

    revealSelection() {
      const origin = this.revealTarget;
      this.revealTarget = null;
      if (!origin || !this.committedOpen || document.hidden ||
          document.activeElement !== origin || !this.root.contains(origin)) return;
      const box = this.panel.getBoundingClientRect();
      // Explicit page navigation returns the reader to view; normal scrolling is untouched.
      if (box.top < 12 || box.bottom > innerHeight - 12) {
        window.scrollBy({ top: box.top - 12, behavior: "instant" });
      }
    }

    paint(height = this.openHeight) {
      if (this.disposed) return;
      const focused = document.activeElement;
      this.root.dataset.textReflow = String(parseFloat(getComputedStyle(document.documentElement).fontSize) > 20);
      this.root.dataset.layout = this.layout;
      this.root.dataset.page = String(this.displayed);
      this.root.dataset.state = this.committedOpen ? "open" : "closed";
      this.root.dataset.presentation = this.committedOpen ? "open" : "closed";
      this.root.dataset.rest = this.committedOpen ? "open" : "closed";
      const show = this.committedOpen ? visiblePages(this.displayed, this.layout) : [];
      this.pages.forEach((page, index) => {
        page.hidden = !show.includes(index);
        page.inert = !show.includes(index);
        page.classList.toggle("hb-compact-page", this.layout === "single");
        page.setAttribute("aria-hidden", String(!show.includes(index)));
        if (index === this.displayed && this.committedOpen) page.setAttribute("aria-current", "page");
        else page.removeAttribute("aria-current");
      });
      this.cover.style.transform = this.committedOpen ? "translateZ(-3px) rotateY(-180deg)" : "translateZ(7px) rotateY(0deg)";
      this.layoutNode.style.transform = this.committedOpen && this.layout === "spread" ? `translateX(${this.width(this.layout) / 2}px)` : "translateX(0px)";
      this.object.style.transform = this.committedOpen ? "rotateX(0deg) rotateY(0deg)" : "rotateX(4deg) rotateY(-7deg)";
      this.geometry(this.committedOpen ? height : undefined);
      this.status.textContent = this.committedOpen
        ? this.layout === "spread" ? pair(this.displayed) === 0 ? "Book samples · Preview pages 1–2 of 4" : "Website ideas & reader moments · Preview pages 3–4 of 4"
          : `${titles[this.displayed]} · Preview page ${this.displayed + 1} of 4`
        : "Open a little world of first foods.";
      this.controls(focused);
    }

    copy(index, layout, width) {
      const copy = this.pages[index].cloneNode(true);
      for (const node of [copy, ...copy.querySelectorAll("*")]) {
        for (const attribute of [...node.attributes]) {
          if (attribute.name === "id" || attribute.name === "hidden" || attribute.name === "inert" ||
              attribute.name === "tabindex" || attribute.name === "role" ||
              attribute.name.startsWith("data-") || attribute.name.startsWith("aria-")) node.removeAttribute(attribute.name);
        }
        if (node.matches("a")) node.removeAttribute("href");
        if (node.matches("button, input, select, textarea, iframe, object, script")) node.remove();
        if (node.matches("img")) {
          node.loading = "eager";
          if (node.srcset) node.sizes = `${Math.ceil(width)}px`;
        }
      }
      copy.classList.add("hb-copy");
      copy.classList.toggle("hb-compact-page", layout === "single");
      copy.setAttribute("aria-hidden", "true");
      copy.inert = true;
      return copy;
    }

    async decodeImage(image, signal, retry = false) {
      if (signal.aborted || this.disposed) throw abortError();
      image.loading = "eager";
      if (retry && (this.failedImages.has(image) || image.complete && !image.naturalWidth)) {
        const src = image.getAttribute("src");
        const srcset = image.getAttribute("srcset");
        image.removeAttribute("srcset");
        image.removeAttribute("src");
        if (srcset) image.setAttribute("srcset", srcset);
        if (src) image.setAttribute("src", src);
      }
      let timer;
      let abort;
      const guard = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Image preparation timed out")), 8000);
        abort = () => reject(abortError());
        signal.addEventListener("abort", abort, { once: true });
      });
      try {
        await Promise.race([guard, (async () => {
          for (let attempt = 0; attempt < 3; attempt++) {
            const source = image.currentSrc || image.src;
            await image.decode();
            if (signal.aborted || this.disposed) throw abortError();
            if (image.naturalWidth && source === (image.currentSrc || image.src)) return;
          }
          throw new Error("Image source changed during preparation");
        })()]);
        this.failedImages.delete(image);
      } catch (error) {
        if (error.name !== "AbortError") this.failedImages.add(image);
        throw error;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      }
    }

    async run(instant = false, retry = false) {
      if (this.disposed) return;
      const revision = ++this.revision;
      const controller = new AbortController();
      this.work = controller;
      this.instant = instant;
      const open = this.desiredOpen;
      const target = this.requested;
      const layout = this.requestedLayout;
      const oldOpen = this.committedOpen;
      const oldLayout = this.layout;
      const from = this.displayed;
      if (!open && !oldOpen) {
        this.layout = layout;
        this.work = null;
        this.paint();
        return;
      }
      if (open && oldOpen && oldLayout === layout && sameView(from, target, layout) && !instant && !retry) {
        this.work = null;
        this.displayed = target;
        this.paint();
        this.revealSelection();
        return;
      }
      const closedCue = oldOpen ? "none" : getComputedStyle(this.coverCue).transform;
      this.coverCue.style.transform = closedCue;
      this.root.dataset.state = oldOpen ? open ? "turning" : "closing" : "opening";
      this.status.textContent = "Preparing your preview…";
      this.controls();
      try {
        const width = this.width(layout);
        const destination = visiblePages(open ? target : from, layout);
        const needed = new Set(destination);
        if (oldOpen && open && !sameView(from, target, layout)) {
          if (layout === "spread") [0, 1, 2, 3].forEach(id => needed.add(id));
          else needed.add(from);
        }
        const copies = new Map();
        this.measure.style.width = `${width}px`;
        for (let index = 0; index < this.pages.length; index++) {
          const copy = this.copy(index, layout, width);
          copies.set(index, copy);
          this.measure.append(copy);
        }
        const images = [];
        for (const index of needed) {
          for (const image of this.pages[index].querySelectorAll("img")) {
            if (image.srcset) image.sizes = `${Math.ceil(width)}px`;
            images.push(image);
          }
          images.push(...copies.get(index).querySelectorAll("img"));
        }
        if (!open) images.push(this.coverArt);
        await Promise.all(images.map(image => this.decodeImage(image, controller.signal, retry)));
        if (this.disposed || revision !== this.revision || controller.signal.aborted) return;
        // Every leaf shares the same measured page box; unused media need not decode.
        let height = Math.max(width * 825 / 840, ...[...copies.values()].map(copy => copy.getBoundingClientRect().height));
        height = Math.ceil(height);
        const transitionHeight = oldOpen && open && oldLayout === layout ? Math.max(height, this.openHeight || 0) : height;
        const reflow = this.root.dataset.textReflow === "true";
        if (instant || this.instant || this.reduced || document.hidden || oldLayout !== layout || reflow ||
            oldOpen === open && sameView(from, target, layout)) {
          this.work = null;
          this.layout = layout;
          this.committedOpen = open;
          if (open) this.displayed = target;
          this.openHeight = height;
          this.clearCopies();
          this.paint();
          this.revealSelection();
          return;
        }
        const active = {
          kind: oldOpen === open ? "turn" : "hinge", from, to: target, layout, height,
          sourceHeight: this.openHeight, sourceOpen: oldOpen, target: open ? 1 : 0, animations: [], closedCue,
          closedAmbient: oldOpen ? "translate3d(-3px, 7px, 0) rotate(-2.9deg)" : getComputedStyle(this.root.querySelector("[data-book-ambient]")).transform,
        };
        this.layout = layout;
        this.root.dataset.layout = layout;
        this.geometry(transitionHeight, layout);
        if (active.kind === "turn") {
          active.target = 1;
          const forward = target > from;
          active.forward = forward;
          const frontId = layout === "spread" ? 1 : forward ? from : target;
          const backId = layout === "spread" ? 2 : forward ? target : from;
          this.front.append(copies.get(frontId));
          this.back.append(copies.get(backId));
          if (layout === "spread") {
            this.underlay.classList.toggle("hb-on-left", !forward);
            this.underlay.append(copies.get(forward ? 3 : 0));
          } else if (forward) {
            const underlying = this.copy(target, layout, width);
            this.underlay.append(underlying);
            await Promise.all([...underlying.querySelectorAll("img")].map(image => this.decodeImage(image, controller.signal, retry)));
            if (this.disposed || revision !== this.revision || controller.signal.aborted) return;
          }
          this.leaf.hidden = false;
        } else {
          if (layout === "spread") this.coverBack.append(copies.get(pair(target)));
          this.underlay.append(copies.get(layout === "spread" ? pair(target) + 1 : target));
          this.pages.forEach(page => { page.hidden = true; page.inert = true; });
          this.root.dataset.rest = "transition";
          this.root.dataset.presentation = "open";
        }
        this.measure.replaceChildren();
        this.work = null;
        this.active = active;
        this.animate(active);
      } catch (error) {
        if (this.disposed || revision !== this.revision || controller.signal.aborted || error.name === "AbortError") return;
        this.work = null;
        this.clearCopies();
        this.failedIntent = { open, page: target };
        this.revealTarget = null;
        this.desiredOpen = this.committedOpen;
        this.requested = this.displayed;
        this.paint();
        this.root.dataset.state = "error";
        this.status.textContent = this.committedOpen
          ? "That page could not load. Your last readable page is still here. Try again."
          : "The sample pages could not load. The cover is still here. Try again.";
        this.retry.hidden = false;
        this.retry.textContent = open ? "Retry page" : "Retry closing";
      }
    }

    animate(active) {
      const duration = active.kind === "turn" ? 1080 : 1120;
      const add = (node, frames, easing = "cubic-bezier(.34,.12,.26,1)") => {
        const animation = node.animate(frames, { duration, easing, fill: "both" });
        animation.pause();
        animation.currentTime = active.kind === "hinge" && active.sourceOpen ? duration : 0;
        animation.playbackRate = active.target ? 1 : -1;
        active.animations.push(animation);
        return animation;
      };
      if (active.kind === "turn") {
        const angles = active.forward ? [0, -180] : [-180, 0];
        add(this.leaf, angles.map(angle => ({ transform: `translateZ(3px) rotateY(${angle}deg)` })));
        const shadow = frames => active.forward ? frames : frames.reverse().map(frame => ({ ...frame, offset: 1 - frame.offset }));
        add(this.casts[1], shadow([
          { opacity: 0, transform: "translateZ(2.4px) scaleX(.05)", offset: 0 },
          { opacity: .38, transform: "translateZ(2.4px) scaleX(.85)", offset: .36 },
          { opacity: .24, transform: "translateZ(2.4px) scaleX(.32)", offset: .64 },
          { opacity: 0, transform: "translateZ(2.4px) scaleX(.02)", offset: 1 },
        ]));
        add(this.casts[0], shadow([
          { opacity: 0, transform: "translateZ(2.4px) scaleX(.05)", offset: 0 },
          { opacity: .25, transform: "translateZ(2.4px) scaleX(.35)", offset: .38 },
          { opacity: .33, transform: "translateZ(2.4px) scaleX(.9)", offset: .7 },
          { opacity: 0, transform: "translateZ(2.4px) scaleX(.05)", offset: 1 },
        ]));
      } else {
        add(this.cover, [{ transform: "translateZ(7px) rotateY(0deg)" }, { transform: "translateZ(-3px) rotateY(-180deg)" }]);
        add(this.coverCue, [{ transform: active.closedCue }, { transform: "none" }]);
        add(this.layoutNode, [{ transform: "translateX(0px)" }, { transform: `translateX(${active.layout === "spread" ? this.width(active.layout) / 2 : 0}px)` }]);
        add(this.object, [{ transform: "rotateX(4deg) rotateY(-7deg)" }, { transform: "rotateX(0deg) rotateY(0deg)" }]);
        add(this.root.querySelector("[data-book-ambient]"), [{ transform: active.closedAmbient }, { transform: "none" }]);
        if (Math.abs(active.height - this.width(active.layout) * 825 / 840) > 12) {
          add(this.layoutNode, [{ height: `${this.width(active.layout) * 825 / 840}px` }, { height: `${active.height}px` }]);
        }
        add(this.root.querySelector(".hb-cover-light"), [{ opacity: 0 }, { opacity: .6, offset: .48 }, { opacity: 0 }]);
        const material = getComputedStyle(this.root);
        const closedWidth = material.getPropertyValue("--hb-plate-closed-width").trim();
        const openWidth = material.getPropertyValue("--hb-plate-open-width").trim();
        const angle = parseFloat(material.getPropertyValue("--hb-plate-angle"));
        const wobble = active.layout === "single" ? .9 : 2.1;
        const widths = [
          { width: closedWidth, offset: 0, easing: "ease-in-out" },
          { width: closedWidth, offset: .14, easing: "cubic-bezier(.16,.8,.24,1)" },
          { width: openWidth, offset: .63, easing: "ease-in-out" },
          { width: openWidth, offset: .82, easing: "ease-out" },
          { width: openWidth, offset: 1 },
        ];
        const poses = [
          [angle, 1, 1],
          [angle - wobble * .6, .975, 1.012],
          [angle + wobble, 1.025, .985],
          [angle - wobble * .35, .995, 1.012],
          [angle, 1, 1],
        ];
        // Share the hinge lifecycle so click-away reversal cannot leave the plate behind.
        add(this.plate, widths.map((frame, index) => {
          const [rotation, x, y] = poses[index];
          return { ...frame, transform: `translate(-50%, -50%) rotate(${rotation}deg) scale(${x}, ${y})` };
        }), "linear");
        add(this.foods, widths, "linear");
      }
      this.root.dataset.state = active.kind === "turn" ? "turning" : active.target ? "opening" : "closing";
      this.status.textContent = active.kind === "turn" ? "Turning to your selected preview…" : active.target ? "Opening the book…" : "Closing the book…";
      this.controls();
      Promise.all(active.animations.map(animation => animation.finished)).then(() => {
        if (!this.disposed && this.active === active) this.complete(active, active.target);
      }).catch(() => {});
      active.animations.forEach(animation => animation.play());
    }

    complete(active, endpoint) {
      if (this.disposed || this.active !== active) return;
      this.active = null;
      if (active.kind === "hinge") {
        this.committedOpen = Boolean(endpoint);
        if (endpoint) this.displayed = this.requested;
        this.desiredOpen = Boolean(endpoint);
      } else {
        this.committedOpen = true;
        this.displayed = endpoint ? this.requested : active.from;
      }
      this.requested = this.displayed;
      this.openHeight = endpoint ? active.height : active.sourceHeight;
      this.clearCopies();
      this.paint();
      active.animations.forEach(animation => animation.cancel());
      this.revealSelection();
    }

    destroy() {
      if (this.disposed) return;
      this.disposed = true;
      this.cancel();
      this.life.abort();
      this.resizeObserver?.disconnect();
      this.intersectionObserver?.disconnect();
      if (this.root.contains(document.activeElement)) this.panel.focus({ preventScroll: true });
      this.root.classList.remove("hb-enhanced");
      ["presentation", "rest", "motion", "textReflow"].forEach(key => { delete this.root.dataset[key]; });
      this.root.dataset.state = "closed";
      this.root.style.removeProperty("--hb-width");
      this.root.style.removeProperty("--hb-height");
      this.pages.forEach(page => {
        page.hidden = false;
        page.inert = false;
        page.removeAttribute("aria-hidden");
        page.removeAttribute("aria-current");
        page.classList.remove("hb-compact-page");
      });
      [this.cover, this.layoutNode, this.object].forEach(node => node.style.removeProperty("transform"));
      this.cover.removeAttribute("aria-hidden");
      this.cover.inert = false;
      this.openButton.disabled = false;
      this.keyboardControls.hidden = true;
      this.panel.tabIndex = -1;
      this.panel.removeAttribute("aria-busy");
      this.status.textContent = "Four website preview pages: two book samples, ideas and reader moments.";
      instances.delete(this.root);
    }
  }

  const roots = scope => scope.matches?.("[data-hero-book]") ? [scope] : [...scope.querySelectorAll("[data-hero-book]")];
  const init = (scope = document) => {
    if (!CSS.supports("transform-style", "preserve-3d") || !Element.prototype.animate || !HTMLImageElement.prototype.decode ||
        !window.ResizeObserver || !window.IntersectionObserver) return;
    roots(scope).forEach(root => {
      if (!instances.has(root) && root.querySelectorAll("[data-reader-page]").length === 4) instances.set(root, new HeroBook(root));
    });
  };
  window.HappyMangoHeroBook = Object.freeze({ init, destroy: (scope = document) => roots(scope).forEach(root => instances.get(root)?.destroy()) });
  init();
})();
