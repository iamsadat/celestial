"use strict";
const { contextBridge } = require("electron");

// ponytail: normalizes the highest-signal fingerprint surfaces (CPU count, RAM,
// platform, languages) and adds light canvas/WebGL noise. Deliberately does NOT
// spoof the user-agent or block APIs outright -- either breaks real sites or is
// itself trivially detectable ("this UA lies"), which is a worse tradeoff than
// blending into a common, plausible profile. Runs via contextBridge.executeInMainWorld
// so the overrides land on the same navigator/canvas objects the page's own
// scripts see (a plain preload script's isolated-world globals wouldn't).
contextBridge.executeInMainWorld({
  func: () => {
    const define = (obj, prop, value) => {
      try {
        Object.defineProperty(obj, prop, { get: () => value, configurable: true });
      } catch {}
    };

    define(navigator, "hardwareConcurrency", 4);
    define(navigator, "deviceMemory", 8);
    define(navigator, "platform", "Win32");
    define(navigator, "languages", Object.freeze(["en-US", "en"]));

    // Canvas noise: perturb a few bytes of pixel data per-session so a canvas
    // hash fingerprint isn't stable, without visibly altering rendered content.
    const seed = (Math.random() * 16) | 0;
    const perturb = (data) => {
      for (let i = 0; i < data.length; i += 97) data[i] ^= seed;
    };
    const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function (...args) {
      const result = origGetImageData.apply(this, args);
      perturb(result.data);
      return result;
    };
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      try {
        const ctx = this.getContext("2d");
        if (ctx) {
          const data = ctx.getImageData(0, 0, this.width, this.height);
          perturb(data.data);
          ctx.putImageData(data, 0, 0);
        }
      } catch {}
      return origToDataURL.apply(this, args);
    };

    // WebGL: report a generic renderer/vendor instead of the real GPU string,
    // one of the strongest device-identifying signals, without touching the
    // actual rendering path.
    const patchGL = (proto) => {
      const origGetParameter = proto.getParameter;
      proto.getParameter = function (param) {
        const dbg = this.getExtension && this.getExtension("WEBGL_debug_renderer_info");
        if (dbg && param === dbg.UNMASKED_VENDOR_WEBGL) return "Google Inc.";
        if (dbg && param === dbg.UNMASKED_RENDERER_WEBGL) return "ANGLE (Generic)";
        return origGetParameter.apply(this, arguments);
      };
    };
    if (window.WebGLRenderingContext) patchGL(WebGLRenderingContext.prototype);
    if (window.WebGL2RenderingContext) patchGL(WebGL2RenderingContext.prototype);
  },
});
