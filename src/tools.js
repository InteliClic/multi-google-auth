import { gmailFor, calendarFor, driveFor } from "./google.js";
import { loadAccounts } from "./config.js";
import { hasToken, loadToken } from "./tokenStore.js";
import { probe } from "./auth.js";

export const accounts = loadAccounts();
export const accountKeys = accounts.map((a) => a.key);

export function accountOr400(key) {
  const a = accounts.find((x) => x.key === key);
  if (!a) throw new Error(`Unknown account "${key}". Valid: ${accountKeys.join(", ")}`);
  return a;
}

function header(headers, name) {
  const f = (headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return f ? f.value : null;
}

export async function listAccounts({ probe: doProbe = true } = {}) {
  const out = [];
  for (const a of accounts) {
    const stored = loadToken(a.key);
    const row = {
      account: a.key,
      expected_email: a.email,
      has_token: hasToken(a.key),
      authorized_email: stored?.authorized_email || null,
    };
    if (row.has_token && doProbe) {
      const p = await probe(a.key);
      row.live = p.live;
      if (!p.live) row.note = `Broken (${p.error}). Re-run /auth/${a.key}`;
    } else if (!row.has_token) {
      row.live = false;
      row.note = `Not authorized. Run /auth/${a.key}`;
    }
    out.push(row);
  }
  return out;
}

export async function gmailSearch({ account, query, max_results = 10 }) {
  accountOr400(account);
  const max = Math.min(Math.max(1, max_results), 25);
  const gmail = gmailFor(account);
  const list = await gmail.users.threads.list({ userId: "me", q: query, maxResults: max });
  const threads = list.data.threads || [];
  const detailed = [];
  for (const t of threads) {
    const g = await gmail.users.threads.get({
      userId: "me",
      id: t.id,
      format: "metadata",
      metadataHeaders: ["Subject", "From", "Date"],
    });
    const msgs = g.data.messages || [];
    const first = msgs[0];
    const last = msgs[msgs.length - 1];
    detailed.push({
      thread_id: t.id,
      message_count: msgs.length,
      subject: header(first?.payload?.headers, "Subject"),
      from_first: header(first?.payload?.headers, "From"),
      from_last: header(last?.payload?.headers, "From"),
      date_last: header(last?.payload?.headers, "Date"),
      snippet: last?.snippet || t.snippet || "",
    });
  }
  return { result_estimate: list.data.resultSizeEstimate ?? detailed.length, threads: detailed };
}

function decodeBody(payload) {
  function walk(p) {
    if (!p) return "";
    if (p.mimeType === "text/plain" && p.body?.data) {
      return Buffer.from(p.body.data, "base64").toString("utf8");
    }
    if (p.parts) {
      for (const c of p.parts) {
        const r = walk(c);
        if (r) return r;
      }
    }
    return "";
  }
  let text = walk(payload);
  if (!text && payload?.body?.data) {
    text = Buffer.from(payload.body.data, "base64").toString("utf8");
  }
  return text;
}

export async function gmailGetThread({ account, thread_id }) {
  accountOr400(account);
  const gmail = gmailFor(account);
  const g = await gmail.users.threads.get({ userId: "me", id: thread_id, format: "full" });
  const messages = (g.data.messages || []).map((m) => {
    const h = m.payload?.headers;
    let body = decodeBody(m.payload);
    if (body.length > 20000) body = body.slice(0, 20000) + "\n…[truncated]";
    return {
      id: m.id,
      from: header(h, "From"),
      to: header(h, "To"),
      date: header(h, "Date"),
      subject: header(h, "Subject"),
      snippet: m.snippet,
      body,
    };
  });
  return { thread_id, message_count: messages.length, messages };
}

export async function gmailCreateDraft({ account, to, subject, body, cc, bcc, thread_id }) {
  accountOr400(account);
  const gmail = gmailFor(account);
  const lines = [`To: ${to}`];
  if (cc) lines.push(`Cc: ${cc}`);
  if (bcc) lines.push(`Bcc: ${bcc}`);
  lines.push(`Subject: ${subject}`);
  lines.push("Content-Type: text/plain; charset=UTF-8", "", body || "");
  const raw = Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
  const res = await gmail.users.drafts.create({
    userId: "me",
    requestBody: { message: { raw, threadId: thread_id || undefined } },
  });
  return {
    draft_id: res.data.id,
    message_id: res.data.message?.id,
    note: "Draft created (NOT sent). Review and send it from Gmail.",
  };
}

export async function calendarListEvents({
  account,
  calendar_id = "primary",
  time_min,
  time_max,
  max_results = 10,
  query,
}) {
  accountOr400(account);
  const cal = calendarFor(account);
  const res = await cal.events.list({
    calendarId: calendar_id,
    timeMin: time_min || new Date().toISOString(),
    timeMax: time_max || undefined,
    q: query || undefined,
    maxResults: Math.min(Math.max(1, max_results), 50),
    singleEvents: true,
    orderBy: "startTime",
  });
  const events = (res.data.items || []).map((e) => ({
    id: e.id,
    summary: e.summary,
    status: e.status,
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    location: e.location,
    attendees: (e.attendees || []).map((a) => a.email),
    html_link: e.htmlLink,
  }));
  return { calendar_id, count: events.length, events };
}

export async function calendarCreateEvent({
  account,
  calendar_id = "primary",
  summary,
  description,
  location,
  start,
  end,
  attendees,
  time_zone,
}) {
  accountOr400(account);
  const cal = calendarFor(account);
  const toTime = (v) =>
    /^\d{4}-\d{2}-\d{2}$/.test(v) ? { date: v } : { dateTime: v, timeZone: time_zone || undefined };
  const res = await cal.events.insert({
    calendarId: calendar_id,
    requestBody: {
      summary,
      description,
      location,
      start: toTime(start),
      end: toTime(end),
      attendees: (attendees || []).map((email) => ({ email })),
    },
  });
  return { id: res.data.id, html_link: res.data.htmlLink, status: res.data.status };
}

export async function driveSearch({ account, query, max_results = 10 }) {
  accountOr400(account);
  const drive = driveFor(account);
  const looksLikeQuery = /[:=]|contains|mimeType|trashed/.test(query);
  const q = looksLikeQuery
    ? query
    : `fullText contains '${query.replace(/'/g, "\\'")}' and trashed = false`;
  const res = await drive.files.list({
    q,
    pageSize: Math.min(Math.max(1, max_results), 50),
    fields: "files(id,name,mimeType,modifiedTime,size,owners(emailAddress),webViewLink)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return { count: (res.data.files || []).length, files: res.data.files || [] };
}

const GOOGLE_EXPORT = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

export async function driveReadFile({ account, file_id }) {
  accountOr400(account);
  const drive = driveFor(account);
  const meta = await drive.files.get({
    fileId: file_id,
    fields: "id,name,mimeType,size",
    supportsAllDrives: true,
  });
  const mime = meta.data.mimeType;
  let content;
  if (GOOGLE_EXPORT[mime]) {
    const res = await drive.files.export(
      { fileId: file_id, mimeType: GOOGLE_EXPORT[mime] },
      { responseType: "text" }
    );
    content = res.data;
  } else if (mime.startsWith("text/") || mime === "application/json") {
    const res = await drive.files.get(
      { fileId: file_id, alt: "media", supportsAllDrives: true },
      { responseType: "text" }
    );
    content = res.data;
  } else {
    return {
      id: file_id,
      name: meta.data.name,
      mimeType: mime,
      note: "Binary/unsupported type — not rendered as text.",
    };
  }
  if (typeof content === "string" && content.length > 40000) {
    content = content.slice(0, 40000) + "\n…[truncated]";
  }
  return { id: file_id, name: meta.data.name, mimeType: mime, content };
}
