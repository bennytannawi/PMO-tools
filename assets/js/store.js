/**
 * PMO Tools — Data store (workspaces, sections, tasks)
 *
 * The only file that reads/writes workspace data. Pages call the async
 * Store.* methods, so moving to a real backend later means editing this
 * file only (same pattern as auth.js).
 *
 * MODE
 *   "demo" : data is kept in this browser's localStorage. Each person/browser
 *            sees only their own data — NOT shared with the team.
 *   "api"  : not implemented yet; see README "Connecting a real backend".
 */
(function (global) {
  "use strict";

  const CONFIG = {
    MODE: "demo",
    STORAGE_KEY: "pmo_data_v1",
    DEFAULT_SECTIONS: ["To do", "In progress", "Review", "Completed"],
    MAX_NAME: 60,
    MAX_TASK_TITLE: 200,
    MAX_SUBTASK: 200,
    MAX_COMMENT: 2000,
    MAX_FILE_MB: 10,          // per file
    MAX_FILES_PER_POST: 5,    // per comment / per upload
    FILES_DB: "pmo_files_v1", // IndexedDB database holding the file contents
  };

  let memoryFallback = null; // used when localStorage is blocked

  function uid(prefix) {
    return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function load() {
    try {
      const raw = global.localStorage.getItem(CONFIG.STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* fall through */ }
    return memoryFallback || { workspaces: [] };
  }

  function save(data) {
    memoryFallback = data;
    try { global.localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(data)); }
    catch (e) { /* storage blocked — data lives for this page only */ }
  }

  function clean(name, max) {
    return String(name || "").replace(/\s+/g, " ").trim().slice(0, max);
  }

  function findWs(data, wsId) {
    const ws = data.workspaces.find((w) => w.id === wsId);
    if (!ws) throw new Error("Workspace not found.");
    return normalise(ws);
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

  /* ---------- File contents (IndexedDB) ----------
   * localStorage is too small for files (~5 MB total), so file bytes live in
   * IndexedDB and only the metadata (name, size, who, when) sits with the task.
   * Demo mode: files stay in this browser only. */
  let dbPromise = null;
  function filesDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        let req;
        try { req = global.indexedDB.open(CONFIG.FILES_DB, 1); }
        catch (e) { reject(new Error("This browser can't store files (private mode?).")); return; }
        req.onupgradeneeded = () => req.result.createObjectStore("files");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(new Error("This browser can't store files (private mode?)."));
      });
      dbPromise.catch(() => { dbPromise = null; });
    }
    return dbPromise;
  }
  async function fileTx(mode, fn) {
    const db = await filesDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("files", mode);
      const req = fn(tx.objectStore("files"));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = tx.onabort = () => reject(tx.error && tx.error.name === "QuotaExceededError"
        ? new Error("This browser is out of storage space for files.") : new Error("Couldn't save the file."));
    });
  }
  const putBlob = (id, blob) => fileTx("readwrite", (st) => st.put(blob, id));
  const getBlob = (id) => fileTx("readonly", (st) => st.get(id));
  const delBlobs = (ids) => ids.length ? fileTx("readwrite", (st) => { ids.forEach((id) => st.delete(id)); }).catch(() => {}) : Promise.resolve();

  function checkFiles(files) {
    const list = Array.from(files || []);
    if (list.length > CONFIG.MAX_FILES_PER_POST) throw new Error("Attach up to " + CONFIG.MAX_FILES_PER_POST + " files at a time.");
    const big = list.find((f) => f.size > CONFIG.MAX_FILE_MB * 1024 * 1024);
    if (big) throw new Error("“" + big.name + "” is larger than " + CONFIG.MAX_FILE_MB + " MB.");
    const empty = list.find((f) => !f.size);
    if (empty) throw new Error("“" + empty.name + "” is empty.");
    return list;
  }

  /** Saves file bytes, returns metadata records. Rolls back on failure. */
  async function saveFiles(list, author) {
    const metas = [];
    try {
      for (const f of list) {
        const m = { id: uid("file"), name: String(f.name || "file").slice(0, 200), size: f.size, type: f.type || "",
          author: person(author), createdAt: Date.now() };
        await putBlob(m.id, f);
        metas.push(m);
      }
    } catch (e) { await delBlobs(metas.map((m) => m.id)); throw e; }
    return metas;
  }

  function taskFileIds(task) {
    return [...(task.attachments || []), ...(task.comments || []).flatMap((c) => c.attachments || [])].map((a) => a.id);
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

  function isMember(ws, user) { return ws.members.some((m) => samePerson(m, user)); }
  function isAdmin(user) { return !!user && user.role === "admin"; }

  function requireMember(ws, user, what) {
    if (!isMember(ws, user) && !isAdmin(user)) throw new Error("Only workspace members can " + what + ".");
  }

  /** Fill in fields added after a workspace was first saved (older data). */
  function normalise(ws) {
    if (!Array.isArray(ws.members)) {
      ws.members = ws.createdBy ? [{ name: ws.createdBy, email: "" }] : [];
    }
    ws.sections.forEach((s) => s.tasks.forEach((t) => {
      if (!Array.isArray(t.subtasks)) t.subtasks = [];
      if (!Array.isArray(t.comments)) t.comments = [];
      if (!("assignee" in t)) t.assignee = null;
      if (!("driveUrl" in t)) t.driveUrl = "";
      if (!("dueDate" in t)) t.dueDate = "";
      if (!Array.isArray(t.attachments)) t.attachments = [];
      t.comments.forEach((c) => { if (!Array.isArray(c.attachments)) c.attachments = []; });
    }));
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

  // Every mutation: load → change → save → return a fresh copy.
  function mutate(fn) {
    const data = load();
    const result = fn(data);
    save(data);
    return Promise.resolve(JSON.parse(JSON.stringify(result === undefined ? null : result)));
  }

  const Store = {
    config: CONFIG,

    /* ---------- Workspaces ---------- */
    async listWorkspaces() {
      return load().workspaces
        .map(summary)
        .sort((a, b) => b.createdAt - a.createdAt);
    },

    async getWorkspace(wsId) {
      return JSON.parse(JSON.stringify(findWs(load(), wsId)));
    },

    /** createdBy may be a user object {name, email} (preferred) or a name. */
    createWorkspace(name, createdBy) {
      return mutate((data) => {
        const n = clean(name, CONFIG.MAX_NAME);
        if (!n) throw new Error("Enter a workspace name.");
        if (data.workspaces.some((w) => w.name.toLowerCase() === n.toLowerCase())) {
          throw new Error("A workspace with this name already exists.");
        }
        const creator = typeof createdBy === "object" && createdBy ? person(createdBy) : { name: createdBy || "", email: "" };
        const ws = {
          id: uid("ws"),
          name: n,
          createdAt: Date.now(),
          createdBy: creator.name,
          members: creator.name ? [creator] : [],
          sections: CONFIG.DEFAULT_SECTIONS.map((title, i) => ({
            id: uid("sec"),
            name: title,
            isDefault: true,
            isDone: i === CONFIG.DEFAULT_SECTIONS.length - 1,
            tasks: [],
          })),
        };
        data.workspaces.push(ws);
        return summary(ws);
      });
    },

    /* ---------- Members ---------- */
    isMember(ws, user) { return isMember(normalise(ws), user); },
    canManageMembers(ws, user) { return isAdmin(user) || isMember(normalise(ws), user); },

    addMember(wsId, member, actor) {
      return mutate((data) => {
        const ws = findWs(data, wsId);
        requireMember(ws, actor, "add members");
        const m = person(member);
        if (!m.name) throw new Error("Enter the member's name.");
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m.email)) throw new Error("Enter a valid email address.");
        if (ws.members.some((x) => x.email === m.email)) throw new Error("This person is already a member.");
        // Upgrade an older name-only record instead of adding a duplicate.
        const legacy = ws.members.find((x) => !x.email && x.name === m.name);
        if (legacy) legacy.email = m.email; else ws.members.push(m);
        return m;
      });
    },

    /** Removes a member; tasks they were PIC of become unassigned. */
    removeMember(wsId, member, actor) {
      return mutate((data) => {
        const ws = findWs(data, wsId);
        requireMember(ws, actor, "remove members");
        if (ws.members.length <= 1) throw new Error("A workspace needs at least one member.");
        const before = ws.members.length;
        ws.members = ws.members.filter((x) => !samePerson(x, member));
        if (ws.members.length === before) throw new Error("Member not found.");
        let unassigned = 0;
        ws.sections.forEach((s) => s.tasks.forEach((t) => {
          if (t.assignee && samePerson(t.assignee, member)) { t.assignee = null; unassigned++; }
        }));
        return { unassigned };
      });
    },

    /* ---------- Sections ---------- */
    addSection(wsId, name) {
      return mutate((data) => {
        const ws = findWs(data, wsId);
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
      return mutate((data) => {
        const ws = findWs(data, wsId);
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
      return mutate((data) => {
        const ws = findWs(data, wsId);
        const s = findSection(ws, sectionId);
        if (s.isDefault) throw new Error("Default sections can't be deleted.");
        ws.sections[0].tasks.push(...s.tasks);
        ws.sections = ws.sections.filter((x) => x.id !== sectionId);
        return { moved: s.tasks.length };
      });
    },

    /* ---------- Tasks ---------- */
    addTask(wsId, sectionId, title, createdBy) {
      return mutate((data) => {
        const ws = findWs(data, wsId);
        const s = findSection(ws, sectionId);
        const t = clean(title, CONFIG.MAX_TASK_TITLE);
        if (!t) throw new Error("Enter a task name.");
        const task = {
          id: uid("task"), title: t, description: "", createdAt: Date.now(), createdBy: createdBy || "",
          assignee: null, dueDate: "", subtasks: [], comments: [], attachments: [], driveUrl: "",
        };
        s.tasks.push(task);
        return task;
      });
    },

    updateTask(wsId, taskId, fields) {
      return mutate((data) => {
        const ws = findWs(data, wsId);
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
      return mutate((data) => {
        const ws = findWs(data, wsId);
        const from = findTask(ws, taskId);
        const to = findSection(ws, toSectionId);
        from.section.tasks.splice(from.index, 1);
        let i = typeof toIndex === "number" ? toIndex : to.tasks.length;
        i = Math.max(0, Math.min(i, to.tasks.length));
        to.tasks.splice(i, 0, from.task);
        return from.task;
      });
    },

    /* ---------- Subtasks (checklist) ---------- */
    addSubtask(wsId, taskId, title) {
      return mutate((data) => {
        const { task } = findTask(findWs(data, wsId), taskId);
        const t = clean(title, CONFIG.MAX_SUBTASK);
        if (!t) throw new Error("Enter a subtask.");
        const sub = { id: uid("sub"), title: t, done: false, createdAt: Date.now() };
        task.subtasks.push(sub);
        return sub;
      });
    },

    updateSubtask(wsId, taskId, subId, fields) {
      return mutate((data) => {
        const { task } = findTask(findWs(data, wsId), taskId);
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
      return mutate((data) => {
        const { task } = findTask(findWs(data, wsId), taskId);
        task.subtasks = task.subtasks.filter((x) => x.id !== subId);
      });
    },

    /* ---------- Comments (workspace members only, time-stamped) ---------- */
    /** Text, files, or both. Files are stored first, then the comment is saved with their timestamp. */
    async addComment(wsId, taskId, text, author, files) {
      const pre = findWs(load(), wsId);
      requireMember(pre, author, "comment");
      findTask(pre, taskId);
      const body = String(text || "").trim().slice(0, CONFIG.MAX_COMMENT);
      const list = checkFiles(files);
      if (!body && !list.length) throw new Error("Write a comment or attach a file first.");
      const metas = await saveFiles(list, author);
      try {
        return await mutate((data) => {
          const { task } = findTask(findWs(data, wsId), taskId);
          const c = { id: uid("cmt"), text: body, author: person(author), createdAt: Date.now(), attachments: metas };
          metas.forEach((m) => { m.createdAt = c.createdAt; });
          task.comments.push(c);
          return c;
        });
      } catch (e) { await delBlobs(metas.map((m) => m.id)); throw e; }
    },

    /** Only the author can edit their comment's text. Keeps the original time stamp and records editedAt. */
    editComment(wsId, taskId, commentId, text, actor) {
      return mutate((data) => {
        const { task } = findTask(findWs(data, wsId), taskId);
        const c = task.comments.find((x) => x.id === commentId);
        if (!c) throw new Error("Comment not found.");
        if (!samePerson(c.author, actor)) throw new Error("You can only edit your own comments.");
        const body = String(text || "").trim().slice(0, CONFIG.MAX_COMMENT);
        if (!body && !c.attachments.length) throw new Error("A comment can't be empty. Delete it instead.");
        if (body !== c.text) { c.text = body; c.editedAt = Date.now(); }
        return c;
      });
    },

    /** Authors can delete their own comments; admins can delete any. Files in the comment are deleted too. */
    async deleteComment(wsId, taskId, commentId, actor) {
      const removed = await mutate((data) => {
        const { task } = findTask(findWs(data, wsId), taskId);
        const c = task.comments.find((x) => x.id === commentId);
        if (!c) throw new Error("Comment not found.");
        if (!samePerson(c.author, actor) && !isAdmin(actor)) throw new Error("You can only delete your own comments.");
        task.comments = task.comments.filter((x) => x.id !== commentId);
        return c.attachments.map((a) => a.id);
      });
      await delBlobs(removed);
    },

    /* ---------- Attachments (task-level) ---------- */
    async addAttachments(wsId, taskId, files, author) {
      const pre = findWs(load(), wsId);
      requireMember(pre, author, "attach files");
      findTask(pre, taskId);
      const list = checkFiles(files);
      if (!list.length) throw new Error("Choose a file to attach.");
      const metas = await saveFiles(list, author);
      try {
        return await mutate((data) => {
          const { task } = findTask(findWs(data, wsId), taskId);
          task.attachments.push(...metas);
          return metas;
        });
      } catch (e) { await delBlobs(metas.map((m) => m.id)); throw e; }
    },

    /** Uploader or admin. (Files attached in a comment are removed by deleting the comment.) */
    async deleteAttachment(wsId, taskId, fileId, actor) {
      await mutate((data) => {
        const { task } = findTask(findWs(data, wsId), taskId);
        const a = task.attachments.find((x) => x.id === fileId);
        if (!a) throw new Error("Attachment not found.");
        if (!samePerson(a.author, actor) && !isAdmin(actor)) throw new Error("Only the person who attached it can delete it.");
        task.attachments = task.attachments.filter((x) => x.id !== fileId);
      });
      await delBlobs([fileId]);
    },

    /** Returns the file as a Blob (or null if it isn't in this browser). */
    async getFile(fileId) {
      try { return (await getBlob(fileId)) || null; } catch (e) { return null; }
    },

    /* ---------- Google Drive folder link (set by the PIC) ---------- */
    canSetDrive(task, user) { return !!task.assignee && (samePerson(task.assignee, user) || isAdmin(user)); },

    setTaskDrive(wsId, taskId, url, actor) {
      return mutate((data) => {
        const { task } = findTask(findWs(data, wsId), taskId);
        if (!task.assignee) throw new Error("Assign a PIC first — the PIC links the Drive folder.");
        if (!Store.canSetDrive(task, actor)) throw new Error("Only the PIC (" + task.assignee.name + ") can change the Drive link.");
        task.driveUrl = cleanDriveUrl(url);
        return task;
      });
    },

    samePerson,

    async deleteTask(wsId, taskId) {
      const ids = await mutate((data) => {
        const ws = findWs(data, wsId);
        const { section, index, task } = findTask(ws, taskId);
        section.tasks.splice(index, 1);
        return taskFileIds(task);
      });
      await delBlobs(ids);
    },
  };

  global.Store = Store;
})(window);
