/* ===========================================================================
 * GridScan — raymarched perspective grid with a sweeping scan pulse.
 *
 * This is a port of the React Bits <GridScan /> component. The fragment shader
 * below is the component's GLSL, essentially verbatim: the four-plane raymarch,
 * the dual grid masks with dash/dot styles, the Gaussian scan band with phase
 * taper, the 8-slot multi-scan queue, and the mouse-driven skew/tilt/yaw.
 *
 * WHAT WAS DROPPED, AND WHY
 *   The original pulls in three.js (1.2MB), `postprocessing`, and face-api.js
 *   (which needs @tensorflow/tfjs-core on top). This app has no build step, so
 *   those would have to come from a CDN via an import map — 2.9MB on the page
 *   whose only job is to paint instantly. So:
 *     · three.js          -> ~150 lines of raw WebGL1 below. Same shader.
 *     · postprocessing    -> the bloom + chromatic-aberration passes below.
 *     · face-api.js       -> dropped. It only drives `enableWebcam`, which is
 *                            off in the usage example; pointer input is kept.
 *   Everything else — the visuals and the prop names — carries over.
 *
 * ARCHITECTURE NOTE
 *   The landing page's background is two vault-door panels that split apart on
 *   login, so the scene has to span both without a visible seam. Rather than
 *   run two WebGL contexts (which would desync, having independent time
 *   origins), one context renders into the left canvas and the right canvas
 *   blits from it. One scene, one clock, no seam.
 *
 * Standalone usage:
 *   GridScan.mount(canvas, { scanColor: '#ff9a4d' });
 *   GridScan.mount([leftCanvas, rightCanvas], { ... });   // one shared scene
 * =========================================================================== */
(function (global) {
  "use strict";

  // ── shaders ──────────────────────────────────────────────────────
  var VERT = [
    "attribute vec2 aPos;",
    "varying vec2 vUv;",
    "void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }"
  ].join("\n");

  // GridScan's fragment shader. Unchanged apart from the derivatives pragma
  // (three.js injects that for you; raw WebGL1 has to ask).
  var FRAG_GRID = [
    "#extension GL_OES_standard_derivatives : enable",
    "precision highp float;",
    "uniform vec3 iResolution;",
    "uniform float iTime;",
    "uniform vec2 uSkew;",
    "uniform float uTilt;",
    "uniform float uYaw;",
    "uniform float uLineThickness;",
    "uniform vec3 uLinesColor;",
    "uniform vec3 uScanColor;",
    "uniform float uGridScale;",
    "uniform float uLineStyle;",
    "uniform float uLineJitter;",
    "uniform float uScanOpacity;",
    "uniform float uScanDirection;",
    "uniform float uNoise;",
    "uniform float uBloomOpacity;",
    "uniform float uScanGlow;",
    "uniform float uScanSoftness;",
    "uniform float uPhaseTaper;",
    "uniform float uScanDuration;",
    "uniform float uScanDelay;",
    "varying vec2 vUv;",
    "uniform float uScanStarts[8];",
    "uniform float uScanCount;",
    "const int MAX_SCANS = 8;",

    "float smoother01(float a, float b, float x){",
    "  float t = clamp((x - a) / max(1e-5, (b - a)), 0.0, 1.0);",
    "  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);",
    "}",

    "void mainImage(out vec4 fragColor, in vec2 fragCoord){",
    "  vec2 p = (2.0 * fragCoord - iResolution.xy) / iResolution.y;",
    "  vec3 ro = vec3(0.0);",
    "  vec3 rd = normalize(vec3(p, 2.0));",
    "  float cR = cos(uTilt), sR = sin(uTilt);",
    "  rd.xy = mat2(cR, -sR, sR, cR) * rd.xy;",
    "  float cY = cos(uYaw), sY = sin(uYaw);",
    "  rd.xz = mat2(cY, -sY, sY, cY) * rd.xz;",
    "  vec2 skew = clamp(uSkew, vec2(-0.7), vec2(0.7));",
    "  rd.xy += skew * rd.z;",

    "  vec3 color = vec3(0.0);",
    "  float minT = 1e20;",
    "  float gridScale = max(1e-5, uGridScale);",
    "  float fadeStrength = 2.0;",
    "  vec2 gridUV = vec2(0.0);",
    "  float hitIsY = 1.0;",
    "  for (int i = 0; i < 4; i++){",
    "    float isY = float(i < 2);",
    "    float pos = mix(-0.2, 0.2, float(i)) * isY + mix(-0.5, 0.5, float(i - 2)) * (1.0 - isY);",
    "    float num = pos - (isY * ro.y + (1.0 - isY) * ro.x);",
    "    float den = isY * rd.y + (1.0 - isY) * rd.x;",
    "    float t = num / den;",
    "    vec3 h = ro + rd * t;",
    "    float depthBoost = smoothstep(0.0, 3.0, h.z);",
    "    h.xy += skew * 0.15 * depthBoost;",
    "    bool use = t > 0.0 && t < minT;",
    "    gridUV = use ? mix(h.zy, h.xz, isY) / gridScale : gridUV;",
    "    minT = use ? t : minT;",
    "    hitIsY = use ? isY : hitIsY;",
    "  }",

    "  vec3 hit = ro + rd * minT;",
    "  float dist = length(hit - ro);",
    "  float jitterAmt = clamp(uLineJitter, 0.0, 1.0);",
    "  if (jitterAmt > 0.0) {",
    "    vec2 j = vec2(sin(gridUV.y * 2.7 + iTime * 1.8), cos(gridUV.x * 2.3 - iTime * 1.6)) * (0.15 * jitterAmt);",
    "    gridUV += j;",
    "  }",
    "  float fx = fract(gridUV.x); float fy = fract(gridUV.y);",
    "  float ax = min(fx, 1.0 - fx); float ay = min(fy, 1.0 - fy);",
    "  float wx = fwidth(gridUV.x); float wy = fwidth(gridUV.y);",
    "  float halfPx = max(0.0, uLineThickness) * 0.5;",
    "  float tx = halfPx * wx; float ty = halfPx * wy;",
    "  float aax = wx; float aay = wy;",
    "  float lineX = 1.0 - smoothstep(tx, tx + aax, ax);",
    "  float lineY = 1.0 - smoothstep(ty, ty + aay, ay);",
    "  if (uLineStyle > 0.5) {",
    "    float dashRepeat = 4.0; float dashDuty = 0.5;",
    "    float vy = fract(gridUV.y * dashRepeat); float vx = fract(gridUV.x * dashRepeat);",
    "    float dashMaskY = step(vy, dashDuty); float dashMaskX = step(vx, dashDuty);",
    "    if (uLineStyle < 1.5) { lineX *= dashMaskY; lineY *= dashMaskX; }",
    "    else {",
    "      float dotRepeat = 6.0; float dotWidth = 0.18;",
    "      float cy = abs(fract(gridUV.y * dotRepeat) - 0.5);",
    "      float cx = abs(fract(gridUV.x * dotRepeat) - 0.5);",
    "      float dotMaskY = 1.0 - smoothstep(dotWidth, dotWidth + fwidth(gridUV.y * dotRepeat), cy);",
    "      float dotMaskX = 1.0 - smoothstep(dotWidth, dotWidth + fwidth(gridUV.x * dotRepeat), cx);",
    "      lineX *= dotMaskY; lineY *= dotMaskX;",
    "    }",
    "  }",
    "  float primaryMask = max(lineX, lineY);",

    "  vec2 gridUV2 = (hitIsY > 0.5 ? hit.xz : hit.zy) / gridScale;",
    "  if (jitterAmt > 0.0) {",
    "    vec2 j2 = vec2(cos(gridUV2.y * 2.1 - iTime * 1.4), sin(gridUV2.x * 2.5 + iTime * 1.7)) * (0.15 * jitterAmt);",
    "    gridUV2 += j2;",
    "  }",
    "  float fx2 = fract(gridUV2.x); float fy2 = fract(gridUV2.y);",
    "  float ax2 = min(fx2, 1.0 - fx2); float ay2 = min(fy2, 1.0 - fy2);",
    "  float wx2 = fwidth(gridUV2.x); float wy2 = fwidth(gridUV2.y);",
    "  float tx2 = halfPx * wx2; float ty2 = halfPx * wy2;",
    "  float lineX2 = 1.0 - smoothstep(tx2, tx2 + wx2, ax2);",
    "  float lineY2 = 1.0 - smoothstep(ty2, ty2 + wy2, ay2);",
    "  if (uLineStyle > 0.5) {",
    "    float dashRepeat2 = 4.0; float dashDuty2 = 0.5;",
    "    float vy2m = fract(gridUV2.y * dashRepeat2); float vx2m = fract(gridUV2.x * dashRepeat2);",
    "    float dashMaskY2 = step(vy2m, dashDuty2); float dashMaskX2 = step(vx2m, dashDuty2);",
    "    if (uLineStyle < 1.5) { lineX2 *= dashMaskY2; lineY2 *= dashMaskX2; }",
    "    else {",
    "      float dotRepeat2 = 6.0; float dotWidth2 = 0.18;",
    "      float cy2 = abs(fract(gridUV2.y * dotRepeat2) - 0.5);",
    "      float cx2 = abs(fract(gridUV2.x * dotRepeat2) - 0.5);",
    "      float dotMaskY2 = 1.0 - smoothstep(dotWidth2, dotWidth2 + fwidth(gridUV2.y * dotRepeat2), cy2);",
    "      float dotMaskX2 = 1.0 - smoothstep(dotWidth2, dotWidth2 + fwidth(gridUV2.x * dotRepeat2), cx2);",
    "      lineX2 *= dotMaskY2; lineY2 *= dotMaskX2;",
    "    }",
    "  }",
    "  float altMask = max(lineX2, lineY2);",

    "  float edgeDistX = min(abs(hit.x - (-0.5)), abs(hit.x - 0.5));",
    "  float edgeDistY = min(abs(hit.y - (-0.2)), abs(hit.y - 0.2));",
    "  float edgeDist = mix(edgeDistY, edgeDistX, hitIsY);",
    "  float edgeGate = 1.0 - smoothstep(gridScale * 0.5, gridScale * 2.0, edgeDist);",
    "  altMask *= edgeGate;",
    "  float lineMask = max(primaryMask, altMask);",
    "  float fade = exp(-dist * fadeStrength);",

    "  float dur = max(0.05, uScanDuration);",
    "  float del = max(0.0, uScanDelay);",
    "  float scanZMax = 2.0;",
    "  float widthScale = max(0.1, uScanGlow);",
    "  float sigma = max(0.001, 0.18 * widthScale * uScanSoftness);",
    "  float sigmaA = sigma * 2.0;",
    "  float combinedPulse = 0.0;",
    "  float combinedAura = 0.0;",

    "  float cycle = dur + del;",
    "  float tCycle = mod(iTime, cycle);",
    "  float scanPhase = clamp((tCycle - del) / dur, 0.0, 1.0);",
    "  float phase = scanPhase;",
    "  if (uScanDirection > 0.5 && uScanDirection < 1.5) { phase = 1.0 - phase; }",
    "  else if (uScanDirection > 1.5) {",
    "    float t2 = mod(max(0.0, iTime - del), 2.0 * dur);",
    "    phase = (t2 < dur) ? (t2 / dur) : (1.0 - (t2 - dur) / dur);",
    "  }",
    "  float scanZ = phase * scanZMax;",
    "  float dz = abs(hit.z - scanZ);",
    "  float lineBand = exp(-0.5 * (dz * dz) / (sigma * sigma));",
    "  float taper = clamp(uPhaseTaper, 0.0, 0.49);",
    "  float headFade = smoother01(0.0, taper, phase);",
    "  float tailFade = 1.0 - smoother01(1.0 - taper, 1.0, phase);",
    "  float phaseWindow = headFade * tailFade;",
    "  combinedPulse += lineBand * phaseWindow * clamp(uScanOpacity, 0.0, 1.0);",
    "  float auraBand = exp(-0.5 * (dz * dz) / (sigmaA * sigmaA));",
    "  combinedAura += (auraBand * 0.25) * phaseWindow * clamp(uScanOpacity, 0.0, 1.0);",

    "  for (int i = 0; i < MAX_SCANS; i++) {",
    "    if (float(i) >= uScanCount) break;",
    "    float tActiveI = iTime - uScanStarts[i];",
    "    float phaseI = clamp(tActiveI / dur, 0.0, 1.0);",
    "    if (uScanDirection > 0.5 && uScanDirection < 1.5) { phaseI = 1.0 - phaseI; }",
    "    else if (uScanDirection > 1.5) { phaseI = (phaseI < 0.5) ? (phaseI * 2.0) : (1.0 - (phaseI - 0.5) * 2.0); }",
    "    float scanZI = phaseI * scanZMax;",
    "    float dzI = abs(hit.z - scanZI);",
    "    float lineBandI = exp(-0.5 * (dzI * dzI) / (sigma * sigma));",
    "    float headFadeI = smoother01(0.0, taper, phaseI);",
    "    float tailFadeI = 1.0 - smoother01(1.0 - taper, 1.0, phaseI);",
    "    float phaseWindowI = headFadeI * tailFadeI;",
    "    combinedPulse += lineBandI * phaseWindowI * clamp(uScanOpacity, 0.0, 1.0);",
    "    float auraBandI = exp(-0.5 * (dzI * dzI) / (sigmaA * sigmaA));",
    "    combinedAura += (auraBandI * 0.25) * phaseWindowI * clamp(uScanOpacity, 0.0, 1.0);",
    "  }",

    "  float lineVis = lineMask;",
    "  vec3 gridCol = uLinesColor * lineVis * fade;",
    "  vec3 scanCol = uScanColor * combinedPulse;",
    "  vec3 scanAura = uScanColor * combinedAura;",
    "  color = gridCol + scanCol + scanAura;",
    "  float n = fract(sin(dot(gl_FragCoord.xy + vec2(iTime * 123.4), vec2(12.9898,78.233))) * 43758.5453123);",
    "  color += (n - 0.5) * uNoise;",
    "  color = clamp(color, 0.0, 1.0);",
    "  float alpha = clamp(max(lineVis, combinedPulse), 0.0, 1.0);",
    "  float gx = 1.0 - smoothstep(tx * 2.0, tx * 2.0 + aax * 2.0, ax);",
    "  float gy = 1.0 - smoothstep(ty * 2.0, ty * 2.0 + aay * 2.0, ay);",
    "  float halo = max(gx, gy) * fade;",
    "  alpha = max(alpha, halo * clamp(uBloomOpacity, 0.0, 1.0));",
    "  fragColor = vec4(color, alpha);",
    "}",
    "void main(){ vec4 c; mainImage(c, vUv * iResolution.xy); gl_FragColor = c; }"
  ].join("\n");

  // bright-pass + downsample (replaces postprocessing's BloomEffect luminance stage)
  var FRAG_BRIGHT = [
    "precision mediump float;",
    "varying vec2 vUv;",
    "uniform sampler2D uTex;",
    "uniform float uThreshold;",
    "uniform float uSmoothing;",
    "void main(){",
    "  vec3 c = texture2D(uTex, vUv).rgb;",
    "  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));",
    "  float k = smoothstep(uThreshold, uThreshold + max(1e-4, uSmoothing), l);",
    "  gl_FragColor = vec4(c * k, 1.0);",
    "}"
  ].join("\n");

  // separable 9-tap gaussian
  var FRAG_BLUR = [
    "precision mediump float;",
    "varying vec2 vUv;",
    "uniform sampler2D uTex;",
    "uniform vec2 uDir;",
    "void main(){",
    "  vec4 s = texture2D(uTex, vUv) * 0.2270270;",
    "  s += (texture2D(uTex, vUv + uDir * 1.3846154) + texture2D(uTex, vUv - uDir * 1.3846154)) * 0.3162162;",
    "  s += (texture2D(uTex, vUv + uDir * 3.2307692) + texture2D(uTex, vUv - uDir * 3.2307692)) * 0.0702702;",
    "  gl_FragColor = s;",
    "}"
  ].join("\n");

  // composite: bloom + radial chromatic aberration, then the scrim/vignette that
  // keeps the login card legible over the grid
  var FRAG_POST = [
    "precision mediump float;",
    "varying vec2 vUv;",
    "uniform sampler2D uScene;",
    "uniform sampler2D uBloom;",
    "uniform float uBloomIntensity;",
    "uniform float uCA;",
    "uniform float uScrim;",
    "uniform float uScrimR0;",
    "uniform float uScrimR1;",
    "uniform float uVignette;",
    "uniform vec2 uAspect;",
    "void main(){",
    "  vec2 d = vUv - 0.5;",
    "  vec2 off = d * uCA;",
    "  float r = texture2D(uScene, vUv + off).r;",
    "  float g = texture2D(uScene, vUv).g;",
    "  float b = texture2D(uScene, vUv - off).b;",
    "  vec3 col = vec3(r, g, b);",
    "  col += texture2D(uBloom, vUv).rgb * uBloomIntensity;",
    "  float rad = length(d * uAspect) * 2.0;",
    "  float scrim = 1.0 - smoothstep(uScrimR0, uScrimR1, rad);",
    "  col *= (1.0 - uScrim * scrim);",
    "  col *= (1.0 - uVignette * smoothstep(0.55, 1.35, rad));",
    "  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);",
    "}"
  ].join("\n");

  // ── props (names match the React component) ──────────────────────
  var DEFAULTS = {
    sensitivity: 0.55,
    lineThickness: 1,
    linesColor: "#ff4500",
    scanColor: "#ff9a4d",
    scanOpacity: 0.55,
    gridScale: 0.1,
    lineStyle: "solid",          // solid | dashed | dotted
    lineJitter: 0.06,
    scanDirection: "forward",    // forward | backward | pingpong
    enablePost: true,
    bloomIntensity: 0.85,
    bloomThreshold: 0.08,
    bloomSmoothing: 0.35,
    chromaticAberration: 0.0022,
    noiseIntensity: 0.012,
    scanGlow: 0.5,
    scanSoftness: 2,
    scanPhaseTaper: 0.9,
    scanDuration: 2.6,
    scanDelay: 1.6,
    scanOnClick: false,
    snapBackDelay: 250,
    // additions for this app: the corridor is behind a login card
    centerScrim: 0.86,
    centerScrimR0: 0.05,
    centerScrimR1: 0.78,
    vignette: 0.45,
    maxDpr: 1.5,
    minScale: 0.6
  };

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // sRGB hex -> linear rgb, matching three's convertSRGBToLinear()
  function srgbToLinear(hex) {
    var n = parseInt(String(hex).replace("#", ""), 16);
    var out = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    for (var i = 0; i < 3; i++) {
      var c = out[i];
      out[i] = c < 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }
    return out;
  }

  // Unity-style critically damped smoothing, as the original uses
  function smoothDamp(cur, target, velRef, smoothTime, dt) {
    smoothTime = Math.max(0.0001, smoothTime);
    var omega = 2 / smoothTime;
    var x = omega * dt;
    var exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    var change = cur - target;
    var originalTo = target;
    target = cur - change;
    var temp = (velRef.v + omega * change) * dt;
    velRef.v = (velRef.v - omega * temp) * exp;
    var out = target + (change + temp) * exp;
    if ((originalTo - cur) * (out - originalTo) > 0) { out = originalTo; velRef.v = 0; }
    return out;
  }

  function mount(target, options) {
    var canvases = Object.prototype.toString.call(target) === "[object Array]"
      ? target.slice() : [target];
    canvases = canvases.filter(Boolean);
    if (!canvases.length) return { destroy: function () {}, scan: function () {} };

    var o = {};
    for (var k in DEFAULTS) o[k] = DEFAULTS[k];
    if (options) for (var k2 in options) if (options[k2] !== undefined) o[k2] = options[k2];

    var glCanvas = canvases[0];
    var mirrors = canvases.slice(1).map(function (c) { return c.getContext("2d"); });

    var gl = glCanvas.getContext("webgl", {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: true,
      powerPreference: "high-performance"
    }) || glCanvas.getContext("experimental-webgl");
    if (!gl) { console.warn("[GridScan] WebGL unavailable"); return { destroy: function () {}, scan: function () {} }; }
    // the grid shader needs fwidth(); three injects this pragma for you
    gl.getExtension("OES_standard_derivatives");

    // ── program helpers ──
    function sh(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error("[GridScan] shader compile failed:\n" + gl.getShaderInfoLog(s));
        return null;
      }
      return s;
    }
    function prog(fragSrc) {
      var v = sh(gl.VERTEX_SHADER, VERT), f = sh(gl.FRAGMENT_SHADER, fragSrc);
      if (!v || !f) return null;
      var p = gl.createProgram();
      gl.attachShader(p, v); gl.attachShader(p, f);
      gl.bindAttribLocation(p, 0, "aPos");
      gl.linkProgram(p);
      gl.deleteShader(v); gl.deleteShader(f);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        console.error("[GridScan] link failed: " + gl.getProgramInfoLog(p));
        return null;
      }
      return p;
    }
    function uni(p) {
      var map = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (var i = 0; i < n; i++) {
        var info = gl.getActiveUniform(p, i);
        var name = info.name.replace(/\[0\]$/, "");
        map[name] = gl.getUniformLocation(p, info.name);
      }
      return map;
    }

    var pGrid = prog(FRAG_GRID);
    if (!pGrid) return { destroy: function () {}, scan: function () {} };
    var pBright = prog(FRAG_BRIGHT), pBlur = prog(FRAG_BLUR), pPost = prog(FRAG_POST);
    var uGrid = uni(pGrid), uBright = uni(pBright), uBlur = uni(pBlur), uPost = uni(pPost);

    var quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // ── render targets ──
    function makeRT(w, h) {
      var tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      var fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { tex: tex, fb: fb, w: w, h: h };
    }
    function freeRT(rt) { if (rt) { gl.deleteTexture(rt.tex); gl.deleteFramebuffer(rt.fb); } }

    var rtScene = null, rtA = null, rtB = null;
    var W = 0, H = 0, dpr = 1, scale = 1;

    // ── input: pointer parallax, as in the original ──
    var sens = clamp(o.sensitivity, 0, 1);
    var skewScale = lerp(0.06, 0.2, sens);
    var tiltScale = lerp(0.12, 0.3, sens);
    var yawScale = lerp(0.1, 0.28, sens);
    var smoothTime = lerp(0.45, 0.12, sens);
    var yBoost = lerp(1.2, 1.6, sens);

    var tgt = { x: 0, y: 0, tilt: 0, yaw: 0 };
    var cur = { x: 0, y: 0, tilt: 0, yaw: 0 };
    var vel = { x: { v: 0 }, y: { v: 0 }, tilt: { v: 0 }, yaw: { v: 0 } };

    var MAX_SCANS = 8;
    var scanStarts = [];
    var scanBuf = new Float32Array(MAX_SCANS);

    function pushScan(tSec) {
      if (scanStarts.length >= MAX_SCANS) scanStarts.shift();
      scanStarts.push(tSec);
    }

    var leaveTimer = 0;
    function onMove(e) {
      if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = 0; }
      var w = global.innerWidth || 1, h = global.innerHeight || 1;
      tgt.x = (e.clientX / w) * 2 - 1;
      tgt.y = -((e.clientY / h) * 2 - 1);
      tgt.yaw = tgt.x * 0.5;
    }
    function onLeave() {
      if (leaveTimer) clearTimeout(leaveTimer);
      leaveTimer = global.setTimeout(function () {
        tgt.x = 0; tgt.y = 0; tgt.tilt = 0; tgt.yaw = 0;
      }, Math.max(0, o.snapBackDelay || 0));
    }
    function onClick() { if (o.scanOnClick) pushScan((global.performance || Date).now() / 1000 - t0 / 1000); }

    var reduced = false;
    try { reduced = global.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}

    // ── sizing ──
    function sizeTo() {
      var cssW = global.innerWidth || 1280, cssH = global.innerHeight || 720;
      dpr = Math.min(global.devicePixelRatio || 1, o.maxDpr) * scale;
      W = Math.max(2, Math.round(cssW * dpr));
      H = Math.max(2, Math.round(cssH * dpr));

      glCanvas.width = W; glCanvas.height = H;
      glCanvas.style.width = cssW + "px"; glCanvas.style.height = cssH + "px";
      canvases.slice(1).forEach(function (c) {
        c.width = W; c.height = H;
        c.style.width = cssW + "px"; c.style.height = cssH + "px";
      });

      freeRT(rtScene); freeRT(rtA); freeRT(rtB);
      rtScene = makeRT(W, H);
      var bw = Math.max(1, W >> 2), bh = Math.max(1, H >> 2);
      rtA = makeRT(bw, bh); rtB = makeRT(bw, bh);
    }

    function blit(p, u, rt) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, rt ? rt.fb : null);
      gl.viewport(0, 0, rt ? rt.w : W, rt ? rt.h : H);
      gl.useProgram(p);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    var linesRGB = srgbToLinear(o.linesColor);
    var scanRGB = srgbToLinear(o.scanColor);
    var styleId = o.lineStyle === "dashed" ? 1 : o.lineStyle === "dotted" ? 2 : 0;
    var dirId = o.scanDirection === "backward" ? 1 : o.scanDirection === "pingpong" ? 2 : 0;
    var usePost = !!o.enablePost;

    var t0 = (global.performance || Date).now();
    var lastT = t0, raf = 0, destroyed = false, frames = 0, acc = 0;

    function render(nowMs, dt) {
      var tSec = (nowMs - t0) / 1000;

      // pointer smoothing
      cur.x = smoothDamp(cur.x, tgt.x, vel.x, smoothTime, dt);
      cur.y = smoothDamp(cur.y, tgt.y, vel.y, smoothTime, dt);
      cur.tilt = smoothDamp(cur.tilt, tgt.tilt, vel.tilt, smoothTime, dt);
      cur.yaw = smoothDamp(cur.yaw, tgt.yaw, vel.yaw, smoothTime, dt);

      // ── scene ──
      gl.useProgram(pGrid);
      gl.uniform3f(uGrid.iResolution, W, H, dpr);
      gl.uniform1f(uGrid.iTime, tSec);
      gl.uniform2f(uGrid.uSkew, cur.x * skewScale, -cur.y * yBoost * skewScale);
      gl.uniform1f(uGrid.uTilt, cur.tilt * tiltScale);
      gl.uniform1f(uGrid.uYaw, clamp(cur.yaw * yawScale, -0.6, 0.6));
      gl.uniform1f(uGrid.uLineThickness, o.lineThickness);
      gl.uniform3f(uGrid.uLinesColor, linesRGB[0], linesRGB[1], linesRGB[2]);
      gl.uniform3f(uGrid.uScanColor, scanRGB[0], scanRGB[1], scanRGB[2]);
      gl.uniform1f(uGrid.uGridScale, o.gridScale);
      gl.uniform1f(uGrid.uLineStyle, styleId);
      gl.uniform1f(uGrid.uLineJitter, clamp(o.lineJitter, 0, 1));
      gl.uniform1f(uGrid.uScanOpacity, clamp(o.scanOpacity, 0, 1));
      gl.uniform1f(uGrid.uScanDirection, dirId);
      gl.uniform1f(uGrid.uNoise, Math.max(0, o.noiseIntensity));
      gl.uniform1f(uGrid.uBloomOpacity, Math.max(0, o.bloomIntensity));
      gl.uniform1f(uGrid.uScanGlow, o.scanGlow);
      gl.uniform1f(uGrid.uScanSoftness, o.scanSoftness);
      gl.uniform1f(uGrid.uPhaseTaper, o.scanPhaseTaper);
      gl.uniform1f(uGrid.uScanDuration, Math.max(0.05, o.scanDuration));
      gl.uniform1f(uGrid.uScanDelay, Math.max(0, o.scanDelay));
      for (var i = 0; i < MAX_SCANS; i++) scanBuf[i] = scanStarts[i] || 0;
      if (uGrid.uScanStarts) gl.uniform1fv(uGrid.uScanStarts, scanBuf);
      if (uGrid.uScanCount) gl.uniform1f(uGrid.uScanCount, scanStarts.length);
      blit(pGrid, uGrid, usePost ? rtScene : null);

      if (!usePost) return;

      // ── bloom: bright pass at quarter res, then separable blur ──
      gl.activeTexture(gl.TEXTURE0);
      gl.useProgram(pBright);
      gl.bindTexture(gl.TEXTURE_2D, rtScene.tex);
      gl.uniform1i(uBright.uTex, 0);
      gl.uniform1f(uBright.uThreshold, o.bloomThreshold);
      gl.uniform1f(uBright.uSmoothing, o.bloomSmoothing);
      blit(pBright, uBright, rtA);

      gl.useProgram(pBlur);
      gl.bindTexture(gl.TEXTURE_2D, rtA.tex);
      gl.uniform1i(uBlur.uTex, 0);
      gl.uniform2f(uBlur.uDir, 1 / rtA.w, 0);
      blit(pBlur, uBlur, rtB);

      gl.bindTexture(gl.TEXTURE_2D, rtB.tex);
      gl.uniform2f(uBlur.uDir, 0, 1 / rtB.h);
      blit(pBlur, uBlur, rtA);

      // ── composite to screen ──
      gl.useProgram(pPost);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, rtScene.tex);
      gl.uniform1i(uPost.uScene, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, rtA.tex);
      gl.uniform1i(uPost.uBloom, 1);
      gl.uniform1f(uPost.uBloomIntensity, Math.max(0, o.bloomIntensity));
      gl.uniform1f(uPost.uCA, o.chromaticAberration);
      gl.uniform1f(uPost.uScrim, o.centerScrim);
      gl.uniform1f(uPost.uScrimR0, o.centerScrimR0);
      gl.uniform1f(uPost.uScrimR1, o.centerScrimR1);
      gl.uniform1f(uPost.uVignette, o.vignette);
      gl.uniform2f(uPost.uAspect, W > H ? W / H : 1, H > W ? H / W : 1);
      blit(pPost, uPost, null);
      gl.activeTexture(gl.TEXTURE0);
    }

    function mirror() {
      for (var i = 0; i < mirrors.length; i++) mirrors[i].drawImage(glCanvas, 0, 0);
    }

    function govern(dt) {
      acc += dt * 1000; frames++;
      if (frames < 60) return;
      var avg = acc / frames; frames = 0; acc = 0;
      if (avg > 24 && scale > o.minScale) { scale = Math.max(o.minScale, scale - 0.2); sizeTo(); }
    }

    function loop(now) {
      if (destroyed) return;
      var dt = Math.max(0, Math.min(0.1, (now - lastT) / 1000));
      lastT = now;
      render(now, dt);
      mirror();
      govern(dt);
      raf = global.requestAnimationFrame(loop);
    }

    var running = false;
    function start() { if (running || destroyed) return; running = true; lastT = (global.performance || Date).now(); raf = global.requestAnimationFrame(loop); }
    function stop() { running = false; if (raf) global.cancelAnimationFrame(raf); raf = 0; }

    var resizeTimer = 0;
    function onResize() {
      global.clearTimeout(resizeTimer);
      resizeTimer = global.setTimeout(function () {
        if (destroyed) return;
        sizeTo();
        if (reduced) { render((global.performance || Date).now(), 0); mirror(); }
      }, 140);
    }
    function onVisibility() { if (document.hidden) stop(); else if (!reduced) start(); }

    sizeTo();
    global.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibility);
    global.addEventListener("mousemove", onMove, { passive: true });
    document.addEventListener("mouseleave", onLeave);
    if (o.scanOnClick) global.addEventListener("click", onClick);

    if (reduced) {
      // one representative frame, mid-sweep, then idle
      t0 = (global.performance || Date).now() - (o.scanDelay + o.scanDuration * 0.55) * 1000;
      render((global.performance || Date).now(), 0);
      mirror();
    } else {
      start();
    }

    return {
      scan: function () { pushScan(((global.performance || Date).now() - t0) / 1000); },
      destroy: function () {
        destroyed = true;
        stop();
        global.removeEventListener("resize", onResize);
        document.removeEventListener("visibilitychange", onVisibility);
        global.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseleave", onLeave);
        if (o.scanOnClick) global.removeEventListener("click", onClick);
        global.clearTimeout(resizeTimer);
        global.clearTimeout(leaveTimer);
        freeRT(rtScene); freeRT(rtA); freeRT(rtB);
        gl.deleteBuffer(quad);
        [pGrid, pBright, pBlur, pPost].forEach(function (p) { if (p) gl.deleteProgram(p); });
        var lose = gl.getExtension("WEBGL_lose_context");
        if (lose) lose.loseContext();
      }
    };
  }

  global.GridScan = { mount: mount, defaults: DEFAULTS };
})(window);
