import { google } from "googleapis";
import { authorizedClient } from "./auth.js";

export function gmailFor(key) {
  return google.gmail({ version: "v1", auth: authorizedClient(key) });
}
export function calendarFor(key) {
  return google.calendar({ version: "v3", auth: authorizedClient(key) });
}
export function driveFor(key) {
  return google.drive({ version: "v3", auth: authorizedClient(key) });
}
