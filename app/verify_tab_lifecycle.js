"use strict";
// ponytail: renderer.js's suspend/lazy-restore logic runs entirely in a
// webview-hosting DOM context (webview els, contextBridge globals) that
// plain node can't stand up cheaply. Like verify_killswitch.js, this locks
// the source shape instead: syntax valid, and the suspend/restore/lazy
// wiring is present. Upgrade to a real DOM/Spectron test if the logic grows
// past what a shape check can catch.
// Run: node app/verify_tab_lifecycle.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const RENDERER_JS = path.join(__dirname, "renderer", "renderer.js");

execFileSync(process.execPath, ["--check", RENDERER_JS], { stdio: "inherit" });

const src = fs.readFileSync(RENDERER_JS, "utf8");

assert.match(src, /IDLE_SUSPEND_MS\s*=\s*60_000/,
  "background tabs must be suspended after ~60s idle");
assert.match(src, /function suspendTab/, "must have a suspendTab function");
assert.match(src, /t\.webview\.src\s*=\s*"about:blank"/,
  "suspend must discard the backgrounded page by navigating its webview to about:blank");
assert.match(src, /function restoreSuspended/, "must have a restoreSuspended function");
assert.match(src, /if\s*\(t\.suspended\)\s*restoreSuspended\(id\)/,
  "activate must restore a suspended tab on refocus");
assert.match(src, /function materialize/, "must have a materialize function for lazy tabs");
assert.match(src, /if\s*\(t\.lazy\)\s*materialize\(id\)/,
  "activate must materialize a lazy (restored-but-unclicked) tab on first click");
assert.match(src, /if\s*\(!lazy\)\s*materialize\(id\)/,
  "newTab must skip webview creation for lazy (startup-restored) tabs");
assert.match(src, /id === activeId \|\| t\.lazy \|\| t\.suspended \|\| !t\.webview/,
  "checkIdleTabs must skip the active tab and tabs with no live webview");

console.log("PASS: tab suspension/lazy-restore source shape verified (syntax valid, wiring intact)");
