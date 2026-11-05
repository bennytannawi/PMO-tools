/**
 * PMO Tools — Set password page
 * Used by two email links from Supabase:
 *   - invitation: a new team member chooses their first password
 *   - password reset: an existing user chooses a new password
 */
(function () {
  "use strict";

  const title = document.getElementById("title");
  const subtitle = document.getElementById("subtitle");
  const form = document.getElementById("password-form");
  const accountLine = document.getElementById("account-line");
  const pw = document.getElementById("new-password");
  const confirmPw = document.getElementById("confirm-password");
  const submitBtn = document.getElementById("submit-btn");
  const toggleBtn = document.getElementById("toggle-password");
  const alertBox = document.getElementById("form-alert");

  function showAlert(message, type) {
    alertBox.textContent = message;
    alertBox.className = "alert" + (type === "info" ? " alert--info" : "");
    alertBox.hidden = false;
  }
  function hideAlert() { alertBox.hidden = true; }

  function setFieldError(input, message) {
    const errorEl = document.getElementById(input.id + "-error");
    errorEl.textContent = message || "";
    input.setAttribute("aria-invalid", message ? "true" : "false");
    if (message) input.setAttribute("aria-describedby", errorEl.id);
    else input.removeAttribute("aria-describedby");
  }

  function setLoading(on) {
    submitBtn.disabled = on;
    submitBtn.classList.toggle("is-loading", on);
    submitBtn.querySelector(".btn__label").textContent = on ? "Saving…" : "Save password";
  }

  function validate() {
    let ok = true;
    if (!pw.value) { setFieldError(pw, "Enter a new password."); ok = false; }
    else if (pw.value.length < 8) { setFieldError(pw, "Use at least 8 characters."); ok = false; }
    else if (!/[A-Za-z]/.test(pw.value) || !/\d/.test(pw.value)) { setFieldError(pw, "Use both letters and numbers."); ok = false; }
    else setFieldError(pw, "");

    if (!confirmPw.value) { setFieldError(confirmPw, "Type the password again."); ok = false; }
    else if (confirmPw.value !== pw.value) { setFieldError(confirmPw, "The passwords don't match."); ok = false; }
    else setFieldError(confirmPw, "");
    return ok;
  }

  [pw, confirmPw].forEach((input) =>
    input.addEventListener("input", () => {
      if (input.getAttribute("aria-invalid") === "true") setFieldError(input, "");
      hideAlert();
    })
  );

  toggleBtn.addEventListener("click", () => {
    const show = pw.type === "password";
    pw.type = show ? "text" : "password";
    toggleBtn.textContent = show ? "Hide" : "Show";
    toggleBtn.setAttribute("aria-label", show ? "Hide password" : "Show password");
    toggleBtn.setAttribute("aria-pressed", String(show));
    pw.focus();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    hideAlert();
    if (!validate()) { (pw.getAttribute("aria-invalid") === "true" ? pw : confirmPw).focus(); return; }
    setLoading(true);
    try {
      await Auth.setPassword(pw.value);
      showAlert("Password saved. Taking you to PMO Tools…", "info");
      setTimeout(() => window.location.replace(Auth.config.HOME_PAGE), 900);
    } catch (err) {
      showAlert(err.message || "Couldn't save your password. Please try again.");
      setLoading(false);
    }
  });

  // Read the link on load.
  (async function init() {
    try {
      const { type, user } = await Auth.readLink();
      if (type === "invite") {
        title.textContent = "Welcome to PMO Tools";
        subtitle.textContent = "Choose a password to activate your account.";
      } else {
        title.textContent = "Set a new password";
        subtitle.textContent = "Choose a new password for your account.";
      }
      accountLine.textContent = "Account: " + user.email;
      form.hidden = false;
      pw.focus();
    } catch (err) {
      title.textContent = "Link not valid";
      subtitle.textContent = "";
      showAlert((err.message || "This link is invalid or has expired.") +
        " Links work once and expire after a while. Go back to sign in and use “Forgot password?” to get a new one, or ask your PMO admin to resend your invitation.");
    }
  })();
})();
