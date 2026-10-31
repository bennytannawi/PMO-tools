/**
 * PMO Tools — Shared helpers for signed-in pages (top bar, toast, small utils).
 */
(function (global) {
  "use strict";

  const PALETTE = ["#4f46e5", "#0e7490", "#b45309", "#15803d", "#be185d", "#7c3aed", "#0369a1", "#c2410c"];

  const UI = {
    initials(name) {
      const parts = String(name || "?").trim().split(/\s+/);
      return ((parts[0] || "?")[0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
    },

    colorFor(text) {
      let h = 0;
      for (const ch of String(text)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      return PALETTE[h % PALETTE.length];
    },

    formatDate(ms) {
      return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    },

    /** Small element builder. Text is always set with textContent (no HTML injection). */
    el(tag, attrs, children) {
      const node = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs || {})) {
        if (v === undefined || v === null || v === false) continue;
        if (k === "text") node.textContent = v;
        else if (k === "class") node.className = v;
        else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? "" : v);
      }
      (children || []).forEach((c) => c && node.append(c));
      return node;
    },

    toast(message) {
      document.querySelectorAll(".toast").forEach((t) => t.remove());
      const t = UI.el("div", { class: "toast", role: "status", text: message });
      document.body.append(t);
      setTimeout(() => t.remove(), 3200);
    },

    /** Fill the top bar's user area and wire Sign out. */
    initTopbar(session) {
      const box = document.getElementById("topbar-user");
      if (!box || !session) return;
      box.append(
        UI.el("span", { class: "name", text: session.user.name }),
        UI.el("span", { class: "avatar", text: UI.initials(session.user.name), title: session.user.email }),
        UI.el("button", { type: "button", class: "button button--ghost button--sm", text: "Sign out", onclick: () => Auth.logout() })
      );
    },
  };

  global.UI = UI;
})(window);
