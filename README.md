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
  - **Comments** — tap **📎 Attach file** to add files to a comment; they appear inside the
    comment under the same time stamp. Workspace members only; each shows author and a date-time stamp
    (e.g. *31 Oct 2026, 11:49 · 5 min ago*). Authors can **edit** their own comments
    (shown as *(edited 5 Nov 2026, 15:40)*; the original time stamp stays) and delete them;
    admins can delete any comment.
  - **Google Drive folder** — the link box is always shown; it unlocks once a PIC is chosen
    (tap *Make me the PIC* to assign yourself). The PIC pastes the folder link (must be a
    `https://drive.google.com/` link); everyone sees an *Open Google Drive folder* button.
    Admins can also set it as a fallback if the PIC is unavailable.
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
workspace.html          Kanban board for one workspace
dashboard.html          Redirect to workspaces.html (kept for old links)
assets/css/login.css    Login styles + shared colour tokens (light/dark)
assets/css/app.css      Styles for signed-in pages
assets/js/config.js     Supabase project URL + publishable key
assets/js/auth.js       Auth service — the only file that talks to Supabase Auth
assets/js/reset-password.js  Set-password page (invites + password reset)
assets/js/store.js      Data store — the only file that reads/writes workspace data
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

### Add a team member
**Authentication → Users → Add user → Send invitation**, enter their work email.
They get an email, click the link, choose a password, and land in PMO Tools.

To give someone a display name or the admin role, run in **SQL Editor**:
```sql
update auth.users
set raw_user_meta_data = raw_user_meta_data || '{"name":"Benny Tannawi"}',
    raw_app_meta_data  = raw_app_meta_data  || '{"role":"admin"}'
where email = 'name@company.com';
```
(Role changes apply the next time that person signs in.) Without a name, the
part of the email before "@" is shown. Remove someone with **Users → ⋯ → Delete user**.

### Email limits
Supabase's built-in email sender allows only a few emails per hour and is meant
for testing. Before inviting the whole team, set up your own SMTP under
**Authentication → Emails → SMTP Settings** (e.g. Google Workspace, Resend, SendGrid).

> ⚠️ The member-only comment rule and the PIC-only Drive rule are enforced in
> the browser for now. When boards move to Supabase, enforce them with Row Level Security.

## Where data is stored (important)
For now, workspaces and tasks are saved in **this browser's localStorage**.
Each person/browser sees only their own data — the team does **not** share
boards yet, and clearing browser data deletes them. To share across the team,
connect a backend and replace the method bodies in `assets/js/store.js`
(`listWorkspaces`, `createWorkspace`, `getWorkspace`, `addMember`,
`removeMember`, `addSection`, `renameSection`, `deleteSection`, `addTask`,
`updateTask`, `moveTask`, `deleteTask`, `addSubtask`, `updateSubtask`,
`deleteSubtask`, `addComment`, `deleteComment`, `addAttachments`,
`deleteAttachment`, `getFile`, `setTaskDrive`) with API calls. The pages only call these async methods, so no
page code needs to change.

### Attachments in demo mode
File contents are saved in the browser's **IndexedDB** (not uploaded anywhere), so a
file can only be opened on the device/browser that attached it. With a backend, send
files to cloud storage (e.g. S3, Google Cloud Storage or Supabase Storage) inside
`saveFiles` / `getFile` in `store.js`.

## Protecting a new page
```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/dist/umd/supabase.js"></script>
<script src="assets/js/config.js"></script>
<script src="assets/js/auth.js"></script>
<script>const session = Auth.requireAuth();</script>
```
