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
 * Разбирает архив и возвращает итоговые числа.
 * `onProgress(stats)` вызывается по ходу, примерно четыре раза в секунду.
 * `signal` прекращает работу: поток снимается целиком.
 *
 * Поток создаётся на каждое открытие и закрывается в конце: 7-Zip в WASM
 * оставляет за собой кучу в сотни мегабайт, и переиспользовать поток означало
 * бы держать её всё время работы. Это же делает отмену честной: распаковку
 * внутри WASM не прервать на полуслове, а снятый поток освобождает и её, и
 * память под ней.
 */
export function openArchive(file, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new ArchiveCancelled()); return; }
    let worker;
    try {
      worker = new Worker(new URL('./archive/worker.js?v=1', import.meta.url), { type: 'module' });
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
      if (data.type === 'progress') { onProgress?.(data.stats); return; }
      if (data.type === 'done') {
        const stats = data.stats;
        if (stats.dicom === 0) {
          // Пустой результат — не ошибка распаковки, и путать их нельзя:
          // врачу важно, снимков нет или архив не открылся.
          finish(reject, stats.encrypted > 0
            ? new ArchiveError('ARC-7', 'Архив защищён паролем — Vidi не может его открыть.')
            : new ArchiveError('ARC-8', 'В архиве нет снимков КТ.'));
          return;
        }
        finish(resolve, stats);
        return;
      }
      if (data.type === 'failed') finish(reject, explain(String(data.reason || '')));
    };

    worker.onerror = () => finish(reject, new ArchiveError('ARC-9', 'Распаковка прервалась.'));

    worker.postMessage({ file });
  });
}
