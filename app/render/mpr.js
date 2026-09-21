//
//  Отрисовка срезов объёма на WebGL2.
//
//  Объём лежит в трёхмерной текстуре целыми 16-битными значениями — теми
//  самыми, что записаны в DICOM. Не в яркости и не в float16: значение точки
//  это плотность, по ней врач отличает кость от корня, и округлять её по
//  дороге нельзя. Знак и rescale применяются в шейдере, при показе.
//
//  Один контекст WebGL на все панели. Каждая панель рисуется в общий холст и
//  переносится в свой обычный canvas — так поверх среза можно рисовать
//  линейку простыми средствами, и на телефоне не тратятся несколько контекстов
//  WebGL сразу (их число там ограничено жёстко).
//
//  Экранные координаты переводятся в координаты объёма одним преобразованием,
//  посчитанным на стороне JS: в нём и выбор плоскости, и развороты сторон, и
//  зум, и соотношение миллиметров. Поэтому шейдер ничего не знает про
//  анатомию, а расчёт сторон лежит в одном месте и проверяется отдельно.
//

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler3D;

uniform usampler3D uVol;
uniform vec3 uDims;
uniform vec3 uOrigin;
uniform vec3 uStepX;
uniform vec3 uStepY;
uniform float uHeight;
uniform float uSigned;
uniform float uSlope;
uniform float uIntercept;
uniform float uLow;
uniform float uSpan;
uniform float uInvert;

out vec4 frag;

float atVoxel(ivec3 c) {
  c = clamp(c, ivec3(0), ivec3(uDims) - ivec3(1));
  float v = float(texelFetch(uVol, c, 0).r);
  // Знаковые значения лежат в том же 16-битном ящике: половина размаха выше
  // 32768 — это минус. Разворачиваем здесь, а не при заливке, чтобы в памяти
  // остались исходные байты файла.
  if (uSigned > 0.5 && v >= 32768.0) v -= 65536.0;
  return v * uSlope + uIntercept;
}

// Трилинейно. Между точками объёма врач ставит линейку не по клеткам, и
// ступенчатый край мешал бы целиться.
float sampleVolume(vec3 p) {
  vec3 f = floor(p);
  vec3 t = p - f;
  ivec3 c = ivec3(f);
  float v000 = atVoxel(c + ivec3(0, 0, 0));
  float v100 = atVoxel(c + ivec3(1, 0, 0));
  float v010 = atVoxel(c + ivec3(0, 1, 0));
  float v110 = atVoxel(c + ivec3(1, 1, 0));
  float v001 = atVoxel(c + ivec3(0, 0, 1));
  float v101 = atVoxel(c + ivec3(1, 0, 1));
  float v011 = atVoxel(c + ivec3(0, 1, 1));
  float v111 = atVoxel(c + ivec3(1, 1, 1));
  return mix(
    mix(mix(v000, v100, t.x), mix(v010, v110, t.x), t.y),
    mix(mix(v001, v101, t.x), mix(v011, v111, t.x), t.y), t.z);
}

void main() {
  vec2 px = vec2(gl_FragCoord.x - 0.5, uHeight - (gl_FragCoord.y - 0.5) - 1.0);
  vec3 p = uOrigin + uStepX * px.x + uStepY * px.y;

  // За краем объёма — чёрное. Иначе крайняя точка растянулась бы по всему
  // полю и выглядела как ткань, которой там нет.
  if (any(lessThan(p, vec3(-0.5))) || any(greaterThan(p, uDims - vec3(0.5)))) {
    frag = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  float hu = sampleVolume(p);
  float g = clamp((hu - uLow) / uSpan, 0.0, 1.0);
  if (uInvert > 0.5) g = 1.0 - g;
  frag = vec4(g, g, g, 1.0);
}`;

/** Сколько байт занимает объём таких размеров. */
export const volumeBytes = (w, h, d) => w * h * d * 2;

/**
 * Насколько уменьшать объём, чтобы он поместился.
 *
 * Спросить у браузера, сколько памяти даст видеокарта, нельзя — такого вопроса
 * в WebGL нет. Поэтому сначала считаем по запасу, который телефон обычно
 * выдерживает, а потом пробуем выделить текстуру на самом деле: неудачная
 * попытка стоит миллисекунды, а неудачная заливка — минуты второго прохода.
 *
 * Поперёк среза и по срезам ужимаем по отдельности и берём вариант с
 * наименьшей потерей. Одним шагом на все оси получалось хуже без причины:
 * снимок 800×800×450 не влезает целиком, но, ужатый только поперёк, занимает
 * 137 МБ и сохраняет ВСЕ срезы, тогда как одинаковый шаг ×2 выбрасывал
 * каждый второй срез ради 69 МБ, которые и не были нужны.
 */
export function chooseReduction(gl, w, h, d, budgetBytes) {
  const maxDim = gl ? gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) : 512;
  const tried = [];
  for (let xy = 1; xy <= 8; xy++) {
    for (let z = 1; z <= 8; z++) {
      // Слишком вытянутая точка (вдоль объёма много крупнее, чем поперёк)
      // обманывает глаз: край на наклонном виде кажется не там, где он есть.
      // Потому перекос ограничен вдвое.
      if (z > xy * 2) continue;
      const sw = Math.ceil(w / xy);
      const sh = Math.ceil(h / xy);
      const sd = Math.ceil(d / z);
      if (Math.max(sw, sh, sd) > maxDim) continue;
      if (volumeBytes(sw, sh, sd) > budgetBytes) continue;
      // Потеря — во сколько раз крупнее стала точка объёма. При равной
      // потере предпочитаем сохранить срезы.
      tried.push({ stepXY: xy, stepZ: z, w: sw, h: sh, d: sd, loss: xy * xy * z });
    }
  }
  tried.sort((a, b) => a.loss - b.loss || a.stepZ - b.stepZ);
  for (const candidate of tried) {
    if (gl && !canAllocate(gl, candidate.w, candidate.h, candidate.d)) continue;
    return candidate;
  }
  return null;
}

/** Пробная выделение текстуры: получилось или нет. */
function canAllocate(gl, w, h, d) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D, tex);
  while (gl.getError() !== gl.NO_ERROR) { /* чистим прошлые ошибки */ }
  gl.texStorage3D(gl.TEXTURE_3D, 1, gl.R16UI, w, h, d);
  const err = gl.getError();
  gl.deleteTexture(tex);
  return err === gl.NO_ERROR;
}

/**
 * Запас памяти под объём. На телефоне вкладку закрывают за превышение без
 * предупреждения, поэтому запас там меньше — лучше показать объём попроще,
 * чем уронить вкладку на середине работы.
 */
export function memoryBudget() {
  const phone = /iPhone|iPad|iPod|Android/.test(navigator.userAgent);
  return (phone ? 192 : 768) * 1048576;
}

export class MPRRenderer {
  static create() {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: false, powerPreference: 'high-performance',
    });
    if (!gl) return null;
    return new MPRRenderer(canvas, gl);
  }

  constructor(canvas, gl) {
    this.canvas = canvas;
    this.gl = gl;
    this.program = buildProgram(gl, VERT, FRAG);
    if (!this.program) { this.broken = true; return; }
    this.u = {};
    for (const name of ['uVol', 'uDims', 'uOrigin', 'uStepX', 'uStepY', 'uHeight',
      'uSigned', 'uSlope', 'uIntercept', 'uLow', 'uSpan', 'uInvert']) {
      this.u[name] = gl.getUniformLocation(this.program, name);
    }
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(this.program, 'aPos');
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
    this.texture = null;
    this.dims = null;
  }

  /**
   * Заливает объём в текстуру. Кусками по срезам: одна заливка на 130 МБ
   * заставляет браузер держать две копии разом, и на телефоне это тот самый
   * миг, когда вкладку закрывают.
   */
  upload(volume) {
    const gl = this.gl;
    const { data, w, h, d } = volume;
    this.dispose();
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, tex);
    while (gl.getError() !== gl.NO_ERROR) { /* чистим прошлые ошибки */ }
    gl.texStorage3D(gl.TEXTURE_3D, 1, gl.R16UI, w, h, d);
    if (gl.getError() !== gl.NO_ERROR) { gl.deleteTexture(tex); return false; }

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
    const chunk = Math.max(1, Math.floor(8 * 1048576 / (w * h * 2)));
    for (let z = 0; z < d; z += chunk) {
      const count = Math.min(chunk, d - z);
      const view = data.subarray(z * w * h, (z + count) * w * h);
      gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, z, w, h, count,
        gl.RED_INTEGER, gl.UNSIGNED_SHORT, view);
      if (gl.getError() !== gl.NO_ERROR) { gl.deleteTexture(tex); return false; }
    }
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    this.texture = tex;
    this.dims = [w, h, d];
    return true;
  }

  /**
   * Рисует срез и возвращает холст с картинкой.
   * `map` — перевод экранного пикселя в координаты объёма (origin/stepX/stepY),
   * `look` — как показывать значения.
   */
  render(width, height, map, look) {
    const gl = this.gl;
    if (!this.texture || this.broken) return null;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.texture);
    gl.uniform1i(this.u.uVol, 0);
    gl.uniform3f(this.u.uDims, this.dims[0], this.dims[1], this.dims[2]);
    gl.uniform3fv(this.u.uOrigin, map.origin);
    gl.uniform3fv(this.u.uStepX, map.stepX);
    gl.uniform3fv(this.u.uStepY, map.stepY);
    gl.uniform1f(this.u.uHeight, height);
    gl.uniform1f(this.u.uSigned, look.signed ? 1 : 0);
    gl.uniform1f(this.u.uSlope, look.slope);
    gl.uniform1f(this.u.uIntercept, look.intercept);
    gl.uniform1f(this.u.uLow, look.center - look.width / 2);
    gl.uniform1f(this.u.uSpan, Math.max(1e-6, look.width));
    gl.uniform1f(this.u.uInvert, look.invert ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return this.canvas;
  }

  dispose() {
    if (this.texture) {
      this.gl.deleteTexture(this.texture);
      this.texture = null;
      this.dims = null;
    }
  }
}

function buildProgram(gl, vertSrc, fragSrc) {
  const vert = compile(gl, gl.VERTEX_SHADER, vertSrc);
  const frag = compile(gl, gl.FRAGMENT_SHADER, fragSrc);
  if (!vert || !frag) return null;
  const program = gl.createProgram();
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  gl.deleteShader(vert);
  gl.deleteShader(frag);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('WebGL:', gl.getProgramInfoLog(program));
    return null;
  }
  return program;
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('WebGL:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}
