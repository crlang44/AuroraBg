/* ============================================================================
 *  AURORA — live animated background for VS Code
 *  Loaded by the "Custom CSS and JS Loader" extension (be5invis.vscode-custom-css)
 *
 *  Tweak the CONFIG values below, then run
 *  "Reload Custom CSS and JS" from the Command Palette.
 * ========================================================================== */
(function () {
  const CONFIG = {
    opacity: 0.60, // how visible the aurora is behind your code   (0 – 1)
    dim:     0.45, // extra dark scrim for text readability         (0 – 1)
    speed:   1.00, // motion speed multiplier                       (0.2 – 3)
    minimap: 0.45, // minimap translucency so aurora shows through  (0 = invisible, 1 = solid)
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
    startAurora();
  })();

  /* ---- 1. make VS Code's own backgrounds transparent ---------------------- */
  function injectStyle() {
    // grab the theme's sticky-scroll colour now (falls back to editor bg, then a dark)
    const themeSticky =
      readVar('--vscode-editorStickyScroll-background') ||
      readVar('--vscode-editor-background') ||
      '#1e1e1e';
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
        --vscode-editorWidget-background: rgba(16,18,26,0.92) !important;
        --vscode-quickInput-background: rgba(16,18,26,0.94) !important;
        --vscode-menu-background: rgba(16,18,26,0.96) !important;
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
      #__aurora-scrim { z-index: 1; background: rgba(4, 5, 10, ${CONFIG.dim}); }
      /* the minimap is a painted canvas — fade it so the aurora bleeds through */
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
  function startAurora() {
    const canvas = document.createElement('canvas');
    canvas.id = '__aurora-bg';
    const scrim = document.createElement('div');
    scrim.id = '__aurora-scrim';
    document.body.prepend(scrim);
    document.body.prepend(canvas);

    const gl = canvas.getContext('webgl', { antialias: false, premultipliedAlpha: false });
    if (!gl) { console.warn('[aurora] WebGL unavailable'); return; }

    const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
    const FRAG = `
      precision highp float;
      uniform vec2 iResolution;
      uniform float iTime;
      uniform float u_idle;

      float hash21(vec2 p){ p=fract(p*vec2(123.34,345.45)); p+=dot(p,p+34.345); return fract(p.x*p.y); }
      float vnoise(vec2 p){
        vec2 i=floor(p),f=fract(p); vec2 u=f*f*(3.0-2.0*f);
        float a=hash21(i),b=hash21(i+vec2(1.,0.)),c=hash21(i+vec2(0.,1.)),d=hash21(i+vec2(1.,1.));
        return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);
      }
      float fbm(vec2 p){ float s=0.0,a=0.5; mat2 m=mat2(1.6,1.2,-1.2,1.6);
        for(int i=0;i<6;i++){ s+=a*vnoise(p); p=m*p; a*=0.5; } return s; }
      vec3 pal(float t,vec3 a,vec3 b,vec3 c,vec3 d){ return a+b*cos(6.28318*(c*t+d)); }
      float dither(vec2 f){ return (hash21(f+fract(iTime))-0.5)*0.004; }

      void main(){
        vec2 frag=gl_FragCoord.xy;
        vec2 uv=(frag-0.5*iResolution.xy)/iResolution.y;
        float t=iTime*0.06*(0.4+u_idle);
        vec2 q=uv;
        float warp=fbm(q*2.0+vec2(0.0,t*4.0));
        float warp2=fbm(q*3.0-vec2(t*2.0,0.0)+warp);
        float curtains=fbm(vec2(q.x*3.0+warp2*1.5, q.y*1.2-t*6.0));
        float aurora=pow(max(curtains,0.0),1.8);
        float h=smoothstep(-0.65,0.75,uv.y+warp*0.3);
        aurora*=mix(0.25,1.0,h);
        float hue=warp2*0.5+q.y*0.3+t*2.0;
        vec3 col=pal(hue,vec3(0.5),vec3(0.5),vec3(1.0),vec3(0.0,0.33,0.66));
        col=vec3(0.02,0.03,0.06)+col*aurora*1.35;
        float star=pow(hash21(floor(frag*0.5)),60.0);
        col+=star*0.4*vec3(0.8,0.9,1.0);
        col*=1.0-0.30*length(uv*vec2(0.7,1.0));
        col+=dither(frag);
        gl_FragColor=vec4(col,1.0);
      }
    `;

    function sh(type, src) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.warn('[aurora]', gl.getShaderInfoLog(s));
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
    const uIdle = gl.getUniformLocation(prog, 'u_idle');

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
      gl.uniform1f(uIdle, 0.2);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      requestAnimationFrame(loop);
    })();
  }
})();
