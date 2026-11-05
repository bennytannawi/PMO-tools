/**
 * PMO Tools — Workspaces page: list workspaces and create new ones.
 */
(function () {
  "use strict";

  const session = window.__session;
  if (!session) return; // requireAuth is redirecting to login
  UI.initTopbar(session);

  const grid = document.getElementById("ws-grid");
  const empty = document.getElementById("ws-empty");
  const subtitle = document.getElementById("ws-subtitle");
  const dialog = document.getElementById("ws-dialog");
  const form = document.getElementById("ws-form");
  const nameInput = document.getElementById("ws-name");
  const nameError = document.getElementById("ws-name-error");
  const counter = document.getElementById("ws-name-counter");
  const createBtn = document.getElementById("ws-create");
  const el = UI.el;
  const canCreate = Roles.canCreateWorkspace(session.user);
  if (!canCreate) {
    document.getElementById("new-ws-btn").hidden = true;
    document.getElementById("empty-new-btn").hidden = true;
    empty.querySelector("h2").textContent = "No workspaces assigned to you yet";
    empty.querySelector("p").textContent = "Ask a Super Admin or Admin to add you to a workspace under Members.";
  }

  function card(ws) {
    const pct = ws.taskCount ? Math.round((ws.completedCount / ws.taskCount) * 100) : 0;
    return el("a", { class: "ws-card", href: "workspace.html?id=" + encodeURIComponent(ws.id) }, [
      el("div", { class: "ws-card__top" }, [
        el("span", { class: "ws-card__icon", style: "background:" + UI.colorFor(ws.name), "aria-hidden": "true", text: UI.initials(ws.name) }),
        el("div", {}, [
          el("div", { class: "ws-card__name", text: ws.name }),
          el("div", { class: "ws-card__meta", text: "Created " + UI.formatDate(ws.createdAt) + (ws.createdBy ? " · " + ws.createdBy : "") }),
        ]),
      ]),
      el("div", { class: "ws-card__stats" }, [
        el("span", {}, [el("strong", { text: String(ws.taskCount) }), document.createTextNode(ws.taskCount === 1 ? " task" : " tasks")]),
        el("span", {}, [el("strong", { text: String(ws.sectionCount) }), document.createTextNode(" sections")]),
        el("span", {}, [el("strong", { text: pct + "%" }), document.createTextNode(" completed")]),
      ]),
      el("div", { class: "progress", role: "progressbar", "aria-valuenow": String(pct), "aria-valuemin": "0", "aria-valuemax": "100", "aria-label": "Completed" }, [
        el("span", { style: "width:" + pct + "%" }),
      ]),
    ]);
  }

  async function render() {
    const list = await Store.listWorkspaces(session.user);
    grid.replaceChildren(...list.map(card));
    empty.hidden = list.length > 0;
    grid.hidden = list.length === 0;
    subtitle.textContent = list.length
      ? list.length + (list.length === 1 ? " workspace" : " workspaces") + " · pick one to open its board."
      : canCreate ? "Pick a workspace to open its board, or create a new one."
        : "You'll see a workspace here once a Super Admin or Admin adds you to it.";
  }

  function setError(msg) {
    nameError.textContent = msg || "";
    nameInput.setAttribute("aria-invalid", msg ? "true" : "false");
  }

  function openDialog() {
    form.reset();
    setError("");
    counter.textContent = "0 / 60";
    dialog.showModal();
    nameInput.focus();
  }

  document.getElementById("new-ws-btn").addEventListener("click", openDialog);
  document.getElementById("empty-new-btn").addEventListener("click", openDialog);
  document.getElementById("ws-cancel").addEventListener("click", () => dialog.close());

  nameInput.addEventListener("input", () => {
    counter.textContent = nameInput.value.length + " / 60";
    if (nameError.textContent) setError("");
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) { setError("Enter a workspace name."); nameInput.focus(); return; }
    createBtn.disabled = true;
    try {
      const ws = await Store.createWorkspace(name, session.user);
      dialog.close();
      await render();
      UI.toast("Workspace “" + ws.name + "” created.");
    } catch (err) {
      setError(err.message);
      nameInput.focus();
    } finally {
      createBtn.disabled = false;
    }
  });

  render();
})();
