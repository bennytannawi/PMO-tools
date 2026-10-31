/**
 * PMO Tools — Workspace board (kanban)
 * Default sections: To do, In progress, Review, Completed, plus custom sections.
 * Tasks: add, edit, delete, drag & drop between/within sections
 * (or move via the task dialog on touch devices / keyboard).
 */
(function () {
  "use strict";

  const session = window.__session;
  if (!session) return;
  UI.initTopbar(session);

  const el = UI.el;
  const board = document.getElementById("board");
  const titleEl = document.getElementById("ws-title");
  const statsEl = document.getElementById("ws-stats");
  const wsId = new URLSearchParams(location.search).get("id");

  const DEFAULT_COLORS = ["var(--sec-todo)", "var(--sec-progress)", "var(--sec-review)", "var(--sec-done)"];

  let ws = null;
  const ui = { addTaskIn: null, addingSection: false, renaming: null, menuOpen: null };
  let dragId = null;

  /* ---------- Load ---------- */
  async function load() {
    try {
      ws = await Store.getWorkspace(wsId);
    } catch (e) {
      titleEl.textContent = "Workspace not found";
      document.title = "Not found · PMO Tools";
      board.replaceChildren(el("div", { class: "empty", style: "flex:1" }, [
        el("h2", { text: "This workspace doesn't exist" }),
        el("p", { text: "It may have been removed, or the link is incomplete." }),
        el("a", { class: "button button--primary", href: "workspaces.html", text: "Back to workspaces" }),
      ]));
      return false;
    }
    return true;
  }

  async function refresh() { if (await load()) render(); }

  async function run(action) {
    try { await action(); }
    catch (err) { UI.toast(err.message || "Something went wrong."); }
    await refresh();
  }

  /* ---------- Render ---------- */
  function render() {
    titleEl.textContent = ws.name;
    document.title = ws.name + " · PMO Tools";
    const total = ws.sections.reduce((n, s) => n + s.tasks.length, 0);
    const done = ws.sections.filter((s) => s.isDone).reduce((n, s) => n + s.tasks.length, 0);
    statsEl.textContent = total + (total === 1 ? " task" : " tasks") + " · " + done + " completed";

    let defaultIdx = 0;
    const cols = ws.sections.map((s) => column(s, s.isDefault ? DEFAULT_COLORS[defaultIdx++] : "var(--sec-custom)"));
    cols.push(addSectionColumn());
    board.replaceChildren(...cols);

    const focus = board.querySelector("[data-autofocus]");
    if (focus) focus.focus();
  }

  function column(section, color) {
    const cards = el("div", { class: "column__cards", "data-section": section.id },
      section.tasks.map((t) => taskCard(t)));
    wireDrop(cards, section.id);

    return el("section", { class: "column", style: "--dot:" + color, "data-done": String(!!section.isDone), "aria-label": section.name }, [
      columnHead(section),
      cards,
      el("div", { class: "column__foot" }, [
        ui.addTaskIn === section.id ? addTaskForm(section) :
          el("button", { type: "button", class: "add-btn", onclick: () => { ui.addTaskIn = section.id; render(); } }, [
            el("span", { class: "button__plus", "aria-hidden": "true", text: "+" }), document.createTextNode("Add task"),
          ]),
      ]),
    ]);
  }

  function columnHead(section) {
    if (ui.renaming === section.id) {
      return el("div", { class: "column__head" }, [inlineForm({
        value: section.name, maxlength: 60, placeholder: "Section name", submitLabel: "Save",
        onSubmit: (v) => run(async () => { await Store.renameSection(ws.id, section.id, v); ui.renaming = null; }),
        onCancel: () => { ui.renaming = null; render(); },
      })]);
    }
    const head = el("div", { class: "column__head" }, [
      el("span", { class: "column__dot", "aria-hidden": "true" }),
      el("h2", { class: "column__name", style: "margin:0;font-size:14px", text: section.name, title: section.name }),
      el("span", { class: "column__count", text: String(section.tasks.length), "aria-label": section.tasks.length + " tasks" }),
    ]);
    if (!section.isDefault) head.append(sectionMenu(section));
    return head;
  }

  function sectionMenu(section) {
    const open = ui.menuOpen === section.id;
    return el("div", { class: "menu" + (open ? " is-open" : "") }, [
      el("button", {
        type: "button", class: "icon-btn", "aria-label": "Section options for " + section.name, "aria-expanded": String(open),
        text: "⋯", onclick: (e) => { e.stopPropagation(); ui.menuOpen = open ? null : section.id; render(); },
      }),
      el("div", { class: "menu__list", role: "menu" }, [
        el("button", { type: "button", role: "menuitem", text: "Rename section",
          onclick: () => { ui.menuOpen = null; ui.renaming = section.id; render(); } }),
        el("button", { type: "button", role: "menuitem", class: "danger", text: "Delete section",
          onclick: () => {
            ui.menuOpen = null;
            const n = section.tasks.length;
            const msg = n
              ? "Delete “" + section.name + "”? Its " + n + (n === 1 ? " task" : " tasks") + " will move to “" + ws.sections[0].name + "”."
              : "Delete “" + section.name + "”?";
            if (confirm(msg)) run(() => Store.deleteSection(ws.id, section.id));
            else render();
          } }),
      ]),
    ]);
  }

  function taskCard(task) {
    const btn = el("button", {
      type: "button", class: "task", draggable: "true", "data-task": task.id,
      onclick: () => openTask(task.id),
      ondragstart: (e) => {
        dragId = task.id;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", task.id);
        requestAnimationFrame(() => btn.classList.add("is-dragging"));
      },
      ondragend: () => { dragId = null; btn.classList.remove("is-dragging"); clearMarkers(); },
    }, [el("span", { class: "task__title", text: task.title })]);
    if (task.description) {
      const d = task.description.length > 90 ? task.description.slice(0, 90) + "…" : task.description;
      btn.append(el("span", { class: "task__desc", text: d }));
    }
    return btn;
  }

  function addTaskForm(section) {
    return inlineForm({
      multiline: true, maxlength: 200, placeholder: "What needs to be done?", submitLabel: "Add task",
      onSubmit: (v) => run(async () => {
        await Store.addTask(ws.id, section.id, v, session.user.name);
        ui.addTaskIn = section.id; // keep open to add several in a row
      }),
      onCancel: () => { ui.addTaskIn = null; render(); },
    });
  }

  function addSectionColumn() {
    const col = el("section", { class: "column column--add", "aria-label": "Add section" });
    if (ui.addingSection) {
      col.append(inlineForm({
        maxlength: 60, placeholder: "Section name, e.g. Blocked", submitLabel: "Add section",
        onSubmit: (v) => run(async () => { await Store.addSection(ws.id, v); ui.addingSection = false; }),
        onCancel: () => { ui.addingSection = false; render(); },
      }));
    } else {
      col.append(el("button", { type: "button", class: "add-btn", onclick: () => { ui.addingSection = true; render(); } }, [
        el("span", { class: "button__plus", "aria-hidden": "true", text: "+" }), document.createTextNode("Add section"),
      ]));
    }
    return col;
  }

  /** Inline input with Save/Cancel. Enter saves, Esc cancels; errors show inline. */
  function inlineForm(opts) {
    const input = opts.multiline
      ? el("textarea", { rows: "2", maxlength: String(opts.maxlength), placeholder: opts.placeholder, "data-autofocus": true })
      : el("input", { type: "text", maxlength: String(opts.maxlength), placeholder: opts.placeholder, "data-autofocus": true, autocomplete: "off" });
    if (opts.value) input.value = opts.value;
    const err = el("p", { class: "field__error" });

    const submit = () => {
      const v = input.value.trim();
      if (!v) { err.textContent = "Enter a name first."; input.focus(); return; }
      opts.onSubmit(v);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
      if (e.key === "Escape") { e.preventDefault(); opts.onCancel(); }
    });
    input.addEventListener("input", () => { err.textContent = ""; });

    return el("div", { class: "inline-form", style: "width:100%" }, [
      input, err,
      el("div", { class: "inline-form__actions" }, [
        el("button", { type: "button", class: "button button--primary button--sm", text: opts.submitLabel, onclick: submit }),
        el("button", { type: "button", class: "button button--ghost button--sm", text: "Cancel", onclick: opts.onCancel }),
      ]),
    ]);
  }

  /* ---------- Drag & drop ---------- */
  function clearMarkers() {
    board.querySelectorAll(".drop-marker").forEach((m) => m.remove());
    board.querySelectorAll(".column.is-over").forEach((c) => c.classList.remove("is-over"));
  }

  /** Index among the other cards (dragged card excluded) where the drop lands. */
  function dropIndex(container, y) {
    const cards = [...container.querySelectorAll(".task")].filter((c) => c.dataset.task !== dragId);
    const i = cards.findIndex((c) => { const r = c.getBoundingClientRect(); return y < r.top + r.height / 2; });
    return { index: i === -1 ? cards.length : i, before: i === -1 ? null : cards[i] };
  }

  function wireDrop(container, sectionId) {
    container.addEventListener("dragover", (e) => {
      if (!dragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const { before } = dropIndex(container, e.clientY);
      board.querySelectorAll(".drop-marker").forEach((m) => m.remove());
      board.querySelectorAll(".column.is-over").forEach((c) => c !== container.parentElement && c.classList.remove("is-over"));
      container.parentElement.classList.add("is-over");
      const marker = el("div", { class: "drop-marker", "aria-hidden": "true" });
      before ? container.insertBefore(marker, before) : container.append(marker);
    });
    container.addEventListener("dragleave", (e) => {
      if (!container.contains(e.relatedTarget)) { container.parentElement.classList.remove("is-over"); container.querySelectorAll(".drop-marker").forEach((m) => m.remove()); }
    });
    container.addEventListener("drop", (e) => {
      if (!dragId) return;
      e.preventDefault();
      const { index } = dropIndex(container, e.clientY);
      const id = dragId;
      dragId = null;
      clearMarkers();
      run(() => Store.moveTask(ws.id, id, sectionId, index));
    });
  }

  /* ---------- Task dialog ---------- */
  const dialog = document.getElementById("task-dialog");
  const tForm = document.getElementById("task-form");
  const tTitle = document.getElementById("task-title");
  const tTitleErr = document.getElementById("task-title-error");
  const tDesc = document.getElementById("task-desc");
  const tSection = document.getElementById("task-section");
  let editingId = null;

  function openTask(taskId) {
    const section = ws.sections.find((s) => s.tasks.some((t) => t.id === taskId));
    const task = section.tasks.find((t) => t.id === taskId);
    editingId = taskId;
    tTitle.value = task.title;
    tDesc.value = task.description || "";
    tTitleErr.textContent = "";
    tTitle.setAttribute("aria-invalid", "false");
    tSection.replaceChildren(...ws.sections.map((s) => el("option", { value: s.id, text: s.name, selected: s.id === section.id })));
    dialog.showModal();
    tTitle.focus();
  }

  document.getElementById("task-cancel").addEventListener("click", () => dialog.close());
  tTitle.addEventListener("input", () => { tTitleErr.textContent = ""; tTitle.setAttribute("aria-invalid", "false"); });

  tForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!tTitle.value.trim()) { tTitleErr.textContent = "Enter a task name."; tTitle.setAttribute("aria-invalid", "true"); tTitle.focus(); return; }
    const id = editingId;
    const current = ws.sections.find((s) => s.tasks.some((t) => t.id === id));
    dialog.close();
    run(async () => {
      await Store.updateTask(ws.id, id, { title: tTitle.value, description: tDesc.value });
      if (tSection.value !== current.id) await Store.moveTask(ws.id, id, tSection.value);
    });
  });

  document.getElementById("task-delete").addEventListener("click", () => {
    if (!confirm("Delete this task? This can't be undone.")) return;
    const id = editingId;
    dialog.close();
    run(() => Store.deleteTask(ws.id, id));
  });

  // Close an open section menu when clicking elsewhere.
  document.addEventListener("click", (e) => {
    if (ui.menuOpen && !e.target.closest(".menu")) { ui.menuOpen = null; render(); }
  });

  refresh();
})();
