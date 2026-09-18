//
//  Подписка и рабочее место для браузерной версии. Та же учётная запись, что и
//  в приложении на Mac: email + код из бота.
//
//  Что здесь ХРАНИТСЯ и почему. В браузере сохраняются только три вещи: номер
//  этого браузера как устройства, его токен и email. Без них каждое открытие
//  страницы было бы НОВЫМ устройством, а браузерный слот у подписки один —
//  врач сжёг бы все сбросы за неделю. Снимки, имена файлов и данные пациента
//  не сохраняются никогда.
//
//  Чего здесь НЕТ: проверки подписи ответа сервера. На Mac она защищает от
//  подменённого сервера, потому что сам код приложения подписан и неизменен. В
//  браузере код открыт и его владелец может поменять что угодно в отладчике,
//  поэтому подпись не добавила бы защиты — от подмены сервера здесь защищает
//  HTTPS и то, что адрес API зашит в файл.
//

const API = 'https://api.vidiviewer.ru';
const STORE_KEY = 'vidi.web.device.v1';

// Как часто говорим серверу «я открыт». Столько же, сколько на Mac: место
// освобождается после 90 секунд молчания, так что три пропущенных подряд
// сигнала ещё не отдают место чужому экрану.
export const SEAT_PING_MS = 45_000;

// ─── Память браузера ───────────────────────────────────────────────────────

/**
 * Проверяем, умеет ли браузер хранить вход. В приватном окне и при
 * заблокированных данных сайта localStorage бросает или молча теряет запись.
 * Это нужно знать ДО входа: иначе каждое открытие станет новым устройством, а
 * браузерный слот один — и врач упрётся в «устройство уже привязано».
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

function forget() {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch (e) {
    // Нечего делать: состояние в памяти всё равно сбрасывает вызывающий код.
  }
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

/** Как устройство будет названо на экране перехвата у врача на Mac. */
export function deviceName() {
  const ua = navigator.userAgent;
  const browser =
    /CriOS|Chrome/.test(ua) ? 'Chrome' :
    /Firefox/.test(ua) ? 'Firefox' :
    /Safari/.test(ua) ? 'Safari' : 'Браузер';
  const platform =
    /iPhone/.test(ua) ? 'iPhone' :
    /iPad/.test(ua) ? 'iPad' :
    /Android/.test(ua) ? 'Android' :
    /Mac/.test(ua) ? 'Mac' :
    /Windows/.test(ua) ? 'Windows' : '';
  return platform ? `${browser}, ${platform}` : browser;
}

// ─── Сеть ──────────────────────────────────────────────────────────────────

/**
 * Обрыв связи и ответ сервера — разные вещи, и их нельзя путать: по первому
 * врача запирать нельзя, по второму иногда нужно.
 */
async function post(path, body) {
  let res;
  try {
    res = await fetch(API + '/' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
  } catch (e) {
    throw new NetworkError();
  }
  try {
    return await res.json();
  } catch (e) {
    throw new NetworkError();
  }
}

export class NetworkError extends Error {}

// ─── Состояние ─────────────────────────────────────────────────────────────

export const auth = {
  email: null,
  isSuper: false,
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
 * Первый вход: сверяем код и привязываем этот браузер.
 * Возвращает {result, ...} — экран решает, что показать врачу.
 *
 * Токен пишем в память ДО того, как признать вход удачным: если запись не
 * прошла, устройство уже привязано на сервере, а браузер об этом не помнит —
 * и следующее открытие страницы упрётся в занятый слот.
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
    auth.isSuper = !!r.is_super;
    auth.paidUntil = r.paid_until ?? null;
    return { result: r.active ? 'ok' : 'locked', paidUntil: r.paid_until ?? null };
  }

  switch (r.status) {
    case 'bad_code': return { result: 'badCode' };
    case 'not_found': return { result: 'notFound' };
    case 'device_limit': return { result: 'deviceLimit', resetsLeft: r.resets_left ?? 0 };
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
 * Выход. На сервере это тот же сброс закрепления, что и кнопка в боте, и он так
 * же ограничен — иначе привязку можно было бы передавать по кругу без предела.
 * Поэтому отказ по лимиту показываем честно и вход НЕ забываем.
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

  if (r.ok) {
    forget();
    auth.email = null;
    return { result: 'ok', resetsLeft: r.resets_left ?? 0 };
  }
  if (r.status === 'reset_limit') {
    return { result: 'resetLimit', retryAfterDays: r.retry_after_days ?? null };
  }
  if (r.status === 'device_revoked') {
    // Устройство уже отвязано на сервере — забыть его здесь безопасно.
    forget();
    auth.email = null;
    return { result: 'ok' };
  }
  return { result: 'error' };
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
