/**
 * PMO Tools — manage-users (Supabase Edge Function)
 *
 * Server-side user management. Runs with the service-role key (never sent to
 * the browser) and checks the CALLER's role on every request.
 *
 * POST { action, ... } with "Authorization: Bearer <user access token>"
 *   list                              Super Admin, Admin
 *   invite   { email, name, role, redirectTo }   Super Admin (any role), Admin (not super_admin)
 *   resend   { id, redirectTo }       Super Admin, Admin (people who haven't accepted yet)
 *   set_name { id, name }             Super Admin, Admin
 *   set_role { id, role }             Super Admin only (not own role)
 *   remove   { id }                   Super Admin only (not self)
 *
 * Deployed from this file; keep it in sync with the deployed version.
 */
import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const ROLES = ["super_admin", "admin", "member", "guest"] as const;
type Role = typeof ROLES[number];
const norm = (r: unknown): Role => (ROLES as readonly string[]).includes(String(r)) ? r as Role : "member";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const fail = (status: number, error: string) => reply(status, { error });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const cleanName = (n: unknown) => String(n ?? "").replace(/\s+/g, " ").trim().slice(0, 80);

// deno-lint-ignore no-explicit-any
function view(u: any) {
  return {
    id: u.id,
    email: u.email,
    name: u.user_metadata?.name || "",
    role: norm(u.app_metadata?.role),
    status: u.last_sign_in_at || u.email_confirmed_at ? "active" : "invited",
    invitedAt: u.invited_at || u.created_at,
    lastSignInAt: u.last_sign_in_at || null,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return fail(405, "Method not allowed.");

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Who is calling?
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return fail(401, "Please sign in again.");
  const { data: me, error: meErr } = await admin.auth.getUser(token);
  if (meErr || !me?.user) return fail(401, "Your session has ended. Please sign in again.");
  const myRole = norm(me.user.app_metadata?.role);
  if (myRole !== "super_admin" && myRole !== "admin") {
    return fail(403, "Only Super Admins and Admins can manage users.");
  }

  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { return fail(400, "Invalid request."); }

  try {
    switch (body.action) {
      case "list": {
        const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
        if (error) throw error;
        const users = data.users.map(view).sort((a, b) => a.email.localeCompare(b.email));
        return reply(200, { users, me: me.user.id });
      }

      case "invite": {
        const email = String(body.email ?? "").trim().toLowerCase();
        const name = cleanName(body.name);
        const role = String(body.role ?? "");
        if (!EMAIL_RE.test(email)) return fail(400, "Enter a valid email address.");
        if (!(ROLES as readonly string[]).includes(role)) return fail(400, "Choose a role.");
        if (role === "super_admin" && myRole !== "super_admin") return fail(403, "Only a Super Admin can invite another Super Admin.");
        const redirectTo = typeof body.redirectTo === "string" && /^https?:\/\//.test(body.redirectTo) ? body.redirectTo : undefined;

        const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
          data: name ? { name } : {},
          redirectTo,
        });
        if (error) {
          if (/already.*(registered|exists)/i.test(error.message)) return fail(409, "This email already has an account.");
          if (error.status === 429 || /rate limit/i.test(error.message)) {
            return fail(429, "Email limit reached. Supabase's built-in email sends only a few per hour — try later, or set up SMTP.");
          }
          throw error;
        }
        const { data: upd, error: roleErr } = await admin.auth.admin.updateUserById(data.user.id, {
          app_metadata: { ...(data.user.app_metadata || {}), role },
        });
        if (roleErr) throw roleErr;
        return reply(200, { user: view(upd.user) });
      }

      case "resend": {
        const { data: t, error: tErr } = await admin.auth.admin.getUserById(String(body.id));
        if (tErr || !t?.user) return fail(404, "User not found.");
        if (t.user.last_sign_in_at) return fail(400, "This person has already accepted. They can use “Forgot password?” on the sign-in page.");
        const redirectTo = typeof body.redirectTo === "string" && /^https?:\/\//.test(body.redirectTo) ? body.redirectTo : undefined;
        const email = t.user.email!;
        // Re-sending an invite works for people who never accepted; if Supabase
        // refuses, send a set-password (recovery) email instead — same result.
        let { error } = await admin.auth.admin.inviteUserByEmail(email, { data: t.user.user_metadata || {}, redirectTo });
        if (error && /already.*(registered|exists)/i.test(error.message)) {
          ({ error } = await admin.auth.resetPasswordForEmail(email, { redirectTo }));
        }
        if (error) {
          if (error.status === 429 || /rate limit|seconds/i.test(error.message)) {
            return fail(429, "Email limit reached. Wait a minute and try again (Supabase's built-in email sends only a few per hour — set up SMTP for more).");
          }
          throw error;
        }
        return reply(200, { ok: true, email });
      }

      case "set_name": {
        const name = cleanName(body.name);
        if (!name) return fail(400, "Enter a name.");
        const { data: t, error: tErr } = await admin.auth.admin.getUserById(String(body.id));
        if (tErr || !t?.user) return fail(404, "User not found.");
        if (myRole === "admin" && norm(t.user.app_metadata?.role) === "super_admin") {
          return fail(403, "Only a Super Admin can change a Super Admin's details.");
        }
        const { data, error } = await admin.auth.admin.updateUserById(t.user.id, {
          user_metadata: { ...(t.user.user_metadata || {}), name },
        });
        if (error) throw error;
        return reply(200, { user: view(data.user) });
      }

      case "set_role": {
        if (myRole !== "super_admin") return fail(403, "Only a Super Admin can change roles.");
        const role = String(body.role ?? "");
        if (!(ROLES as readonly string[]).includes(role)) return fail(400, "Choose a role.");
        if (String(body.id) === me.user.id) return fail(400, "You can't change your own role.");
        const { data: t, error: tErr } = await admin.auth.admin.getUserById(String(body.id));
        if (tErr || !t?.user) return fail(404, "User not found.");
        const { data, error } = await admin.auth.admin.updateUserById(t.user.id, {
          app_metadata: { ...(t.user.app_metadata || {}), role },
        });
        if (error) throw error;
        return reply(200, { user: view(data.user) });
      }

      case "remove": {
        if (myRole !== "super_admin") return fail(403, "Only a Super Admin can remove users.");
        if (String(body.id) === me.user.id) return fail(400, "You can't remove yourself.");
        const { error } = await admin.auth.admin.deleteUser(String(body.id));
        if (error) throw error;
        return reply(200, { ok: true });
      }

      default:
        return fail(400, "Unknown action.");
    }
  } catch (e) {
    console.error(e);
    return fail(500, "Something went wrong on the server. Please try again.");
  }
});
