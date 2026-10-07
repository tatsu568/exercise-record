"use strict";

// Dependency-free static server for Windows and local Wi-Fi checks.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const port = Number(process.env.PORT || 8080);
const mime = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json; charset=utf-8"
};

http.createServer((request, response) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname); }
  catch { response.writeHead(400).end("Bad request"); return; }
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = path.resolve(root, relative);
  if (file !== root && !file.startsWith(root + path.sep)) { response.writeHead(403).end("Forbidden"); return; }
  fs.stat(file, (statError, stat) => {
    const target = !statError && stat.isDirectory() ? path.join(file, "index.html") : file;
    fs.readFile(target, (error, content) => {
      if (error) { response.writeHead(404).end("Not found"); return; }
      response.writeHead(200, { "Content-Type": mime[path.extname(target).toLowerCase()] || "application/octet-stream", "X-Content-Type-Options": "nosniff" });
      response.end(content);
    });
  });
}).listen(port, "0.0.0.0", () => {
  console.log(`運動記録Webアプリを起動しました: http://localhost:${port}`);
  console.log("同じWi-FiのiPhoneでは、PCのIPv4アドレスを使ってアクセスしてください。");
});
