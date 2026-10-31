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
          assignee: null, subtasks: [], comments: [], driveUrl: "",
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
    addComment(wsId, taskId, text, author) {
      return mutate((data) => {
        const ws = findWs(data, wsId);
        requireMember(ws, author, "comment");
        const body = String(text || "").trim().slice(0, CONFIG.MAX_COMMENT);
        if (!body) throw new Error("Write a comment first.");
        const { task } = findTask(ws, taskId);
        const c = { id: uid("cmt"), text: body, author: person(author), createdAt: Date.now() };
        task.comments.push(c);
        return c;
      });
    },

    /** Authors can delete their own comments; admins can delete any. */
    deleteComment(wsId, taskId, commentId, actor) {
      return mutate((data) => {
        const { task } = findTask(findWs(data, wsId), taskId);
        const c = task.comments.find((x) => x.id === commentId);
        if (!c) throw new Error("Comment not found.");
        if (!samePerson(c.author, actor) && !isAdmin(actor)) throw new Error("You can only delete your own comments.");
        task.comments = task.comments.filter((x) => x.id !== commentId);
      });
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

    deleteTask(wsId, taskId) {
      return mutate((data) => {
        const ws = findWs(data, wsId);
        const { section, index } = findTask(ws, taskId);
        section.tasks.splice(index, 1);
      });
    },
  };

  global.Store = Store;
})(window);
