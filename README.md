# PMO-tools
Create a simple PMO tools similar to Asana for the team

## Current status
- **Login page** (`index.html`) — email + password sign-in, show/hide password,
  "Keep me signed in", inline validation, loading state, and a 60-second
  lockout after 5 failed attempts.
- **Workspaces** (`workspaces.html`) — the landing page after login. Lists all
  workspaces (tasks, sections, % completed) and a **New workspace** button that
  asks for the workspace name (required, max 60 chars, no duplicate names).
- **Workspace board** (`workspace.html?id=…`) — kanban with default sections
  **To do → In progress → Review → Completed**, plus an **Add section** column
  for custom sections (rename/delete via the ⋯ menu; tasks in a deleted section
  move to To do). Tasks: add, edit name/description, delete, drag & drop between
  or within sections, or move via the task dialog (works on phones).
- **Task details** (click a card) — two-panel view with:
  - **Project** — read-only, always the board (workspace) name.
  - **PIC / assigned to** — pick from the workspace members. On the board, each card shows
    the PIC's avatar and first name beside the title (**?** if nobody is assigned); tap it
    to open a dropdown of workspace members and assign/change the PIC directly.
  - **Due date** — chosen from a calendar picker (typing is disabled). The card shows
    📅 with the date: red when overdue, amber when due today/tomorrow.
  - **Description**.
  - **Subtasks / checklist** — add, tick, rename, delete; progress bar, and `☑ 2/5` on the card.
  - **Attachments** — drag files in or tap *choose files* (up to 5 at a time, 10 MB each).
    Each file shows who attached it and the date-time. Files attached in comments also
    appear here. Tap a file to open it (images/PDF) or download it. The card shows 📎 count.
  - **@mentions** — type `@` in a comment to pick a workspace member; it inserts their
    handle (name in lower case, no spaces: *Rivan Oktavianus* → `@rivanoktavianus`).
    Mentions are highlighted; comments that mention you get an amber marker. Each
    comment stores its `mentions` list (name + email) for future notifications.
  - **Comments** — tap **📎 Attach file** to add files to a comment; they appear inside the
    comment under the same time stamp. Workspace members only; each shows author and a date-time stamp
    (e.g. *31 Oct 2026, 11:49 · 5 min ago*). Authors can **edit** their own comments
    (shown as *(edited 5 Nov 2026, 15:40)*; the original time stamp stays) and delete them;
    admins can delete any comment.
  - **Google Drive folder** — any workspace member can paste or change the folder link
    (must be a `https://drive.google.com/` link) and type a **folder name**. The button
    shows that name (e.g. *Finance ↗*), or *Open Google Drive folder* if left blank; the
    card shows **Drive · Finance**. (The name is typed, not read from Drive — reading it
    automatically would need Google sign-in / the Drive API.)
  - Name, description, section and PIC save with **Save**; subtasks, comments and the
    Drive link save instantly.
- **Workspace members** (Members button on the board) — add by name + email, remove
  (their tasks become unassigned). The workspace creator is the first member.
- `dashboard.html` now just redirects to `workspaces.html` for old links.

## Project structure
```
index.html              Login page
reset-password.html     Set password (invitation / reset links land here)
workspaces.html         Workspaces list + create (landing page after login)
users.html              Users: invite, roles, remove (Super Admin / Admin)
workspace.html          Kanban board for one workspace
dashboard.html          Redirect to workspaces.html (kept for old links)
assets/css/login.css    Login styles + shared colour tokens (light/dark)
assets/css/app.css      Styles for signed-in pages
assets/js/config.js     Supabase project URL + publishable key
assets/js/auth.js       Auth service — the only file that talks to Supabase Auth
assets/js/reset-password.js  Set-password page (invites + password reset)
assets/js/users.js      Users page behaviour
supabase/functions/manage-users/index.ts  Server function for user management
supabase/migrations/    Database tables, security rules, storage bucket
assets/js/store.js      Data store — reads/writes workspaces in Supabase (+ live updates, import)
assets/js/common.js     Shared helpers (top bar, toast, element builder)
assets/js/login.js      Login form behaviour
assets/js/workspaces.js Workspaces page behaviour
assets/js/board.js      Kanban board behaviour
```

## Run locally
No build step. Serve the folder with any static server, e.g.:
```
python3 -m http.server 8000
```
then open http://localhost:8000.

## Sign-in (Supabase)
Accounts are managed in Supabase — there are **no passwords in this code**.
`assets/js/config.js` holds the project URL and the *publishable* key (both are
public by design). Never put the secret / `service_role` key in this repo.

- **Login** (`index.html`) — email + password via Supabase.
- **Forgot password** — emails a reset link (the page never reveals whether an
  email has an account).
- **Set password** (`reset-password.html`) — where invitation and reset links land;
  the person chooses a password and is signed in.

### One-time Supabase settings (dashboard)
1. **Authentication → Sign In / Providers → Email**: enabled. Turn **off**
   *Allow new users to sign up* so only invited people can get in.
2. **Authentication → URL Configuration**:
   - *Site URL*: `https://bennytannawi.github.io/PMO-tools/`
   - *Redirect URLs*: add `https://bennytannawi.github.io/PMO-tools/reset-password.html`
     (and `http://localhost:8000/reset-password.html` for local testing).

### Roles
| Role | Workspaces | Cards | Invite users | Change roles |
|---|---|---|---|---|
| **Super Admin** | All | Edit | ✓ (any role) | ✓ |
| **Admin** | Assigned only | Edit | ✓ (not Super Admin) | – |
| **Member** | Assigned only | Edit | – | – |
| **Guest** | Assigned only | View only | – | – |

"Assigned" = listed under the board's **Members**. Only Super Admins and Admins
create workspaces and add/remove workspace members (picked from people who have
an account). Super Admins and Admins can also delete others' comments/files.
The role is stored in Supabase `app_metadata.role` (users can't change it);
a missing role counts as Member. Role changes apply on the person's next page load.

### Add a team member
Super Admins and Admins: **Users** (top bar) → *Invite someone* → name, email,
role → **Send invitation**. The person gets an email, sets a password, and can sign
in. Then add them to workspaces from each board's **Members** button.
Super Admins change roles and remove people on the same page.

The Users page calls the `manage-users` Edge Function
(`supabase/functions/manage-users/index.ts`), which holds the admin key on the
server and re-checks the caller's role on every request.

### Email limits
Supabase's built-in email sender allows only a few emails per hour and is meant
for testing. Before inviting the whole team, set up your own SMTP under
**Authentication → Emails → SMTP Settings** (e.g. Google Workspace, Resend, SendGrid).

> ⚠️ The member-only rules for comments, files and the Drive link are enforced in
> the browser for now. When boards move to Supabase, enforce them with Row Level Security.

## Where data is stored
Everything is in Supabase, so **every device and every teammate sees the same
boards**, and changes show up live on other open screens (Supabase Realtime;
also refreshed when a tab comes back to the foreground).

- **Table `public.workspaces`** — one row per workspace; the whole board
  (sections, tasks, subtasks, comments, members) is in `doc` (JSON).
  Edits read the latest copy, apply the change and save with a version check,
  so two people editing at once never overwrite each other.
- **Storage bucket `attachments`** (private) — files at `<workspace id>/<file id>`, 10 MB max.
- **Security (Row Level Security)** — the server enforces the roles: Super Admin
  sees all workspaces; others only those where their email is in Members;
  Guests can't change anything or upload; only Super Admin/Admin create
  workspaces or change members. Schema and policies:
  `supabase/migrations/20261105_shared_workspaces.sql`.

### Moving boards from the old per-browser version
Boards created before this change were saved only in that browser. Super
Admins/Admins see a banner on the Workspaces page: **Import them to the shared
workspace list** — do it once on each device that has old boards. Files
attached on that device are uploaded too. The old copy is left in the browser
untouched.

## Protecting a new page
```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/dist/umd/supabase.js"></script>
<script src="assets/js/config.js"></script>
<script src="assets/js/auth.js"></script>
<script>const session = Auth.requireAuth();</script>
```
