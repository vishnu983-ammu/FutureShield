"use strict";

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const mobileDir = path.join(__dirname, "..", "mobile");
const androidDir = path.join(mobileDir, "android");
const { ensureAndroidSdk } = require("./ensure-android-sdk");

execSync("npm install", { cwd: mobileDir, stdio: "inherit" });

if (fs.existsSync(androidDir)) {
  console.log("Android platform already exists — running cap sync…");
  execSync("npx cap sync", { cwd: mobileDir, stdio: "inherit" });
  ensureAndroidSdk(androidDir);
} else {
  console.log("Adding Android platform…");
  execSync("npx cap add android", { cwd: mobileDir, stdio: "inherit" });
  if (fs.existsSync(androidDir)) ensureAndroidSdk(androidDir);
}
