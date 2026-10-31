# PMO-tools
Create a simple PMO tools similar to Asana for the team

## Current status
- **Login page** (`index.html`) — email + password sign-in, show/hide password,
  "Keep me signed in", inline validation, loading state, and a 60-second
  lockout after 5 failed attempts.
- **Dashboard placeholder** (`dashboard.html`) — protected page that redirects
  to login when signed out; shows the signed-in user and a Sign out button.

## Project structure
```
index.html              Login page
dashboard.html          Protected landing page (placeholder)
assets/css/login.css    Styles (light + dark mode, mobile responsive)
assets/js/auth.js       Auth service — the only file that talks to the backend
assets/js/login.js      Login form behaviour
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

## Protecting a new page
```html
<script src="assets/js/auth.js"></script>
<script>const session = Auth.requireAuth();</script>
```
