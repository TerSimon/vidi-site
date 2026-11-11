//
//  Подписка и рабочее место для браузерной версии. Та же учётная запись, что и
//  в приложении на Mac: email + код из бота.
//
//  Что здесь ХРАНИТСЯ и почему. В браузере сохраняются только три вещи: номер
//  этого браузера как устройства, его токен и email. Без них каждое открытие
//  страницы требовало бы нового входа. Новый вход переносит браузерный сеанс
//  сюда и отзывает прежний. Снимки, имена файлов и данные пациента не
//  сохраняются никогда.
//
//  Чего здесь НЕТ: проверки подписи ответа сервера. На Mac она защищает от
//  подменённого сервера, потому что сам код приложения подписан и неизменен. В
//  браузере код открыт и его владелец может поменять что угодно в отладчике,
//  поэтому подпись не добавила бы защиты — от подмены сервера здесь защищает
//  HTTPS и то, что адрес API зашит в файл.
//

const API = 'https://api.vidiviewer.ru';
const STORE_KEY = 'vidi.web.device.v1';

// Как часто проверяем рабочее место и отзыв браузерного сеанса. Новый вход
// в другом браузере будет замечен на ближайшей проверке при наличии связи.
export const SEAT_PING_MS = 15_000;

// ─── Память браузера ───────────────────────────────────────────────────────

/**
 * Проверяем, умеет ли браузер хранить вход. В приватном окне и при
 * заблокированных данных сайта localStorage бросает или молча теряет запись.
 * Это нужно знать ДО входа: иначе браузер забудет полученный токен и при
 * каждом открытии страницы будет снова просить почту и код.
 */
export function storageWorks() {
  try {
    const probe = '__vidi_probe__';
    localStorage.setItem(probe, '1');
    const ok = localStorage.getItem(probe) === '1';
    localStorage.removeItem(probe);
    return ok;
  } catch (e) {
    return false;
  }
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function save(state) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    return true;
  } catch (e) {
    return false;
  }
}

function isCurrent(state) {
  const current = load();
  return current?.id === state.id && current?.token === state.token &&
    current?.email === state.email;
}

function forget() {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch (e) {
    // Состояние в памяти сбрасывается ниже даже при запрете хранилища.
  }
  auth.email = null;
  auth.paidUntil = null;
}

/**
 * Номер этого браузера как устройства. Случайный и постоянный — не отпечаток:
 * ничего об устройстве врача он не сообщает и на другом сайте не читается.
 */
function deviceID(state) {
  if (state?.id) return state.id;
  const rnd = (crypto.randomUUID && crypto.randomUUID()) ||
    Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, '0')).join('');
  return 'web-' + rnd;
}

/**
 * Как устройство будет названо на экране переноса рабочего места на Mac.
 * Имя должно быть узнаваемым для владельца.
 *
 * Порядок проверок важен: Яндекс Браузер, Edge и Opera несут в строке и
 * «Chrome», а Chrome и Firefox на iPhone — ещё и «Safari».
 */
export function deviceName() {
  const ua = navigator.userAgent;
  const browser =
    /YaBrowser/.test(ua) ? 'Яндекс Браузер' :
    /EdgA?\/|EdgiOS/.test(ua) ? 'Edge' :
    /OPR\/|OPiOS/.test(ua) ? 'Opera' :
    /CriOS|Chrome/.test(ua) ? 'Chrome' :
    /FxiOS|Firefox/.test(ua) ? 'Firefox' :
    /Safari/.test(ua) ? 'Safari' : 'Браузер';
  // iPad с iPadOS 13 и новее пишет о себе «Macintosh»; выдаёт его сенсорный
  // экран — у Mac его нет.
  const iPadAsMac = /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
  const platform =
    /iPhone/.test(ua) ? 'iPhone' :
    /iPad/.test(ua) || iPadAsMac ? 'iPad' :
    /Android/.test(ua) ? 'Android' :
    /Mac/.test(ua) ? 'Mac' :
    /Windows/.test(ua) ? 'Windows' : '';
  return platform ? `${browser}, ${platform}` : browser;
}

// ─── Сеть ──────────────────────────────────────────────────────────────────

// Сколько ждём ответа сервера. Без предела зависший сервер (соединение есть,
// ответа нет) держал экран «Проверяем доступ…» и кнопку «Проверяем…» столько,
// сколько браузер сочтёт нужным, — на телефоне это минуты. После предела
// запрос считается обрывом связи, и врач видит, что делать.
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Обрыв связи и ответ сервера — разные вещи, и их нельзя путать: по первому
 * врача запирать нельзя, по второму иногда нужно.
 */
async function post(path, body) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS) : null;
  try {
    let res;
    try {
      res = await fetch(API + '/' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
        signal: ctl?.signal,
      });
    } catch (e) {
      throw new NetworkError();
    }
    try {
      return await res.json();
    } catch (e) {
      throw new NetworkError();
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class NetworkError extends Error {}

// ─── Состояние ─────────────────────────────────────────────────────────────

export const auth = {
  email: null,
  paidUntil: null,

  get signedIn() {
    return !!load()?.token;
  },

  get savedEmail() {
    return load()?.email ?? null;
  },
};

// ─── Вход ──────────────────────────────────────────────────────────────────

/**
 * Явный вход: сверяем код и переносим браузерный сеанс сюда.
 * Возвращает {result, ...} — экран решает, что показать врачу.
 *
 * Токен пишем в память ДО того, как признать вход удачным: если запись не
 * прошла, токен уже выдан на сервере, а браузер об этом не помнит —
 * и при следующем открытии понадобится повторный вход.
 */
export async function activate(email, code) {
  const state = load() ?? {};
  const id = deviceID(state);

  let r;
  try {
    r = await post('activate', {
      email, code,
      device_id: id,
      device_name: deviceName(),
      kind: 'web',
    });
  } catch (e) {
    return { result: 'network' };
  }

  if (r.ok && r.device_token) {
    const saved = save({ id, token: r.device_token, email: r.email ?? email });
    if (!saved) return { result: 'storage' };
    auth.email = r.email ?? email;
    auth.paidUntil = r.paid_until ?? null;
    return { result: r.active ? 'ok' : 'locked', paidUntil: r.paid_until ?? null };
  }

  switch (r.status) {
    case 'bad_code': return { result: 'badCode' };
    case 'not_found': return { result: 'notFound' };
    // Совместимость на время обновления сервера: не направляем к сбросам.
    case 'device_limit': return { result: 'deviceLimit' };
    case 'too_many_attempts': return { result: 'tooManyAttempts', retryAfter: r.retry_after ?? null };
    default: return { result: 'error' };
  }
}

/** Проверка при открытии страницы: жив ли ещё доступ. */
export async function check() {
  const state = load();
  if (!state?.token) return { result: 'signedOut' };

  let r;
  try {
    r = await post('check', {
      email: state.email,
      device_id: state.id,
      device_token: state.token,
    });
  } catch (e) {
    // Без связи в браузере доступ не открываем: офлайн-грейс есть на Mac, где
    // ответ сервера подписан и его нельзя подделать. Здесь подписи нет, значит
    // «разрешить офлайн» означало бы «разрешить всем».
    return { result: 'offline' };
  }

  if (!isCurrent(state)) return { result: 'superseded' };

  if (r.ok) {
    auth.email = state.email;
    auth.paidUntil = r.paid_until ?? null;
    return { result: r.active ? 'ok' : 'expired', paidUntil: r.paid_until ?? null };
  }
  if (r.status === 'device_revoked') {
    forget();
    return { result: 'revoked' };
  }
  return { result: 'error' };
}

/**
 * Выход отзывает только этот браузерный токен, без бюджета сбросов.
 * Запоздалый ответ старого выхода не должен стереть более новый вход,
 * записанный в этой же вкладке или в соседней вкладке браузера.
 */
export async function signOut() {
  const state = load();
  if (!state?.token) return { result: 'ok' };

  let r;
  try {
    r = await post('deactivate', {
      email: state.email,
      device_id: state.id,
      device_token: state.token,
    });
  } catch (e) {
    return { result: 'network' };
  }

  if (!isCurrent(state)) return { result: 'superseded' };

  if (r.ok) {
    forget();
    return { result: 'ok' };
  }
  if (r.status === 'device_revoked') {
    // Старый токен уже отозван — новый сеанс на сервере не затрагиваем.
    forget();
    return { result: 'ok' };
  }
  return { result: 'error' };
}

/**
 * Билет на загрузку кода просмотра.
 *
 * Сам просмотр считает снимок на устройстве врача и серверу не нужен — потому
 * его код и не лежит на сайте файлом: иначе им можно было бы пользоваться, не
 * входя вовсе. Здесь берётся короткий билет, по которому сервер отдаёт модуль.
 */
export async function moduleTicket() {
  const state = load();
  if (!state?.token) return null;
  try {
    const r = await post('module_ticket', {
      email: state.email,
      device_id: state.id,
      device_token: state.token,
    });
    return r?.ok ? r.ticket : null;
  } catch (e) {
    return null;    // без связи просмотр не загрузить — вызывающий скажет это вслух
  }
}

/** Адрес модуля просмотра на сервере. */
export function moduleURL(path, ticket) {
  return API + '/m/' + path + '?t=' + encodeURIComponent(ticket);
}

// ─── Рабочее место ─────────────────────────────────────────────────────────

/**
 * «Я открыт». mine=false означает, что снимок сейчас открыт в другом месте.
 * claim=true переносит место сюда.
 *
 * Поле claim шлём только когда действительно забираем место: на сервере любое
 * непустое значение читается как «да».
 */
export async function seat({ claim = false } = {}) {
  const state = load();
  if (!state?.token) return { result: 'signedOut' };

  const body = {
    email: state.email,
    device_id: state.id,
    device_token: state.token,
  };
  if (claim) body.claim = true;

  let r;
  try {
    r = await post('seat', body);
  } catch (e) {
    return { result: 'offline' };
  }

  // Старый запрос мог завершиться уже после нового входа в другой вкладке.
  if (!isCurrent(state)) return { result: 'superseded' };

  if (r.ok) {
    if (r.mine) return { result: 'mine' };
    return {
      result: 'taken',
      holder: describeHolder(r.holder?.device_name, r.holder?.kind),
    };
  }
  if (r.status === 'device_revoked') {
    forget();
    return { result: 'revoked' };
  }
  return { result: 'error' };
}

/** Как назвать занявшее место устройство, когда сервер не прислал имя. */
export function describeHolder(name, kind) {
  const trimmed = (name ?? '').trim();
  if (trimmed) return trimmed;
  return kind === 'web' ? 'в браузере' : 'на другом Mac';
}
