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
  - **PIC / assigned to** — pick from the workspace members; shown as an avatar on the card.
  - **Description**.
  - **Subtasks / checklist** — add, tick, rename, delete; progress bar, and `☑ 2/5` on the card.
  - **Comments** — workspace members only; each shows author and a date-time stamp
    (e.g. *31 Oct 2026, 11:49 · 5 min ago*). Authors (and admins) can delete their own.
  - **Google Drive folder** — the PIC pastes the folder link (must be a
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
workspaces.html         Workspaces list + create (landing page after login)
workspace.html          Kanban board for one workspace
dashboard.html          Redirect to workspaces.html (kept for old links)
assets/css/login.css    Login styles + shared colour tokens (light/dark)
assets/css/app.css      Styles for signed-in pages
assets/js/auth.js       Auth service — the only file that talks to the auth backend
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

## Demo accounts (demo mode only)
| Email              | Password      | Role   |
|--------------------|---------------|--------|
| admin@pmo.local    | Admin#2026    | admin  |
| member@pmo.local   | Member#2026   | member |

> ⚠️ Demo mode checks passwords in the browser and is **not secure**. It is for
> UI testing only. Switch to a real backend before sharing with the team.

## Connecting a real backend
Open `assets/js/auth.js` and set:
```js
MODE: "api",
API_BASE_URL: "https://your-backend/api",
```
The page will `POST {email, password}` to `/auth/login` and expects:
```json
{ "token": "...", "user": { "name": "...", "email": "...", "role": "admin" } }
```
Then delete the `DEMO_USERS` list. Password hashing, rate limiting and
account management must live on the server.

> ⚠️ The member-only comment rule and the PIC-only Drive rule are enforced in
> the browser in demo mode. With a real backend, enforce them on the server too.

## Where data is stored (important)
In demo mode, workspaces and tasks are saved in **this browser's localStorage**.
Each person/browser sees only their own data — the team does **not** share
boards yet, and clearing browser data deletes them. To share across the team,
connect a backend and replace the method bodies in `assets/js/store.js`
(`listWorkspaces`, `createWorkspace`, `getWorkspace`, `addMember`,
`removeMember`, `addSection`, `renameSection`, `deleteSection`, `addTask`,
`updateTask`, `moveTask`, `deleteTask`, `addSubtask`, `updateSubtask`,
`deleteSubtask`, `addComment`, `deleteComment`, `setTaskDrive`) with API calls. The pages only call these async methods, so no
page code needs to change.

## Protecting a new page
```html
<script src="assets/js/auth.js"></script>
<script>const session = Auth.requireAuth();</script>
```
