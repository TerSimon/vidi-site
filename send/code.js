// Код приёма (этап 6): 6 цифр, последняя — проверочная по алгоритму Дамма, людям —
// «482 918». Опечатку в одной цифре и перестановку соседних видно сразу, без сервера, —
// снимок не уйдёт чужому врачу. Таблица — стандартная квазигруппа Дамма; та же на
// сервере (vidi-api/main.py) и в Vidi (InboxCode). Работает в браузере и в Node.

export const CODE_DIGITS = 6;

const DAMM = [
  [0, 3, 1, 7, 5, 9, 8, 6, 4, 2],
  [7, 0, 9, 2, 1, 5, 4, 8, 6, 3],
  [4, 2, 0, 6, 8, 7, 1, 3, 5, 9],
  [1, 7, 5, 0, 9, 8, 3, 4, 2, 6],
  [6, 1, 2, 3, 0, 4, 5, 9, 7, 8],
  [3, 6, 7, 4, 2, 0, 9, 5, 8, 1],
  [5, 8, 6, 9, 7, 2, 0, 1, 3, 4],
  [8, 9, 4, 5, 3, 6, 2, 0, 1, 7],
  [9, 4, 3, 8, 6, 1, 7, 2, 0, 5],
  [2, 5, 8, 1, 4, 3, 6, 7, 9, 0],
];

const damm = (digits) => [...digits].reduce((interim, ch) => DAMM[interim][ch.charCodeAt(0) - 48], 0);

/** 5 цифр → код: дописывает проверочную цифру. */
export const withCheck = (base) => base + damm(base);

/** 6 цифр ASCII с верной проверочной. */
export const codeValid = (code) => /^[0-9]{6}$/.test(code) && damm(code) === 0;

// Код — после последнего «#», если вставили ссылку …/send/#482918.
const tail = (text) => text.slice(text.lastIndexOf('#') + 1);

/** Цифры кода (не больше 6) из того, что ввели или вставили: «482 918», «482-918», ссылка. */
export const codeDigits = (text) => tail(text).replace(/[^0-9]/g, '').slice(0, CODE_DIGITS);

/** Вид для людей — по три цифры: «482 918». */
export const formatCode = (digits) => (digits.length > 3 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits);

/** Буквенный код до этапа 6 («K7P3-9QXM»): сервер его больше не принимает. */
export const isOldCode = (text) => /[A-Za-z]/.test(tail(text));
