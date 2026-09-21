//
//  Объёмный вид: луч сквозь объём.
//
//  Считается по той же трёхмерной текстуре, что и срезы, — второй копии нет.
//  Луч идёт спереди назад и останавливается, как только дальше уже ничего не
//  видно: на телефоне это разница между «крутится» и «не крутится».
//
//  Шаг луча грубее, пока врач вращает, и мельче, когда отпустил. Разглядывают
//  неподвижную картинку, а во время вращения важна плавность.
//
//  Пространство здесь анатомическое, а не осей файла: вверх — это макушка
//  пациента, даже если объём записан сагиттально.
//

import { VERT, buildProgram } from './mpr.js?v=0.6.0';

const FRAG = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler3D;

uniform usampler3D uVol;
uniform ivec3 uDims;
uniform int uAxisU;
uniform int uAxisV;
uniform int uAxisN;
uniform vec3 uFlip;
uniform vec3 uSizeMM;        // размеры объёма вдоль u, v и высоты
uniform vec3 uVoxel;
uniform vec2 uViewport;
uniform mat3 uRotation;      // из экранных осей в анатомические
uniform float uZoom;
uniform vec2 uPanMM;
uniform float uStepMM;
uniform float uGradMM;
uniform float uSigned;
uniform float uSlope;
uniform float uIntercept;
uniform float uThreshold;    // с какой плотности начинается кость
uniform float uWidth;        // на сколько HU набирается полная непрозрачность

out vec4 frag;

float atVoxel(ivec3 c) {
  c = clamp(c, ivec3(0), uDims - ivec3(1));
  float v = float(texelFetch(uVol, c, 0).r);
  if (uSigned > 0.5 && v >= 32768.0) v -= 65536.0;
  return v * uSlope + uIntercept;
}

float atMM(vec3 mm) {
  vec3 i = mm / uVoxel;
  vec3 idx = vec3(0.0);
  idx[uAxisU] = uFlip.x > 0.5 ? float(uDims[uAxisU] - 1) - i.x : i.x;
  idx[uAxisV] = uFlip.y > 0.5 ? float(uDims[uAxisV] - 1) - i.y : i.y;
  idx[uAxisN] = uFlip.z > 0.5 ? float(uDims[uAxisN] - 1) - i.z : i.z;

  // Трилинейно. По ближайшей точке поверхность идёт ступеньками, и на
  // объёмной картинке они читаются как продольные полосы по всему черепу.
  vec3 f = floor(idx);
  vec3 t = idx - f;
  ivec3 c = ivec3(f);
  return mix(
    mix(mix(atVoxel(c + ivec3(0, 0, 0)), atVoxel(c + ivec3(1, 0, 0)), t.x),
        mix(atVoxel(c + ivec3(0, 1, 0)), atVoxel(c + ivec3(1, 1, 0)), t.x), t.y),
    mix(mix(atVoxel(c + ivec3(0, 0, 1)), atVoxel(c + ivec3(1, 0, 1)), t.x),
        mix(atVoxel(c + ivec3(0, 1, 1)), atVoxel(c + ivec3(1, 1, 1)), t.x), t.y), t.z);
}

/**
 * Упорядоченный сдвиг по точке экрана, матрица Байера 4×4. Значения от 0 до 1
 * разложены так, что соседние точки берут заметно разные глубины, но вся
 * картина повторяется каждые четыре точки — это рябит куда меньше случайного.
 */
float dither(vec2 p) {
  int x = int(mod(p.x, 4.0));
  int y = int(mod(p.y, 4.0));
  int i = y * 4 + x;
  int m =
    i == 0 ? 0 : i == 1 ? 8 : i == 2 ? 2 : i == 3 ? 10 :
    i == 4 ? 12 : i == 5 ? 4 : i == 6 ? 14 : i == 7 ? 6 :
    i == 8 ? 3 : i == 9 ? 11 : i == 10 ? 1 : i == 11 ? 9 :
    i == 12 ? 15 : i == 13 ? 7 : i == 14 ? 13 : 5;
  return (float(m) + 0.5) / 16.0;
}

/** Непрозрачность по плотности: мягкое ткани — прозрачно, кость — плотно. */
float opacityOf(float hu) {
  return smoothstep(uThreshold, uThreshold + max(1.0, uWidth), hu);
}

void main() {
  // Экранная точка → луч. Проекция параллельная: у КТ нет перспективы, и
  // размеры на картинке не должны зависеть от того, что ближе к глазу.
  vec2 ndc = (gl_FragCoord.xy / uViewport) * 2.0 - 1.0;
  float aspect = uViewport.x / uViewport.y;
  // На узкой панели видимая ширина меньше высоты, и объём обрезался по бокам.
  // Вписываем по той стороне, которой не хватает.
  float fit = min(1.0, aspect);
  float halfSize = 0.5 * max(max(uSizeMM.x, uSizeMM.y), uSizeMM.z) / fit / uZoom;
  vec3 center = uSizeMM * 0.5;

  vec3 right = uRotation * vec3(1.0, 0.0, 0.0);
  vec3 up = uRotation * vec3(0.0, 1.0, 0.0);
  vec3 dir = uRotation * vec3(0.0, 0.0, 1.0);

  vec3 origin = center
    + right * (ndc.x * halfSize * aspect - uPanMM.x)
    + up * (ndc.y * halfSize - uPanMM.y)
    - dir * halfSize * 2.0;

  // Пересечение с коробкой объёма: марш начинается у самой кости, а не от
  // экрана, иначе половина шагов уходит в пустоту.
  vec3 invDir = 1.0 / dir;
  vec3 t0 = (vec3(0.0) - origin) * invDir;
  vec3 t1 = (uSizeMM - origin) * invDir;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  float enter = max(max(tmin.x, tmin.y), tmin.z);
  float exit = min(min(tmax.x, tmax.y), tmax.z);
  if (exit <= enter) { frag = vec4(0.0, 0.0, 0.0, 1.0); return; }
  enter = max(enter, 0.0);

  // Сдвигаем начало луча на случайную долю шага. Без этого все лучи берут
  // пробы на одних и тех же глубинах, и объём покрывается ровными полосами —
  // они особенно заметны при вращении, где шаг грубее. Сдвиг превращает
  // полосу в незаметную рябь.
  enter += dither(gl_FragCoord.xy) * uStepMM * 0.5;

  vec3 colour = vec3(0.0);
  float alpha = 0.0;
  for (int s = 0; s < 2048; s++) {
    float t = enter + float(s) * uStepMM;
    if (t > exit || alpha > 0.98) break;
    vec3 pos = origin + dir * t;
    float hu = atMM(pos);
    float aRef = opacityOf(hu);
    // Пересчёт на настоящий шаг: столько же вещества, пройденного быстрее,
    // должно дать ту же непрозрачность.
    float a = 1.0 - pow(1.0 - aRef * 0.5, uStepMM / 0.5);
    if (a > 0.003) {
      // Нормаль по разнице плотностей вокруг точки: даёт объём, без неё
      // картинка выглядит плоским туманом. Расстояние взятия — размер точки
      // объёма, а НЕ шаг луча: при вращении шаг грубее, и нормаль, считанная
      // по нему, прыгала от точки к точке — это и была рябь.
      float d = uGradMM;
      vec3 grad = vec3(
        atMM(pos + vec3(d, 0.0, 0.0)) - atMM(pos - vec3(d, 0.0, 0.0)),
        atMM(pos + vec3(0.0, d, 0.0)) - atMM(pos - vec3(0.0, d, 0.0)),
        atMM(pos + vec3(0.0, 0.0, d)) - atMM(pos - vec3(0.0, 0.0, d)));
      float glen = length(grad);
      vec3 normal = glen > 1e-4 ? -grad / glen : -dir;
      float lambert = max(0.10, dot(normal, -dir));
      // Кость тёплая, как на снимке в кабинете, а не синевато-серая.
      vec3 tone = mix(vec3(0.78, 0.72, 0.62), vec3(1.0, 0.96, 0.89), aRef);
      vec3 lit = tone * lambert;
      colour += (1.0 - alpha) * lit * a;
      alpha += (1.0 - alpha) * a;
    }
  }

  frag = vec4(colour, 1.0);
}`;

export class VolumeRenderer {
  constructor(gl) {
    this.gl = gl;
    this.program = buildProgram(gl, VERT, FRAG);
    this.broken = !this.program;
  }

  /**
   * Рисует объём в холст.
   * `view` — поворот (по горизонтали и вертикали), увеличение и грубость шага.
   */
  render(canvas, texture, dims, geom, view) {
    const gl = this.gl;
    if (this.broken) return null;
    const width = canvas.width;
    const height = canvas.height;
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.program);
    const u = (name) => gl.getUniformLocation(this.program, name);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, texture);
    gl.uniform1i(u('uVol'), 0);
    gl.uniform3i(u('uDims'), dims[0], dims[1], dims[2]);
    gl.uniform1i(u('uAxisU'), geom.axes.u);
    gl.uniform1i(u('uAxisV'), geom.axes.v);
    gl.uniform1i(u('uAxisN'), geom.axes.n);
    gl.uniform3f(u('uFlip'), geom.flip.u ? 1 : 0, geom.flip.v ? 1 : 0, geom.flip.n ? 1 : 0);
    gl.uniform3f(u('uSizeMM'), geom.sizeMM.u, geom.sizeMM.v, geom.sizeMM.n);
    gl.uniform3f(u('uVoxel'), geom.voxel.u, geom.voxel.v, geom.voxel.n);
    gl.uniform2f(u('uViewport'), width, height);
    gl.uniformMatrix3fv(u('uRotation'), false, rotation(view.yaw, view.pitch));
    gl.uniform1f(u('uZoom'), view.zoom ?? 1);
    gl.uniform2f(u('uPanMM'), view.panX ?? 0, view.panY ?? 0);
    gl.uniform1f(u('uStepMM'), view.stepMM);
    gl.uniform1f(u('uGradMM'), view.gradMM);
    gl.uniform1f(u('uSigned'), geom.signed ? 1 : 0);
    gl.uniform1f(u('uSlope'), geom.slope);
    gl.uniform1f(u('uIntercept'), geom.intercept);
    gl.uniform1f(u('uThreshold'), view.threshold);
    gl.uniform1f(u('uWidth'), view.softness);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return { width, height };
  }
}

/**
 * Поворот из экранных осей в анатомические.
 *
 * Вертикаль экрана — это ось «макушка — подбородок», а не третья ось массива:
 * иначе объём, записанный сагиттально, вставал бы на бок.
 */
/**
 * Половина видимой области в миллиметрах. Та же формула, что в шейдере:
 * по ней JS считает, куда сместить камеру, чтобы точка под пальцами осталась
 * на месте.
 */
export function halfView(sizeMM, aspect, zoom) {
  const fit = Math.min(1, aspect);
  const half = 0.5 * Math.max(sizeMM.u, sizeMM.v, sizeMM.n) / fit / zoom;
  return { x: half * aspect, y: half };
}

export function rotation(yaw, pitch) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);

  // Столбцы — это «вправо», «вверх» и направление луча в анатомических осях.
  // Смотрим спереди: вправо на экране — левая сторона пациента (+u), вверх —
  // к макушке (−n, потому что высота считается сверху вниз), луч уходит от
  // лица к затылку (+v).
  const base = [
    [1, 0, 0],
    [0, 0, 1],
    [0, -1, 0],
  ];
  const yawM = [
    [cy, 0, sy],
    [0, 1, 0],
    [-sy, 0, cy],
  ];
  const pitchM = [
    [1, 0, 0],
    [0, cp, -sp],
    [0, sp, cp],
  ];
  const m = mul(base, mul(yawM, pitchM));
  // В GLSL матрица приходит по столбцам.
  return new Float32Array([
    m[0][0], m[1][0], m[2][0],
    m[0][1], m[1][1], m[2][1],
    m[0][2], m[1][2], m[2][2],
  ]);
}

function mul(a, b) {
  const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
    }
  }
  return out;
}
