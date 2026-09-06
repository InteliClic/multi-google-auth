# multi-google-auth

A small self-hosted **MCP server** that gives an AI assistant (Claude, etc.) read/act
access to **multiple Google accounts** at once — Gmail, Calendar, and Drive — through a
single connection, using per-account OAuth refresh tokens.

It was built to fix a specific, recurring failure: tokens that silently die, while a
status check still cheerfully reports every account as "connected."

## Why this exists (the recurring-breakage fix)

Two things cause the "it says connected but it's broken" loop:

1. **Missing refresh tokens.** Google only returns a long-lived `refresh_token` when you
   request `access_type=offline` **and** force `prompt=consent`. Without the forced
   consent, repeat authorizations come back with *no* refresh token, so the account works
   for an hour and then can't refresh. This hub always sends both → you always get a
   refresh token.
2. **The OAuth app is still in "Testing" mode.** Google **expires refresh tokens after 7
   days** for any OAuth app whose consent screen publishing status is *Testing*. That is
   the classic "all my Google connections broke again this week" symptom. **The permanent
   fix is to set the consent screen to "In production"** (see setup step 3). Once it's in
   production, refresh tokens don't expire on a 7-day clock.

And so a dead token can't masquerade as healthy, **`list_accounts` actively probes each
refresh token** (it performs a real token refresh) and reports `live: true/false` — not
just "a token file exists."

## Tools exposed

| Tool | What it does |
|---|---|
| `list_accounts` | Lists accounts and **probes** each token: `live` vs `broken` vs `not connected`. |
| `gmail_search` | Search threads with Gmail query syntax (`from:`, `newer_than:7d`, `has:attachment`…). |
| `gmail_get_thread` | Full thread with decoded plain-text bodies. |
| `gmail_create_draft` | Creates a **draft only** — it never sends. |
| `calendar_list_events` | Upcoming events for an account/calendar. |
| `calendar_create_event` | Create an event (timed or all-day). |
| `drive_search` | Full-text or raw-query Drive search. |
| `drive_read_file` | Read a file's text (Docs/Sheets/Slides exported to text/CSV). |

All tools take an `account` argument — one of the keys in `accounts.json`
(`aroncorp`, `inteliclic`, `personal`, `logicall`).

## Prerequisites

- **Node.js 18+**
- A Google Cloud project you control

## Setup

### 1. Install

```bash
git clone https://github.com/InteliClic/multi-google-auth.git
cd multi-google-auth
npm install
cp .env.example .env
```

### 2. Create the OAuth client

In the [Google Cloud Console](https://console.cloud.google.com/):

1. Pick (or create) a project.
2. **APIs & Services → Enable APIs** → enable **Gmail API**, **Google Calendar API**, and
   **Google Drive API**.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
   - Application type: **Web application**.
   - **Authorized redirect URIs** → add `http://localhost:8790/oauth2callback`
     (and, if you host it, `https://your-domain/oauth2callback`).
4. Copy the **Client ID** and **Client secret** into `.env`.

### 3. Publish the consent screen to "In production"  ← the durable fix

**APIs & Services → OAuth consent screen**:

- User type: **External** is fine.
- Add the scopes this hub uses: `.../auth/userinfo.email`, `.../auth/gmail.modify`,
  `.../auth/calendar`, `.../auth/drive.readonly`.
- Click **Publish app** so the **Publishing status = In production**.

> If you leave it in **Testing**, Google expires every refresh token after **7 days** and
> you're back to reconnecting weekly. Publishing to production is what stops that. (These
> are your own accounts on your own project, so you don't need Google's brand verification
> for it to work — an "unverified app" consent warning you can click through is expected.)

### 4. Configure accounts

`accounts.json` ships with four accounts. Edit keys/emails to taste:

```json
[
  { "key": "aroncorp",   "email": "nick@aroncorp.com",    "label": "Aron Corp" },
  { "key": "inteliclic", "email": "nick@inteliclic.com",  "label": "InteliClic" },
  { "key": "personal",   "email": "nickcr@gmail.com",     "label": "Personal" },
  { "key": "logicall",   "email": "nicholas@logicall.io", "label": "LogiCall" }
]
```

### 5. Authorize each account

```bash
npm run auth
```

Open **http://localhost:8790/**. For each account click **authorize**, pick the matching
Google account, and approve. Tokens are written to `tokens/<key>.json` (gitignored). The
page shows 🟢 live / 🔴 broken / ⚪ not connected for each. `Ctrl+C` when done.

To **re-authorize** a broken account later, just visit `http://localhost:8790/auth/<key>`
(e.g. `/auth/inteliclic`).

### 6. Connect it to Claude

Add it as an MCP server. CLI:

```bash
claude mcp add multi-google-auth -- node /absolute/path/to/multi-google-auth/src/index.js
```

or in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "multi-google-auth": {
      "command": "node",
      "args": ["/absolute/path/to/multi-google-auth/src/index.js"]
    }
  }
}
```

The server reads `.env` from its own folder, so the absolute path is all it needs.

## Hosting it remotely (optional)

Run it on a small always-on box instead of your laptop:

- Set `PUBLIC_URL=https://your-domain` in `.env` and add `https://your-domain/oauth2callback`
  to the OAuth client's redirect URIs.
- Put it behind HTTPS (a reverse proxy) and **restrict who can reach `/auth`** — anyone who
  can open it can start an OAuth flow into your accounts.
- Keep `tokens/` on a persistent volume.
- Run two roles from one install if you like: the MCP over stdio, and a long-running
  `--auth-only` instance for the web auth pages.

## Security

- **Never commit secrets.** `.env` and `tokens/` are gitignored. `accounts.json` holds only
  emails (not secrets) and is committed so the hub works out of the box.
- Scopes are least-privilege for the tools: Gmail is `modify` (read + draft; this hub never
  calls send), Calendar is read/write, Drive is **read-only**.
- `gmail_create_draft` and `calendar_create_event` are the only write actions; drafts are
  never sent automatically.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `invalid_grant` / `list_accounts` shows **broken** | Re-authorize: visit `/auth/<key>`. |
| It keeps breaking every few days | Your consent screen is still in **Testing**. Publish it to **In production** (step 3). |
| No `refresh_token` saved | Make sure you're using this hub's auth flow (it forces `prompt=consent`); revoke the app at <https://myaccount.google.com/permissions> and re-authorize. |
| `redirect_uri_mismatch` | The redirect URI in `.env` must EXACTLY match one on the OAuth client. |
| Wrong account authorized | The callback warns on mismatch; re-run `/auth/<key>` and pick the right Google account. |
