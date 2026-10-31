/**
 * PMO Tools — Auth service
 *
 * One place that talks to the authentication backend. The login page and
 * any later page only call Auth.login / Auth.logout / Auth.getSession /
 * Auth.requireAuth, so swapping the backend means editing this file only.
 *
 * MODE
 *   "demo" : no backend. Accepts the DEMO_USERS below. For UI testing only —
 *            anyone can read these credentials in the browser. Never use in
 *            production.
 *   "api"  : POSTs { email, password } to API_BASE_URL + "/auth/login" and
 *            expects { token, user: { name, email, role } } back.
 */
(function (global) {
  "use strict";

  const CONFIG = {
    MODE: "demo",                 // "demo" | "api"
    API_BASE_URL: "/api",         // used when MODE === "api"
    SESSION_KEY: "pmo_session",
    SESSION_HOURS_DEFAULT: 8,     // session length without "Keep me signed in"
    SESSION_DAYS_REMEMBER: 14,    // session length with "Keep me signed in"
    LOGIN_PAGE: "index.html",
    HOME_PAGE: "dashboard.html",
  };

  // Demo accounts — replace or remove once a real backend is connected.
  const DEMO_USERS = [
    { email: "admin@pmo.local",  password: "Admin#2026",  name: "PMO Admin", role: "admin"  },
    { email: "member@pmo.local", password: "Member#2026", name: "Team Member", role: "member" },
  ];

  function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function storageFor(remember) {
    return remember ? global.localStorage : global.sessionStorage;
  }

  function saveSession(session, remember) {
    try {
      // Clear any old session in either store first.
      global.localStorage.removeItem(CONFIG.SESSION_KEY);
      global.sessionStorage.removeItem(CONFIG.SESSION_KEY);
      storageFor(remember).setItem(CONFIG.SESSION_KEY, JSON.stringify(session));
    } catch (e) {
      // Storage blocked (private mode etc.) — session lives only for this page.
      global.__pmoSession = session;
    }
  }

  function readSession() {
    let raw = null;
    try {
      raw = global.sessionStorage.getItem(CONFIG.SESSION_KEY) ||
            global.localStorage.getItem(CONFIG.SESSION_KEY);
    } catch (e) { /* ignore */ }
    const session = raw ? JSON.parse(raw) : global.__pmoSession || null;
    if (!session) return null;
    if (Date.now() > session.expiresAt) { clearSession(); return null; }
    return session;
  }

  function clearSession() {
    try {
      global.localStorage.removeItem(CONFIG.SESSION_KEY);
      global.sessionStorage.removeItem(CONFIG.SESSION_KEY);
    } catch (e) { /* ignore */ }
    global.__pmoSession = null;
  }

  function expiryFor(remember) {
    const ms = remember
      ? CONFIG.SESSION_DAYS_REMEMBER * 24 * 60 * 60 * 1000
      : CONFIG.SESSION_HOURS_DEFAULT * 60 * 60 * 1000;
    return Date.now() + ms;
  }

  async function loginDemo(email, password) {
    await wait(600); // simulate network latency
    const user = DEMO_USERS.find(
      (u) => u.email.toLowerCase() === email.toLowerCase() && u.password === password
    );
    if (!user) throw new Error("Incorrect email or password.");
    return {
      token: "demo-" + Math.random().toString(36).slice(2),
      user: { name: user.name, email: user.email, role: user.role },
    };
  }

  async function loginApi(email, password) {
    let res;
    try {
      res = await fetch(CONFIG.API_BASE_URL + "/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });
    } catch (e) {
      throw new Error("Can't reach the server. Check your connection and try again.");
    }
    if (res.status === 401) throw new Error("Incorrect email or password.");
    if (res.status === 429) throw new Error("Too many attempts. Please wait a few minutes.");
    if (!res.ok) throw new Error("Sign-in failed (" + res.status + "). Please try again.");
    return res.json();
  }

  const Auth = {
    config: CONFIG,

    /** Sign in. Resolves to the session; rejects with a user-friendly Error. */
    async login(email, password, remember) {
      const result = CONFIG.MODE === "api"
        ? await loginApi(email, password)
        : await loginDemo(email, password);

      const session = {
        token: result.token,
        user: result.user,
        expiresAt: expiryFor(remember),
      };
      saveSession(session, remember);
      return session;
    },

    logout() {
      clearSession();
      global.location.href = CONFIG.LOGIN_PAGE;
    },

    getSession: readSession,

    /** Call at the top of any protected page. Redirects to login if signed out. */
    requireAuth() {
      const session = readSession();
      if (!session) {
        const next = encodeURIComponent(global.location.pathname.split("/").pop() || CONFIG.HOME_PAGE);
        global.location.replace(CONFIG.LOGIN_PAGE + "?next=" + next);
        return null;
      }
      return session;
    },
  };

  global.Auth = Auth;
})(window);
