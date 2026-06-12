/* ============================================================================
 *  OCEAN — live animated background for VS Code & Antigravity
 *  Loaded by the "Custom CSS and JS Loader" extension
 *
 *  The water is a real simulation: a wave-equation heightfield runs in
 *  ping-pong float textures, and caustics are computed by refracting a
 *  light mesh through the simulated surface and measuring where the rays
 *  converge (after Evan Wallace's WebGL Water). On GPUs without float
 *  textures the shader falls back to a procedural approximation.
 *
 *  Tweak the CONFIG values below, then run
 *  "Reload Custom CSS and JS" from the Command Palette.
 * ========================================================================== */
(function () {
  const CONFIG = {
    opacity: 0.60, // how visible the ocean is behind your code   (0 – 1)
    dim: 0.50, // extra dark scrim for text readability         (0 – 1)
    speed: 1.00, // motion speed multiplier                       (0.2 – 3)
    minimap: 0.45, // minimap translucency so ocean shows through  (0 = invisible, 1 = solid)
    sticky: 0.92, // sticky-scroll backing opacity (uses the THEME's color)
    caustics: 1.0, // brightness of the caustic web on the surface    (0 – 2)
  };

  if (document.getElementById('__aurora-bg')) return; // already injected

  /* read a CSS custom property's *current* (theme) value, before we blank it */
  function readVar(name) {
    const el = document.querySelector('.monaco-workbench') || document.body;
    return getComputedStyle(el).getPropertyValue(name).trim();
  }

  /* wait until the workbench exists so the theme variables are populated
     (called at the very end of this file, after all constants exist) */
  function boot() {
    if (!document.querySelector('.monaco-workbench')) {
      return requestAnimationFrame(boot);
    }
    injectStyle();
    startOcean();
  }

  /* ---- 1. make VS Code's own backgrounds transparent ---------------------- */
  function injectStyle() {
    // grab the theme's sticky-scroll colour now (falls back to editor bg, then a dark blue)
    const themeSticky =
      readVar('--vscode-editorStickyScroll-background') ||
      readVar('--vscode-editor-background') ||
      '#10141f';
    const stickyBg = `color-mix(in srgb, ${themeSticky} ${Math.round(CONFIG.sticky * 100)}%, transparent)`;

    const style = document.createElement('style');
    style.id = '__aurora-style';
    style.textContent = `
      /* Most VS Code surfaces read their background from these variables —
         blanking them at the root is far more reliable than per-element rules. */
      :root, .monaco-workbench {
        --vscode-editor-background: transparent !important;
        --vscode-editorGutter-background: transparent !important;
        --vscode-breadcrumb-background: transparent !important;
        --vscode-editorGroupHeader-tabsBackground: transparent !important;
        --vscode-editorGroupHeader-noTabsBackground: transparent !important;
        --vscode-editorGroup-emptyBackground: transparent !important;
        --vscode-tab-activeBackground: transparent !important;
        --vscode-tab-inactiveBackground: transparent !important;
        --vscode-tab-hoverBackground: rgba(255,255,255,0.05) !important;
        --vscode-sideBar-background: transparent !important;
        --vscode-sideBarSectionHeader-background: transparent !important;
        --vscode-activityBar-background: transparent !important;
        --vscode-panel-background: transparent !important;
        --vscode-minimap-background: transparent !important;
        /* sticky scroll keeps the theme's own colour, mostly opaque */
        --vscode-editorStickyScroll-background: ${stickyBg} !important;
        --vscode-editorStickyScrollHover-background: ${stickyBg} !important;
        /* keep pop-ups (autocomplete, hovers, command palette) legible */
        --vscode-editorWidget-background: rgba(10,14,24,0.92) !important;
        --vscode-quickInput-background: rgba(10,14,24,0.94) !important;
        --vscode-menu-background: rgba(10,14,24,0.96) !important;
      }
      /* a few surfaces hardcode their background instead of using a variable */
      .monaco-workbench,
      .part.editor, .part.editor > .content,
      .editor-container, .editor-group-container, .editor-group-container.empty,
      .editor-instance, .monaco-grid-view, .grid-view-container,
      .split-view-view, .monaco-pane-view,
      .monaco-editor, .monaco-editor .overflow-guard,
      .monaco-editor-background, .monaco-editor .margin,
      .monaco-scrollable-element, .monaco-scrollable-element > .scrollbar,
      .sidebar, .auxiliarybar, .panel,
      .tabs-container, .title.tabs, .editor-actions, .breadcrumbs-control {
        background-color: transparent !important;
      }
      /* keep the workbench painting above the canvas + scrim */
      .monaco-workbench { position: relative; z-index: 2; }
      #__aurora-bg, #__aurora-scrim {
        position: fixed; inset: 0; width: 100vw; height: 100vh;
        pointer-events: none;
      }
      #__aurora-bg    { z-index: 0; opacity: ${CONFIG.opacity}; }
      #__aurora-scrim { z-index: 1; background: rgba(3, 6, 12, ${CONFIG.dim}); }
      /* the minimap is a painted canvas — fade it so the ocean bleeds through */
      .monaco-editor .minimap { opacity: ${CONFIG.minimap} !important; }
      /* sticky scroll: theme colour, kept readable */
      .monaco-editor .sticky-widget,
      .monaco-editor .sticky-widget .sticky-line-content {
        background-color: ${stickyBg} !important;
      }
    `;
    document.head.appendChild(style);
  }

  /* ---- 2. shared GLSL ------------------------------------------------------ */

  const NOISE_GLSL = `
      float hash21(vec2 p){ p=fract(p*vec2(123.34,345.45)); p+=dot(p,p+34.345); return fract(p.x*p.y); }
      float vnoise(vec2 p){
        vec2 i=floor(p),f=fract(p); vec2 u=f*f*(3.0-2.0*f);
        float a=hash21(i),b=hash21(i+vec2(1.,0.)),c=hash21(i+vec2(0.,1.)),d=hash21(i+vec2(1.,1.));
        return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);
      }
      float fbm(vec2 p){ float s=0.0,a=0.5; mat2 m=mat2(1.6,1.2,-1.2,1.6);
        for(int i=0;i<6;i++){ s+=a*vnoise(p); p=m*p; a*=0.5; } return s; }
      float dither(vec2 f){ return (hash21(f+fract(iTime))-0.5)*0.004; }

      /* one vertical curtain of light shafts: noise across x, animated in time */
      float rayCurtain(float x, float tt){
        float a = vnoise(vec2(x, tt));
        float b = vnoise(vec2(x * 2.3 + 7.7, tt * 1.4));
        return smoothstep(0.45, 0.85, a * 0.6 + b * 0.4);
      }
  `;

  const VERT_MAIN = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';

  const VERT_PASS = `
      attribute vec2 p; varying vec2 vUv;
      void main(){ vUv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }
  `;

  /* add a disturbance to the heightfield (rain of "wind gusts" keeps it alive) */
  const FRAG_DROP = `
      precision highp float;
      uniform sampler2D water;
      uniform vec2 center; uniform float radius; uniform float strength;
      varying vec2 vUv;
      void main(){
        vec4 info = texture2D(water, vUv);
        float drop = max(0.0, 1.0 - length(center - vUv) / radius);
        drop = 0.5 - cos(drop * 3.14159265) * 0.5;
        info.r += drop * strength;
        gl_FragColor = info;
      }
  `;

  /* one tick of the wave equation: r = height, g = velocity */
  const FRAG_STEP = `
      precision highp float;
      uniform sampler2D water;
      uniform vec2 delta;
      varying vec2 vUv;
      void main(){
        vec4 info = texture2D(water, vUv);
        vec2 dx = vec2(delta.x, 0.0), dy = vec2(0.0, delta.y);
        float average = (texture2D(water, vUv - dx).r + texture2D(water, vUv - dy).r
                       + texture2D(water, vUv + dx).r + texture2D(water, vUv + dy).r) * 0.25;
        info.g += (average - info.r) * 2.0;
        info.g *= 0.995;          // wave damping
        info.r += info.g;
        info.r *= 0.9995;         // bleed any DC offset back to sea level
        gl_FragColor = info;
      }
  `;

  /* caustics: refract a light-carrying mesh through the surface and let the
     fragment derivatives measure how much each triangle was focused */
  const VERT_CAUSTICS = `
      precision highp float;
      attribute vec2 av;
      uniform sampler2D water;
      uniform vec2 delta;
      varying vec2 vOld, vNew;
      void main(){
        float h  = texture2D(water, av).r;
        float hx = texture2D(water, av + vec2(delta.x, 0.0)).r;
        float hy = texture2D(water, av + vec2(0.0, delta.y)).r;
        vec3 normal = normalize(vec3((h - hx) / delta.x * 0.25, 1.0, (h - hy) / delta.y * 0.25));
        vec3 ray = refract(vec3(0.0, -1.0, 0.0), normal, 0.7504);
        vec2 disp = ray.xz / max(-ray.y, 0.1) * 0.45;
        vOld = av;
        vNew = av + disp;
        gl_Position = vec4(vNew * 2.0 - 1.0, 0.0, 1.0);
      }
  `;

  const FRAG_CAUSTICS = `
      #extension GL_OES_standard_derivatives : enable
      precision highp float;
      varying vec2 vOld, vNew;
      void main(){
        float oldArea = length(dFdx(vOld)) * length(dFdy(vOld));
        float newArea = length(dFdx(vNew)) * length(dFdy(vNew));
        float ratio = oldArea / max(newArea, 1e-6);
        gl_FragColor = vec4(vec3(ratio * 0.16), 1.0);
      }
  `;

  /* ---- 3. the scene, lit by the simulation -------------------------------- */
  const FRAG_SCENE = `
      precision highp float;
      uniform vec2 iResolution;
      uniform float iTime;
      uniform sampler2D uWater;
      uniform sampler2D uCaustics;
      ${NOISE_GLSL}

      const float TILE = 14.0;          // world size of one simulation tile
      const float TEXEL = 1.0 / 256.0;

      vec2 worldToUv(vec2 w, float t){ return w / TILE + vec2(t * 0.012, t * 0.02); }
      float caus(vec2 w, float t){ return texture2D(uCaustics, worldToUv(w, t)).r; }
      vec2 slopeAt(vec2 w, float t){
        vec2 suv = worldToUv(w, t);
        float h0 = texture2D(uWater, suv).r;
        float hx = texture2D(uWater, suv + vec2(TEXEL, 0.0)).r - h0;
        float hy = texture2D(uWater, suv + vec2(0.0, TEXEL)).r - h0;
        return vec2(hx, hy) * 220.0;
      }

      void main(){
        vec2 frag=gl_FragCoord.xy;
        vec2 uv=(frag-0.5*iResolution.xy)/iResolution.y;
        float t=iTime*0.12;

        float depth = clamp(uv.y + 0.5, 0.0, 1.0); // 0.0 at bottom edge, 1.0 at top edge

        // 1. Background Gradient (The Cutout)
        vec3 colBottom = vec3(0.01, 0.02, 0.08); // Very dark navy abyss
        vec3 colMid    = vec3(0.02, 0.15, 0.45); // Deep true blue (less green)
        vec3 colTop    = vec3(0.05, 0.46, 0.85); // Bright blue near surface, slightly green to match the caustics

        vec3 col = mix(colBottom, colMid, smoothstep(0.0, 0.5, depth));
        col = mix(col, colTop, smoothstep(0.5, 1.0, depth));

        // 2. Fluid Domain Warping for volumetric ripples
        vec2 q = vec2(0.0);
        q.x = fbm(uv * 2.0 + vec2(0.0, t * 0.4));
        q.y = fbm(uv * 2.0 - vec2(t * 0.3, 0.0));

        vec2 r = vec2(0.0);
        r.x = fbm(uv * 3.0 + q * 2.0 + vec2(t * 0.5, -t * 0.4));
        r.y = fbm(uv * 3.0 - q * 2.0 - vec2(-t * 0.3, t * 0.6));

        float f = fbm(uv * 2.5 + r * 2.0 + vec2(0.0, t * 0.3));

        // Add the fluid ripples, stronger near the top (shifted to pure blue, less green)
        col += vec3(0.02, 0.15, 0.50) * f * (0.2 + 0.8 * depth);

        // 3. Volumetric god rays, distributed in depth: three curtains of shafts
        // hang from the surface at increasing distance. Their brightness and
        // bending come straight from the simulated surface above them.
        float horizonBase = 0.22;

        // ambient wash so the water column never goes flat
        float bg1 = vnoise(vec2(uv.x * 3.0, t * 0.3));
        float bg2 = vnoise(vec2(uv.x * 6.0, t * 0.5));
        float bgShafts = smoothstep(0.2, 0.9, bg1 * 0.6 + bg2 * 0.4);
        col += vec3(0.02, 0.10, 0.40) * bgShafts * pow(depth, 1.2) * 0.5;

        vec3 rayTint = vec3(0.05, 0.25, 0.70);
        vec3 hazeTint = colTop * 1.1;
        for (int k = 0; k < 3; k++) {
          float d = 2.5 * pow(2.2, float(k));           // curtain distance: 2.5, 5.5, 12
          float yAtt = horizonBase + 1.0 / d;           // where it meets the surface on screen
          // rays refract off straight-down according to the wave slope overhead
          vec2 slA = slopeAt(vec2(uv.x * d, d), t);
          float tilt = clamp(slA.x * 0.4, -0.35, 0.35);
          float xs = uv.x + (yAtt - uv.y) * tilt;       // ray-column coordinate
          float sway = sin(t * (1.1 - 0.04 * d) + d * 2.7) * 0.5 / d;
          float xw = xs * d * 2.2 + sway + d * 7.31;    // perspective: far shafts pack tighter
          float shafts = pow(rayCurtain(xw, t * (1.4 - 0.05 * d) + d), 1.2);
          // sync: shafts brighten beneath bright caustic patches on the surface
          float cA = caus(vec2(xs * d, d), t);
          shafts *= 0.3 + 7.0 * max(cA - 0.17, 0.0);
          float lenVar = 0.5 + vnoise(vec2(xw * 0.4, t * 0.5 + d)) * 1.1;
          float below = max(yAtt - uv.y, 0.0);
          float fall = exp(-below * d * 0.35 / lenVar); // far curtains compress vertically
          float cut = smoothstep(yAtt + 0.05, yAtt - 0.03, uv.y);
          float fogL = exp(-d * 0.085);                 // distance haze
          col += mix(hazeTint, rayTint, fogL) * shafts * fall * cut * fogL * 0.7;
        }

        // 4. The water surface seen from below: the upper band of the screen is
        // perspective-projected onto the simulated plane, lit by the computed
        // caustics and shaded by the simulated wave slope.
        float horizon = horizonBase + 0.025 * sin(uv.x * 4.0 - t * 2.6)
                      + 0.02 * fbm(vec2(uv.x * 2.5 + t * 1.2, t * 0.8));
        float dy = uv.y - horizon;

        // soft glow where the surface melts into the distance
        col += vec3(0.05, 0.30, 0.80) * smoothstep(horizon - 0.15, horizon + 0.25, uv.y) * 0.35;

        if (dy > 0.002) {
          float dist = 1.0 / dy;                     // distance along the overhead plane
          vec2 pw0 = vec2(uv.x * dist, dist);        // projected point on the surface
          vec2 sl = slopeAt(pw0, t);

          // refraction parallax: the view through a tilted facet shifts the lookup
          vec2 wq = pw0 + sl * 0.8;
          // chromatic dispersion: wavelengths focus at slightly different points
          float cr = caus(wq, t);
          float cg = caus(wq + vec2(0.07, 0.0), t);
          float cb = caus(wq + vec2(0.14, 0.0), t);
          vec3 web = max(vec3(cr, cg, cb) - 0.17, 0.0) * 6.0 * vec3(0.40, 0.80, 1.15);

          // slope shading: wave faces tilted toward the viewer catch the skylight
          float shade = clamp(0.55 - sl.y * 0.45 - sl.x * 0.12, 0.0, 1.0);
          // glassy highlight running along the swell crests
          float glint = pow(clamp(1.0 - abs(sl.y - 0.55) * 1.6, 0.0, 1.0), 3.0);

          float fog = exp(-(dist - 3.0) * 0.18);     // far cells dissolve into the haze
          fog = min(fog, 1.0);
          col += (vec3(0.04, 0.22, 0.55) * 0.35
                  + web * float(${CONFIG.caustics.toFixed(2)}) * 0.8
                  + vec3(0.35, 0.65, 1.0) * glint * 0.30)
                 * (0.45 + 1.1 * shade) * fog;
        }

        // 5. Drifting Bioluminescent Plankton
        vec2 pGrid = uv * 12.0;
        pGrid.y -= iTime * 0.04;
        pGrid.x += sin(pGrid.y * 2.0 + iTime * 0.1) * 0.15;
        vec2 ip = floor(pGrid);
        vec2 fp = fract(pGrid);
        vec2 pOffset = vec2(hash21(ip), hash21(ip + 13.37));
        float pDist = length(fp - pOffset);
        float pBlink = sin(iTime * 0.6 + pOffset.x * 6.28) * 0.5 + 0.5;

        float pGlow = smoothstep(0.015 + 0.015 * pOffset.y, 0.0, pDist) * pBlink;
        pGlow *= smoothstep(0.0, 0.8, depth);

        // Plankton shifted to a softer blue with just a hint of cyan
        col += pGlow * 0.4 * vec3(0.15, 0.50, 0.90);

        // Vignette
        col *= 1.0 - 0.4 * length(uv * vec2(0.6, 1.0));

        // Dither
        col += dither(frag);

        gl_FragColor=vec4(col,1.0);
      }
  `;

  /* ---- 4. procedural fallback (no float textures) -------------------------- */
  const FRAG_FALLBACK = `
      precision highp float;
      uniform vec2 iResolution;
      uniform float iTime;
      ${NOISE_GLSL}

      /* Iterative-refraction caustic web: each pass bends the sample point like
         light through a wavy surface, and brightness spikes where rays focus. */
      float caustic(vec2 suv, float tc){
        vec2 p = mod(suv * 6.2831853, 6.2831853) - 250.0;
        vec2 i = p;
        float c = 1.0;
        const float inten = 0.005;
        for (int n = 0; n < 5; n++) {
          float ph = tc * (1.0 - (3.5 / float(n + 1)));
          i = p + vec2(cos(ph - i.x) + sin(ph + i.y), sin(ph - i.y) + cos(ph + i.x));
          c += 1.0 / max(length(vec2(p.x / (sin(i.x + ph) / inten), p.y / (cos(i.y + ph) / inten))), 1e-3);
        }
        c /= 5.0;
        c = 1.17 - pow(c, 1.4);
        return pow(abs(c), 8.0);
      }

      /* low-frequency swell height field for the overhead surface plane */
      float waveH(vec2 p, float tw){
        float h = sin(p.y * 0.55 + tw * 2.2);
        h += 0.6 * sin(dot(p, vec2(0.42, 0.35)) + tw * 1.6);
        h += 0.8 * vnoise(p * 0.35 + vec2(tw * 0.8, tw * 0.5)) - 0.4;
        return h;
      }

      void main(){
        vec2 frag=gl_FragCoord.xy;
        vec2 uv=(frag-0.5*iResolution.xy)/iResolution.y;
        float t=iTime*0.12;

        float depth = clamp(uv.y + 0.5, 0.0, 1.0);

        vec3 colBottom = vec3(0.01, 0.02, 0.08);
        vec3 colMid    = vec3(0.02, 0.15, 0.45);
        vec3 colTop    = vec3(0.05, 0.46, 0.85);

        vec3 col = mix(colBottom, colMid, smoothstep(0.0, 0.5, depth));
        col = mix(col, colTop, smoothstep(0.5, 1.0, depth));

        vec2 q = vec2(0.0);
        q.x = fbm(uv * 2.0 + vec2(0.0, t * 0.4));
        q.y = fbm(uv * 2.0 - vec2(t * 0.3, 0.0));
        vec2 r = vec2(0.0);
        r.x = fbm(uv * 3.0 + q * 2.0 + vec2(t * 0.5, -t * 0.4));
        r.y = fbm(uv * 3.0 - q * 2.0 - vec2(-t * 0.3, t * 0.6));
        float f = fbm(uv * 2.5 + r * 2.0 + vec2(0.0, t * 0.3));
        col += vec3(0.02, 0.15, 0.50) * f * (0.2 + 0.8 * depth);

        float horizonBase = 0.22;
        float tc = iTime * 0.1 + 23.0;
        vec2 cDrift = vec2(t * 0.25, t * 0.45);

        float bg1 = vnoise(vec2(uv.x * 3.0, t * 0.3));
        float bg2 = vnoise(vec2(uv.x * 6.0, t * 0.5));
        float bgShafts = smoothstep(0.2, 0.9, bg1 * 0.6 + bg2 * 0.4);
        col += vec3(0.02, 0.10, 0.40) * bgShafts * pow(depth, 1.2) * 0.5;

        vec3 rayTint = vec3(0.05, 0.25, 0.70);
        vec3 hazeTint = colTop * 1.1;
        for (int k = 0; k < 3; k++) {
          float d = 2.5 * pow(2.2, float(k));
          float yAtt = horizonBase + 1.0 / d;
          vec2 ap = vec2(uv.x * d, d);
          float hT = waveH(ap, t);
          float slopeA = (waveH(ap + vec2(0.15, 0.0), t) - hT) / 0.15;
          float tilt = clamp(slopeA * 0.22, -0.35, 0.35);
          float xs = uv.x + (yAtt - uv.y) * tilt;
          float sway = sin(t * (1.1 - 0.04 * d) + d * 2.7) * 0.5 / d;
          float xw = xs * d * 2.2 + sway + d * 7.31;
          float shafts = pow(rayCurtain(xw, t * (1.4 - 0.05 * d) + d), 1.2);
          float hA = waveH(vec2(xs * d, d), t);
          vec2 cw = vec2(xs * d, d) * 0.22 + cDrift;
          cw.x += sin(cw.y * 1.5 + t * 0.9) * 0.12;
          float cA = caustic(cw, tc + hA * 0.5) * (0.55 + 0.7 * smoothstep(-1.2, 1.4, hA));
          shafts *= 0.35 + 1.6 * min(cA, 1.2);
          float lenVar = 0.5 + vnoise(vec2(xw * 0.4, t * 0.5 + d)) * 1.1;
          float below = max(yAtt - uv.y, 0.0);
          float fall = exp(-below * d * 0.35 / lenVar);
          float cut = smoothstep(yAtt + 0.05, yAtt - 0.03, uv.y);
          float fogL = exp(-d * 0.085);
          col += mix(hazeTint, rayTint, fogL) * shafts * fall * cut * fogL * 0.7;
        }

        float horizon = horizonBase + 0.025 * sin(uv.x * 4.0 - t * 2.6)
                      + 0.02 * fbm(vec2(uv.x * 2.5 + t * 1.2, t * 0.8));
        float dy = uv.y - horizon;

        col += vec3(0.05, 0.30, 0.80) * smoothstep(horizon - 0.15, horizon + 0.25, uv.y) * 0.35;

        if (dy > 0.002) {
          float dist = 1.0 / dy;
          vec2 pw0 = vec2(uv.x * dist, dist);

          float e = 0.15;
          float h = waveH(pw0, t);
          vec2 grad = vec2(waveH(pw0 + vec2(e, 0.0), t) - h,
                           waveH(pw0 + vec2(0.0, e), t) - h) / e;

          vec2 pw = (pw0 + grad * 1.6) * 0.22 + cDrift;
          pw.x += sin(pw.y * 1.5 + t * 0.9) * 0.12;
          float tcw = tc + h * 0.5;

          float cr = caustic(pw, tcw);
          float cg = caustic(pw * 1.012, tcw + 0.04);
          float cb = caustic(pw * 1.024, tcw + 0.08);
          float focus = 0.55 + 0.7 * smoothstep(-1.2, 1.4, h);
          vec3 web = vec3(cr, cg, cb) * vec3(0.40, 0.80, 1.15) * focus;

          float shade = clamp(0.55 - grad.y * 0.45 - grad.x * 0.12, 0.0, 1.0);
          float glint = pow(clamp(1.0 - abs(grad.y - 0.55) * 1.6, 0.0, 1.0), 3.0);

          float fog = exp(-(dist - 3.0) * 0.18);
          fog = min(fog, 1.0);
          col += (vec3(0.04, 0.22, 0.55) * 0.35
                  + web * float(${CONFIG.caustics.toFixed(2)}) * 0.8
                  + vec3(0.35, 0.65, 1.0) * glint * 0.30)
                 * (0.45 + 1.1 * shade) * fog;
        }

        vec2 pGrid = uv * 12.0;
        pGrid.y -= iTime * 0.04;
        pGrid.x += sin(pGrid.y * 2.0 + iTime * 0.1) * 0.15;
        vec2 ip = floor(pGrid);
        vec2 fp = fract(pGrid);
        vec2 pOffset = vec2(hash21(ip), hash21(ip + 13.37));
        float pDist = length(fp - pOffset);
        float pBlink = sin(iTime * 0.6 + pOffset.x * 6.28) * 0.5 + 0.5;
        float pGlow = smoothstep(0.015 + 0.015 * pOffset.y, 0.0, pDist) * pBlink;
        pGlow *= smoothstep(0.0, 0.8, depth);
        col += pGlow * 0.4 * vec3(0.15, 0.50, 0.90);

        col *= 1.0 - 0.4 * length(uv * vec2(0.6, 1.0));
        col += dither(frag);

        gl_FragColor=vec4(col,1.0);
      }
  `;

  /* ---- 5. pipeline --------------------------------------------------------- */

  function startOcean() {
    const canvas = document.createElement('canvas');
    canvas.id = '__aurora-bg';
    const scrim = document.createElement('div');
    scrim.id = '__aurora-scrim';
    document.body.prepend(scrim);
    document.body.prepend(canvas);

    const gl = canvas.getContext('webgl', { antialias: false, premultipliedAlpha: false });
    if (!gl) { console.warn('[ocean] WebGL unavailable'); return; }

    if (!initSim(gl, canvas)) {
      console.warn('[ocean] float-texture simulation unavailable, using procedural water');
      initProcedural(gl, canvas);
    }
  }

  function compileProgram(gl, vsSrc, fsSrc) {
    function sh(type, src) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.warn('[ocean]', gl.getShaderInfoLog(s));
      return s;
    }
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.warn('[ocean]', gl.getProgramInfoLog(p)); return null; }
    return p;
  }

  function watchResize(canvas) {
    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.floor(window.innerWidth * dpr);
      const h = Math.floor(window.innerHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    }
    window.addEventListener('resize', resize);
    resize();
    return resize;
  }

  function initSim(gl, canvas) {
    if (!gl.getExtension('OES_texture_float')) return false;
    if (!gl.getExtension('OES_texture_float_linear')) return false;
    if (!gl.getExtension('OES_standard_derivatives')) return false;
    if (gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS) < 1) return false;

    const SIM = 256, CAUS = 512, GRID = 255;

    function makeTex(size, type) {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, type, null);
      return t;
    }
    function makeFbo(tex) {
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return f;
    }

    let src = { tex: makeTex(SIM, gl.FLOAT) };
    src.fbo = makeFbo(src.tex);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return false;
    }
    let dst = { tex: makeTex(SIM, gl.FLOAT) };
    dst.fbo = makeFbo(dst.tex);
    const caustTex = makeTex(CAUS, gl.UNSIGNED_BYTE);
    const caustFbo = makeFbo(caustTex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const progDrop = compileProgram(gl, VERT_PASS, FRAG_DROP);
    const progStep = compileProgram(gl, VERT_PASS, FRAG_STEP);
    const progCaust = compileProgram(gl, VERT_CAUSTICS, FRAG_CAUSTICS);
    const progMain = compileProgram(gl, VERT_MAIN, FRAG_SCENE);
    if (!progDrop || !progStep || !progCaust || !progMain) return false;

    // fullscreen triangle
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    // light-carrying refraction mesh (256x256 vertices = exactly Uint16 range)
    const verts = new Float32Array((GRID + 1) * (GRID + 1) * 2);
    let vi = 0;
    for (let y = 0; y <= GRID; y++) for (let x = 0; x <= GRID; x++) { verts[vi++] = x / GRID; verts[vi++] = y / GRID; }
    const idx = new Uint16Array(GRID * GRID * 6);
    let ii = 0;
    for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
      const a = y * (GRID + 1) + x, b = a + 1, c = a + GRID + 1, d = c + 1;
      idx[ii++] = a; idx[ii++] = c; idx[ii++] = b; idx[ii++] = b; idx[ii++] = c; idx[ii++] = d;
    }
    const meshBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, meshBuf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const meshIdx = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, meshIdx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);

    const U = (p, n) => gl.getUniformLocation(p, n);
    const A = (p, n) => gl.getAttribLocation(p, n);
    const uDrop = { water: U(progDrop, 'water'), center: U(progDrop, 'center'), radius: U(progDrop, 'radius'), strength: U(progDrop, 'strength'), ap: A(progDrop, 'p') };
    const uStep = { water: U(progStep, 'water'), delta: U(progStep, 'delta'), ap: A(progStep, 'p') };
    const uCaust = { water: U(progCaust, 'water'), delta: U(progCaust, 'delta'), av: A(progCaust, 'av') };
    const uMain = { res: U(progMain, 'iResolution'), time: U(progMain, 'iTime'), water: U(progMain, 'uWater'), caust: U(progMain, 'uCaustics'), ap: A(progMain, 'p') };

    function bindQuad(loc) {
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }
    function swap() { const tmp = src; src = dst; dst = tmp; }

    function waterPass(prog, locs, set) {
      gl.useProgram(prog);
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, SIM, SIM);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(locs.water, 0);
      if (set) set();
      bindQuad(locs.ap);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      swap();
    }

    function drop(x, y, radius, strength) {
      waterPass(progDrop, uDrop, () => {
        gl.uniform2f(uDrop.center, x, y);
        gl.uniform1f(uDrop.radius, radius);
        gl.uniform1f(uDrop.strength, strength);
      });
    }
    function step() {
      waterPass(progStep, uStep, () => gl.uniform2f(uStep.delta, 1 / SIM, 1 / SIM));
    }

    function renderCaustics() {
      gl.useProgram(progCaust);
      gl.bindFramebuffer(gl.FRAMEBUFFER, caustFbo);
      gl.viewport(0, 0, CAUS, CAUS);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(uCaust.water, 0);
      gl.uniform2f(uCaust.delta, 1 / SIM, 1 / SIM);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);      // folded light accumulates
      gl.bindBuffer(gl.ARRAY_BUFFER, meshBuf);
      gl.enableVertexAttribArray(uCaust.av);
      gl.vertexAttribPointer(uCaust.av, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, meshIdx);
      gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_SHORT, 0);
      gl.disable(gl.BLEND);
    }

    function renderMain(timeSec) {
      gl.useProgram(progMain);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(uMain.water, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, caustTex);
      gl.uniform1i(uMain.caust, 1);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform2f(uMain.res, canvas.width, canvas.height);
      gl.uniform1f(uMain.time, timeSec);
      bindQuad(uMain.ap);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    const resize = watchResize(canvas);

    // prime the surface with some initial chop
    for (let i = 0; i < 80; i++) {
      drop(Math.random(), Math.random(), 0.015 + Math.random() * 0.035, (Math.random() - 0.5) * 0.11);
      step(); step();
    }

    const start = performance.now();
    let nextDrop = 0;
    (function loop() {
      resize();
      const now = performance.now();
      // wind: small random disturbances keep the sea alive
      if (now >= nextDrop) {
        nextDrop = now + (60 + Math.random() * 120) / CONFIG.speed;
        drop(Math.random(), Math.random(), 0.015 + Math.random() * 0.035, (Math.random() - 0.5) * 0.09);
      }
      step(); step();
      renderCaustics();
      renderMain(((now - start) / 1000) * CONFIG.speed);
      requestAnimationFrame(loop);
    })();
    console.info('[ocean] full water simulation active');
    return true;
  }

  function initProcedural(gl, canvas) {
    const prog = compileProgram(gl, VERT_MAIN, FRAG_FALLBACK);
    if (!prog) return;
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const lp = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(lp);
    gl.vertexAttribPointer(lp, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(prog, 'iResolution');
    const uTime = gl.getUniformLocation(prog, 'iTime');
    const resize = watchResize(canvas);

    const start = performance.now();
    (function loop() {
      resize();
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, ((performance.now() - start) / 1000) * CONFIG.speed);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      requestAnimationFrame(loop);
    })();
  }

  boot();
})();
