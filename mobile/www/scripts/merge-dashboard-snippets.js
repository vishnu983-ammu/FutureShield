#!/usr/bin/env node
/**
 * One-time (idempotent) merge of snippets/*.html into index.html.
 * Run: node scripts/merge-dashboard-snippets.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const INDEX = path.join(ROOT, "index.html");
const SNIP = path.join(ROOT, "snippets");

function read(name) {
  return fs.readFileSync(path.join(SNIP, name), "utf8").trim();
}

function insertAfter(html, marker, chunk, guard) {
  if (guard && html.includes(guard)) {
    console.log(`  skip ${guard} (already merged)`);
    return html;
  }
  if (!html.includes(marker)) {
    throw new Error(`Marker not found: ${marker}`);
  }
  return html.replace(marker, `${marker}\n${chunk}\n`);
}

function splitModalsFile(raw) {
  const needle = "PAYMENT APPROVE MODAL";
  const idx = raw.indexOf(needle);
  if (idx < 0) {
    return { tiles: raw.trim(), modals: "" };
  }
  // Walk back to the opening <!-- so the merged modals block is a valid comment + markup
  const commentStart = raw.lastIndexOf("<!--", idx);
  const splitAt = commentStart >= 0 ? commentStart : idx;
  return {
    tiles: raw.slice(0, splitAt).trim(),
    modals: raw.slice(splitAt).trim(),
  };
}

let html = fs.readFileSync(INDEX, "utf8");
const nav = read("nav-features.html");
const sections = read("sections-features.html");
const modalsRaw = read("modals-features.html");
const { tiles, modals } = splitModalsFile(modalsRaw);

html = insertAfter(html, "<!-- FS_INSERT_NAV -->", nav, "id=\"nav-paymentstatus\"");
html = insertAfter(html, "<!-- FS_INSERT_SECTIONS -->", sections, "id=\"section-paymentstatus\"");
html = insertAfter(html, "<!-- FS_INSERT_DASH_TILES -->", tiles, "id=\"dash-card-contest-progress\"");
html = insertAfter(html, "<!-- FS_INSERT_MODALS -->", modals, "id=\"modal-payment-approve\"");

fs.writeFileSync(INDEX, html, "utf8");
console.log("Merged dashboard snippets into index.html");
