//
//  Панорамная развёртка и аксиальная проекция для подбора дуги.
//
//  Обе считаются на видеокарте по той же трёхмерной текстуре, что и срезы.
//  Копию объёма в памяти телефона держать нельзя: она стоит столько же,
//  сколько сам объём, и вкладку закрывают без предупреждения.
//
//  Проекция возвращается обратно в JS упакованной в два байта на точку — так
//  не нужны ни плавающие текстуры, ни расширения, которых на iPhone может не
//  оказаться. Точность при этом не теряется: значение DICOM 16-битное.
//

import { VERT, buildProgram } from './mpr.js?v=0.7.1';

// Проекция максимальной яркости вдоль оси, поперечной аксиальному виду.
// Берётся средняя треть объёма: там челюсть, а выше и ниже — свод черепа и
// шея, из-за которых дуга растягивалась бы на всё поле.
const MIP_FRAG = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler3D;

uniform usampler3D uVol;
uniform ivec3 uDims;
uniform int uAxisU;
uniform int uAxisV;
uniform int uAxisN;
uniform int uFrom;
uniform int uTo;
uniform float uSigned;

out vec4 frag;

void main() {
  ivec3 vox = ivec3(0);
  vox[uAxisU] = int(gl_FragCoord.x);
  vox[uAxisV] = int(gl_FragCoord.y);

  float best = -65536.0;
  for (int k = uFrom; k < uTo; k++) {
    vox[uAxisN] = k;
    float v = float(texelFetch(uVol, vox, 0).r);
    if (uSigned > 0.5 && v >= 32768.0) v -= 65536.0;
    best = max(best, v);
  }

  // Сдвигаем в неотрицательное и раскладываем по двум байтам: читать обратно
  // целые текстуры умеют не все, а RGBA8 умеют все.
  float shifted = clamp(best + 32768.0, 0.0, 65535.0);
  float high = floor(shifted / 256.0);
  float low = shifted - high * 256.0;
  frag = vec4(low / 255.0, high / 255.0, 0.0, 1.0);
}`;

// Развёртка вдоль дуги. Столбец — доля длины дуги, строка — высота.
// Поперёк дуги берётся максимум по слою заданной толщины: тонкий слой режет
// по кривой, толстый показывает весь зубной ряд разом.
const PANO_FRAG = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler3D;
precision highp sampler2D;

uniform usampler3D uVol;
uniform sampler2D uColumns;      // точка и нормаль дуги на каждый столбец, мм
uniform ivec3 uDims;
uniform int uAxisU;
uniform int uAxisV;
uniform int uAxisN;
uniform float uFlipU;
uniform float uFlipV;
uniform float uFlipN;
uniform vec3 uVoxel;             // размер точки вдоль u, v и высоты, мм
uniform float uHeightMM;
uniform float uPixelMM;
uniform float uSlabMM;
uniform float uSlabStepMM;
uniform float uHeightPx;
uniform float uSigned;
uniform float uSlope;
uniform float uIntercept;
uniform float uLow;
uniform float uSpan;
uniform float uInvert;

out vec4 frag;

float at(ivec3 c) {
  c = clamp(c, ivec3(0), uDims - ivec3(1));
  float v = float(texelFetch(uVol, c, 0).r);
  if (uSigned > 0.5 && v >= 32768.0) v -= 65536.0;
  return v * uSlope + uIntercept;
}

float atVoxel(vec3 idx) {
  vec3 f = floor(idx);
  vec3 t = idx - f;
  ivec3 c = ivec3(f);
  return mix(
    mix(mix(at(c + ivec3(0, 0, 0)), at(c + ivec3(1, 0, 0)), t.x),
        mix(at(c + ivec3(0, 1, 0)), at(c + ivec3(1, 1, 0)), t.x), t.y),
    mix(mix(at(c + ivec3(0, 0, 1)), at(c + ivec3(1, 0, 1)), t.x),
        mix(at(c + ivec3(0, 1, 1)), at(c + ivec3(1, 1, 1)), t.x), t.y), t.z);
}

// Номер точки объёма по координате в миллиметрах вида. Развороты сторон
// учитываются здесь: дуга живёт в координатах аксиального вида, а объём с
// аппарата бывает записан как угодно.
float indexOf(float mm, float voxel, int axis, float flip) {
  float i = mm / voxel;
  return flip > 0.5 ? float(uDims[axis] - 1) - i : i;
}

void main() {
  int column = int(gl_FragCoord.x);
  vec4 c = texelFetch(uColumns, ivec2(column, 0), 0);
  vec2 p = c.xy;
  vec2 n = c.zw;

  // Голова сверху: строка 0 — верх объёма.
  float row = uHeightPx - gl_FragCoord.y;
  float zMM = (row + 0.5) * uPixelMM;
  if (zMM > uHeightMM) { frag = vec4(0.0, 0.0, 0.0, 1.0); return; }

  // Шаг поперёк дуги — размер точки объёма, а не размер точки картинки.
  // Связав их, получаем 250 выборок на пиксель при слое 25 мм: развёртка
  // считалась две секунды, и вся подробность уходила в никуда.
  int steps = uSlabMM > uSlabStepMM ? int(uSlabMM / uSlabStepMM) : 1;
  steps = min(steps, 192);
  float halfSlab = float(steps - 1) * uSlabStepMM * 0.5;

  // Толстый слой — это максимум по многим выборкам, он сам по себе гладкий:
  // сглаживать каждую выборку значило бы платить восьмикратно за незаметное.
  bool fine = steps <= 4;

  float best = -1e9;
  for (int t = 0; t < 192; t++) {
    if (t >= steps) break;
    float off = steps == 1 ? 0.0 : (float(t) * uSlabStepMM - halfSlab);
    vec2 q = p + n * off;
    vec3 idx = vec3(0.0);
    idx[uAxisU] = indexOf(q.x, uVoxel.x, uAxisU, uFlipU);
    idx[uAxisV] = indexOf(q.y, uVoxel.y, uAxisV, uFlipV);
    idx[uAxisN] = indexOf(zMM, uVoxel.z, uAxisN, uFlipN);
    best = max(best, fine ? atVoxel(idx) : at(ivec3(floor(idx + 0.5))));
  }

  float g = clamp((best - uLow) / uSpan, 0.0, 1.0);
  if (uInvert > 0.5) g = 1.0 - g;
  frag = vec4(g, g, g, 1.0);
}`;

/** Проходы панорамы поверх уже залитого объёма. */
export class PanoRenderer {
  constructor(gl) {
    this.gl = gl;
    this.mip = buildProgram(gl, VERT, MIP_FRAG);
    this.pano = buildProgram(gl, VERT, PANO_FRAG);
    this.broken = !this.mip || !this.pano;
    this.columnsTexture = null;
  }

  /**
   * Аксиальная проекция максимальной яркости по средней трети объёма.
   * Возвращает исходные значения DICOM в порядке номеров точек объёма —
   * развороты сторон применяет тот, кто вызывает.
   */
  axialMIP(texture, dims, axes, signed) {
    const gl = this.gl;
    const w = dims[axes.u];
    const h = dims[axes.v];
    const depth = dims[axes.n];

    const target = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, target);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(target);
      return null;
    }

    gl.viewport(0, 0, w, h);
    gl.useProgram(this.mip);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, texture);
    gl.uniform1i(gl.getUniformLocation(this.mip, 'uVol'), 0);
    gl.uniform3i(gl.getUniformLocation(this.mip, 'uDims'), dims[0], dims[1], dims[2]);
    gl.uniform1i(gl.getUniformLocation(this.mip, 'uAxisU'), axes.u);
    gl.uniform1i(gl.getUniformLocation(this.mip, 'uAxisV'), axes.v);
    gl.uniform1i(gl.getUniformLocation(this.mip, 'uAxisN'), axes.n);
    gl.uniform1i(gl.getUniformLocation(this.mip, 'uFrom'), Math.floor(depth * 0.3));
    gl.uniform1i(gl.getUniformLocation(this.mip, 'uTo'), Math.ceil(depth * 0.7));
    gl.uniform1f(gl.getUniformLocation(this.mip, 'uSigned'), signed ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const bytes = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(target);

    const data = new Int32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      data[i] = (bytes[i * 4] | (bytes[i * 4 + 1] << 8)) - 32768;
    }
    return { data, width: w, height: h };
  }

  /** Колонки дуги кладём в текстуру: их тысячи, в uniform такое не влезет. */
  setColumns(points, normals) {
    const gl = this.gl;
    const n = points.length;
    const data = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      data[i * 4] = points[i][0];
      data[i * 4 + 1] = points[i][1];
      data[i * 4 + 2] = normals[i][0];
      data[i * 4 + 3] = normals[i][1];
    }
    if (this.columnsTexture) gl.deleteTexture(this.columnsTexture);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, n, 1, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.columnsTexture = tex;
    this.columnCount = n;
    return gl.getError() === gl.NO_ERROR;
  }

  /** Рисует развёртку в текущий холст. */
  render(canvas, texture, dims, geom, look) {
    const gl = this.gl;
    if (this.broken || !this.columnsTexture) return null;
    const width = this.columnCount;
    const height = Math.max(1, Math.round(geom.heightMM / geom.pixelMM));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.pano);
    const u = (name) => gl.getUniformLocation(this.pano, name);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, texture);
    gl.uniform1i(u('uVol'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.columnsTexture);
    gl.uniform1i(u('uColumns'), 1);
    gl.uniform3i(u('uDims'), dims[0], dims[1], dims[2]);
    gl.uniform1i(u('uAxisU'), geom.axes.u);
    gl.uniform1i(u('uAxisV'), geom.axes.v);
    gl.uniform1i(u('uAxisN'), geom.axes.n);
    gl.uniform1f(u('uFlipU'), geom.flip.u ? 1 : 0);
    gl.uniform1f(u('uFlipV'), geom.flip.v ? 1 : 0);
    gl.uniform1f(u('uFlipN'), geom.flip.n ? 1 : 0);
    gl.uniform3f(u('uVoxel'), geom.voxel.u, geom.voxel.v, geom.voxel.n);
    gl.uniform1f(u('uHeightMM'), geom.heightMM);
    gl.uniform1f(u('uPixelMM'), geom.pixelMM);
    gl.uniform1f(u('uSlabMM'), geom.slabMM);
    gl.uniform1f(u('uSlabStepMM'), geom.slabStepMM);
    gl.uniform1f(u('uHeightPx'), height);
    gl.uniform1f(u('uSigned'), look.signed ? 1 : 0);
    gl.uniform1f(u('uSlope'), look.slope);
    gl.uniform1f(u('uIntercept'), look.intercept);
    gl.uniform1f(u('uLow'), look.center - look.width / 2);
    gl.uniform1f(u('uSpan'), Math.max(1e-6, look.width));
    gl.uniform1f(u('uInvert'), look.invert ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
    return { width, height };
  }

  dispose() {
    if (this.columnsTexture) {
      this.gl.deleteTexture(this.columnsTexture);
      this.columnsTexture = null;
    }
  }
}
