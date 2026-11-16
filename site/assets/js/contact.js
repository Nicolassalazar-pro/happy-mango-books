(() => {
  "use strict";

  const form = document.querySelector("[data-inquiry-form]");
  if (!form) return;

  const topic = form.querySelector("#inquiry-type");
  const bulkFields = form.querySelector("[data-bulk-fields]");
  const button = form.querySelector("[data-send-inquiry]");
  const status = form.querySelector("[data-form-status]");
  const preview = document.querySelector("[data-inquiry-preview]");
  const fields = {
    name: form.querySelector("#inquiry-name"),
    email: form.querySelector("#inquiry-email"),
    organization: form.querySelector("#inquiry-organization"),
    copies: form.querySelector("#inquiry-copies"),
    message: form.querySelector("#inquiry-message"),
  };
  const demoNote = "This is a demo form. Nothing entered here will be sent.";

  function clearError(field) {
    field.setCustomValidity("");
    field.removeAttribute("aria-invalid");
    const error = document.getElementById(`${field.id}-error`);
    error.textContent = "";
    error.hidden = true;
  }

  function validateField(field) {
    clearError(field);
    if (field.matches(":disabled")) return true;

    let message = "";
    if (field === fields.name && !field.value.trim()) {
      message = "Please enter your name.";
    } else if (field === fields.email && !field.value.trim()) {
      message = "Please enter your email.";
    } else if (field === fields.email && field.validity.typeMismatch) {
      message = "Please enter a valid email address.";
    } else if (field === fields.message && !field.value.trim()) {
      message = "Please add a message about what you have in mind.";
    } else if (field === fields.copies && !field.validity.valid) {
      message = "Enter a whole number of copies, at least 1, or leave this blank.";
    } else if (!field.validity.valid) {
      message = field.validationMessage;
    }

    if (!message) return true;
    field.setCustomValidity(message);
    field.setAttribute("aria-invalid", "true");
    const error = document.getElementById(`${field.id}-error`);
    error.textContent = message;
    error.hidden = false;
    return false;
  }

  function markEdited() {
    if (preview.hidden) return;
    preview.hidden = true;
    status.textContent = "Review again to see your changes. Nothing entered here will be sent.";
  }

  function syncBulkFields() {
    const isBulk = topic.value === "bulk";
    bulkFields.disabled = !isBulk;
    bulkFields.hidden = !isBulk;
    clearError(fields.organization);
    clearError(fields.copies);
  }

  function showPreview() {
    const isBulk = topic.value === "bulk";
    const values = {
      topic: isBulk ? "A bulk-order request" : "A general inquiry",
      name: fields.name.value.trim(),
      email: fields.email.value.trim(),
      organization: isBulk ? fields.organization.value.trim() : "",
      copies: isBulk ? fields.copies.value : "",
      message: fields.message.value.trim(),
    };
    for (const [key, value] of Object.entries(values)) {
      preview.querySelector(`[data-preview-value="${key}"]`).textContent = value;
    }
    for (const key of ["organization", "copies"]) {
      preview.querySelector(`[data-preview-row="${key}"]`).hidden = !values[key];
    }
    preview.hidden = false;
    status.textContent = "Your inquiry is ready to review below. This demo has not sent or saved your message.";
  }

  // A future FormSubmit delivery adapter requires separate configuration and live-send proof.
  // This preview has no transport, recipient, storage, automatic retry or delivery-success state.
  form.addEventListener("submit", event => {
    event.preventDefault();
    const invalidFields = Object.values(fields).filter(field => !validateField(field));
    if (invalidFields.length) {
      preview.hidden = true;
      status.textContent = "Please check the marked fields. Nothing has been sent.";
      invalidFields[0].focus();
      return;
    }
    showPreview();
  });

  topic.addEventListener("change", () => {
    syncBulkFields();
    markEdited();
  });
  for (const field of Object.values(fields)) {
    field.addEventListener("input", () => {
      if (field.hasAttribute("aria-invalid")) validateField(field);
      markEdited();
    });
  }

  if (new URLSearchParams(window.location.search).get("type") === "bulk") {
    topic.value = "bulk";
  }
  syncBulkFields();
  status.textContent = demoNote;
  form.noValidate = true;
  button.disabled = false;
})();
