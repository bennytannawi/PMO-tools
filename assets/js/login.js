/**
 * PMO Tools — Login page behaviour
 * Validation, show/hide password, loading state, lockout, and redirect.
 */
(function () {
  "use strict";

  const form = document.getElementById("login-form");
  const email = document.getElementById("email");
  const password = document.getElementById("password");
  const remember = document.getElementById("remember");
  const submitBtn = document.getElementById("submit-btn");
  const toggleBtn = document.getElementById("toggle-password");
  const alertBox = document.getElementById("form-alert");

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const MAX_ATTEMPTS = 5;
  const LOCKOUT_MS = 60 * 1000;
  let failedAttempts = 0;
  let lockedUntil = 0;

  // Already signed in? Go straight to the app.
  if (window.Auth && Auth.getSession()) {
    window.location.replace(nextPage());
    return;
  }

  // Only allow redirects to local .html pages (prevents open-redirects).
  function nextPage() {
    const next = new URLSearchParams(window.location.search).get("next");
    return next && /^[\w-]+\.html$/.test(next) ? next : Auth.config.HOME_PAGE;
  }

  function setFieldError(input, message) {
    const errorEl = document.getElementById(input.id + "-error");
    errorEl.textContent = message || "";
    input.setAttribute("aria-invalid", message ? "true" : "false");
    if (message) input.setAttribute("aria-describedby", errorEl.id);
    else input.removeAttribute("aria-describedby");
  }

  function showAlert(message, type) {
    alertBox.textContent = message;
    alertBox.className = "alert" + (type === "info" ? " alert--info" : "");
    alertBox.hidden = false;
  }

  function hideAlert() { alertBox.hidden = true; }

  function validate() {
    let ok = true;
    const emailVal = email.value.trim();

    if (!emailVal) { setFieldError(email, "Enter your work email."); ok = false; }
    else if (!EMAIL_RE.test(emailVal)) { setFieldError(email, "Enter a valid email address."); ok = false; }
    else setFieldError(email, "");

    if (!password.value) { setFieldError(password, "Enter your password."); ok = false; }
    else if (password.value.length < 8) { setFieldError(password, "Password must be at least 8 characters."); ok = false; }
    else setFieldError(password, "");

    return ok;
  }

  function setLoading(isLoading) {
    submitBtn.disabled = isLoading;
    submitBtn.classList.toggle("is-loading", isLoading);
    submitBtn.querySelector(".btn__label").textContent = isLoading ? "Signing in…" : "Sign in";
  }

  // Clear a field's error as soon as the user edits it.
  [email, password].forEach((input) =>
    input.addEventListener("input", () => {
      if (input.getAttribute("aria-invalid") === "true") setFieldError(input, "");
      hideAlert();
    })
  );

  toggleBtn.addEventListener("click", () => {
    const show = password.type === "password";
    password.type = show ? "text" : "password";
    toggleBtn.textContent = show ? "Hide" : "Show";
    toggleBtn.setAttribute("aria-label", show ? "Hide password" : "Show password");
    toggleBtn.setAttribute("aria-pressed", String(show));
    password.focus();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideAlert();

    if (Date.now() < lockedUntil) {
      const secs = Math.ceil((lockedUntil - Date.now()) / 1000);
      showAlert("Too many failed attempts. Try again in " + secs + " seconds.");
      return;
    }

    if (!validate()) {
      (email.getAttribute("aria-invalid") === "true" ? email : password).focus();
      return;
    }

    setLoading(true);
    try {
      await Auth.login(email.value.trim(), password.value, remember.checked);
      failedAttempts = 0;
      window.location.replace(nextPage());
    } catch (err) {
      failedAttempts += 1;
      password.value = "";
      if (failedAttempts >= MAX_ATTEMPTS) {
        lockedUntil = Date.now() + LOCKOUT_MS;
        failedAttempts = 0;
        showAlert("Too many failed attempts. Please wait 60 seconds before trying again.");
      } else {
        showAlert(err.message || "Sign-in failed. Please try again.");
      }
      password.focus();
    } finally {
      setLoading(false);
    }
  });

  document.getElementById("forgot-link").addEventListener("click", (e) => {
    e.preventDefault();
    showAlert("Password reset isn't set up yet. Please contact your PMO admin to reset your password.", "info");
  });

  document.getElementById("request-access-link").addEventListener("click", (e) => {
    e.preventDefault();
    showAlert("Ask your PMO admin to create an account for your work email.", "info");
  });
})();
