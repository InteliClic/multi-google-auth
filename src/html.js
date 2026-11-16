// HTML-escape anything printed into a page.
export function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function page(title, body) {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
    `<body style="font-family:system-ui;max-width:860px;margin:40px auto;padding:0 16px">${body}</body></html>`
  );
}
