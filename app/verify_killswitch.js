"use strict";
// ponytail: main.js's kill-switch logic is entangled with electron's `session`
// API (setProxy, webRequest.onBeforeRequest), so it can't run under plain node
// without stubbing out all of electron -- too heavy for what this needs to
// prove. Instead this locks the source shape: syntax valid, and the
// fail-closed/fail-open wiring (blackhole port, health poll endpoint,
// onBeforeRequest cancel-on-active) is present. Upgrade to a real
// electron-mocha/spectron run if the logic grows past what a shape check can
// catch. Run: node app/verify_killswitch.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const MAIN_JS = path.join(__dirname, "main.js");

execFileSync(process.execPath, ["--check", MAIN_JS], { stdio: "inherit" });

const src = fs.readFileSync(MAIN_JS, "utf8");

assert.match(src, /BLACKHOLE_PROXY_RULES\s*=\s*"http=127\.0\.0\.1:1;https=127\.0\.0\.1:1"/,
  "blackhole proxy rules must point at an unbound port for instant fail-closed");
assert.match(src, /REAL_PROXY_RULES\s*=\s*"http=127\.0\.0\.1:8080;https=127\.0\.0\.1:8080"/,
  "real proxy rules must point at the actual sidecar proxy port");
assert.match(src, /127\.0\.0\.1:8765\/status/,
  "kill-switch must poll the sidecar's health endpoint");
assert.match(src, /killSwitchActive\s*\?\s*BLACKHOLE_PROXY_RULES\s*:\s*REAL_PROXY_RULES/,
  "setProxy must flip between real/blackhole rules based on killSwitchActive");
assert.match(src, /onBeforeRequest/, "must register a webRequest.onBeforeRequest gate");
assert.match(src, /if\s*\(!killSwitchActive\)\s*return callback\(\{\s*cancel:\s*false\s*\}\)/,
  "onBeforeRequest must pass everything through when kill-switch is not active");
assert.match(src, /hostname !== "127\.0\.0\.1" && hostname !== "localhost"/,
  "onBeforeRequest must cancel non-loopback requests while kill-switch is active");

console.log("PASS: kill-switch source shape verified (syntax valid, fail-closed wiring intact)");
