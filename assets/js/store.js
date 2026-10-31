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
    return ws;
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

    createWorkspace(name, createdBy) {
      return mutate((data) => {
        const n = clean(name, CONFIG.MAX_NAME);
        if (!n) throw new Error("Enter a workspace name.");
        if (data.workspaces.some((w) => w.name.toLowerCase() === n.toLowerCase())) {
          throw new Error("A workspace with this name already exists.");
        }
        const ws = {
          id: uid("ws"),
          name: n,
          createdAt: Date.now(),
          createdBy: createdBy || "",
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
        const task = { id: uid("task"), title: t, description: "", createdAt: Date.now(), createdBy: createdBy || "" };
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
