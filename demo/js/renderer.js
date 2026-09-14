// WebGL2-рендер: MPR-срез (fs_mpr) и 3D-raymarching (fs_volume) — перенос
// шейдеров приложения из Shaders.metal. Один canvas на весь вьювер, каждый пейн
// рисуется в свой viewport; 3D кешируется в offscreen-текстуре.

const VS = `#version 300 es
in vec2 aPos;
out vec2 vPos;
void main() {
  vPos = aPos;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FS_MPR = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler3D uVol;
uniform vec3 uCenter;
uniform vec3 uU;
uniform vec3 uV;
uniform vec3 uN;
uniform vec3 uSize;
uniform float uThick;
uniform int uSamples;
uniform float uLo;
uniform float uInvW;
in vec2 vPos;
out vec4 outColor;

bool inside(vec3 t) {
  return all(greaterThanEqual(t, vec3(0.0))) && all(lessThanEqual(t, vec3(1.0)));
}

void main() {
  // vPos.y = +1 — верх пейна; экранное «вниз» — это +v.
  vec3 p = uCenter + uU * vPos.x - uV * vPos.y;
  float acc = 0.0;
  bool hit = false;
  if (uSamples <= 1) {
    vec3 t = p / uSize;
    if (inside(t)) {
      acc = textureLod(uVol, t, 0.0).r;
      hit = true;
    }
  } else {
    float stepMM = uThick / float(uSamples - 1);
    // Джиттер ломает регулярные полосы толстого MIP (как в приложении).
    float jitter = (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) * stepMM;
    for (int i = 0; i < uSamples; i++) {
      vec3 t = (p + uN * (-0.5 * uThick + float(i) * stepMM + jitter)) / uSize;
      if (!inside(t)) continue;
      acc = max(acc, textureLod(uVol, t, 0.0).r);
      hit = true;
    }
  }
  if (!hit) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  float n = clamp((acc - uLo) * uInvW, 0.0, 1.0);
  outColor = vec4(vec3(n), 1.0);
}`;

const FS_VOLUME = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler3D uVol;
uniform sampler2D uLut;
uniform vec3 uCamPos;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uFwd;
uniform vec2 uPan;
uniform vec3 uSize;
uniform vec3 uGradStep;
uniform float uStep;
uniform float uStepCorr;
uniform int uMaxSteps;
uniform float uOpacity;
uniform float uHuScale;
uniform float uHuOffset;
uniform float uTfMin;
uniform float uTfInvRange;
uniform float uAmbient;
uniform float uLightAz;
uniform int uClip;
uniform vec3 uClipO;
uniform vec3 uClipN;
uniform int uXray;
uniform float uXrayLo;
uniform float uXrayInvW;
in vec2 vPos;
out vec4 outColor;

float hashJitter(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

float vol(vec3 tex) {
  return textureLod(uVol, tex, 0.0).r;
}

float tfAlpha(float s) {
  float hu = s * uHuScale + uHuOffset;
  return textureLod(uLut, vec2(clamp((hu - uTfMin) * uTfInvRange, 0.0, 1.0), 0.5), 0.0).a;
}

void main() {
  // Студийный градиент-фон + виньетка (кинематографичный режим приложения).
  float yTop = vPos.y * 0.5 + 0.5;
  vec3 bg = mix(vec3(0.015, 0.018, 0.030), vec3(0.10, 0.13, 0.19), smoothstep(0.0, 1.0, yTop));
  bg *= smoothstep(0.95, 0.20, length(vPos * 0.5));

  vec2 ndc = vPos + uPan;
  vec3 ro = uCamPos + uRight * ndc.x + uUp * ndc.y;
  vec3 rd = uFwd;

  vec3 safeDir = rd + vec3(1e-7);
  vec3 invD = 1.0 / safeDir;
  vec3 t0 = -ro * invD;
  vec3 t1 = (uSize - ro) * invD;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  float tNear = max(max(max(tmin.x, tmin.y), tmin.z), 0.0);
  float tFar = min(min(tmax.x, tmax.y), tmax.z);
  if (tFar <= tNear) {
    outColor = vec4(bg, 1.0);
    return;
  }

  // Плоскость отсечения: остаётся полупространство dot(p - O, N) >= 0.
  if (uClip != 0) {
    float denom = dot(rd, uClipN);
    float s0 = dot(ro - uClipO, uClipN);
    if (abs(denom) > 1e-6) {
      float tp = -s0 / denom;
      if (denom > 0.0) tNear = max(tNear, tp);
      else tFar = min(tFar, tp);
    } else if (s0 < 0.0) {
      outColor = vec4(bg, 1.0);
      return;
    }
    if (tFar <= tNear) {
      outColor = vec4(bg, 1.0);
      return;
    }
  }

  float jitter = hashJitter(gl_FragCoord.xy);
  vec3 toCam = -rd;

  if (uXray != 0) {
    // «Рентген»: взвешенная по плотности проекция + примесь MIP.
    float sumWHU = 0.0, sumW = 0.0, maxHU = -1000.0, cnt = 0.0;
    float t = tNear + jitter * uStep;
    for (int i = 0; i < uMaxSteps; i++) {
      if (t > tFar) break;
      float hu = vol((ro + rd * t) / uSize) * uHuScale + uHuOffset;
      if (hu > -500.0) {
        float w = pow(max(0.0, (hu + 1000.0) / 1000.0), 3.0);
        sumWHU += hu * w;
        sumW += w;
        maxHU = max(maxHU, hu);
        cnt += 1.0;
      }
      t += uStep;
    }
    if (cnt < 1.0) {
      outColor = vec4(bg, 1.0);
      return;
    }
    float wmean = sumW > 1e-4 ? sumWHU / sumW : -1000.0;
    float projHU = mix(wmean, maxHU, 0.8);
    float b = pow(clamp((projHU - uXrayLo) * uXrayInvW, 0.0, 1.0), 0.65);
    outColor = vec4(mix(bg, vec3(0.95), b), 1.0);
    return;
  }

  vec3 accColor = vec3(0.0);
  float accAlpha = 0.0;
  float t = tNear + jitter * uStep;
  vec3 rightN = normalize(uRight);
  vec3 upN = normalize(uUp);
  vec3 keyDir = normalize(toCam + (rightN * cos(uLightAz) + upN * sin(uLightAz)) * 0.694);
  vec3 halfKey = normalize(keyDir + toCam);

  for (int i = 0; i < uMaxSteps; i++) {
    if (accAlpha >= 0.98 || t > tFar) break;
    vec3 pMM = ro + rd * t;
    vec3 tex = pMM / uSize;
    float s = vol(tex);
    float hu = s * uHuScale + uHuOffset;
    vec4 tfv = textureLod(uLut, vec2(clamp((hu - uTfMin) * uTfInvRange, 0.0, 1.0), 0.5), 0.0);
    float alpha = clamp(tfv.a * uOpacity, 0.0, 1.0);
    if (alpha < 0.002) {
      t += uStep;
      continue;
    }
    vec3 baseColor = tfv.rgb;

    vec3 g = vec3(
      vol(tex + vec3(uGradStep.x, 0.0, 0.0)) - vol(tex - vec3(uGradStep.x, 0.0, 0.0)),
      vol(tex + vec3(0.0, uGradStep.y, 0.0)) - vol(tex - vec3(0.0, uGradStep.y, 0.0)),
      vol(tex + vec3(0.0, 0.0, uGradStep.z)) - vol(tex - vec3(0.0, 0.0, uGradStep.z))
    ) * uHuScale;
    float glen = length(g);
    if (glen > 1e-4) {
      vec3 normal = -g / glen;
      // Мягкая тень: короткий марш к ключевому свету по непрозрачности TF.
      float occ = 0.0;
      vec3 sp = pMM + keyDir * 1.5;
      for (int k = 0; k < 8; k++) {
        vec3 sv = sp / uSize;
        if (any(lessThan(sv, vec3(0.0))) || any(greaterThan(sv, vec3(1.0)))) break;
        occ += tfAlpha(vol(sv));
        if (occ > 3.0) break;
        sp += keyDir * 3.0;
      }
      float shadow = 0.30 + 0.70 * exp(-occ * 1.1);
      float diffuse = max(dot(normal, keyDir), 0.0) * 0.75 + max(dot(normal, toCam), 0.0) * 0.35;
      float spec = pow(max(dot(normal, halfKey), 0.0), 32.0) * 0.25 * shadow;
      float light = uAmbient + (1.0 - uAmbient) * diffuse * shadow;
      baseColor = baseColor * light + vec3(spec);
      alpha = clamp(alpha * (1.0 + 0.6 * min(glen * 4.0, 1.0)), 0.0, 1.0);
    } else {
      baseColor *= uAmbient;
    }

    // Пресеты приложения подобраны под шаг 0.5 мм — пересчитываем непрозрачность под наш шаг.
    alpha = 1.0 - pow(1.0 - alpha, uStepCorr);
    accColor += (1.0 - accAlpha) * alpha * baseColor;
    accAlpha += (1.0 - accAlpha) * alpha;
    t += uStep;
  }
  accColor += (1.0 - accAlpha) * bg;
  outColor = vec4(accColor, 1.0);
}`;

const FS_BLIT = `#version 300 es
precision mediump float;
uniform sampler2D uTex;
in vec2 vPos;
out vec4 outColor;
void main() {
  outColor = texture(uTex, vPos * 0.5 + 0.5);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader: ${log}`);
  }
  return sh;
}

function program(gl, fsSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`link: ${gl.getProgramInfoLog(p)}`);
  }
  const uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    uniforms[info.name] = gl.getUniformLocation(p, info.name);
  }
  return { p, u: uniforms };
}

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('no-webgl2');
    this.gl = gl;
    this.canvas = canvas;
    this.maxTexture3D = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);

    this.mpr = program(gl, FS_MPR);
    this.volume = program(gl, FS_VOLUME);
    this.blit = program(gl, FS_BLIT);

    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.volTex = null;
    this.lutTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.fbo = null;
    this.fboTex = null;
    this.fboW = 0;
    this.fboH = 0;
  }

  /** Заменяет объём. Старую текстуру удаляем сразу — на телефоне памяти впритык. */
  setVolume(bytes, dims) {
    const gl = this.gl;
    const [w, h, d] = dims;
    if (this.volTex) gl.deleteTexture(this.volTex);
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texStorage3D(gl.TEXTURE_3D, 1, gl.R8, w, h, d);
    // Послойная загрузка: один большой texSubImage3D на слабых GPU подвешивает вкладку.
    const slice = w * h;
    const chunk = 16;
    for (let z = 0; z < d; z += chunk) {
      const n = Math.min(chunk, d - z);
      gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, z, w, h, n, gl.RED, gl.UNSIGNED_BYTE,
        bytes.subarray(z * slice, (z + n) * slice));
    }
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    this.volTex = tex;
  }

  setLUT(lut) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, lut.length / 4, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut);
  }

  resize(width, height) {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  clear() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.043, 0.055, 0.078, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** rect — в пикселях canvas, начало координат сверху-слева. */
  _viewport(rect) {
    const gl = this.gl;
    const y = this.canvas.height - rect.y - rect.h;
    gl.viewport(rect.x, y, rect.w, rect.h);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(rect.x, y, rect.w, rect.h);
  }

  drawMPR(rect, s) {
    if (!this.volTex || rect.w <= 0 || rect.h <= 0) return;
    const gl = this.gl;
    const { p, u } = this.mpr;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._viewport(rect);
    gl.useProgram(p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.volTex);
    gl.uniform1i(u.uVol, 0);
    gl.uniform3fv(u.uCenter, s.center);
    gl.uniform3fv(u.uU, s.u);
    gl.uniform3fv(u.uV, s.v);
    gl.uniform3fv(u.uN, s.n);
    gl.uniform3fv(u.uSize, s.size);
    gl.uniform1f(u.uThick, s.thick);
    gl.uniform1i(u.uSamples, s.samples);
    gl.uniform1f(u.uLo, s.lo);
    gl.uniform1f(u.uInvW, s.invW);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  _ensureFBO(w, h) {
    const gl = this.gl;
    if (this.fbo && this.fboW === w && this.fboH === h) return;
    if (!this.fbo) {
      this.fbo = gl.createFramebuffer();
      this.fboTex = gl.createTexture();
    }
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
    this.fboW = w;
    this.fboH = h;
  }

  /** Рендер 3D в offscreen-текстуру заданного размера (меньше пейна при вращении). */
  renderVolume(w, h, s) {
    if (!this.volTex || w <= 0 || h <= 0) return;
    const gl = this.gl;
    this._ensureFBO(w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, w, h);
    const { p, u } = this.volume;
    gl.useProgram(p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.volTex);
    gl.uniform1i(u.uVol, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.uniform1i(u.uLut, 1);
    gl.uniform3fv(u.uCamPos, s.camPos);
    gl.uniform3fv(u.uRight, s.right);
    gl.uniform3fv(u.uUp, s.up);
    gl.uniform3fv(u.uFwd, s.fwd);
    gl.uniform2fv(u.uPan, s.pan);
    gl.uniform3fv(u.uSize, s.size);
    gl.uniform3fv(u.uGradStep, s.gradStep);
    gl.uniform1f(u.uStep, s.step);
    gl.uniform1f(u.uStepCorr, s.step / 0.5);
    gl.uniform1i(u.uMaxSteps, s.maxSteps);
    gl.uniform1f(u.uOpacity, s.opacity);
    gl.uniform1f(u.uHuScale, s.huScale);
    gl.uniform1f(u.uHuOffset, s.huOffset);
    gl.uniform1f(u.uTfMin, s.tfMin);
    gl.uniform1f(u.uTfInvRange, s.tfInvRange);
    gl.uniform1f(u.uAmbient, s.ambient);
    gl.uniform1f(u.uLightAz, s.lightAz);
    gl.uniform1i(u.uClip, s.clip ? 1 : 0);
    gl.uniform3fv(u.uClipO, s.clipO);
    gl.uniform3fv(u.uClipN, s.clipN);
    gl.uniform1i(u.uXray, s.xray ? 1 : 0);
    gl.uniform1f(u.uXrayLo, s.xrayLo);
    gl.uniform1f(u.uXrayInvW, s.xrayInvW);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.volumeReady = true;
  }

  blitVolume(rect) {
    if (!this.fbo || !this.volumeReady || rect.w <= 0 || rect.h <= 0) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._viewport(rect);
    const { p, u } = this.blit;
    gl.useProgram(p);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    gl.uniform1i(u.uTex, 2);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
