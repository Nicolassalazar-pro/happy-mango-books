(() => {
  document.documentElement.classList.remove("no-js");
  for (const image of document.querySelectorAll("[data-standalone-image]")) {
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
