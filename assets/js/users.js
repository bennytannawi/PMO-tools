/**
 * PMO Tools — Users page (Super Admin & Admin)
 * Invite people, see everyone with an account, change roles (Super Admin),
 * rename, and remove (Super Admin). All changes go through the
 * manage-users server function, which re-checks the caller's role.
 */
(function () {
  "use strict";

  const session = window.__session;
  if (!session) return;
  UI.initTopbar(session);

  const me = session.user;
  const el = UI.el;

  if (!Roles.canInvite(me)) {
    document.getElementById("no-access").hidden = false;
    return;
  }
  document.getElementById("users-layout").hidden = false;

  const isSuper = Roles.canChangeRoles(me);
  const rows = document.getElementById("user-rows");
  const table = document.getElementById("user-table");
  const listMeta = document.getElementById("list-meta");

  /* ---------- Role guide + invite role options ---------- */
  document.getElementById("role-guide").replaceChildren(...Roles.LIST.map((r) =>
    el("li", {}, [el("strong", { text: Roles.LABELS[r] }), document.createTextNode(Roles.DESCRIPTIONS[r])])));

  const roleSel = document.getElementById("inv-role");
  const roleHint = document.getElementById("inv-role-hint");
  roleSel.replaceChildren(...Roles.invitable(me).map((r) =>
    el("option", { value: r, text: Roles.LABELS[r], selected: r === "member" })));
  const updateRoleHint = () => { roleHint.textContent = Roles.DESCRIPTIONS[roleSel.value] || ""; };
  roleSel.addEventListener("change", updateRoleHint);
  updateRoleHint();

  /* ---------- People list ---------- */
  let users = [];

  function relative(iso) {
    if (!iso) return "";
    return "since " + UI.formatDate(new Date(iso).getTime());
  }

  function roleCell(u, isMe) {
    // Super Admins change roles (not their own); everyone else sees a badge.
    if (!isSuper || isMe) return el("span", { class: "role-badge role-badge--" + u.role, text: Roles.LABELS[u.role] });
    const sel = el("select", { "aria-label": "Role for " + (u.name || u.email) },
      Roles.LIST.map((r) => el("option", { value: r, text: Roles.LABELS[r], selected: r === u.role })));
    sel.addEventListener("change", async () => {
      const to = sel.value;
      if (!confirm("Change " + (u.name || u.email) + " to " + Roles.LABELS[to] + "?\n\n" + Roles.DESCRIPTIONS[to])) {
        sel.value = u.role; return;
      }
      sel.disabled = true;
      try {
        await Auth.adminCall("set_role", { id: u.id, role: to });
        UI.toast((u.name || u.email) + " is now " + Roles.LABELS[to] + ".");
      } catch (e) { UI.toast(e.message); }
      await load();
    });
    return sel;
  }

  function actions(u, isMe) {
    const out = [];
    if (u.status === "invited") out.push(el("button", { type: "button", class: "link-btn", text: "Resend invite",
      onclick: async (e) => {
        const b = e.currentTarget;
        b.disabled = true; b.textContent = "Sending…";
        try {
          await Auth.adminCall("resend", { id: u.id, redirectTo: Auth.resetPageUrl() });
          UI.toast("New invitation link sent to " + u.email + ".");
        } catch (err) { UI.toast(err.message); }
        b.disabled = false; b.textContent = "Resend invite";
      } }));
    const canRename = isSuper || u.role !== "super_admin";
    if (canRename) out.push(el("button", { type: "button", class: "link-btn", text: "Rename",
      onclick: async () => {
        const v = prompt("Display name for " + u.email, u.name || "");
        if (v === null || !v.trim() || v.trim() === u.name) return;
        try { await Auth.adminCall("set_name", { id: u.id, name: v }); UI.toast("Name updated."); }
        catch (e) { UI.toast(e.message); }
        await load();
      } }));
    if (isSuper && !isMe) out.push(el("button", { type: "button", class: "link-btn", style: "color:var(--danger)", text: "Remove",
      onclick: async () => {
        if (!confirm("Remove " + (u.name || u.email) + " from PMO Tools?\n\nThey won't be able to sign in. This can't be undone (you can invite them again).")) return;
        try { await Auth.adminCall("remove", { id: u.id }); UI.toast("Removed " + u.email + "."); }
        catch (e) { UI.toast(e.message); }
        await load();
      } }));
    return el("div", { style: "display:flex;gap:12px;justify-content:flex-end" }, out);
  }

  function render() {
    table.hidden = !users.length;
    const invited = users.filter((u) => u.status === "invited").length;
    listMeta.textContent = users.length + (users.length === 1 ? " person" : " people") +
      (invited ? " · " + invited + " invitation" + (invited === 1 ? "" : "s") + " not yet accepted" : "");
    rows.replaceChildren(...users.map((u) => {
      const isMe = u.email === me.email;
      const name = u.name || u.email.split("@")[0];
      return el("tr", {}, [
        el("td", {}, [el("div", { class: "user-cell" }, [
          el("span", { class: "avatar avatar--sm", style: "background:" + UI.colorFor(name) + ";color:#fff", "aria-hidden": "true", text: UI.initials(name) }),
          el("div", {}, [
            el("div", { class: "user-cell__name", text: name + (isMe ? " (you)" : "") }),
            el("div", { class: "user-cell__email", text: u.email }),
          ]),
        ])]),
        el("td", {}, [roleCell(u, isMe)]),
        el("td", {}, [el("span", { class: "status status--" + u.status,
          text: u.status === "invited" ? "Invited " + relative(u.invitedAt) : "Active" })]),
        el("td", {}, [actions(u, isMe)]),
      ]);
    }));
  }

  async function load() {
    try {
      const r = await Auth.adminCall("list");
      users = r.users || [];
      render();
    } catch (e) {
      listMeta.textContent = "Couldn't load people: " + e.message;
    }
  }

  /* ---------- Invite ---------- */
  const form = document.getElementById("invite-form");
  const nameIn = document.getElementById("inv-name");
  const emailIn = document.getElementById("inv-email");
  const btn = document.getElementById("invite-btn");
  const alertBox = document.getElementById("invite-alert");
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function fieldError(input, msg) {
    document.getElementById(input.id + "-error").textContent = msg || "";
    input.setAttribute("aria-invalid", msg ? "true" : "false");
  }
  function showAlert(msg, type) {
    alertBox.textContent = msg;
    alertBox.className = "alert" + (type === "info" ? " alert--info" : "");
    alertBox.hidden = false;
  }
  [nameIn, emailIn].forEach((i) => i.addEventListener("input", () => { fieldError(i, ""); alertBox.hidden = true; }));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    alertBox.hidden = true;
    const email = emailIn.value.trim().toLowerCase();
    const name = nameIn.value.trim();
    let ok = true;
    if (!name) { fieldError(nameIn, "Enter their name."); ok = false; }
    if (!EMAIL_RE.test(email)) { fieldError(emailIn, "Enter a valid email address."); ok = false; }
    if (!ok) return;
    if (users.some((u) => u.email === email)) { fieldError(emailIn, "This email already has an account."); return; }

    btn.disabled = true;
    btn.classList.add("is-loading");
    btn.querySelector(".btn__label").textContent = "Sending…";
    try {
      await Auth.adminCall("invite", { email, name, role: roleSel.value, redirectTo: Auth.resetPageUrl() });
      showAlert("Invitation sent to " + email + " as " + Roles.LABELS[roleSel.value] + ".", "info");
      form.reset();
      roleSel.value = "member";
      updateRoleHint();
      await load();
    } catch (err) {
      showAlert(err.message);
    } finally {
      btn.disabled = false;
      btn.classList.remove("is-loading");
      btn.querySelector(".btn__label").textContent = "Send invitation";
    }
  });

  load();
})();
