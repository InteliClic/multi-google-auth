import fs from "node:fs";
import http2 from "node:http2";
import { authorizedClient } from "./auth.js";
import { loadToken } from "./tokenStore.js";

// Google Assistant API (embeddedassistant.googleapis.com, v1alpha2): one text query, as if
// it were said to a Google speaker signed in as the account ("3D Printer off"). It is gRPC
// only; this speaks it over node:http2 with a small hand-rolled protobuf codec, so the hub
// needs no gRPC packages. Field numbers come from googleapis'
// google/assistant/embedded/v1alpha2/embedded_assistant.proto. The request matches
// gassist-text, the library behind Home Assistant's Google Assistant SDK integration:
// device ids "default", MP3 audio out, screen mode PLAYING so a reply can come back as HTML.
export const ASSISTANT_SCOPE = "https://www.googleapis.com/auth/assistant-sdk-prototype";
const HOST = "embeddedassistant.googleapis.com";
const PATH = "/google.assistant.embedded.v1alpha2.EmbeddedAssistant/Assist";
const DEADLINE_MS = 60_000;

// --- protobuf, just enough for AssistRequest / AssistResponse ---
function varint(n) {
  const out = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}
const tag = (field, wire) => varint((field << 3) | wire);
const pbInt = (field, n) => Buffer.concat([tag(field, 0), varint(n)]);
const pbBytes = (field, buf) => Buffer.concat([tag(field, 2), varint(buf.length), buf]);
const pbStr = (field, s) => pbBytes(field, Buffer.from(s, "utf8"));

// Decode one message into { fieldNumber: [values] }: varints as numbers, length-delimited
// fields as Buffers (sub-messages are decoded again by the caller).
export function decode(buf) {
  const out = {};
  let i = 0;
  const readVarint = () => {
    let r = 0n;
    let s = 0n;
    for (;;) {
      if (i >= buf.length) throw new Error("truncated protobuf varint");
      const b = buf[i++];
      r |= BigInt(b & 0x7f) << s;
      if (!(b & 0x80)) return r;
      s += 7n;
    }
  };
  while (i < buf.length) {
    const key = Number(readVarint());
    const field = key >> 3;
    const wire = key & 7;
    let v;
    if (wire === 0) v = Number(readVarint());
    else if (wire === 2) {
      const n = Number(readVarint());
      v = buf.subarray(i, i + n);
      i += n;
    } else if (wire === 5) {
      v = buf.subarray(i, i + 4);
      i += 4;
    } else if (wire === 1) {
      v = buf.subarray(i, i + 8);
      i += 8;
    } else throw new Error(`protobuf wire type ${wire} not handled`);
    (out[field] ||= []).push(v);
  }
  return out;
}

export function assistRequest(text, language) {
  const audioOut = Buffer.concat([pbInt(1, 2 /* MP3 */), pbInt(2, 24000), pbInt(3, 100)]);
  const dialogIn = Buffer.concat([pbStr(2, language), pbInt(7, 1 /* is_new_conversation */)]);
  const device = Buffer.concat([pbStr(1, "default"), pbStr(3, "default")]);
  const screenOut = pbInt(1, 3 /* PLAYING */);
  const config = Buffer.concat([
    pbStr(6, text), // text_query
    pbBytes(2, audioOut),
    pbBytes(3, dialogIn),
    pbBytes(4, device),
    pbBytes(8, screenOut),
  ]);
  return pbBytes(1, config); // AssistRequest.config
}

function grpcFrame(msg) {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(msg.length, 1);
  return Buffer.concat([head, msg]);
}

function htmlToText(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// The token must carry the Assistant scope; without it Google answers 403 with no hint why.
export function assistantScopeGranted(key) {
  const scope = loadToken(key)?.tokens?.scope || "";
  return scope.split(/\s+/).includes(ASSISTANT_SCOPE);
}

export async function assistantText(key, text, { language = "en-US", audioPath } = {}) {
  if (!assistantScopeGranted(key)) {
    throw new Error(
      `Account "${key}" has not granted the Google Assistant scope. Give it extra_scopes in accounts.json and re-run /auth/${key}`
    );
  }
  const { token } = await authorizedClient(key).getAccessToken();
  const t0 = Date.now();

  return new Promise((resolve, reject) => {
    const session = http2.connect(`https://${HOST}`);
    session.on("error", reject);
    const req = session.request({
      ":method": "POST",
      ":path": PATH,
      "content-type": "application/grpc",
      te: "trailers",
      authorization: `Bearer ${token}`,
      "grpc-timeout": `${DEADLINE_MS}m`,
    });
    req.setTimeout(DEADLINE_MS + 5000, () => req.close(http2.constants.NGHTTP2_CANCEL));

    let httpStatus = null;
    let trailers = {};
    let pending = Buffer.alloc(0);
    const audio = [];
    const display = [];
    const html = [];
    const transcripts = [];
    let deviceActions = 0;

    req.on("response", (h) => {
      httpStatus = h[":status"];
      // A trailers-only reply puts grpc-status in the response headers.
      if (h["grpc-status"] !== undefined) trailers = h;
    });
    req.on("trailers", (h) => {
      trailers = h;
    });
    req.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 5) {
        const n = pending.readUInt32BE(1);
        if (pending.length < 5 + n) break;
        const r = decode(pending.subarray(5, 5 + n));
        pending = pending.subarray(5 + n);
        for (const a of r[3] || []) audio.push(...(decode(a)[1] || []));
        for (const s of r[4] || []) html.push(...(decode(s)[2] || []).map((b) => b.toString("utf8")));
        for (const d of r[5] || []) display.push(...(decode(d)[1] || []).map((b) => b.toString("utf8")));
        for (const s of r[2] || []) transcripts.push(...(decode(s)[1] || []).map((b) => b.toString("utf8")));
        deviceActions += (r[6] || []).length;
      }
    });
    req.on("error", (e) => {
      session.close();
      reject(e);
    });
    req.on("close", () => {
      session.close();
      const grpcStatus = trailers["grpc-status"] === undefined ? null : Number(trailers["grpc-status"]);
      if (grpcStatus !== 0) {
        const msg = trailers["grpc-message"] ? decodeURIComponent(trailers["grpc-message"]) : "no grpc-status";
        reject(new Error(`Assistant call failed: http ${httpStatus}, grpc-status ${grpcStatus}: ${msg}`));
        return;
      }
      const mp3 = Buffer.concat(audio);
      if (audioPath && mp3.length) fs.writeFileSync(audioPath, mp3);
      resolve({
        account: key,
        query: text,
        reply_text: display.join(" ").trim() || null,
        screen_text: html.length ? htmlToText(html.join("")).slice(0, 2000) : null,
        audio_bytes: mp3.length,
        audio_path: audioPath && mp3.length ? audioPath : null,
        device_actions: deviceActions,
        grpc_status: grpcStatus,
        ms: Date.now() - t0,
      });
    });

    req.end(grpcFrame(assistRequest(text, language)));
  });
}
