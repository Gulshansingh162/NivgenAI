# CityShield Flask API

The backend uses Flask, SQLAlchemy, MySQL, and bearer-token authentication.
The Flask app serves the frontend as well as the API.

## Setup

1. Create a MySQL database and application account. For example, run these
   statements as a MySQL administrator and replace the example password:

   ```sql
   CREATE DATABASE cityshield
     CHARACTER SET utf8mb4
     COLLATE utf8mb4_unicode_ci;
   CREATE USER 'cityshield_app'@'127.0.0.1' IDENTIFIED BY 'REPLACE_WITH_PASSWORD';
   GRANT ALL PRIVILEGES ON cityshield.* TO 'cityshield_app'@'127.0.0.1';
   FLUSH PRIVILEGES;
   ```

2. From `backend`, create a virtual environment and install dependencies:

   ```powershell
   py -m venv .venv
   .\.venv\Scripts\Activate.ps1
   py -m pip install -r requirements.txt
   ```

3. Configure `backend/.env` (copy `.env.example` only if `.env` does not
   already exist). Set `DATABASE_URL` to your MySQL connection string, for
   example:

   ```text
   DATABASE_URL=mysql+pymysql://cityshield_app:YOUR_PASSWORD@127.0.0.1:3306/cityshield?charset=utf8mb4
   ```

   Replace `JWT_SECRET_KEY` with a unique random secret of at least 32
   characters. Keep `.env` private. If your password contains URL-reserved
   characters, URL-encode them in `DATABASE_URL`. This project's current
   `backend/.env` points to SQLite; replace its `DATABASE_URL` line with your
   MySQL URL to save new citizen and incident data in MySQL. Do not share your
   database password in chat or commit `.env`.

4. Start the development server from `backend`:

   ```powershell
   py -m app.main
   ```

   Open `http://127.0.0.1:5000`. The first request creates the tables and
   applies the existing users-table compatibility columns. Existing SQLite
   data is not automatically copied to MySQL; export and migrate it separately
   if it must be retained. Use a production WSGI server and HTTPS in deployment.

   You can also initialize the tables explicitly with
   `flask --app app.main init-db`.

## API

Portal requests use `Authorization: Bearer <access_token>`. A scoped integration
key can be sent as `X-API-Key: <key>` on authenticated role endpoints. Registration,
login, and health-check endpoints remain public and do not require a key.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/register` | Register a citizen account |
| POST | `/api/auth/login` | Login and receive an access token |
| GET | `/api/auth/me` | Verify the current account |
| POST | `/api/citizen/incidents` | Submit a report using multipart form data |
| GET | `/api/citizen/incidents` | List reports from the signed-in citizen |
| GET | `/api/citizen/incidents/<id>/updates` | View report status history |
| GET | `/api/citizen/incidents/<id>/image` | View the owner's uploaded image |
| GET | `/api/citizen/facilities` | Find nearby hospitals and designated emergency shelters |
| POST | `/api/worker/reports` | Submit a report as a signed-in worker |
| GET | `/api/worker/reports` | List reports submitted by the worker |
| GET | `/api/worker/assigned` | List incidents assigned to the worker |
| PATCH | `/api/worker/assigned/<id>` | Update status and post assigned-work progress |
| GET | `/api/worker/incidents/<id>/updates` | View owned or assigned incident history |
| GET | `/api/admin/stats` | View incident and worker totals |
| GET | `/api/admin/api-keys/users` | List active account identities for binding API keys (admin session only) |
| GET | `/api/admin/api-keys` | List API key metadata, never secret values (admin session only) |
| POST | `/api/admin/api-keys` | Create a role-bound API key; secret is returned once (admin session only) |
| PATCH | `/api/admin/api-keys/<id>` | Revoke an API key (admin session only) |
| GET | `/api/admin/incidents` | List existing incidents |
| PATCH | `/api/admin/incidents/<id>` | Update status, add an update, or assign a worker or response unit |
| GET | `/api/admin/alerts` | List emergency alerts |
| POST | `/api/admin/alerts` | Send a verified emergency alert to all residents |
| PATCH | `/api/admin/alerts/<id>` | Close an active emergency alert |
| GET | `/api/admin/units` | List response units and their availability |
| POST | `/api/admin/units` | Register an ambulance, rescue team, or municipal crew |
| PATCH | `/api/admin/units/<id>` | Set a response unit in or out of service |
| GET | `/api/admin/workers` | List worker accounts |
| POST | `/api/admin/workers` | Create a worker account |
| GET | `/api/citizen/alerts` | View active emergency alerts |

Citizen reports accept the categories `Flooding`, `Accident`, `Waste`, and
`Road Damage`. JPG, PNG, and WebP images up to 5 MB are saved under the
project's `uploads/` folder; report details, coordinates, and status history
are saved in MySQL. Location text is required, and latitude/longitude are
optional but must be supplied together. Citizen report and image requests are
scoped to the signed-in account. The citizen dashboard checks for status
updates every 30 seconds while it is open.

The Admin Dashboard map uses only GPS coordinates shared with reports. Reports
without coordinates remain available in Incident Management but do not appear
as guessed map pins.

The Resident Portal's Emergency Shelter & Hospital Finder requests device
location only after the resident selects **Find facilities near me**. It
searches OpenStreetMap for hospitals and explicitly designated emergency
shelters within 5 km, recommends the nearest mapped shelter, and links to
directions. Listings may be incomplete; operating status and capacity are not
live-confirmed. If the finder cannot access location or facility data, residents
should follow official local emergency guidance.

Administrators create worker accounts with a name, email, and temporary
password in the Admin Dashboard; there is no public worker registration
endpoint. Workers sign in from **Worker Login**, view incidents assigned to
them, open directions to the incident's coordinates or address in Google Maps,
and post status and progress updates. Administrators assign an active worker
in the Incident Management table. Workers can only update incidents assigned
to their own account.

Incident statuses are `Reported`, `Under Review`, `In Progress`, `Resolved`,
and `Rejected`. Administrators can add an update while changing status or
assigning an incident; workers can see the update history for reports they
submitted and incidents assigned to them. Both dashboards poll for updates
every 30 seconds while open.

Administrators can send verified emergency alerts for flooding, road closures,
severe weather, fire, or other emergencies. Each alert includes an affected
location and safety instructions, is broadcast to all signed-in residents, and
can be closed from the Admin Dashboard. The Resident Portal refreshes active
alerts every 30 seconds while open.

Administrators can register separate ambulance, rescue team, and municipal
crew units in Emergency Resource Management. Open incidents are listed in
critical, high, medium, then low priority order. A unit can be assigned to only
one open incident at a time; it is shown as deployed until that incident is
resolved or rejected. Units can be taken out of service while not deployed.
Unit assignments and incident status changes are recorded in the existing
incident update history.

Incident Management includes rule-based response recommendations using the
reported category, priority, and description. Suggestions include relevant
tracked response units and their availability, an action plan, and safety
instructions. They do not automatically assign or dispatch teams; an
administrator must verify the report and decide on the response.

The Admin AI Copilot summarizes active incidents and alerts, reports created
today, and incident records matching supported priority, category, status, ID,
or text filters. It can show the recorded details for critical incidents, but
the database does not store a separate reason for a critical designation.
Copilot answers use built-in query matching and summary rules on data already
loaded in the administrator dashboard; no external AI model is used.

Administrators can create API keys in **API Key Management** for an active
administrator, worker, or citizen account. Keys are bound to that account and
inherit its role and record-level access. Read-only keys are limited to GET
requests; read/write keys can use that role's existing read and write
endpoints. Key secrets are shown once and only their SHA-256 hashes are stored.
Send keys in the `X-API-Key` header from trusted server-to-server integrations;
never embed them in frontend code, URLs, or source control. Keys expire after
90 days by default (30, 90, or 365 days can be selected; non-expiring keys are
available but discouraged) and can be revoked in the Admin Dashboard. Creating
or revoking keys always requires an administrator's JWT session. Public
registration/login and portal sign-in continue to use their existing flows.

The Resident Portal supports voice-assisted reports through the browser's
Web Speech API in compatible browsers. Residents choose English, Hindi, or
Punjabi; recognized speech fills the description and can suggest a category,
title, and critical urgency based on detected phrases. Residents should review
the transcript and enter or confirm the location before submitting. Microphone
permission and browser/network support are required; typed reporting remains
available.

## Where the citizen and worker interface code lives

- `frontend/index.html` and `frontend/app.js`: Citizen login and registration.
- `frontend/citizen-dashboard.html`, `frontend/citizen-dashboard.css`, and
  `frontend/citizen-dashboard.js`: Voice-assisted English, Hindi, and Punjabi
  report entry, report form, location and image inputs, nearby hospital and
  emergency shelter finder, report tracking, and update notifications.
- `frontend/worker-dashboard.html`, `frontend/worker-dashboard.css`, and
  `frontend/worker-dashboard.js`: Worker-submitted reports, assigned incidents,
  progress updates, and status tracking.
- `backend/app/schemas.py`: Citizen registration input validation. Worker
  registration is intentionally not public; only admins create worker logins.
- `backend/app/models.py`: MySQL-backed users, incidents, worker assignments,
  response units, emergency alerts, and incident updates.
- `backend/app/main.py`: Registration, login, report, image, and update API
  routes, plus compatibility migrations for existing databases.
- `frontend/admin-dashboard.html` and `frontend/admin-dashboard.js`: Manage
  response units, prioritize incidents, create worker accounts, assign
  incidents to workers and units, manage scoped API keys, and use the
  data-grounded Admin AI Copilot.
- `backend/.env`: MySQL connection and private JWT configuration.
- `uploads/`: Image files attached to submitted reports.

Start MySQL, make sure the `cityshield` database and user from the setup steps
exist, then start the Flask server from `backend`. Open
`http://127.0.0.1:5000`. An administrator first creates worker accounts in the
Admin Dashboard and shares the worker's login email and temporary password
securely. The worker then chooses **Worker Login** to sign in.
The first request creates any missing model tables in the configured MySQL
database. Existing tables and report data are retained.

The frontend also supports VS Code Live Server on port 5500, with its API
requests restricted to localhost origins and forwarded to Flask on port 5000.
