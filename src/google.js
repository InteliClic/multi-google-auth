import { google } from "googleapis";
import { authorizedClient } from "./auth.js";
import { loadAccounts, scopesFor } from "./config.js";

// An account with its own scope list may not carry this API at all (personal has no
// Drive; personal-drive has only Drive). Say which key does, instead of Google's 403.
function needScope(key, scope, what) {
  if (scopesFor(key).includes(scope)) return;
  const all = loadAccounts();
  const me = all.find((a) => a.key === key);
  const alt = all.filter((a) => a.email === me?.email && scopesFor(a.key).includes(scope)).map((a) => a.key);
  throw new Error(`Account "${key}" has no ${what} access${alt.length ? `; use ${alt.join(" or ")}` : ""}`);
}

export function gmailFor(key) {
  needScope(key, "https://www.googleapis.com/auth/gmail.modify", "Gmail");
  return google.gmail({ version: "v1", auth: authorizedClient(key) });
}
export function calendarFor(key) {
  needScope(key, "https://www.googleapis.com/auth/calendar", "Calendar");
  return google.calendar({ version: "v3", auth: authorizedClient(key) });
}
export function driveFor(key) {
  needScope(key, "https://www.googleapis.com/auth/drive.readonly", "Drive");
  return google.drive({ version: "v3", auth: authorizedClient(key) });
}
