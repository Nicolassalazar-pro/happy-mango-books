(() => {
  document.documentElement.classList.remove("no-js");
  for (const image of document.querySelectorAll("img")) {
    image.addEventListener("error", () => {
      if (image.dataset.failed) return;
      image.dataset.failed = "true";
      const message = document.createElement("p");
      message.className = "error-message";
      message.textContent = "This photograph could not load. The book information is still available.";
      image.after(message);
      image.hidden = true;
    });
  }
})();
(() => {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  for (const button of document.querySelectorAll("[data-wiggle]")) {
    const scene = document.getElementById(button.getAttribute("aria-controls"));
    const pieces = [...scene.querySelectorAll("[data-food-motion]")];
    const status = button.parentElement.querySelector("[data-wiggle-status]");
    let active = [];
    const stop = () => { active.forEach(animation => animation.cancel()); active = []; };
    button.addEventListener("click", () => {
      stop();
      status.textContent = "Nom, nom!";
      if (reduce.matches) return;
      active = pieces.map((piece, index) => piece.animate([
        { transform: "translateY(0) rotate(0)" },
        { transform: `translateY(-${5 + index}px) rotate(-5deg)`, offset: .3 },
        { transform: "translateY(-2px) rotate(4deg)", offset: .65 },
        { transform: "translateY(0) rotate(0)" },
      ], { duration: 540, delay: index * 35, easing: "ease-in-out", iterations: 1 }));
    });
    reduce.addEventListener("change", () => { if (reduce.matches) stop(); });
    document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); });
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(entries => { if (!entries[0].isIntersecting) stop(); }).observe(scene);
    }
  }
})();
