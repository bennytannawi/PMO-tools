/**
 * PMO Tools — Auth service (Supabase)
 *
 * The only file that talks to the authentication backend. Pages call:
 *   Auth.login(email, password, remember)   sign in
 *   Auth.logout()                           sign out and go to the login page
 *   Auth.getSession()                       current session or null (sync)
 *   Auth.requireAuth()                      top of protected pages (sync)
 *   Auth.requestPasswordReset(email)        email a reset link
 *   Auth.readLink()                         reset-password page: read invite/reset link
 *   Auth.setPassword(password)              reset-password page: save new password
 *
 * Accounts live in Supabase (Authentication → Users). There are no passwords
 * in this code. Needs, loaded before this file:
 *   https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/dist/umd/supabase.js
 *   assets/js/config.js
 *
 * Roles live in Supabase app_metadata.role (users can't change it themselves):
 *   super_admin  all workspaces · edit all cards · invite users · change roles
 *   admin        assigned workspaces · edit all cards · invite users
 *   member       assigned workspaces · edit all cards
 *   guest        assigned workspaces · view only
 * Missing/unknown role = member. Display name comes from user_metadata.name,
 * else the part of the email before "@".
 */
(function (global) {
  "use strict";

  const CONFIG = {
    SESSION_KEY: "pmo_session",   // our small session record (name, email, role, expiry)
    REMEMBER_KEY: "pmo_remember", // "1" when "Keep me signed in" was ticked
    SESSION_HOURS_DEFAULT: 8,     // session length without "Keep me signed in"
    SESSION_DAYS_REMEMBER: 14,    // session length with "Keep me signed in"
    LOGIN_PAGE: "index.html",
    HOME_PAGE: "workspaces.html",
    RESET_PAGE: "reset-password.html",
  };

  /* ---------- Roles ---------- */
  const ROLE_LIST = ["super_admin", "admin", "member", "guest"];
  const Roles = {
    LIST: ROLE_LIST,
    LABELS: { super_admin: "Super Admin", admin: "Admin", member: "Member", guest: "Guest" },
    DESCRIPTIONS: {
      super_admin: "All workspaces · edit all cards · invite users · change roles",
      admin: "Assigned workspaces · edit all cards · invite users",
      member: "Assigned workspaces · edit all cards",
      guest: "Assigned workspaces · view only",
    },
    normalize(r) { return ROLE_LIST.includes(r) ? r : "member"; },
    of(user) { return Roles.normalize(user && user.role); },
    label(user) { return Roles.LABELS[Roles.of(user)]; },
    isSuperAdmin(user) { return Roles.of(user) === "super_admin"; },
    seesAllWorkspaces(user) { return Roles.of(user) === "super_admin"; },
    canEditCards(user) { return Roles.of(user) !== "guest"; },
    canInvite(user) { return ["super_admin", "admin"].includes(Roles.of(user)); },
    canManageWorkspaceMembers(user) { return ["super_admin", "admin"].includes(Roles.of(user)); },
    canCreateWorkspace(user) { return ["super_admin", "admin"].includes(Roles.of(user)); },
    canModerate(user) { return ["super_admin", "admin"].includes(Roles.of(user)); }, // delete others' comments/files
    canChangeRoles(user) { return Roles.of(user) === "super_admin"; },
    /** Roles this user may give when inviting. Admins can't create Super Admins. */
    invitable(user) {
      const r = Roles.of(user);
      return r === "super_admin" ? ROLE_LIST.slice() : r === "admin" ? ["admin", "member", "guest"] : [];
    },
  };
  global.Roles = Roles;

  /* ---------- Storage helpers (never throw) ---------- */
  function safe(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }
  const ls = () => global.localStorage;
  const ss = () => global.sessionStorage;

  function rememberOn() { return safe(() => ls().getItem(CONFIG.REMEMBER_KEY) === "1", false); }
  function setRemember(on) {
    safe(() => (on ? ls().setItem(CONFIG.REMEMBER_KEY, "1") : ls().removeItem(CONFIG.REMEMBER_KEY)));
  }

  // Supabase keeps its tokens here: localStorage when "Keep me signed in",
  // otherwise sessionStorage (cleared when the browser closes).
  const tokenStorage = {
    getItem: (k) => safe(() => ss().getItem(k) || ls().getItem(k), null),
    setItem: (k, v) => safe(() => (rememberOn() ? ls() : ss()).setItem(k, v)),
    removeItem: (k) => safe(() => { ss().removeItem(k); ls().removeItem(k); }),
  };

  /* ---------- Supabase client (created on first use) ---------- */
  let client = null;
  function sb() {
    if (client) return client;
    const cfg = global.PMO_CONFIG || {};
    if (!global.supabase || !global.supabase.createClient) {
      throw new Error("Sign-in service didn't load. Check your connection and refresh the page.");
    }
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_KEY) {
      throw new Error("Sign-in isn't configured yet. Ask your PMO admin.");
    }
    client = global.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, {
      auth: {
        storage: tokenStorage,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true, // reads invite / reset tokens from the link
        flowType: "implicit",
      },
    });
    return client;
  }

  /* ---------- Our session record ---------- */
  function toUser(u) {
    const meta = (u && u.user_metadata) || {};
    const app = (u && u.app_metadata) || {};
    const email = String((u && u.email) || "").toLowerCase();
    const fromEmail = email.split("@")[0].replace(/[._-]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    return {
      id: u && u.id,
      name: String(meta.name || meta.full_name || fromEmail || "User").slice(0, 80),
      email,
      role: Roles.normalize(app.role),
    };
  }

  function expiryFor(remember) {
    return Date.now() + (remember
      ? CONFIG.SESSION_DAYS_REMEMBER * 24 * 60 * 60 * 1000
      : CONFIG.SESSION_HOURS_DEFAULT * 60 * 60 * 1000);
  }

  function saveSession(user, remember) {
    const session = { user, expiresAt: expiryFor(remember) };
    const ok = safe(() => {
      ls().removeItem(CONFIG.SESSION_KEY);
      ss().removeItem(CONFIG.SESSION_KEY);
      (remember ? ls() : ss()).setItem(CONFIG.SESSION_KEY, JSON.stringify(session));
      return true;
    }, false);
    if (!ok) global.__pmoSession = session; // storage blocked: this page only
    return session;
  }

  function readSession() {
    const raw = safe(() => ss().getItem(CONFIG.SESSION_KEY) || ls().getItem(CONFIG.SESSION_KEY), null);
    const session = raw ? safe(() => JSON.parse(raw), null) : global.__pmoSession || null;
    if (!session || !session.user) return null;
    if (Date.now() > session.expiresAt) { clearLocal(); return null; }
    return session;
  }

  function clearLocal() {
    safe(() => {
      ls().removeItem(CONFIG.SESSION_KEY);
      ss().removeItem(CONFIG.SESSION_KEY);
    });
    global.__pmoSession = null;
  }

  function pageUrl(page) { return new URL(page, global.location.href).href.split("#")[0].split("?")[0]; }

  /* ---------- Friendly errors ---------- */
  function friendly(err, fallback) {
    const msg = String((err && err.message) || "");
    const status = err && err.status;
    if (/invalid login credentials/i.test(msg)) return new Error("Incorrect email or password.");
    if (/email not confirmed/i.test(msg)) return new Error("Your account isn't activated yet. Open the invitation email and set your password first.");
    if (status === 429 || /rate limit|too many/i.test(msg)) return new Error("Too many attempts. Please wait a few minutes and try again.");
    if (/password should be|weak password|at least/i.test(msg)) return new Error(msg);
    if (/same.*password|different from the old/i.test(msg)) return new Error("Choose a password different from your current one.");
    if (/failed to fetch|network|load failed/i.test(msg)) return new Error("Can't reach the server. Check your connection and try again.");
    if (/didn't load|isn't configured/i.test(msg)) return err;
    return new Error(fallback);
  }

  /* ---------- Public API ---------- */
  const Auth = {
    config: CONFIG,

    async login(email, password, remember) {
      clearLocal();
      setRemember(!!remember);
      let res;
      try {
        res = await sb().auth.signInWithPassword({ email, password });
      } catch (e) { throw friendly(e, "Sign-in failed. Please try again."); }
      if (res.error) throw friendly(res.error, "Sign-in failed. Please try again.");
      return saveSession(toUser(res.data.user), !!remember);
    },

    async logout() {
      try { await sb().auth.signOut({ scope: "local" }); } catch (e) { /* still sign out locally */ }
      tokenStorage.removeItem("sb-" + safe(() => new URL(global.PMO_CONFIG.SUPABASE_URL).hostname.split(".")[0], "") + "-auth-token");
      clearLocal();
      setRemember(false);
      global.location.href = CONFIG.LOGIN_PAGE;
    },

    getSession: readSession,

    /** Call at the top of any protected page. Redirects to login if signed out. */
    requireAuth() {
      const session = readSession();
      if (!session) {
        const next = encodeURIComponent((global.location.pathname.split("/").pop() || CONFIG.HOME_PAGE) + global.location.search);
        global.location.replace(CONFIG.LOGIN_PAGE + "?next=" + next);
        return null;
      }
      // In the background, confirm with Supabase that this account still exists
      // and pick up role / name changes. Signs out if the account was removed.
      setTimeout(() => {
        try {
          sb().auth.getSession().then(async (r) => {
            if (!r.data || !r.data.session) return Auth.logout();
            const u = await sb().auth.getUser();
            if (u.error && (u.error.status === 401 || u.error.status === 403 || u.error.status === 404)) return Auth.logout();
            if (!u.data || !u.data.user) return;
            const fresh = toUser(u.data.user);
            const cur = readSession();
            if (cur && (fresh.role !== cur.user.role || fresh.name !== cur.user.name)) {
              cur.user = fresh; // keep the same expiry and storage place
              const inLocal = safe(() => !!ls().getItem(CONFIG.SESSION_KEY), false);
              safe(() => (inLocal ? ls() : ss()).setItem(CONFIG.SESSION_KEY, JSON.stringify(cur)));
              global.location.reload(); // re-render with the new permissions
            }
          }).catch(() => { /* offline: keep working */ });
        } catch (e) { /* library not loaded: keep local session */ }
      }, 0);
      return session;
    },

    /** Email a password-reset link. Resolves even if the email has no account. */
    async requestPasswordReset(email) {
      let res;
      try {
        res = await sb().auth.resetPasswordForEmail(email, { redirectTo: pageUrl(CONFIG.RESET_PAGE) });
      } catch (e) { throw friendly(e, "Couldn't send the reset email. Please try again."); }
      if (res.error && (res.error.status === 429 || /rate limit/i.test(res.error.message))) {
        throw friendly(res.error, "");
      }
      // Other errors are hidden on purpose, so the page never reveals who has an account.
    },

    /**
     * On reset-password.html: read the invite / reset link.
     * Resolves to { type: "invite" | "recovery", user } or rejects if the link is bad.
     */
    async readLink() {
      const hash = new URLSearchParams(global.location.hash.replace(/^#/, ""));
      const query = new URLSearchParams(global.location.search);
      const linkError = hash.get("error_description") || query.get("error_description");
      if (linkError) throw new Error("This link is invalid or has expired.");
      const type = hash.get("type") || query.get("type") || "recovery";
      const res = await sb().auth.getSession(); // processes the tokens in the link
      if (res.error || !res.data.session) throw new Error("This link is invalid or has expired.");
      // Remove tokens from the address bar.
      safe(() => global.history.replaceState(null, "", global.location.pathname));
      return { type: type === "invite" || type === "signup" ? "invite" : "recovery", user: toUser(res.data.session.user) };
    },

    /** Current access token (for calling server functions), or null. */
    async accessToken() {
      try { const r = await sb().auth.getSession(); return r.data.session ? r.data.session.access_token : null; }
      catch (e) { return null; }
    },

    /** Call the manage-users server function. Rejects with a friendly Error. */
    async adminCall(action, payload) {
      const token = await Auth.accessToken();
      if (!token) throw new Error("Your session has ended. Please sign in again.");
      const cfg = global.PMO_CONFIG;
      let res;
      try {
        res = await fetch(cfg.SUPABASE_URL + "/functions/v1/manage-users", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + token, apikey: cfg.SUPABASE_KEY },
          body: JSON.stringify(Object.assign({ action }, payload || {})),
        });
      } catch (e) { throw new Error("Can't reach the server. Check your connection and try again."); }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Request failed (" + res.status + "). Please try again.");
      return body;
    },

    resetPageUrl() { return pageUrl(CONFIG.RESET_PAGE); },

    /** On reset-password.html: save the new password and sign the user in. */
    async setPassword(password) {
      let res;
      try {
        res = await sb().auth.updateUser({ password });
      } catch (e) { throw friendly(e, "Couldn't save your password. Please try again."); }
      if (res.error) throw friendly(res.error, "Couldn't save your password. Please try again.");
      return saveSession(toUser(res.data.user), rememberOn());
    },
  };

  global.Auth = Auth;
})(window);
