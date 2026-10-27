#!/usr/bin/env node
/*
 * Tiny static file server for local / LAN play.
 * This is NOT a game server: rooms and moves travel browser-to-browser
 * over WebRTC. This process only hands out HTML/CSS/JS files.
 *
 * Usage:
 *   node tools/serve.js
 *   PORT=8080 node tools/serve.js
 */
"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};

function send(res, status, body, type) {
  res.writeHead(status, {
    "Content-Type": type || "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(body);
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      send(res, 404, "Not found");
      return;
    }
    send(res, 200, data, types[path.extname(filePath).toLowerCase()] || "application/octet-stream");
  });
}

function handle(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  } catch (err) {
    send(res, 400, "Bad request");
    return;
  }
  const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(root + path.sep)) {
    send(res, 403, "Forbidden");
    return;
  }
  fs.stat(target, (err, stat) => {
    if (!err && stat.isDirectory()) {
      const index = path.join(target, "index.html");
      if (fs.existsSync(index)) serveFile(res, index);
      else send(res, 404, "Not found");
      return;
    }
    if (err) {
      send(res, 404, "Not found");
      return;
    }
    serveFile(res, target);
  });
}

function lanAddresses() {
  const addresses = [];
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach((name) => {
    (nets[name] || []).forEach((info) => {
      if (info.family === "IPv4" && !info.internal) {
        addresses.push(info.address);
      }
    });
  });
  return addresses;
}

const server = http.createServer(handle);
server.listen(port, host, () => {
  console.log("");
  console.log("  游戏集 / ARCADE · static preview");
  console.log("  " + "─".repeat(42));
  console.log("  This machine : http://127.0.0.1:" + port + "/");
  lanAddresses().forEach((ip) => {
    console.log("  LAN           : http://" + ip + ":" + port + "/");
  });
  console.log("");
  console.log("  Open the SAME URL on both devices for P2P play.");
  console.log("  Press Ctrl+C to stop. No game data is served.");
  console.log("");
});
