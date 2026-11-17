import crypto from "node:crypto";
import { ImapFlow } from "imapflow";
import { suffixOf } from "./config.js";
import { describePart } from "./attachments.js";

// Gmail over IMAP with an app password, for an account whose OAuth client cannot
// stay authorized: a consumer @gmail.com account may only grant the Gmail scopes
// to a Testing-mode client, and those refresh tokens die after 7 days. An app
// password (GMAIL_APP_PASSWORD_<KEY> in .env) does not expire. Thread and message
// ids are Gmail's own (X-GM-THRID / X-GM-MSGID, in hex), the same ids the API uses,
// so results from either path can be passed to the other.

export function imapPasswordFor(key) {
  const v = process.env[`GMAIL_APP_PASSWORD_${suffixOf(key)}`] || "";
  // Google shows the password in four groups of four; the spaces are not part of it.
  return v.trim().replace(/^["']|["']$/g, "").replace(/\s+/g, "");
}

async function withClient(account, fn) {
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: account.email, pass: imapPasswordFor(account.key) },
    logger: false, // stdout belongs to MCP
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => {});
  }
}

async function boxPath(client, use) {
  const box = (await client.list()).find((b) => b.specialUse === use);
  if (!box) throw new Error(`No ${use} mailbox found over IMAP`);
  return box.path;
}

async function inAllMail(client, fn) {
  const lock = await client.getMailboxLock(await boxPath(client, "\\All"), { readOnly: true });
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

const toHex = (dec) => BigInt(dec).toString(16);
const toDec = (hex) => BigInt(`0x${hex}`).toString();
const addrs = (list) =>
  (list || []).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ") || null;
const when = (d) => (d ? new Date(d).toUTCString() : null);
const oneLine = (s) => String(s ?? "").replace(/[\r\n]+/g, " "); // no header injection

function findPart(node, type) {
  if (!node) return null;
  if (node.childNodes?.length) {
    for (const c of node.childNodes) {
      const found = findPart(c, type);
      if (found) return found;
    }
    return null;
  }
  return node.type === type && node.disposition !== "attachment" ? node.part || "1" : null;
}

function htmlToText(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// The text of one message: its text/plain part, else its HTML stripped to text.
// download() decodes the transfer encoding and converts the charset to UTF-8.
async function textOf(client, uid, structure, maxBytes) {
  const plain = findPart(structure, "text/plain");
  const part = plain || findPart(structure, "text/html");
  if (!part) return "";
  const { content } = await client.download(String(uid), part, { uid: true, maxBytes });
  const chunks = [];
  for await (const c of content) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  return plain ? text : htmlToText(text);
}

export async function imapProbe(account) {
  try {
    await withClient(account, async () => {});
    return { live: true };
  } catch (e) {
    return { live: false, error: String(e?.responseText || e?.message || e) };
  }
}

export async function imapSearch(account, query, max) {
  return withClient(account, (client) =>
    inAllMail(client, async () => {
      const uids = (await client.search({ gmraw: query }, { uid: true })) || [];
      // Newest matches first; group them into threads, newest thread first.
      const newest = new Map();
      const recent = uids.slice(-200);
      if (recent.length) {
        for await (const m of client.fetch(recent.join(","), { threadId: true }, { uid: true })) {
          if (!newest.has(m.threadId) || m.uid > newest.get(m.threadId)) newest.set(m.threadId, m.uid);
        }
      }
      const picked = [...newest.entries()].sort((a, b) => b[1] - a[1]).slice(0, max);
      const threads = [];
      for (const [threadId] of picked) {
        const all = (await client.search({ threadId }, { uid: true })) || [];
        const firstUid = all[0];
        const lastUid = all[all.length - 1];
        const first = await client.fetchOne(String(firstUid), { envelope: true }, { uid: true });
        const last = await client.fetchOne(String(lastUid), { envelope: true, bodyStructure: true }, { uid: true });
        const snippet = (await textOf(client, lastUid, last.bodyStructure, 4096)).replace(/\s+/g, " ").trim();
        threads.push({
          thread_id: toHex(threadId),
          message_count: all.length,
          subject: first.envelope?.subject || null,
          from_first: addrs(first.envelope?.from),
          from_last: addrs(last.envelope?.from),
          date_last: when(last.envelope?.date),
          snippet: snippet.slice(0, 200),
        });
      }
      return { result_estimate: uids.length, threads, via: "imap" };
    })
  );
}

export async function imapGetThread(account, thread_id) {
  return withClient(account, (client) =>
    inAllMail(client, async () => {
      const uids = (await client.search({ threadId: toDec(thread_id) }, { uid: true })) || [];
      const messages = [];
      for (const uid of uids) {
        const m = await client.fetchOne(String(uid), { envelope: true, bodyStructure: true }, { uid: true });
        let body = await textOf(client, uid, m.bodyStructure, 200000);
        if (body.length > 20000) body = body.slice(0, 20000) + "\n…[truncated]";
        messages.push({
          id: m.emailId ? toHex(m.emailId) : String(uid),
          from: addrs(m.envelope?.from),
          to: addrs(m.envelope?.to),
          date: when(m.envelope?.date),
          subject: m.envelope?.subject || null,
          snippet: body.replace(/\s+/g, " ").trim().slice(0, 200),
          body,
        });
      }
      return { thread_id, message_count: messages.length, messages, via: "imap" };
    })
  );
}

// Every file a message carries, from its BODYSTRUCTURE. An attached email
// (message/rfc822) is one file and is not opened up.
export function fileParts(node, out = []) {
  if (!node) return out;
  if (node.childNodes?.length && node.type !== "message/rfc822") {
    for (const c of node.childNodes) fileParts(c, out);
    return out;
  }
  const file = describePart({
    type: node.type,
    disposition: node.disposition,
    filename: node.dispositionParameters?.filename || node.parameters?.name,
    contentId: node.id,
  });
  if (!file) return out;
  // BODYSTRUCTURE gives the size as sent, still base64 for most files: about 57 bytes
  // of file per 78 sent. The exact size is known once the part has been read.
  const sent = Number(node.size) || 0;
  const base64 = String(node.encoding || "").toLowerCase() === "base64";
  out.push({
    ...file,
    part: node.part || "1",
    size: base64 ? Math.round((sent * 57) / 78) : sent,
    size_floor: base64 ? Math.floor(sent * 0.7) : sent,
    size_exact: !base64,
  });
  return out;
}

// The attachments of a thread or of one message. `use` gets { message_count, items,
// bytesOf } while the connection is open and returns the tool result. The mailbox is
// opened read-only and parts are fetched with BODY.PEEK, so nothing is marked as read.
export async function imapAttachments(account, { thread_id, message_id }, use) {
  return withClient(account, (client) =>
    inAllMail(client, async () => {
      const query = thread_id ? { threadId: toDec(thread_id) } : { emailId: toDec(message_id) };
      const uids = (await client.search(query, { uid: true })) || [];
      if (!uids.length) throw new Error(`No ${thread_id ? `thread ${thread_id}` : `message ${message_id}`} on ${account.email}`);
      const items = [];
      for (const uid of uids) {
        const m = await client.fetchOne(String(uid), { envelope: true, bodyStructure: true }, { uid: true });
        const mid = m.emailId ? toHex(m.emailId) : String(uid);
        for (const f of fileParts(m.bodyStructure)) {
          items.push({
            ...f,
            id: `${mid}/${f.part}`,
            message_id: mid,
            uid,
            from: addrs(m.envelope?.from),
            date: when(m.envelope?.date),
          });
        }
      }
      // download() removes the transfer encoding; decodeText: false keeps a text file's
      // bytes as sent. One byte past the limit is enough to know it is over.
      const bytesOf = async (item, limit) => {
        const { content } = await client.download(String(item.uid), item.part, {
          uid: true,
          maxBytes: limit + 1,
          decodeText: false,
          chunkSize: 1024 * 1024,
        });
        if (!content) throw new Error(`Part ${item.part} of message ${item.message_id} was not returned`);
        const chunks = [];
        for await (const c of content) chunks.push(c);
        return Buffer.concat(chunks);
      };
      return { ...(await use({ message_count: uids.length, items, bytesOf })), via: "imap" };
    })
  );
}

const encodeWord = (s) =>
  /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;

export async function imapCreateDraft(account, { to, subject, body, cc, bcc, thread_id }) {
  return withClient(account, async (client) => {
    const h = [`From: ${account.email}`, `To: ${oneLine(to)}`];
    if (cc) h.push(`Cc: ${oneLine(cc)}`);
    if (bcc) h.push(`Bcc: ${oneLine(bcc)}`);
    h.push(`Subject: ${encodeWord(oneLine(subject))}`);
    if (thread_id) {
      // Reply in the thread the way a mail client does: point at its last message.
      const parent = await inAllMail(client, async () => {
        const uids = (await client.search({ threadId: toDec(thread_id) }, { uid: true })) || [];
        if (!uids.length) throw new Error(`No thread ${thread_id} on ${account.email}`);
        return client.fetchOne(String(uids[uids.length - 1]), { envelope: true, headers: ["references"] }, { uid: true });
      });
      const parentId = parent.envelope?.messageId;
      if (parentId) {
        const refs = (parent.headers?.toString() || "").replace(/^references:/i, "").replace(/\s+/g, " ").trim();
        h.push(`In-Reply-To: ${parentId}`, `References: ${[refs, parentId].filter(Boolean).join(" ")}`);
      }
    }
    const messageId = `<${crypto.randomUUID()}@${account.email.split("@")[1]}>`;
    h.push(
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: ${messageId}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64"
    );
    const encoded = Buffer.from(body || "", "utf8").toString("base64").replace(/.{1,76}/g, "$&\r\n");
    const res = await client.append(await boxPath(client, "\\Drafts"), `${h.join("\r\n")}\r\n\r\n${encoded}`, [
      "\\Draft",
      "\\Seen",
    ]);
    if (!res) throw new Error("Gmail did not accept the draft");
    return {
      draft_uid: res.uid ?? null,
      message_id: messageId,
      via: "imap",
      note: "Draft created (NOT sent). Review and send it from Gmail.",
    };
  });
}
