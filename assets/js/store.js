/**
 * PMO Tools — Data store (workspaces, sections, tasks) — Supabase
 *
 * The only file that reads/writes workspace data. Pages call the async
 * Store.* methods. Everything is saved in Supabase, so every device and every
 * teammate sees the same boards, and changes appear live (Store.subscribe).
 *
 * Storage
 *   table  public.workspaces   one row per workspace; the board is in `doc`
 *   bucket attachments         files at <workspace id>/<file id>
 *
 * Safe concurrent edits: each change reads the latest board, applies the
 * change, and saves only if nobody saved in between (version check);
 * otherwise it re-reads and re-applies (up to a few times).
 *
 * Permissions follow the user's role (Roles in auth.js) and workspace
 * membership. The same rules are enforced by Supabase Row Level Security
 * (see supabase/migrations), so they can't be bypassed from the browser.
 */
(function (global) {
  "use strict";

  const CONFIG = {
    TABLE: "workspaces",
    BUCKET: "attachments",
    DEFAULT_SECTIONS: ["To do", "In progress", "Review", "Completed"],
    MAX_NAME: 60,
    MAX_TASK_TITLE: 200,
    MAX_SUBTASK: 200,
    MAX_COMMENT: 2000,
    MAX_FILE_MB: 10,          // per file
    MAX_FILES_PER_POST: 5,    // per comment / per upload
    // Old per-browser storage (before Supabase) — read only, for the one-time import.
    LOCAL_KEY: "pmo_data_v1",
    LOCAL_FILES_DB: "pmo_files_v1",
    IMPORTED_KEY: "pmo_imported_v1",
  };

  const sb = () => global.Auth.client();
  const clone = (x) => JSON.parse(JSON.stringify(x === undefined ? null : x));

  function uid(prefix) {
    return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function clean(name, max) {
    return String(name || "").replace(/\s+/g, " ").trim().slice(0, max);
  }

  /* ---------- Errors from Supabase → friendly messages ---------- */
  function dbError(err, fallback) {
    const msg = String((err && err.message) || "");
    const code = err && err.code;
    if (code === "23505") return new Error("A workspace with this name already exists.");
    if (code === "42501" || /row-level security|permission denied/i.test(msg)) {
      return new Error(/members/i.test(msg) ? msg : "You don't have permission to do that.");
    }
    if (/JWT|token|not authenticated/i.test(msg)) return new Error("Your session has ended. Please sign in again.");
    if (/failed to fetch|network|load failed/i.test(msg)) return new Error("Can't reach the server. Check your connection and try again.");
    if (/^(Enter|Only|This board)/.test(msg)) return new Error(msg);
    return new Error(fallback || "Couldn't save. Please try again.");
  }

  function findSection(ws, sectionId) {
    const s = ws.sections.find((x) => x.id === sectionId);
    if (!s) throw new Error("Section not found.");
    return s;
  }

  function findTask(ws, taskId) {
    for (const s of ws.sections) {
      const i = s.tasks.findIndex((t) => t.id === taskId);
      if (i > -1) return { section: s, index: i, task: s.tasks[i] };
    }
    throw new Error("Task not found.");
  }

  /* ---------- People & permissions ---------- */
  function person(u) {
    return { name: clean(u && u.name, 80), email: String((u && u.email) || "").trim().toLowerCase() };
  }

  /** Same person? Match by email; fall back to name for older records with no email. */
  function samePerson(a, b) {
    if (!a || !b) return false;
    if (a.email && b.email) return a.email === String(b.email).toLowerCase();
    return !!a.name && a.name === b.name;
  }

  /* Roles (see Roles in auth.js):
   *   super_admin  every workspace; edits everything
   *   admin        assigned workspaces; edits all cards; manages members; moderates
   *   member       assigned workspaces; edits all cards
   *   guest        assigned workspaces; view only
   * "Assigned" = listed in the workspace's Members. */
  const R = () => global.Roles;
  function me(actor) {
    if (actor && typeof actor === "object" && actor.email) return actor;
    const s = global.Auth && global.Auth.getSession();
    return s ? s.user : null;
  }
  function isMember(ws, user) { return ws.members.some((m) => samePerson(m, user)); }
  function isAdmin(user) { return !!user && R().canModerate(user); } // can delete others' comments/files
  function canView(ws, user) { return !!user && (R().seesAllWorkspaces(user) || isMember(ws, user)); }
  function canEdit(ws, user) { return canView(ws, user) && R().canEditCards(user); }
  function canManageMembers(ws, user) { return canView(ws, user) && R().canManageWorkspaceMembers(user); }

  function requireView(ws, user) {
    if (!canView(ws, user)) throw new Error("You don't have access to this workspace.");
  }
  function requireEdit(ws, user) {
    requireView(ws, user);
    if (!R().canEditCards(user)) throw new Error("Guests can view only. Ask an Admin if you need to make changes.");
  }

  /** Fill in fields added after a workspace was first saved (older data). */
  function normalise(ws) {
    if (!Array.isArray(ws.members)) {
      ws.members = ws.createdBy ? [{ name: ws.createdBy, email: "" }] : [];
    }
    if (!Array.isArray(ws.sections)) ws.sections = [];
    ws.sections.forEach((s) => {
      if (!Array.isArray(s.tasks)) s.tasks = [];
      s.tasks.forEach((t) => {
        if (!Array.isArray(t.subtasks)) t.subtasks = [];
        if (!Array.isArray(t.comments)) t.comments = [];
        if (!("assignee" in t)) t.assignee = null;
        if (!("driveUrl" in t)) t.driveUrl = "";
        if (!("driveName" in t)) t.driveName = "";
        if (!("dueDate" in t)) t.dueDate = "";
        if (!Array.isArray(t.attachments)) t.attachments = [];
        t.comments.forEach((c) => { if (!Array.isArray(c.attachments)) c.attachments = []; });
      });
    });
    return ws;
  }

  /** Accepts Google Drive links only (https://drive.google.com/...). */
  function cleanDriveUrl(raw) {
    const v = String(raw || "").trim();
    if (!v) return "";
    let u;
    try { u = new URL(v); } catch (e) { throw new Error("Paste a full Google Drive link, starting with https://drive.google.com/"); }
    if (u.protocol !== "https:" || u.hostname !== "drive.google.com") {
      throw new Error("That isn't a Google Drive link. It should start with https://drive.google.com/");
    }
    return u.href;
  }

  function summary(ws) {
    return {
      id: ws.id,
      name: ws.name,
      createdAt: ws.createdAt,
      createdBy: ws.createdBy,
      sectionCount: ws.sections.length,
      taskCount: ws.sections.reduce((n, s) => n + s.tasks.length, 0),
      completedCount: ws.sections.filter((s) => s.isDone).reduce((n, s) => n + s.tasks.length, 0),
    };
  }

  function newWorkspace(name, creator) {
    return {
      id: uid("ws"),
      name,
      createdAt: Date.now(),
      createdBy: creator.name,
      members: creator.name ? [creator] : [],
      sections: CONFIG.DEFAULT_SECTIONS.map((title, i) => ({
        id: uid("sec"), name: title, isDefault: true, isDone: i === CONFIG.DEFAULT_SECTIONS.length - 1, tasks: [],
      })),
    };
  }

  /* ---------- Reading & writing boards ---------- */
  const lastSaved = {}; // wsId → version this browser last wrote (to skip our own live echoes)

  async function fetchRow(wsId) {
    let res;
    try { res = await sb().from(CONFIG.TABLE).select("doc, version").eq("id", wsId).maybeSingle(); }
    catch (e) { throw dbError(e, "Couldn't load the workspace."); }
    if (res.error) throw dbError(res.error, "Couldn't load the workspace.");
    // Not found and no access look the same from here (Row Level Security hides it).
    if (!res.data) throw new Error("Workspace not found.");
    return { ws: normalise(res.data.doc), version: res.data.version };
  }

  /**
   * Apply fn(ws) to the latest copy and save it.
   * opts.check(ws, user) runs first (permissions). fn may throw (validation).
   */
  async function mutateWs(wsId, fn, opts) {
    const check = (opts && opts.check) || ((ws, u) => requireEdit(ws, u));
    for (let attempt = 0; attempt < 4; attempt++) {
      const row = await fetchRow(wsId);
      check(row.ws, me(opts && opts.actor));
      const result = fn(row.ws);
      let res;
      try {
        res = await sb().from(CONFIG.TABLE)
          .update({ doc: row.ws, version: row.version + 1 })
          .eq("id", wsId).eq("version", row.version)
          .select("version");
      } catch (e) { throw dbError(e); }
      if (res.error) {
        if (res.error.code === "40001") continue; // changed meanwhile → retry
        throw dbError(res.error);
      }
      if (res.data && res.data.length) {
        lastSaved[wsId] = res.data[0].version;
        return clone(result);
      }
      // 0 rows: someone saved first → re-read and re-apply.
      await new Promise((r) => setTimeout(r, 120 + Math.random() * 200));
    }
    throw new Error("Someone else is editing this board right now. Please try again.");
  }

  /* ---------- @mentions ----------
   * Handle = the member's name in lower case with spaces/punctuation removed:
   * "Rivan Oktavianus" → "rivanoktavianus". If two members end up with the same
   * handle, later ones get 2, 3, … appended. */
  function baseHandle(name) {
    return String(name || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "") || "user";
  }
  function mentionHandles(members) {
    const used = {};
    return (members || []).map((m) => {
      const b = baseHandle(m.name);
      used[b] = (used[b] || 0) + 1;
      return { handle: used[b] === 1 ? b : b + used[b], name: m.name, email: m.email };
    });
  }
  /** Members mentioned in text as @handle (case-insensitive, each once). */
  function findMentions(text, members) {
    const map = new Map(mentionHandles(members).map((h) => [h.handle, h]));
    const out = new Map();
    String(text || "").replace(/(^|[^a-z0-9_.@])@([a-z0-9]+)/gi, (all, pre, h) => {
      const hit = map.get(h.toLowerCase());
      if (hit) out.set(hit.handle, { handle: hit.handle, name: hit.name, email: hit.email });
      return all;
    });
    return [...out.values()];
  }

  /* ---------- Files (Supabase Storage) ---------- */
  const filePath = (wsId, fileId) => wsId + "/" + fileId;

  function checkFiles(files) {
    const list = Array.from(files || []);
    if (list.length > CONFIG.MAX_FILES_PER_POST) throw new Error("Attach up to " + CONFIG.MAX_FILES_PER_POST + " files at a time.");
    const big = list.find((f) => f.size > CONFIG.MAX_FILE_MB * 1024 * 1024);
    if (big) throw new Error("“" + big.name + "” is larger than " + CONFIG.MAX_FILE_MB + " MB.");
    const empty = list.find((f) => !f.size);
    if (empty) throw new Error("“" + empty.name + "” is empty.");
    return list;
  }

  async function uploadBlob(path, blob, type) {
    const res = await sb().storage.from(CONFIG.BUCKET).upload(path, blob, {
      contentType: type || blob.type || "application/octet-stream", upsert: false,
    });
    if (res.error) {
      const m = String(res.error.message || "");
      if (/exceeded|too large|payload/i.test(m)) throw new Error("That file is larger than " + CONFIG.MAX_FILE_MB + " MB.");
      if (/row-level|security|unauthorized|403/i.test(m)) throw new Error("You don't have permission to upload files here.");
      throw new Error("Couldn't upload the file. Please try again.");
    }
  }

  async function removePaths(paths) {
    const list = paths.filter(Boolean);
    if (!list.length) return;
    try { await sb().storage.from(CONFIG.BUCKET).remove(list); } catch (e) { /* leftover files are harmless */ }
  }

  /** Uploads files, returns metadata records. Rolls back on failure. */
  async function saveFiles(wsId, list, author) {
    const metas = [];
    try {
      for (const f of list) {
        const id = uid("file");
        const m = { id, path: filePath(wsId, id), name: String(f.name || "file").slice(0, 200), size: f.size, type: f.type || "",
          author: person(author), createdAt: Date.now() };
        await uploadBlob(m.path, f, m.type);
        metas.push(m);
      }
    } catch (e) { await removePaths(metas.map((m) => m.path)); throw e; }
    return metas;
  }

  function taskFilePaths(task) {
    return [...(task.attachments || []), ...(task.comments || []).flatMap((c) => c.attachments || [])]
      .map((a) => a.path).filter(Boolean);
  }

  /* ---------- Old per-browser data (for the one-time import) ---------- */
  function readLocalData() {
    try {
      const raw = global.localStorage.getItem(CONFIG.LOCAL_KEY);
      const d = raw ? JSON.parse(raw) : null;
      return d && Array.isArray(d.workspaces) ? d : { workspaces: [] };
    } catch (e) { return { workspaces: [] }; }
  }
  function importedIds() {
    try { return JSON.parse(global.localStorage.getItem(CONFIG.IMPORTED_KEY) || "[]"); } catch (e) { return []; }
  }
  function markImported(id) {
    try {
      const ids = importedIds();
      if (!ids.includes(id)) ids.push(id);
      global.localStorage.setItem(CONFIG.IMPORTED_KEY, JSON.stringify(ids));
    } catch (e) { /* ignore */ }
  }
  function localBlob(fileId) {
    return new Promise((resolve) => {
      let req;
      try { req = global.indexedDB.open(CONFIG.LOCAL_FILES_DB, 1); } catch (e) { resolve(null); return; }
      req.onupgradeneeded = () => req.result.createObjectStore("files");
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        try {
          const g = req.result.transaction("files", "readonly").objectStore("files").get(fileId);
          g.onsuccess = () => resolve(g.result || null);
          g.onerror = () => resolve(null);
        } catch (e) { resolve(null); }
      };
    });
  }

  const Store = {
    config: CONFIG,

    /* ---------- Workspaces ---------- */
    /** Only the workspaces this user may see (Super Admin: all) — filtered by the server. */
    async listWorkspaces() {
      let res;
      try { res = await sb().from(CONFIG.TABLE).select("doc"); }
      catch (e) { throw dbError(e, "Couldn't load workspaces."); }
      if (res.error) throw dbError(res.error, "Couldn't load workspaces.");
      return res.data.map((r) => summary(normalise(r.doc))).sort((a, b) => b.createdAt - a.createdAt);
    },

    async getWorkspace(wsId, user) {
      const { ws, version } = await fetchRow(wsId);
      requireView(ws, me(user));
      lastSaved[wsId] = Math.max(lastSaved[wsId] || 0, version);
      return clone(ws);
    },

    /** createdBy: the signed-in user {name, email}. */
    async createWorkspace(name, createdBy) {
      const user = me(typeof createdBy === "object" ? createdBy : null);
      if (!R().canCreateWorkspace(user)) throw new Error("Only Super Admins and Admins can create workspaces.");
      const n = clean(name, CONFIG.MAX_NAME);
      if (!n) throw new Error("Enter a workspace name.");
      const ws = newWorkspace(n, person(user));
      let res;
      try { res = await sb().from(CONFIG.TABLE).insert({ id: ws.id, name: ws.name, doc: ws }); }
      catch (e) { throw dbError(e); }
      if (res.error) throw dbError(res.error, "Couldn't create the workspace.");
      return summary(ws);
    },

    /* ---------- Members ---------- */
    isMember(ws, user) { return isMember(normalise(ws), user); },
    canView(ws, user) { return canView(normalise(ws), me(user)); },
    canEdit(ws, user) { return canEdit(normalise(ws), me(user)); },
    canManageMembers(ws, user) { return canManageMembers(normalise(ws), me(user)); },
    canModerate(user) { return isAdmin(me(user)); },

    addMember(wsId, member, actor) {
      return mutateWs(wsId, (ws) => {
        const m = person(member);
        if (!m.name) throw new Error("Enter the member's name.");
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m.email)) throw new Error("Enter a valid email address.");
        if (ws.members.some((x) => x.email === m.email)) throw new Error("This person is already a member.");
        // Upgrade an older name-only record instead of adding a duplicate.
        const legacy = ws.members.find((x) => !x.email && x.name === m.name);
        if (legacy) legacy.email = m.email; else ws.members.push(m);
        return m;
      }, { actor, check: (ws, u) => { if (!canManageMembers(ws, u)) throw new Error("Only Super Admins and Admins can add members."); } });
    },

    /** Removes a member; tasks they were PIC of become unassigned. */
    removeMember(wsId, member, actor) {
      return mutateWs(wsId, (ws) => {
        if (ws.members.length <= 1) throw new Error("A workspace needs at least one member.");
        const before = ws.members.length;
        ws.members = ws.members.filter((x) => !samePerson(x, member));
        if (ws.members.length === before) throw new Error("Member not found.");
        let unassigned = 0;
        ws.sections.forEach((s) => s.tasks.forEach((t) => {
          if (t.assignee && samePerson(t.assignee, member)) { t.assignee = null; unassigned++; }
        }));
        return { unassigned };
      }, { actor, check: (ws, u) => { if (!canManageMembers(ws, u)) throw new Error("Only Super Admins and Admins can remove members."); } });
    },

    /* ---------- Sections ---------- */
    addSection(wsId, name) {
      return mutateWs(wsId, (ws) => {
        const n = clean(name, CONFIG.MAX_NAME);
        if (!n) throw new Error("Enter a section name.");
        if (ws.sections.some((s) => s.name.toLowerCase() === n.toLowerCase())) {
          throw new Error("This workspace already has a section with that name.");
        }
        const section = { id: uid("sec"), name: n, isDefault: false, isDone: false, tasks: [] };
        ws.sections.push(section);
        return section;
      });
    },

    renameSection(wsId, sectionId, name) {
      return mutateWs(wsId, (ws) => {
        const s = findSection(ws, sectionId);
        if (s.isDefault) throw new Error("Default sections can't be renamed.");
        const n = clean(name, CONFIG.MAX_NAME);
        if (!n) throw new Error("Enter a section name.");
        if (ws.sections.some((x) => x.id !== sectionId && x.name.toLowerCase() === n.toLowerCase())) {
          throw new Error("This workspace already has a section with that name.");
        }
        s.name = n;
        return s;
      });
    },

    /** Deletes a custom section; its tasks move to the first section ("To do"). */
    deleteSection(wsId, sectionId) {
      return mutateWs(wsId, (ws) => {
        const s = findSection(ws, sectionId);
        if (s.isDefault) throw new Error("Default sections can't be deleted.");
        ws.sections[0].tasks.push(...s.tasks);
        ws.sections = ws.sections.filter((x) => x.id !== sectionId);
        return { moved: s.tasks.length };
      });
    },

    /* ---------- Tasks ---------- */
    addTask(wsId, sectionId, title, createdBy) {
      return mutateWs(wsId, (ws) => {
        const s = findSection(ws, sectionId);
        const t = clean(title, CONFIG.MAX_TASK_TITLE);
        if (!t) throw new Error("Enter a task name.");
        const task = {
          id: uid("task"), title: t, description: "", createdAt: Date.now(), createdBy: createdBy || "",
          assignee: null, dueDate: "", subtasks: [], comments: [], attachments: [], driveUrl: "", driveName: "",
        };
        s.tasks.push(task);
        return task;
      });
    },

    updateTask(wsId, taskId, fields) {
      return mutateWs(wsId, (ws) => {
        const { task } = findTask(ws, taskId);
        if ("title" in fields) {
          const t = clean(fields.title, CONFIG.MAX_TASK_TITLE);
          if (!t) throw new Error("Enter a task name.");
          task.title = t;
        }
        if ("description" in fields) task.description = String(fields.description || "").slice(0, 5000);
        if ("dueDate" in fields) {
          const d = String(fields.dueDate || "");
          if (d && (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(new Date(d + "T00:00:00")))) throw new Error("Pick a valid due date.");
          task.dueDate = d;
        }
        if ("assignee" in fields) {
          if (!fields.assignee) task.assignee = null;
          else {
            const m = ws.members.find((x) => samePerson(x, fields.assignee));
            if (!m) throw new Error("The PIC must be a member of this workspace.");
            task.assignee = { name: m.name, email: m.email };
          }
        }
        return task;
      });
    },

    /** Move a task to another (or the same) section at a position. */
    moveTask(wsId, taskId, toSectionId, toIndex) {
      return mutateWs(wsId, (ws) => {
        const from = findTask(ws, taskId);
        const to = findSection(ws, toSectionId);
        from.section.tasks.splice(from.index, 1);
        let i = typeof toIndex === "number" ? toIndex : to.tasks.length;
        i = Math.max(0, Math.min(i, to.tasks.length));
        to.tasks.splice(i, 0, from.task);
        return from.task;
      });
    },

    async deleteTask(wsId, taskId) {
      const paths = await mutateWs(wsId, (ws) => {
        const { section, index, task } = findTask(ws, taskId);
        section.tasks.splice(index, 1);
        return taskFilePaths(task);
      });
      await removePaths(paths);
    },

    /* ---------- Subtasks (checklist) ---------- */
    addSubtask(wsId, taskId, title) {
      return mutateWs(wsId, (ws) => {
        const { task } = findTask(ws, taskId);
        const t = clean(title, CONFIG.MAX_SUBTASK);
        if (!t) throw new Error("Enter a subtask.");
        const sub = { id: uid("sub"), title: t, done: false, createdAt: Date.now() };
        task.subtasks.push(sub);
        return sub;
      });
    },

    updateSubtask(wsId, taskId, subId, fields) {
      return mutateWs(wsId, (ws) => {
        const { task } = findTask(ws, taskId);
        const sub = task.subtasks.find((x) => x.id === subId);
        if (!sub) throw new Error("Subtask not found.");
        if ("done" in fields) sub.done = !!fields.done;
        if ("title" in fields) {
          const t = clean(fields.title, CONFIG.MAX_SUBTASK);
          if (!t) throw new Error("Enter a subtask.");
          sub.title = t;
        }
        return sub;
      });
    },

    deleteSubtask(wsId, taskId, subId) {
      return mutateWs(wsId, (ws) => {
        const { task } = findTask(ws, taskId);
        task.subtasks = task.subtasks.filter((x) => x.id !== subId);
      });
    },

    /* ---------- Comments (time-stamped) ---------- */
    /** Text, files, or both. Files are uploaded first, then the comment is saved with their timestamp. */
    async addComment(wsId, taskId, text, author, files) {
      const pre = await fetchRow(wsId);
      requireEdit(pre.ws, me(author));
      findTask(pre.ws, taskId);
      const body = String(text || "").trim().slice(0, CONFIG.MAX_COMMENT);
      const list = checkFiles(files);
      if (!body && !list.length) throw new Error("Write a comment or attach a file first.");
      const metas = await saveFiles(wsId, list, author);
      try {
        return await mutateWs(wsId, (ws) => {
          const { task } = findTask(ws, taskId);
          const c = { id: uid("cmt"), text: body, author: person(author), createdAt: Date.now(), attachments: clone(metas),
            mentions: findMentions(body, ws.members) };
          c.attachments.forEach((m) => { m.createdAt = c.createdAt; });
          task.comments.push(c);
          return c;
        }, { actor: author });
      } catch (e) { await removePaths(metas.map((m) => m.path)); throw e; }
    },

    /** Only the author can edit their comment's text. Keeps the original time stamp and records editedAt. */
    editComment(wsId, taskId, commentId, text, actor) {
      return mutateWs(wsId, (ws) => {
        const { task } = findTask(ws, taskId);
        const c = task.comments.find((x) => x.id === commentId);
        if (!c) throw new Error("Comment not found.");
        if (!samePerson(c.author, actor)) throw new Error("You can only edit your own comments.");
        const body = String(text || "").trim().slice(0, CONFIG.MAX_COMMENT);
        if (!body && !c.attachments.length) throw new Error("A comment can't be empty. Delete it instead.");
        if (body !== c.text) { c.text = body; c.editedAt = Date.now(); c.mentions = findMentions(body, ws.members); }
        return c;
      }, { actor });
    },

    /** Authors can delete their own comments; Admins/Super Admins can delete any. Files in the comment are deleted too. */
    async deleteComment(wsId, taskId, commentId, actor) {
      const paths = await mutateWs(wsId, (ws) => {
        const { task } = findTask(ws, taskId);
        const c = task.comments.find((x) => x.id === commentId);
        if (!c) throw new Error("Comment not found.");
        if (!samePerson(c.author, actor) && !isAdmin(me(actor))) throw new Error("You can only delete your own comments.");
        task.comments = task.comments.filter((x) => x.id !== commentId);
        return c.attachments.map((a) => a.path);
      }, { actor });
      await removePaths(paths);
    },

    /* ---------- Attachments (task-level) ---------- */
    async addAttachments(wsId, taskId, files, author) {
      const pre = await fetchRow(wsId);
      requireEdit(pre.ws, me(author));
      findTask(pre.ws, taskId);
      const list = checkFiles(files);
      if (!list.length) throw new Error("Choose a file to attach.");
      const metas = await saveFiles(wsId, list, author);
      try {
        return await mutateWs(wsId, (ws) => {
          const { task } = findTask(ws, taskId);
          task.attachments.push(...clone(metas));
          return metas;
        }, { actor: author });
      } catch (e) { await removePaths(metas.map((m) => m.path)); throw e; }
    },

    /** Uploader or Admin/Super Admin. (Files attached in a comment are removed by deleting the comment.) */
    async deleteAttachment(wsId, taskId, fileId, actor) {
      const path = await mutateWs(wsId, (ws) => {
        const { task } = findTask(ws, taskId);
        const a = task.attachments.find((x) => x.id === fileId);
        if (!a) throw new Error("Attachment not found.");
        if (!samePerson(a.author, actor) && !isAdmin(me(actor))) throw new Error("Only the person who attached it can delete it.");
        task.attachments = task.attachments.filter((x) => x.id !== fileId);
        return a.path || null;
      }, { actor });
      await removePaths([path]);
    },

    /** Returns the file as a Blob (or null if unavailable). Pass the attachment record. */
    async getFile(a) {
      const meta = typeof a === "object" && a ? a : { id: a };
      if (meta.path) {
        try {
          const res = await sb().storage.from(CONFIG.BUCKET).download(meta.path);
          return res.error ? null : res.data;
        } catch (e) { return null; }
      }
      return localBlob(meta.id); // very old record not yet uploaded
    },

    /* ---------- Google Drive folder link (anyone who can edit) ---------- */
    canSetDrive(ws, user) { return canEdit(normalise(ws), me(user)); },

    /** name = folder name shown on the button (optional). */
    setTaskDrive(wsId, taskId, url, actor, name) {
      return mutateWs(wsId, (ws) => {
        const { task } = findTask(ws, taskId);
        task.driveUrl = cleanDriveUrl(url);
        task.driveName = task.driveUrl ? clean(name, 80) : "";
        return task;
      }, { actor });
    },

    samePerson,
    mentionHandles,

    /* ---------- Live updates ---------- */
    /**
     * Calls onChange() whenever a workspace changes on any device
     * (wsId = one board, or null = any visible workspace), and when this tab
     * comes back to the foreground. Returns an unsubscribe function.
     */
    subscribe(wsId, onChange) {
      let timer = null;
      const fire = () => { clearTimeout(timer); timer = setTimeout(onChange, 150); };
      let channel = null;
      try {
        channel = sb().channel("pmo-" + (wsId || "all") + "-" + Math.random().toString(36).slice(2, 8))
          .on("postgres_changes",
            Object.assign({ event: "*", schema: "public", table: CONFIG.TABLE }, wsId ? { filter: "id=eq." + wsId } : {}),
            (payload) => {
              const v = payload.new && payload.new.version;
              const id = (payload.new && payload.new.id) || (payload.old && payload.old.id);
              if (wsId && v && v <= (lastSaved[id] || 0)) return; // our own save, already shown
              fire();
            })
          .subscribe();
      } catch (e) { /* live updates unavailable; foreground refresh still works */ }
      const onVisible = () => { if (document.visibilityState === "visible") fire(); };
      document.addEventListener("visibilitychange", onVisible);
      global.addEventListener("online", fire);
      return () => {
        document.removeEventListener("visibilitychange", onVisible);
        global.removeEventListener("online", fire);
        if (channel) try { sb().removeChannel(channel); } catch (e) { /* ignore */ }
      };
    },

    /* ---------- One-time import of boards saved in this browser ---------- */
    /** Boards saved only in this browser (before Supabase) and not imported yet. */
    localBoards() {
      const done = importedIds();
      return readLocalData().workspaces.filter((w) => w && w.id && !done.includes(w.id))
        .map((w) => summary(normalise(clone(w))));
    },

    /**
     * Upload this browser's boards (and their files) to Supabase.
     * onProgress(text) is called with status updates. Resolves to
     * { imported: [names], skipped: [names], missingFiles: n }.
     */
    async importLocalBoards(user, onProgress) {
      const u = me(user);
      if (!R().canCreateWorkspace(u)) throw new Error("Only Super Admins and Admins can import boards.");
      const say = onProgress || (() => {});
      const done = importedIds();
      const boards = readLocalData().workspaces.filter((w) => w && w.id && !done.includes(w.id));
      const out = { imported: [], skipped: [], missingFiles: 0 };

      for (const original of boards) {
        const ws = normalise(clone(original));
        say("Importing “" + ws.name + "”…");

        // Already in the shared database (e.g. imported from another browser)?
        const exists = await sb().from(CONFIG.TABLE).select("id").eq("id", ws.id).maybeSingle();
        if (exists.data) { markImported(ws.id); out.skipped.push(ws.name); continue; }

        // The importer must stay able to see it.
        const mine = person(u);
        if (!isMember(ws, mine)) ws.members.push(mine);

        // Files: copy from this browser to shared storage.
        const metas = [];
        ws.sections.forEach((s) => s.tasks.forEach((t) => {
          metas.push(...t.attachments);
          t.comments.forEach((c) => metas.push(...c.attachments));
        }));
        const uploaded = [];
        for (const m of metas) {
          if (m.path) continue;
          const blob = await localBlob(m.id);
          if (!blob) { m.missing = true; out.missingFiles++; continue; }
          m.path = filePath(ws.id, m.id);
          try { await uploadBlob(m.path, blob, m.type); uploaded.push(m.path); }
          catch (e) { delete m.path; m.missing = true; out.missingFiles++; }
        }

        // Insert; if the name is taken, add a suffix.
        let name = ws.name, n = 2, res;
        for (;;) {
          ws.name = name;
          res = await sb().from(CONFIG.TABLE).insert({ id: ws.id, name: ws.name, doc: ws });
          if (!res.error || res.error.code !== "23505" || n > 9) break;
          name = clean(original.name, CONFIG.MAX_NAME - 5) + " (" + n++ + ")";
        }
        if (res.error) {
          await removePaths(uploaded);
          throw dbError(res.error, "Couldn't import “" + original.name + "”.");
        }
        markImported(original.id);
        out.imported.push(ws.name);
      }
      return out;
    },
  };

  global.Store = Store;
})(window);
