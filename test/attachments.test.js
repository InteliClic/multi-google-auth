// gmail_get_attachments tests. No network and no real credentials: an empty .env in a
// temp dir, fake message structures, and a fake source of bytes. Files are written only
// under a temp folder that `after` removes.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mga-att-test-"));
const envFile = path.join(tmp, "test.env");
fs.writeFileSync(envFile, "# empty on purpose: no real .env may be read\n");
for (const k of Object.keys(process.env)) {
  if (/^(HUB_|GOOGLE_CLIENT_|GMAIL_APP_PASSWORD_|TOKENS_DIR$)/.test(k)) delete process.env[k];
}
Object.assign(process.env, {
  DOTENV_CONFIG_PATH: envFile,
  GOOGLE_CLIENT_ID: "123456789012-fake.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "fake",
  TOKENS_DIR: path.join(tmp, "tokens"),
});

await import("../src/env.js");
const { ROOT } = await import("../src/config.js");
const A = await import("../src/attachments.js");
const { fileParts } = await import("../src/gmailImap.js");
const T = await import("../src/tools.js");
const { ALL_TOOLS, READ_TOOLS, TOOL_DEFS } = await import("../src/mcp.js");

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64)]);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
let n = 0;
const freshDir = () => A.outputDir(path.join(tmp, `out-${++n}`));

test("safeName keeps only a harmless file name", () => {
  assert.equal(A.safeName("Service quote 2026.pdf"), "Service quote 2026.pdf");
  assert.equal(A.safeName("..\\..\\Windows\\System32\\evil.pdf"), "evil.pdf");
  assert.equal(A.safeName("../../etc/passwd"), "passwd");
  assert.equal(A.safeName("C:\\Users\\x\\a.pdf"), "a.pdf");
  assert.equal(A.safeName('a<b>:"c"|d?e*.txt'), "a_b___c__d_e_.txt");
  assert.equal(A.safeName("quote.pdf:evil.exe"), "quote.pdf_evil.exe.untrusted");
  assert.equal(A.safeName("line\r\nbreak\u0000.pdf"), "linebreak.pdf");
  assert.equal(A.safeName("invoice\u202Efdp.exe"), "invoicefdp.exe.untrusted"); // right-to-left override
  assert.equal(A.safeName("  .hidden  "), "hidden");
  assert.equal(A.safeName("name. . "), "name");
  assert.equal(A.safeName("NUL.txt"), "_NUL.txt");
  assert.equal(A.safeName("com1"), "_com1");
  assert.equal(A.safeName(""), "attachment");
  assert.equal(A.safeName("..", "attachment-1"), "attachment-1");
  assert.equal(A.safeName("setup.EXE"), "setup.EXE.untrusted");
  assert.equal(A.safeName("run.ps1"), "run.ps1.untrusted");
  assert.equal(A.safeName("link.lnk"), "link.lnk.untrusted");
  const long = A.safeName("x".repeat(400) + ".pdf");
  assert.equal([...long].length, 150);
  assert.ok(long.endsWith(".pdf"));
  for (const bad of ["a/b", "a\\b", "..", "."]) assert.ok(!/[\\/]/.test(A.safeName(bad)) && !/^\.+$/.test(A.safeName(bad)));
});

test("sniffType reads the type from the first bytes, not from the name", () => {
  assert.equal(A.sniffType(PDF).type, "application/pdf");
  assert.equal(A.sniffType(Buffer.from("89504e470d0a1a0a0000", "hex")).type, "image/png");
  assert.equal(A.sniffType(Buffer.from("ffd8ffe000104a464946", "hex")).type, "image/jpeg");
  assert.equal(A.sniffType(Buffer.from("PK\x03\x04....word/document.xml....", "latin1")).exts[0], "docx");
  assert.equal(A.sniffType(Buffer.from("PK\x03\x04....xl/workbook.xml....", "latin1")).exts[0], "xlsx");
  assert.equal(A.sniffType(Buffer.from("PK\x03\x04plain zip", "latin1")).type, "application/zip");
  assert.equal(A.sniffType(EXE).runs, true);
  assert.equal(A.sniffType(Buffer.from("#!/bin/sh\nrm -rf /\n")).runs, true);
  assert.equal(A.sniffType(Buffer.from("<!DOCTYPE html><html></html>")).type, "text/html");
  assert.equal(A.sniffType(Buffer.from("name,amount\nA,1\n")).type, "text/plain");
  assert.equal(A.sniffType(Buffer.from("Received: from x\r\nSubject: hi\r\n\r\nbody")).type, "message/rfc822");
  assert.match(A.sniffType(Buffer.from([0x00, 0x01, 0x02, 0xfe, 0x00, 0x99])).type, /octet-stream/);
  assert.equal(A.sniffType(Buffer.alloc(0)).type, "empty file");
});

test("capBytes: 25 MB by default, never above 50 MB", () => {
  assert.equal(A.capBytes(), 25 * 1024 * 1024);
  assert.equal(A.capBytes(1), 1024 * 1024);
  assert.equal(A.capBytes(9999), 50 * 1024 * 1024);
  assert.equal(A.capBytes(-3), 25 * 1024 * 1024);
  assert.equal(A.capBytes("nonsense"), 25 * 1024 * 1024);
});

test("hexId refuses anything that is not a Gmail id", () => {
  assert.equal(A.hexId("19C2A4F0B7D3E615", "thread_id"), "19c2a4f0b7d3e615");
  for (const bad of ["", "xyz", "1a1e/../2", "19c2a4f0b7d3e6150", "1 OR 1"]) assert.throws(() => A.hexId(bad, "thread_id"), /hex/);
});

test("outputDir: absolute, outside the connector's folder, created", () => {
  assert.throws(() => A.outputDir("relative/folder"), /absolute/);
  assert.throws(() => A.outputDir(""), /absolute/);
  assert.throws(() => A.outputDir(ROOT), /connector's own folder/);
  assert.throws(() => A.outputDir(path.join(ROOT, "tokens")), /connector's own folder/);
  assert.throws(() => A.outputDir(path.join(ROOT, "src", "..", "tokens", "x")), /connector's own folder/);
  const d = path.join(tmp, "made", "deep");
  assert.equal(A.outputDir(d), d);
  assert.ok(fs.statSync(d).isDirectory());
});

test("saveBytes never overwrites and reports hash, size and sniffed type", () => {
  const dir = freshDir();
  const first = A.saveBytes(dir, "quote.pdf", PDF);
  assert.equal(first.path, path.join(dir, "quote.pdf"));
  assert.equal(first.bytes, PDF.length);
  assert.equal(first.sha256, sha(PDF));
  assert.equal(first.detected_type, "application/pdf");
  assert.equal(first.warning, undefined);
  assert.deepEqual(fs.readFileSync(first.path), PDF);

  // The same bytes again: no second copy.
  const again = A.saveBytes(dir, "quote.pdf", PDF);
  assert.equal(again.path, first.path);
  assert.equal(again.already_there, true);
  assert.deepEqual(fs.readdirSync(dir), ["quote.pdf"]);

  // Different bytes under the same name: a numbered file, the first one untouched.
  const other = Buffer.concat([PDF, Buffer.from("more")]);
  const second = A.saveBytes(dir, "quote.pdf", other);
  assert.equal(second.path, path.join(dir, "quote (1).pdf"));
  assert.deepEqual(fs.readFileSync(first.path), PDF);
  assert.deepEqual(fs.readFileSync(second.path), other);
});

test("saveBytes keeps every file inside the folder and warns about disguises", () => {
  const dir = freshDir();
  const escaped = A.saveBytes(dir, "..\\..\\escape.pdf", PDF);
  assert.equal(path.dirname(escaped.path), dir);

  const disguised = A.saveBytes(dir, "invoice.pdf", EXE);
  assert.match(disguised.warning, /program or script/);
  const html = A.saveBytes(dir, "statement.pdf", Buffer.from("<html>login here</html>"));
  assert.match(html.warning, /ends in \.pdf but the content is text\/html/);
  const text = A.saveBytes(dir, "scan.pdf", Buffer.from("just words"));
  assert.match(text.warning, /does not start like one/);

  const exe = A.saveBytes(dir, "setup.exe", EXE);
  assert.equal(path.basename(exe.path), "setup.exe.untrusted");
  assert.match(exe.warning, /\.untrusted/);
  const exe2 = A.saveBytes(dir, "setup.exe", Buffer.concat([EXE, Buffer.from("x")]));
  assert.equal(path.basename(exe2.path), "setup (1).exe.untrusted");

  const nameless = A.saveBytes(dir, null, PDF, "attachment-19a-2");
  assert.equal(path.basename(nameless.path), "attachment-19a-2.pdf");
  for (const f of fs.readdirSync(dir)) assert.equal(path.dirname(path.join(dir, f)), dir);
});

// multipart/mixed: [alternative: plain + (related: html + inline logo)], a PDF, a
// nameless PDF, an attached email with its own attachment inside.
const STRUCTURE = {
  type: "multipart/mixed",
  childNodes: [
    {
      part: "1",
      type: "multipart/alternative",
      childNodes: [
        { part: "1.1", type: "text/plain", encoding: "7bit", size: 20 },
        {
          part: "1.2",
          type: "multipart/related",
          childNodes: [
            { part: "1.2.1", type: "text/html", encoding: "quoted-printable", size: 300 },
            { part: "1.2.2", type: "image/png", id: "<logo@x>", disposition: "inline", dispositionParameters: { filename: "logo.png" }, encoding: "base64", size: 780 },
          ],
        },
      ],
    },
    { part: "2", type: "application/pdf", disposition: "attachment", dispositionParameters: { filename: "Service quote 2026.pdf" }, id: "<f_abc>", encoding: "base64", size: 7800 },
    { part: "3", type: "application/pdf", encoding: "base64", size: 78 },
    {
      part: "4",
      type: "message/rfc822",
      encoding: "7bit",
      size: 999,
      childNodes: [{ part: "4.1", type: "application/zip", disposition: "attachment", dispositionParameters: { filename: "inner.zip" }, size: 5 }],
    },
    { part: "5", type: "text/csv", parameters: { name: "rows.csv" }, encoding: "quoted-printable", size: 40 },
  ],
};

test("fileParts (IMAP) lists files, not message text, and does not open attached emails", () => {
  const parts = fileParts(STRUCTURE);
  assert.deepEqual(
    parts.map((p) => [p.part, p.filename, p.mime_type, p.inline]),
    [
      ["1.2.2", "logo.png", "image/png", true],
      ["2", "Service quote 2026.pdf", "application/pdf", false], // a Content-ID on a real attachment is not "inline"
      ["3", null, "application/pdf", false],
      ["4", null, "message/rfc822", false],
      ["5", "rows.csv", "text/csv", false],
    ]
  );
  const pdf = parts[1];
  assert.equal(pdf.size, 5700); // 7800 base64 bytes are about 5700 of file
  assert.equal(pdf.size_exact, false);
  assert.ok(pdf.size_floor <= pdf.size);
  assert.equal(parts[4].size_exact, true);
  // A message that is nothing but one file: the part is "1".
  assert.deepEqual(
    fileParts({ type: "application/pdf", disposition: "attachment", dispositionParameters: { filename: "only.pdf" }, encoding: "base64", size: 78 }).map((p) => p.part),
    ["1"]
  );
  assert.deepEqual(fileParts({ type: "text/plain", size: 5 }), []);
});

test("apiFileParts (Gmail API) lists the same kinds of part", () => {
  const message = {
    id: "19aa",
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "Dealer <service@example.test>" },
        { name: "Date", value: "Tue, 17 Nov 2026 09:00:00 -0700" },
      ],
      parts: [
        { partId: "0", mimeType: "text/plain", filename: "", body: { size: 5, data: "aGVsbG8" } },
        {
          partId: "1",
          mimeType: "image/png",
          filename: "logo.png",
          headers: [
            { name: "Content-Disposition", value: 'inline; filename="logo.png"' },
            { name: "Content-ID", value: "<logo@x>" },
          ],
          body: { size: 600, attachmentId: "ATT-LOGO" },
        },
        {
          partId: "2",
          mimeType: "application/pdf",
          filename: "quote.pdf",
          headers: [{ name: "Content-Disposition", value: 'attachment; filename="quote.pdf"' }],
          body: { size: 5700, attachmentId: "ATT-PDF" },
        },
        {
          partId: "3",
          mimeType: "message/rfc822",
          filename: "forwarded.eml",
          body: { size: 999, attachmentId: "ATT-EML" },
          parts: [{ partId: "3.0", mimeType: "application/zip", filename: "inner.zip", body: { size: 5, attachmentId: "ATT-ZIP" } }],
        },
        { partId: "4", mimeType: "text/plain", filename: "note.txt", body: { size: 2, data: "aGk" } },
      ],
    },
  };
  const parts = T.apiFileParts(message);
  assert.deepEqual(
    parts.map((p) => [p.id, p.filename, p.mime_type, p.inline, p.size, p.attachment_id]),
    [
      ["19aa/1", "logo.png", "image/png", true, 600, "ATT-LOGO"],
      ["19aa/2", "quote.pdf", "application/pdf", false, 5700, "ATT-PDF"],
      ["19aa/3", "forwarded.eml", "message/rfc822", false, 999, "ATT-EML"],
      ["19aa/4", "note.txt", "text/plain", false, 2, null],
    ]
  );
  assert.equal(parts[1].from, "Dealer <service@example.test>");
  assert.equal(parts[3].data, "aGk"); // a small part arrives inside the message itself
});

// A fake source: what a path (IMAP or API) hands to deliver().
function source(extra = {}) {
  const calls = [];
  const content = { "m1/2": PDF, "m1/3": EXE, "m1/9": Buffer.alloc(3000, 1) };
  const items = [
    { id: "m1/1", message_id: "m1", from: "a@x", date: "d", filename: "logo.png", mime_type: "image/png", size: 4, size_exact: true, inline: true },
    { id: "m1/2", message_id: "m1", from: "a@x", date: "d", filename: "quote.pdf", mime_type: "application/pdf", size: PDF.length, size_exact: false, inline: false },
    { id: "m1/3", message_id: "m1", from: "a@x", date: "d", filename: "tool.exe", mime_type: "application/octet-stream", size: EXE.length, size_exact: true, inline: false },
    { id: "m1/8", message_id: "m1", from: "a@x", date: "d", filename: "huge.bin", mime_type: "application/octet-stream", size: 9e9, size_floor: 8e9, size_exact: false, inline: false },
    { id: "m1/9", message_id: "m1", from: "a@x", date: "d", filename: "grows.bin", mime_type: "application/octet-stream", size: 10, size_exact: false, inline: false },
    { id: "m1/7", message_id: "m1", from: "a@x", date: "d", filename: "broken.pdf", mime_type: "application/pdf", size: 10, size_exact: true, inline: false },
    ...(extra.items || []),
  ];
  return {
    calls,
    message_count: 1,
    items,
    bytesOf: async (item, limit) => {
      calls.push([item.id, limit]);
      if (item.id === "m1/1") return Buffer.from("89504e470d0a1a0a", "hex");
      if (!content[item.id]) throw new Error("server said no");
      return content[item.id];
    },
  };
}

test("deliver without a folder only lists and fetches nothing", async () => {
  const src = source();
  const out = await A.deliver(src);
  assert.equal(out.attachment_count, 6);
  assert.equal(out.saved_count, undefined);
  assert.equal(src.calls.length, 0);
  assert.deepEqual(out.attachments[1], {
    id: "m1/2",
    message_id: "m1",
    from: "a@x",
    date: "d",
    filename: "quote.pdf",
    mime_type: "application/pdf",
    size: PDF.length,
    size_is_estimate: true,
  });
  assert.equal(out.attachments[0].inline, true);
});

test("deliver saves all but inline images, holds the size limit, and reports each outcome", async () => {
  const src = source();
  const dir = freshDir();
  const out = await A.deliver(src, { dir, maxBytes: 2000 });
  const by = Object.fromEntries(out.attachments.map((r) => [r.id, r]));
  assert.match(by["m1/1"].skipped, /Inline image/);
  assert.equal(by["m1/2"].saved.sha256, sha(PDF));
  assert.equal(by["m1/2"].saved.detected_type, "application/pdf");
  assert.equal(path.basename(by["m1/3"].saved.path), "tool.exe.untrusted");
  assert.match(by["m1/3"].saved.warning, /program or script/);
  assert.match(by["m1/8"].skipped, /over the/); // declared too large: never fetched
  assert.match(by["m1/9"].skipped, /over the/); // larger than declared: fetched, not written
  assert.equal(by["m1/7"].error, "server said no");
  assert.equal(out.saved_count, 2);
  assert.equal(out.output_dir, dir);
  assert.match(out.note, /untrusted/);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["quote.pdf", "tool.exe.untrusted"]);
  assert.deepEqual(src.calls.map((c) => c[0]), ["m1/2", "m1/3", "m1/9", "m1/7"]);
  assert.ok(src.calls.every((c) => c[1] === 2000));
});

test("deliver saves only the one asked for, by id or by exact name", async () => {
  const dir = freshDir();
  const byId = await A.deliver(source(), { dir, only: "m1/2" });
  assert.equal(byId.saved_count, 1);
  assert.deepEqual(fs.readdirSync(dir), ["quote.pdf"]);
  assert.equal(byId.attachments.filter((r) => r.saved || r.skipped || r.error).length, 1);

  const dir2 = freshDir();
  const inline = await A.deliver(source(), { dir: dir2, only: "logo.png" }); // asked for by name: saved even though inline
  assert.equal(inline.saved_count, 1);
  assert.deepEqual(fs.readdirSync(dir2), ["logo.png"]);

  await assert.rejects(A.deliver(source(), { dir, only: "nothing.pdf" }), /No attachment "nothing.pdf"/);
});

test("the tool is registered for stdio and kept out of the HTTP hub's read tools", () => {
  assert.ok(ALL_TOOLS.includes("gmail_get_attachments"));
  assert.ok(!READ_TOOLS.includes("gmail_get_attachments")); // it writes to the host's disk
  assert.equal(TOOL_DEFS.gmail_get_attachments.fn, T.gmailGetAttachments);
});

test("gmailGetAttachments checks its arguments before touching the network", async () => {
  await assert.rejects(T.gmailGetAttachments({ account: "nobody", thread_id: "1a" }), /Unknown account/);
  await assert.rejects(T.gmailGetAttachments({ account: "aroncorp" }), /thread_id or message_id/);
  await assert.rejects(T.gmailGetAttachments({ account: "aroncorp", thread_id: "1a", message_id: "1b" }), /one of them/);
  await assert.rejects(T.gmailGetAttachments({ account: "aroncorp", thread_id: "not-hex" }), /hex/);
  await assert.rejects(T.gmailGetAttachments({ account: "aroncorp", thread_id: "1a", attachment: "x.pdf" }), /output_dir/);
  await assert.rejects(T.gmailGetAttachments({ account: "aroncorp", thread_id: "1a", output_dir: "relative" }), /absolute/);
  await assert.rejects(T.gmailGetAttachments({ account: "aroncorp", thread_id: "1a", output_dir: path.join(ROOT, "tokens") }), /connector's own folder/);
});
