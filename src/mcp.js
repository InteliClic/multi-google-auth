import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as T from "./tools.js";

const accountEnum = z.enum(T.accountKeys.length ? T.accountKeys : ["default"]);

function ok(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}
function fail(e) {
  return { content: [{ type: "text", text: `ERROR: ${e?.message || e}` }], isError: true };
}
const wrap = (fn) => async (args) => {
  try {
    return ok(await fn(args));
  } catch (e) {
    return fail(e);
  }
};

export async function startMcp() {
  const server = new McpServer({ name: "multi-google-auth", version: "1.0.0" });

  server.tool(
    "list_accounts",
    "List configured Google accounts and whether each is LIVE. Actively probes each refresh token, so it reports 'live' vs 'broken' instead of just whether a token file exists.",
    { probe: z.boolean().optional().describe("Actively test each token (default true).") },
    wrap(T.listAccounts)
  );

  server.tool(
    "gmail_search",
    "Search Gmail threads with Gmail query syntax (from:, subject:, after:YYYY/MM/DD, has:attachment, newer_than:7d, in:sent).",
    { account: accountEnum, query: z.string(), max_results: z.number().optional() },
    wrap(T.gmailSearch)
  );

  server.tool(
    "gmail_get_thread",
    "Get every message in a Gmail thread with decoded plain-text bodies.",
    { account: accountEnum, thread_id: z.string() },
    wrap(T.gmailGetThread)
  );

  server.tool(
    "gmail_create_draft",
    "Create a Gmail DRAFT (never sends). Returns the draft id to review and send from Gmail.",
    {
      account: accountEnum,
      to: z.string(),
      subject: z.string(),
      body: z.string(),
      cc: z.string().optional(),
      bcc: z.string().optional(),
      thread_id: z.string().optional(),
    },
    wrap(T.gmailCreateDraft)
  );

  server.tool(
    "calendar_list_events",
    "List upcoming Google Calendar events for an account.",
    {
      account: accountEnum,
      calendar_id: z.string().optional(),
      time_min: z.string().optional(),
      time_max: z.string().optional(),
      max_results: z.number().optional(),
      query: z.string().optional(),
    },
    wrap(T.calendarListEvents)
  );

  server.tool(
    "calendar_create_event",
    "Create a Google Calendar event. start/end are ISO datetimes, or YYYY-MM-DD for all-day.",
    {
      account: accountEnum,
      summary: z.string(),
      start: z.string(),
      end: z.string(),
      description: z.string().optional(),
      location: z.string().optional(),
      attendees: z.array(z.string()).optional(),
      calendar_id: z.string().optional(),
      time_zone: z.string().optional(),
    },
    wrap(T.calendarCreateEvent)
  );

  server.tool(
    "drive_search",
    "Search Google Drive. Pass plain text for a full-text search, or a raw Drive query (e.g. \"mimeType='application/pdf'\", \"name contains 'invoice'\").",
    { account: accountEnum, query: z.string(), max_results: z.number().optional() },
    wrap(T.driveSearch)
  );

  server.tool(
    "drive_read_file",
    "Read a Drive file's text content (Google Docs/Sheets/Slides are exported to text/CSV).",
    { account: accountEnum, file_id: z.string() },
    wrap(T.driveReadFile)
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp] multi-google-auth ready on stdio");
}
