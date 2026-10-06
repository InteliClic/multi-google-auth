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
| `list_accounts` | Lists accounts and **probes** each token: `live` vs `broken` vs `not connected`, with `authorized_at` (the last consent). |
| `gmail_search` | Search threads with Gmail query syntax (`from:`, `newer_than:7d`, `has:attachment`…). |
| `gmail_get_thread` | Full thread with decoded plain-text bodies. |
| `gmail_create_draft` | Creates a **draft only** — it never sends. |
| `calendar_list_events` | Upcoming events for an account/calendar. |
| `calendar_create_event` | Create an event (timed or all-day). |
| `drive_search` | Full-text or raw-query Drive search. |
| `drive_read_file` | Read a file's text (Docs/Sheets/Slides exported to text/CSV). |
| `assistant_command` | Sends a text command to **Google Assistant** as the account, the same as saying it to a Google speaker ("3D Printer off"). It acts on real devices. Only for an account whose `scopes` include the Assistant scope (see *Google Assistant* below). |

All tools take an `account` argument — one of the keys in `accounts.json`
(`aroncorp`, `inteliclic`, `personal`, `personal-drive`, `assistant`, `logicall`). A tool asked of a key
without that API says which key has it.

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

**APIs & Services → OAuth consent screen** (in the current console: **Google Auth Platform →
Audience**, with the app name under **Branding**):

- User type: **External** is fine.
- Add the scopes this hub uses: `.../auth/userinfo.email`, `.../auth/gmail.modify`,
  `.../auth/calendar`, `.../auth/drive.readonly`.
- Click **Publish app** so the **Publishing status = In production**.
  - If **Publish app** is greyed out with "Your app's OAuth configuration is incomplete", fix the
    **Branding** page first — usually a red *Missing domain* under **Authorized domains** (add the
    domain of whatever you put in *Application home page*, or clear that field) — then **Save**.
  - Don't upload a logo. Google's own note says a logo means you must submit the app for
    verification once it leaves Testing; a private hub gains nothing from one.

> If you leave it in **Testing**, Google expires every refresh token after **7 days** and
> you're back to reconnecting weekly. Publishing to production is what stops that. (These
> are your own accounts on your own project, so you don't need Google's brand verification
> for it to work — an "unverified app" consent warning you can click through is expected.)

#### Consumer @gmail.com accounts need a Testing client

Google will not let a consumer **@gmail.com** account grant *restricted* scopes (Gmail
read/modify, Drive read-only) to an unverified app that is **In production** — the consent
screen says **"This app is blocked"** with no way through. Google Workspace accounts are fine
(their org admin governs app access). Tested 2026-10-01 with nickcr@gmail.com on this hub's
production app: **Calendar alone is blocked too**; only the Assistant scope alone gets through.

So a consumer account's Calendar and Drive use their own client on a project that stays in
**Testing**:

1. Signed in as that Gmail account, create a Google Cloud project and enable the Calendar
   and Drive APIs (and the Google Assistant API for `assistant_command`).
2. **Google Auth Platform → Branding**: any name, no logo. **Audience**: External, leave it in
   **Testing**, and add the Gmail address under **Test users**.
3. **Clients → Create client → Web application**, redirect URI
   `http://localhost:8790/oauth2callback`.
4. Put its credentials in `.env` as `GOOGLE_CLIENT_ID_<KEY>` / `GOOGLE_CLIENT_SECRET_<KEY>`
   for each key that uses it (`<KEY>` = the key upper-cased, non-alphanumerics as `_`).
5. Restart `npm run auth` and authorize each key.

The Testing rule applies: each grant's refresh token dies 7 days after its approval.
`list_accounts` reports `expires_weekly: true` for such a grant (Google puts
`refresh_token_expires_in` on it), and `authorized_at`, which only a consent sets, is where the
7 days start.

This hub splits nickcr@gmail.com into three keys, each with its own `scopes` (see *Configure
accounts*), so that only Calendar needs the weekly click:

- **`personal`**: Calendar, on the Testing client, re-approved weekly. Its Gmail goes over IMAP
  (below). `.env`: `GOOGLE_CLIENT_ID_PERSONAL` / `GOOGLE_CLIENT_SECRET_PERSONAL`.
- **`personal-drive`**: Drive only, on the Testing client, re-approved when Drive is needed;
  its lapsing costs nothing day to day. `.env`: `GOOGLE_CLIENT_ID_PERSONAL_DRIVE` /
  `GOOGLE_CLIENT_SECRET_PERSONAL_DRIVE`, the same values.
- **`assistant`**: the Assistant only, on the **production** client (no `.env` override), which
  Google allows for this scope alone, so it **does not expire**. `assistant_command` on
  `personal` goes through it.

#### Gmail that doesn't expire: an app password

A consumer account's **Gmail** can skip OAuth entirely. Turn on 2-Step Verification for it,
create an app password at <https://myaccount.google.com/apppasswords>, and put it in `.env` as
`GMAIL_APP_PASSWORD_<KEY>` (spaces as Google shows them are fine). That account's
`gmail_search`, `gmail_get_thread` and `gmail_create_draft` then go over IMAP
(`imap.gmail.com`, Gmail's own search syntax via `X-GM-RAW`) and return the same thread and
message ids as the API. An app password lasts until it is deleted or the Google password
changes. `list_accounts` reports `gmail: "imap"` and probes that login as `gmail_live`.
Calendar and Drive still use OAuth.

### 4. Configure accounts

`accounts.json` ships with these keys. Edit keys/emails to taste:

```json
[
  { "key": "aroncorp",   "email": "nick@aroncorp.com",    "label": "Aron Corp" },
  { "key": "inteliclic", "email": "nick@inteliclic.com",  "label": "InteliClic" },
  { "key": "billing",    "email": "billing@inteliclic.com", "label": "InteliClic Billing" },
  { "key": "personal",   "email": "nickcr@gmail.com",     "label": "Personal",
    "scopes": ["openid", "https://www.googleapis.com/auth/userinfo.email",
               "https://www.googleapis.com/auth/calendar"] },
  { "key": "personal-drive", "email": "nickcr@gmail.com", "label": "Personal Drive",
    "scopes": ["openid", "https://www.googleapis.com/auth/userinfo.email",
               "https://www.googleapis.com/auth/drive.readonly"] },
  { "key": "assistant",  "email": "nickcr@gmail.com",     "label": "Personal Assistant",
    "scopes": ["openid", "https://www.googleapis.com/auth/userinfo.email",
               "https://www.googleapis.com/auth/assistant-sdk-prototype"] },
  { "key": "logicall",   "email": "nicholas@logicall.io", "label": "LogiCall" }
]
```

`scopes` is optional: an account's full scope list in place of the shared one (`SCOPES` in
`src/config.js`). `list_accounts` reports any the stored grant doesn't carry as
`scopes_missing`.

#### Google Assistant (`assistant_command`)

The tool calls the Google Assistant API (`embeddedassistant.googleapis.com`, gRPC v1alpha2) the
way Home Assistant's *Google Assistant SDK* integration does, so anything you can say to a
Google speaker on that account works as text. To turn it on for an account:

1. In the Cloud project that owns **that key's** OAuth client, enable the **Google
   Assistant API**.
2. Add `https://www.googleapis.com/auth/assistant-sdk-prototype` to the key's `scopes` (or
   give the account a key of its own with only that scope, like `assistant`; a call on any
   key of the same email goes there).
3. Authorize the key (`/auth/<key>`) so the grant carries the scope.

Use Google's own device names: Google calls it "3 D Printer", and "3D Printer off" goes
unanswered while "turn off 3 D Printer" works. The reply text arrives in `screen_text`
(`reply_text` stays empty); a reply with no `screen_text` usually means Google did not act,
and its audio (pass `audio_path`) says why, e.g. "Sorry, I didn't understand". Confirm what a
command did some other way.

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

The server reads `.env` (plus `accounts.json` and `tokens/`) from its own folder, so the absolute
path is all it needs — it doesn't matter which directory Claude launches it from.

> **Port sharing:** the MCP instance also serves `/auth/<key>` on port 8790 whenever the port is
> free, and simply skips the web server (tools still work) if `npm run auth` already owns it. If
> you'd rather the Claude-launched instance never open a port, add `-e DISABLE_AUTH_SERVER=1` (or
> `"env": { "DISABLE_AUTH_SERVER": "1" }`) and use `npm run auth` for the auth pages.

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
| **Error 403: access_denied** — "…has not completed the Google verification process… can only be accessed by developer-approved testers" | The consent screen is in **Testing** and that Google account isn't a test user. Publish to **In production** (step 3). Adding the account under *Audience → Test users* also unblocks it, but the 7-day token expiry still applies. |
| **This app is blocked** — "tried to access sensitive info… Google blocked this access" (no *Advanced* link) | A consumer **@gmail.com** account trying to grant **restricted** scopes (Gmail read/modify, Drive read-only) to an unverified production app. Google Workspace accounts get through because their org admin governs app access; consumer accounts can't bypass it. Options for that one account: a separate project kept in **Testing** with the account as a test user (7-day token expiry applies; re-authorize from the status page), completing restricted-scope verification (privacy policy, demo video, and a CASA security assessment for Gmail scopes), or leaving that account out. |
| Accounts authorized while the app was in Testing still die after 7 days | The 7-day clock is stamped on the token when it's issued. After publishing, re-authorize each account once via `/auth/<key>`. |
| `npm run auth` fails: `port 8790 is already in use` | Another instance (e.g. one Claude launched) is already serving the pages — just open <http://localhost:8790/>. Or set `PORT=<other>`. |
| It keeps breaking every few days | Your consent screen is still in **Testing**. Publish it to **In production** (step 3). |
| No `refresh_token` saved | Make sure you're using this hub's auth flow (it forces `prompt=consent`); revoke the app at <https://myaccount.google.com/permissions> and re-authorize. |
| `redirect_uri_mismatch` | The redirect URI in `.env` must EXACTLY match one on the OAuth client. |
| Wrong account authorized | The callback warns on mismatch; re-run `/auth/<key>` and pick the right Google account. |
