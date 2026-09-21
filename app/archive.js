//
//  Открытие архива КТ: запуск рабочего потока, ход работы и понятный отказ.
//
//  Сам разбор идёт в archive/worker.js — в отдельном потоке, иначе распаковка
//  на 600 МБ держала бы экран неподвижным. Здесь только управление и перевод
//  результата на язык врача.
//
//  Из потока приходят одни числа. Имён файлов и текста ошибок 7-Zip тут нет и
//  быть не должно: в архивах КТ в них обычно стоит фамилия пациента.
//

/** Отказ, который можно показать врачу: что случилось и короткий код. */
export class ArchiveError extends Error {
  constructor(code, text) {
    super(text);
    this.code = code;
    this.text = text;
  }
}

/**
 * Перевод причины отказа. Коды короткие, чтобы врач мог назвать их вслух;
 * данных пациента в них нет.
 */
function explain(reason) {
  if (reason === 'unknown-format') {
    return new ArchiveError('ARC-1',
      'Не удалось распознать архив. Vidi открывает ZIP, RAR, 7z и папку с файлами DICOM.');
  }
  if (reason === 'too-deep') {
    return new ArchiveError('ARC-2', 'В архиве слишком много вложенных архивов.');
  }
  if (reason === '7z:memory') {
    return new ArchiveError('ARC-3',
      'Не хватило памяти на этом устройстве. Закройте другие вкладки и попробуйте снова.');
  }
  if (reason.startsWith('7z:')) {
    return new ArchiveError('ARC-4', 'Архив повреждён или распакован не полностью.');
  }
  return new ArchiveError('ARC-5', 'Не удалось открыть архив.');
}

/** Доля выполненного, 0…1. До оглавления архива она неизвестна. */
export function progressOf(stats) {
  if (!stats || !stats.entriesTotal) return null;
  return Math.min(1, stats.files / stats.entriesTotal);
}

/** Врач нажал «Отмена». Не ошибка — показывать её как сбой нельзя. */
export class ArchiveCancelled extends Error {}

/**
 * Запускает разбор архива в отдельном потоке и следит за ним.
 *
 * Поток создаётся на каждый проход и закрывается в конце: 7-Zip в WASM
 * оставляет за собой кучу в сотни мегабайт, и переиспользовать поток означало
 * бы держать её всё время работы. Это же делает отмену честной: распаковку
 * внутри WASM не прервать на полуслове, а снятый поток освобождает и её, и
 * память под ней.
 *
 * `handle(data, finish)` решает, что делать с каждым сообщением.
 */
function runWorker(message, { onProgress, signal }, handle) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new ArchiveCancelled()); return; }
    let worker;
    try {
      worker = new Worker(new URL('./archive/worker.js?v=0.5.2', import.meta.url), { type: 'module' });
    } catch (e) {
      reject(new ArchiveError('ARC-6', 'Браузер не смог запустить распаковку.'));
      return;
    }

    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      fn(value);
    };
    function onAbort() { finish(reject, new ArchiveCancelled()); }
    signal?.addEventListener('abort', onAbort);

    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') { onProgress?.(data.stats, data.fill); return; }
      if (data.type === 'failed') { finish(reject, explain(String(data.reason || ''))); return; }
      handle(data, { resolve: (v) => finish(resolve, v), reject: (e) => finish(reject, e) });
    };

    worker.onerror = () => finish(reject, new ArchiveError('ARC-9', 'Распаковка прервалась.'));

    // Перенос объёма без копии: после отправки буфер на стороне потока пуст,
    // и телефон не держит два объёма разом.
    worker.postMessage(message);
  });
}

/**
 * Первый проход: что лежит в архиве. Читаются только заголовки — пиксели
 * пролетают мимо, иначе распакованный архив остался бы в памяти целиком.
 * `onProgress(stats)` вызывается по ходу, примерно четыре раза в секунду.
 */
export function openArchive(file, { onProgress, signal } = {}) {
  return runWorker({ file }, { onProgress, signal }, (data, { resolve, reject }) => {
    if (data.type !== 'done') return;
    const stats = data.stats;
    const study = data.study;
    if (stats.dicom === 0) {
      // Пустой результат — не ошибка распаковки, и путать их нельзя:
      // врачу важно, снимков нет или архив не открылся.
      reject(stats.encrypted > 0
        ? new ArchiveError('ARC-7', 'Архив защищён паролем — Vidi не может его открыть.')
        : new ArchiveError('ARC-8', 'В архиве нет снимков КТ.'));
      return;
    }
    if (!study?.series?.length) {
      // Снимки нашлись, но ни один заголовок не прочитался. Это другой
      // случай, чем пустой архив, и говорить о нём надо иначе.
      reject(new ArchiveError('ARC-10',
        'Снимки в архиве есть, но Vidi не смог их прочитать.'));
      return;
    }
    resolve({ stats, study });
  });
}

/**
 * Второй проход: пиксели выбранной серии ложатся в объём.
 *
 * `plan` — что именно собирать: seriesUID, размеры среза, порядок срезов и
 * во сколько раз уменьшать под память устройства.
 */
export function buildVolume(file, plan, { onProgress, signal } = {}) {
  return runWorker({ file, fill: plan }, { onProgress, signal }, (data, { resolve, reject }) => {
    if (data.type !== 'volume') return;
    const v = data.volume;
    if (v.filled === 0) {
      reject(new ArchiveError('ARC-11', 'Снимки выбранной серии не прочитались.'));
      return;
    }
    resolve({ ...v, stats: data.stats });
  });
}
