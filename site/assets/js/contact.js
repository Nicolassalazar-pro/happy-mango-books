(() => {
  "use strict";

  const form = document.querySelector("[data-inquiry-form]");
  if (!form) return;

  const topic = form.querySelector("#inquiry-type");
  const bulkFields = form.querySelector("[data-bulk-fields]");
  const button = form.querySelector("[data-send-inquiry]");
  const status = form.querySelector("[data-form-status]");
  const preview = document.querySelector("[data-inquiry-preview]");
  const subject = form.querySelector('[name="_subject"]');
  const honey = form.querySelector('[name="_honey"]');
  const fields = {
    name: form.querySelector("#inquiry-name"),
    email: form.querySelector("#inquiry-email"),
    organization: form.querySelector("#inquiry-organization"),
    copies: form.querySelector("#inquiry-copies"),
    message: form.querySelector("#inquiry-message"),
  };
  let state = "idle";

  function setState(next, message) {
    state = next;
    form.dataset.inquiryState = next;
    form.setAttribute("aria-busy", String(next === "sending"));
    button.disabled = ["sending", "accepted", "uncertain"].includes(next);
    button.textContent = next === "sending" ? "Sending..." : next === "accepted" ? "Inquiry submitted" :
      next === "uncertain" ? "Status unconfirmed" : next === "error" ? "Try sending again" : "Send inquiry";
    topic.disabled = next === "sending";
    Object.values(fields).forEach(field => { field.readOnly = next === "sending"; });
    status.textContent = message;
  }

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
    if (state === "sending" || state === "uncertain") return;
    const submitted = state === "accepted" || !preview.hidden;
    preview.hidden = true;
    setState("idle", submitted ? "You changed this inquiry. Sending again creates a new submission." :
      "Send your question to info@happymangobooks.com.");
  }

  function syncBulkFields() {
    const isBulk = topic.value === "bulk";
    bulkFields.disabled = !isBulk;
    bulkFields.hidden = !isBulk;
    subject.value = `Happy Mango Books - ${isBulk ? "Bulk order inquiry" : "General inquiry"}`;
    clearError(fields.organization);
    clearError(fields.copies);
  }

  function values() {
    const isBulk = topic.value === "bulk";
    return {
      topic: isBulk ? "A bulk-order request" : "A general inquiry",
      name: fields.name.value.trim(),
      email: fields.email.value.trim(),
      organization: isBulk ? fields.organization.value.trim() : "",
      copies: isBulk ? fields.copies.value : "",
      message: fields.message.value.trim(),
    };
  }

  function showSummary(submitted) {
    for (const [key, value] of Object.entries(submitted)) {
      preview.querySelector(`[data-preview-value="${key}"]`).textContent = value;
    }
    for (const key of ["organization", "copies"]) {
      preview.querySelector(`[data-preview-row="${key}"]`).hidden = !submitted[key];
    }
    preview.hidden = false;
  }

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (["sending", "accepted", "uncertain"].includes(state)) return;
    if (honey.value) {
      setState("error", "This inquiry could not be submitted. Please use the email link instead.");
      return;
    }
    const invalidFields = Object.values(fields).filter(field => !validateField(field));
    if (invalidFields.length) {
      preview.hidden = true;
      setState("error", "Please check the marked fields. Nothing has been sent.");
      invalidFields[0].focus();
      return;
    }
    const submitted = values();
    const payload = Object.fromEntries(new FormData(form));
    payload.name = submitted.name;
    payload.email = submitted.email;
    payload.message = submitted.message;
    if (topic.value === "bulk") {
      payload.organization = submitted.organization;
      payload.estimated_copies = submitted.copies;
    }
    preview.hidden = true;
    setState("sending", "Sending your inquiry...");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(form.dataset.inquiryEndpoint, {
        method: "POST",
        headers: { "Accept": "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Unconfirmed submission");
      const result = await response.json();
      if (result?.success === true || result?.success === "true") {
        showSummary(submitted);
        setState("accepted", "Thank you. FormSubmit accepted your inquiry for Happy Mango Books. A copy is shown below.");
      } else if (result?.success === false || result?.success === "false") {
        setState("error", "The form service did not accept your inquiry. Your message is still here. Please email info@happymangobooks.com if this continues.");
      } else {
        throw new Error("Unconfirmed submission");
      }
    } catch {
      // A timeout or lost response can happen after acceptance; never resend automatically.
      setState("uncertain", "We could not confirm whether your inquiry was submitted. Your message is still here. Please email info@happymangobooks.com before sending it again.");
    } finally {
      clearTimeout(timer);
    }
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
  form.noValidate = true;
  setState("idle", "Send your question to info@happymangobooks.com.");
})();
