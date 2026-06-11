/* ============================================================================
 *  OCEAN — live animated background for VS Code & Antigravity
 *  Loaded by the "Custom CSS and JS Loader" extension
 *
 *  Tweak the CONFIG values below, then run
 *  "Reload Custom CSS and JS" from the Command Palette.
 * ========================================================================== */
(function () {
  const CONFIG = {
    opacity: 0.60, // how visible the ocean is behind your code   (0 – 1)
    dim:     0.50, // extra dark scrim for text readability         (0 – 1)
    speed:   1.00, // motion speed multiplier                       (0.2 – 3)
    minimap: 0.45, // minimap translucency so ocean shows through  (0 = invisible, 1 = solid)
    sticky:  0.92, // sticky-scroll backing opacity (uses the THEME's color)
  };

  if (document.getElementById('__aurora-bg')) return; // already injected

  /* read a CSS custom property's *current* (theme) value, before we blank it */
  function readVar(name) {
    const el = document.querySelector('.monaco-workbench') || document.body;
    return getComputedStyle(el).getPropertyValue(name).trim();
  }

  /* wait until the workbench exists so the theme variables are populated */
  (function boot() {
    if (!document.querySelector('.monaco-workbench')) {
      return requestAnimationFrame(boot);
    }
    injectStyle();
    startOcean();
  })();

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

  /* ---- 2. the canvas + shader -------------------------------------------- */
  function startOcean() {
    const canvas = document.createElement('canvas');
    canvas.id = '__aurora-bg';
    const scrim = document.createElement('div');
    scrim.id = '__aurora-scrim';
    document.body.prepend(scrim);
    document.body.prepend(canvas);

    const gl = canvas.getContext('webgl', { antialias: false, premultipliedAlpha: false });
    if (!gl) { console.warn('[ocean] WebGL unavailable'); return; }

    const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
    const FRAG = `
      precision highp float;
      uniform vec2 iResolution;
      uniform float iTime;

      float hash21(vec2 p){ p=fract(p*vec2(123.34,345.45)); p+=dot(p,p+34.345); return fract(p.x*p.y); }
      float vnoise(vec2 p){
        vec2 i=floor(p),f=fract(p); vec2 u=f*f*(3.0-2.0*f);
        float a=hash21(i),b=hash21(i+vec2(1.,0.)),c=hash21(i+vec2(0.,1.)),d=hash21(i+vec2(1.,1.));
        return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);
      }
      float fbm(vec2 p){ float s=0.0,a=0.5; mat2 m=mat2(1.6,1.2,-1.2,1.6);
        for(int i=0;i<6;i++){ s+=a*vnoise(p); p=m*p; a*=0.5; } return s; }
      float dither(vec2 f){ return (hash21(f+fract(iTime))-0.5)*0.004; }

      void main(){
        vec2 frag=gl_FragCoord.xy;
        vec2 uv=(frag-0.5*iResolution.xy)/iResolution.y;
        float t=iTime*0.12;

        // 1. Fluid Domain Warping
        vec2 q = vec2(0.0);
        q.x = fbm(uv * 1.5 + vec2(0.0, t * 0.4));
        q.y = fbm(uv * 1.5 - vec2(t * 0.3, 0.0));

        vec2 r = vec2(0.0);
        r.x = fbm(uv * 2.5 + q * 2.0 + vec2(t * 0.5, -t * 0.4));
        r.y = fbm(uv * 2.5 - q * 2.0 - vec2(-t * 0.3, t * 0.6));

        float f = fbm(uv * 2.0 + r * 2.0 + vec2(0.0, t * 0.3));

        // 2. Color Mapping
        vec3 colDeep = vec3(0.01, 0.03, 0.12);  // deep navy
        vec3 colMid  = vec3(0.02, 0.20, 0.40);  // ocean teal
        vec3 colHigh = vec3(0.15, 0.65, 0.85);  // bright cyan water

        // Base swirl
        vec3 col = mix(colDeep, colMid, f * 1.2);

        // Highlight crests
        float crest = smoothstep(0.4, 0.8, f);
        col = mix(col, colHigh, pow(crest, 2.5) * 0.8);

        // Subsurface scattering (light from above)
        float depth = smoothstep(-0.8, 0.8, uv.y + f * 0.3);
        col += vec3(0.05, 0.15, 0.25) * depth * (1.0 - f * 0.5);

        // 3. Drifting Bioluminescent Plankton
        vec2 pGrid = uv * 8.0;
        pGrid.y -= iTime * 0.06;
        pGrid.x += sin(pGrid.y * 2.0 + iTime * 0.1) * 0.2;
        vec2 ip = floor(pGrid);
        vec2 fp = fract(pGrid);
        vec2 pOffset = vec2(hash21(ip), hash21(ip + 13.37));
        float pDist = length(fp - pOffset);
        float pBlink = sin(iTime * 0.6 + pOffset.x * 6.28) * 0.5 + 0.5;
        float pGlow = smoothstep(0.04 + 0.03 * pOffset.y, 0.0, pDist) * pBlink;
        pGlow *= smoothstep(-1.0, -0.6, uv.y) * smoothstep(1.0, 0.6, uv.y);
        col += pGlow * 0.3 * vec3(0.3, 0.8, 0.9);

        // Vignette
        col *= 1.0 - 0.4 * length(uv * vec2(0.6, 1.0));

        // Dither
        col += dither(frag);

        gl_FragColor=vec4(col,1.0);
      }
    `;

    function sh(type, src) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.warn('[ocean]', gl.getShaderInfoLog(s));
      return s;
    }
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const lp = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(lp);
    gl.vertexAttribPointer(lp, 2, gl.FLOAT, false, 0, 0);

    const uRes  = gl.getUniformLocation(prog, 'iResolution');
    const uTime = gl.getUniformLocation(prog, 'iTime');

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.floor(window.innerWidth * dpr);
      const h = Math.floor(window.innerHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    }
    window.addEventListener('resize', resize);
    resize();

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
})();
