/**
 * PMO Tools — Workspace board (kanban)
 * Default sections: To do, In progress, Review, Completed, plus custom sections.
 * Tasks: add, edit, delete, drag & drop between/within sections
 * (or move via the task dialog on touch devices / keyboard).
 * Task details: project (= board name), PIC, description, subtasks/checklist,
 * time-stamped comments (workspace members only), Google Drive folder (set by PIC).
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
    renderMemberAvatars();

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

    const badges = [];
    const subs = task.subtasks || [];
    if (subs.length) {
      const doneN = subs.filter((x) => x.done).length;
      badges.push(el("span", { class: "badge" + (doneN === subs.length ? " badge--done" : ""), title: "Subtasks done",
        text: "☑ " + doneN + "/" + subs.length }));
    }
    const nC = (task.comments || []).length;
    if (nC) badges.push(el("span", { class: "badge", title: nC + (nC === 1 ? " comment" : " comments"), text: "💬 " + nC }));
    if (task.driveUrl) badges.push(el("span", { class: "badge badge--drive", title: "Google Drive folder linked", text: "Drive" }));
    const pic = task.assignee
      ? el("span", { class: "avatar avatar--xs", style: "background:" + UI.colorFor(task.assignee.name) + ";color:#fff",
          title: "PIC: " + task.assignee.name, text: UI.initials(task.assignee.name) })
      : null;
    if (badges.length || pic) {
      btn.append(el("span", { class: "task__foot" }, [el("span", { class: "task__badges" }, badges), pic]));
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

  /* ---------- Members ---------- */
  const me = session.user;
  const membersBtn = document.getElementById("members-btn");
  const membersAvatars = document.getElementById("members-avatars");
  const mDialog = document.getElementById("members-dialog");
  const mList = document.getElementById("member-list");
  const mAdd = document.getElementById("member-add");

  function avatar(name, cls) {
    return el("span", { class: "avatar " + (cls || ""), style: "background:" + UI.colorFor(name) + ";color:#fff",
      text: UI.initials(name), title: name, "aria-hidden": "true" });
  }

  function renderMemberAvatars() {
    const shown = ws.members.slice(0, 4).map((m) => avatar(m.name, "avatar--sm"));
    if (ws.members.length > 4) shown.push(el("span", { class: "avatar avatar--sm avatar--more", text: "+" + (ws.members.length - 4) }));
    membersAvatars.replaceChildren(...shown);
    membersBtn.setAttribute("aria-label", "Workspace members: " + ws.members.length);
  }

  function renderMembersDialog() {
    const canManage = Store.canManageMembers(ws, me);
    mList.replaceChildren(...ws.members.map((m) => el("li", { class: "member" }, [
      avatar(m.name, "avatar--sm"),
      el("div", { class: "member__who" }, [
        el("div", { class: "member__name", text: m.name + (Store.samePerson(m, me) ? " (you)" : "") }),
        el("div", { class: "member__email", text: m.email || "No email on file" }),
      ]),
      canManage && ws.members.length > 1 ? el("button", { type: "button", class: "icon-btn", "aria-label": "Remove " + m.name, text: "✕",
        onclick: async () => {
          if (!confirm("Remove " + m.name + " from this workspace? Tasks where they are PIC become unassigned.")) return;
          try {
            const r = await Store.removeMember(ws.id, m, me);
            if (r.unassigned) UI.toast(r.unassigned + (r.unassigned === 1 ? " task is" : " tasks are") + " now unassigned.");
          } catch (err) { UI.toast(err.message); }
          await refresh(); renderMembersDialog();
        } }) : null,
    ])));

    if (!canManage) {
      mAdd.replaceChildren(el("p", { class: "hint", text: "Only workspace members can add people." }));
      return;
    }
    const name = el("input", { type: "text", maxlength: "80", placeholder: "Name", autocomplete: "off", "aria-label": "Member name" });
    const email = el("input", { type: "email", maxlength: "120", placeholder: "email@company.com", autocomplete: "off", "aria-label": "Member email" });
    const err = el("p", { class: "field__error" });
    const submit = async () => {
      try {
        await Store.addMember(ws.id, { name: name.value, email: email.value }, me);
        await refresh(); renderMembersDialog();
        mAdd.querySelector("input").focus();
      } catch (e2) { err.textContent = e2.message; }
    };
    [name, email].forEach((i) => i.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }));
    [name, email].forEach((i) => i.addEventListener("input", () => { err.textContent = ""; }));
    mAdd.replaceChildren(el("div", { class: "member-add" }, [
      el("h3", { text: "Add a member" }),
      el("div", { class: "member-add__row" }, [name, email,
        el("button", { type: "button", class: "button button--primary button--sm", text: "Add", onclick: submit })]),
      err,
    ]));
  }

  membersBtn.addEventListener("click", () => { renderMembersDialog(); mDialog.showModal(); });
  document.getElementById("members-done").addEventListener("click", () => mDialog.close());

  /* ---------- Task dialog ---------- */
  const dialog = document.getElementById("task-dialog");
  const tForm = document.getElementById("task-form");
  const tProject = document.getElementById("task-project");
  const tTitle = document.getElementById("task-title");
  const tTitleErr = document.getElementById("task-title-error");
  const tDesc = document.getElementById("task-desc");
  const tSection = document.getElementById("task-section");
  const tPic = document.getElementById("task-pic");
  const tPicHint = document.getElementById("task-pic-hint");
  const tMeta = document.getElementById("task-meta");
  const subList = document.getElementById("sub-list");
  const subInput = document.getElementById("sub-input");
  const subProgress = document.getElementById("sub-progress");
  const subBar = document.getElementById("sub-bar");
  const cmtList = document.getElementById("cmt-list");
  const cmtCount = document.getElementById("cmt-count");
  const cmtComposer = document.getElementById("cmt-composer");
  const driveBox = document.getElementById("drive-box");
  let editingId = null;

  function currentTask() {
    for (const s of ws.sections) {
      const t = s.tasks.find((x) => x.id === editingId);
      if (t) return { task: t, section: s };
    }
    return null;
  }

  function formatStamp(ms) {
    return new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function relative(ms) {
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    const h = Math.round(m / 60);
    if (h < 24) return h + (h === 1 ? " hour ago" : " hours ago");
    return null;
  }

  /** Run a "saves instantly" action, then redraw the board and the live parts of the dialog. */
  async function live(action) {
    try { await action(); }
    catch (err) { UI.toast(err.message || "Something went wrong."); }
    await refresh();
    if (dialog.open && currentTask()) renderLive();
    else if (dialog.open) dialog.close();
  }

  function renderLive() {
    const { task } = currentTask();
    renderSubtasks(task);
    renderComments(task);
    renderDrive(task);
  }

  /* Subtasks */
  function renderSubtasks(task) {
    const subs = task.subtasks;
    const doneN = subs.filter((x) => x.done).length;
    subProgress.textContent = subs.length ? doneN + " of " + subs.length + " done" : "";
    subBar.hidden = !subs.length;
    subBar.firstElementChild.style.width = (subs.length ? Math.round(doneN / subs.length * 100) : 0) + "%";
    subList.replaceChildren(...subs.map((sub) => {
      const box = el("input", { type: "checkbox", id: "sub-" + sub.id, checked: sub.done,
        onchange: () => live(() => Store.updateSubtask(ws.id, task.id, sub.id, { done: box.checked })) });
      return el("li", { class: "checklist__item" + (sub.done ? " is-done" : "") }, [
        box,
        el("label", { for: "sub-" + sub.id, text: sub.title }),
        el("button", { type: "button", class: "icon-btn", "aria-label": "Rename subtask " + sub.title, title: "Rename", text: "✎",
          onclick: () => {
            const v = prompt("Rename subtask", sub.title);
            if (v !== null && v.trim() && v.trim() !== sub.title) live(() => Store.updateSubtask(ws.id, task.id, sub.id, { title: v }));
          } }),
        el("button", { type: "button", class: "icon-btn", "aria-label": "Delete subtask " + sub.title, title: "Delete", text: "✕",
          onclick: () => live(() => Store.deleteSubtask(ws.id, task.id, sub.id)) }),
      ]);
    }));
  }

  function addSubtask() {
    const v = subInput.value.trim();
    if (!v) { subInput.focus(); return; }
    subInput.value = "";
    live(() => Store.addSubtask(ws.id, editingId, v)).then(() => subInput.focus());
  }
  document.getElementById("sub-add").addEventListener("click", addSubtask);
  subInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addSubtask(); } });

  /* Comments */
  function renderComments(task) {
    const n = task.comments.length;
    cmtCount.textContent = n ? String(n) : "";
    cmtList.replaceChildren(...(n ? task.comments.map((c) => {
      const mine = Store.samePerson(c.author, me);
      const rel = relative(c.createdAt);
      return el("li", { class: "comment" }, [
        avatar(c.author.name, "avatar--sm"),
        el("div", { class: "comment__body" }, [
          el("div", { class: "comment__head" }, [
            el("strong", { text: c.author.name }),
            el("time", { datetime: new Date(c.createdAt).toISOString(), title: formatStamp(c.createdAt),
              text: formatStamp(c.createdAt) + (rel ? " · " + rel : "") }),
            mine || me.role === "admin" ? el("button", { type: "button", class: "link-btn", text: "Delete",
              onclick: () => { if (confirm("Delete this comment?")) live(() => Store.deleteComment(ws.id, task.id, c.id, me)); } }) : null,
          ]),
          el("p", { class: "comment__text", text: c.text }),
        ]),
      ]);
    }) : [el("li", { class: "comments__empty", text: "No comments yet." })]));

    if (!Store.isMember(ws, me) && me.role !== "admin") {
      cmtComposer.replaceChildren(el("p", { class: "hint", text: "Only members of this workspace can comment. Ask a member to add you under Members." }));
      return;
    }
    const box = el("textarea", { rows: "2", maxlength: "2000", placeholder: "Write a comment… (Ctrl+Enter to post)", "aria-label": "New comment" });
    const post = () => {
      const v = box.value.trim();
      if (!v) { box.focus(); return; }
      live(() => Store.addComment(ws.id, task.id, v, me));
    };
    box.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); post(); } });
    cmtComposer.replaceChildren(el("div", { class: "comment-new" }, [
      avatar(me.name, "avatar--sm"),
      el("div", { class: "comment-new__box" }, [box,
        el("button", { type: "button", class: "button button--primary button--sm", text: "Post comment", onclick: post })]),
    ]));
  }

  /* Google Drive folder */
  function renderDrive(task) {
    const canEdit = Store.canSetDrive(task, me);
    const nodes = [];
    if (task.driveUrl) {
      nodes.push(el("a", { class: "button button--drive", href: task.driveUrl, target: "_blank", rel: "noopener noreferrer" }, [
        driveIcon(), document.createTextNode("Open Google Drive folder"),
      ]));
    } else {
      nodes.push(el("p", { class: "hint", text: task.assignee ? "No folder linked yet." : "Assign a PIC — the PIC links the folder." }));
    }
    if (canEdit) {
      const input = el("input", { type: "url", placeholder: "https://drive.google.com/drive/folders/…", value: task.driveUrl || "",
        "aria-label": "Google Drive folder link", autocomplete: "off" });
      const err = el("p", { class: "field__error" });
      input.addEventListener("input", () => { err.textContent = ""; });
      const save = async () => {
        try { await Store.setTaskDrive(ws.id, task.id, input.value, me); UI.toast(input.value.trim() ? "Drive folder linked." : "Drive link removed."); }
        catch (e) { err.textContent = e.message; return; }
        await refresh(); if (currentTask()) renderLive();
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); save(); } });
      nodes.push(el("div", { class: "drive-edit" }, [input,
        el("button", { type: "button", class: "button button--ghost button--sm", text: task.driveUrl ? "Update" : "Link", onclick: save })]), err);
    } else if (task.assignee) {
      nodes.push(el("p", { class: "hint", text: "Only the PIC (" + task.assignee.name + ") can change this link." }));
    }
    driveBox.replaceChildren(...nodes);
  }

  function driveIcon() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", "16"); svg.setAttribute("height", "16"); svg.setAttribute("aria-hidden", "true");
    [["M8 3h8l6 10h-8z", "#FBBC04"], ["M2 17l4-7 4 7-3 5z", "#0F9D58"], ["M7 21l3-4h12l-3 4z", "#4285F4"]].forEach(([d, c]) => {
      const p = document.createElementNS(ns, "path"); p.setAttribute("d", d); p.setAttribute("fill", c); svg.append(p);
    });
    return svg;
  }

  /* Open / save */
  function fillPicOptions(task) {
    const opts = [el("option", { value: "", text: "Unassigned" })];
    ws.members.forEach((m, i) => opts.push(el("option", { value: String(i), text: m.name,
      selected: !!task.assignee && Store.samePerson(m, task.assignee) })));
    tPic.replaceChildren(...opts);
    tPicHint.textContent = ws.members.length ? "" : "Add members first (Members button, top right).";
  }

  function openTask(taskId) {
    editingId = taskId;
    const { task, section } = currentTask();
    tProject.value = ws.name;
    tTitle.value = task.title;
    tDesc.value = task.description || "";
    tTitleErr.textContent = "";
    tTitle.setAttribute("aria-invalid", "false");
    subInput.value = "";
    tSection.replaceChildren(...ws.sections.map((s) => el("option", { value: s.id, text: s.name, selected: s.id === section.id })));
    fillPicOptions(task);
    tMeta.textContent = "Created " + formatStamp(task.createdAt) + (task.createdBy ? " by " + task.createdBy : "");
    renderLive();
    dialog.showModal();
    tTitle.focus();
  }

  document.getElementById("task-cancel").addEventListener("click", () => dialog.close());
  document.getElementById("task-close").addEventListener("click", () => dialog.close());
  tTitle.addEventListener("input", () => { tTitleErr.textContent = ""; tTitle.setAttribute("aria-invalid", "false"); });

  tForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!tTitle.value.trim()) { tTitleErr.textContent = "Enter a task name."; tTitle.setAttribute("aria-invalid", "true"); tTitle.focus(); return; }
    const id = editingId;
    const current = currentTask().section;
    const assignee = tPic.value === "" ? null : ws.members[Number(tPic.value)];
    dialog.close();
    run(async () => {
      await Store.updateTask(ws.id, id, { title: tTitle.value, description: tDesc.value, assignee });
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
