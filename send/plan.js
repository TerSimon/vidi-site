// Что отправить (этап 8). Отправитель может не знать, где на диске лежит КТ,
// поэтому уходит папка целиком — с программой просмотра, картинками, архивами, —
// а Vidi сам найдёт в ней снимок. Если в папке снимки нескольких пациентов
// (общая папка клиники), отправитель один раз выбирает, чей: чужие врачу не уходят.
// Здесь только решение — без страницы, его проверяют тесты в Node.

// Не снимок: программа просмотра с диска, служебное, картинки, документы. Такие
// файлы не читаем (в папку целиком они всё равно уходят).
export const NOT_DICOM = /\.(exe|dll|ocx|sys|msi|cab|bat|cmd|com|lnk|inf|ini|cfg|manifest|mo|qm|qss|chm|hlp|htm|html|js|css|txt|rtf|pdf|doc|docx|xls|xlsx|xml|json|log|db|ico|cur|bmp|gif|jpg|jpeg|png|tif|tiff|svg|ttf|otf|stl|wav|mp3|mp4|avi|mov|ds_store)$/i;

const ARCHIVE_ZIP = /\.zip$/i;
const ARCHIVE_RAR = /\.rar$/i;
// Такие архивы Vidi не открывает: снимок в них до Vidi не дойдёт.
const ARCHIVE_UNSUPPORTED = /\.(7z|tar|tgz|gz|bz2|xz)$/i;
// Служебное системы — не уходит даже с папкой целиком.
const JUNK_NAME = /^(thumbs\.db|desktop\.ini)$/i;
const JUNK_DIR = /^(__macosx|\$recycle\.bin|system volume information)$/i;

const baseName = (path) => path.split('/').pop();

/** Служебный файл системы: скрытый, миниатюры Windows, корзина, след macOS в архиве. */
export function isJunk(path) {
  const parts = path.split('/');
  const name = parts.pop();
  return name.startsWith('.') || JUNK_NAME.test(name)
    || parts.some((dir) => dir.startsWith('.') || JUNK_DIR.test(dir));
}

/**
 * Есть ли у имени настоящее расширение: 1–5 латинских букв и цифр, хотя бы одна
 * буква. У «IM0001», «КТ Иванов 12.10.2026» и «1.2.840.10008» его нет — такие
 * файлы узнаём по содержимому. Тот же закон — у Vidi (InboxPackage.archiveKind).
 */
export function hasRealExtension(name) {
  return /\.(?=[a-z0-9]*[a-z])[a-z0-9]{1,5}$/i.test(name);
}

/**
 * Архив по имени: 'zip' — заглянем внутрь; 'rar' — внутрь не заглянуть, но Vidi его
 * откроет; 'unsupported' — 7z, tar, gz: Vidi их не открывает; null — не архив.
 */
export function archiveByName(name) {
  if (ARCHIVE_ZIP.test(name)) return 'zip';
  if (ARCHIVE_RAR.test(name)) return 'rar';
  return ARCHIVE_UNSUPPORTED.test(name) ? 'unsupported' : null;
}

/** Заведомо не снимок — читать заголовок незачем. DICOMDIR — оглавление диска. */
export function skipPeek(name) {
  return /^DICOMDIR$/i.test(name) || NOT_DICOM.test(name);
}

/**
 * Что это за файл — по имени, а если нужно, по содержимому. io — чтение файла:
 * { peek, peekZip, sniffArchive } из dicom-peek.js и zip-peek.js (в тестах — подставные).
 * → { kind: 'junk' | 'dicom' | 'zip' | 'opaque' | 'unsupported' | 'other', info?, infos? }
 */
export async function classify(path, file, io) {
  if (isJunk(path)) return { kind: 'junk' };
  const name = baseName(path);
  let archive = archiveByName(name);
  if (!archive && skipPeek(name)) return { kind: 'other' };
  if (!archive) {
    const info = await io.peek(file);
    if (info) return { kind: 'dicom', info };
    // Архив без расширения («КТ Иванова 12.10.2026») узнаём по первым байтам.
    if (!hasRealExtension(name)) archive = await io.sniffArchive(file);
  }
  if (archive === 'zip') return io.peekZip(file);
  if (archive === 'rar') return { kind: 'opaque' };
  if (archive) return { kind: 'unsupported' };
  return { kind: 'other' };
}

/**
 * Кто на снимке: имя без регистра и лишних пробелов, «ё» как «е», плюс номер пациента.
 * Без имени и номера — исследование (анонимные снимки разных людей не сливаются).
 * Пустая строка — не понять, чей.
 */
export function personKey(info) {
  const name = (info.patient || '').normalize('NFC').toLocaleLowerCase('ru').replace(/ё/g, 'е')
    .replace(/\s+/g, ' ').trim();
  const id = (info.patientId || '').trim();
  if (name || id) return `${name}|${id}`;
  return info.study ? `study|${info.study}` : '';
}

const sum = (entries) => entries.reduce((s, e) => s + e.size, 0);
const pack = (entries) => ({ entries, bytes: sum(entries) });

/** Общая папка всех файлов («Иванов» у «Иванов/CT/IM1.dcm») или ''. */
function commonFolder(entries) {
  const first = entries[0]?.path.split('/');
  if (!first || first.length < 2) return '';
  const root = first[0];
  return entries.every((e) => e.path.startsWith(`${root}/`)) ? root : '';
}

/** Папка, где лежит файл, — подпись архива в выборе. */
function parentName(path) {
  const parts = path.split('/');
  return parts.length > 1 ? parts[parts.length - 2] : '';
}

/** Архив — вариант выбора, если внутрь не заглянуть или пациентов в нём несколько. */
function archiveOption(entry) {
  return {
    id: `archive:${entry.path}`, kind: 'archive', title: baseName(entry.path),
    folder: parentName(entry.path), entries: [entry], bytes: entry.size,
  };
}

/**
 * entries — [{ path, size, kind, info?, infos? }] без служебного (isJunk):
 *   'dicom'  — снимок, info — заголовок;
 *   'zip'    — архив со снимками, infos — заголовки найденных внутри;
 *   'opaque' — архив, внутрь которого не заглянуть (RAR, ZIP с шифром);
 *   'unsupported' — архив, который Vidi не открывает (7z, tar, gz): не снимок для Vidi;
 *   'other'  — всё остальное.
 * → { mode: 'whole' | 'choose' | 'empty', folder, whole, core, options, person, unsupported }
 *   whole — вся папка; core — только снимки и архивы (если вся не влезает в лимит);
 *   options — варианты «чей снимок»; person — пациент папки, если он один и известен;
 *   unsupported — имена архивов, которые Vidi не открывает (подсказка, если снимков нет).
 */
export function sortOut(entries) {
  const people = new Map();
  const archives = [];
  let unattributed = 0;

  const personFor = (key, info) => {
    if (!people.has(key)) {
      people.set(key, {
        id: `person:${key}`, kind: 'person', title: info.patient || 'Пациент без имени',
        info, entries: [], bytes: 0,
      });
    }
    return people.get(key);
  };
  const add = (person, entry) => {
    person.entries.push(entry);
    person.bytes += entry.size;
  };

  for (const entry of entries) {
    if (entry.kind === 'dicom') {
      const key = personKey(entry.info);
      if (key) add(personFor(key, entry.info), entry);
      else unattributed += 1;
    } else if (entry.kind === 'zip') {
      const inside = new Map();
      for (const info of entry.infos) {
        const key = personKey(info);
        if (key && !inside.has(key)) inside.set(key, info);
      }
      if (inside.size === 1) {
        const [[key, info]] = inside;
        add(personFor(key, info), entry);
      } else if (inside.size > 1) {
        // Разделить архив нельзя: он — отдельный вариант, а его пациенты считаются.
        for (const [key, info] of inside) personFor(key, info);
        archives.push({ ...archiveOption(entry), patients: [...inside.values()].map((i) => i.patient || 'Пациент без имени') });
      } else {
        // Снимок без имени и номера — чей, не понять: как архив-загадка.
        archives.push(archiveOption(entry));
      }
    } else if (entry.kind === 'opaque') {
      archives.push(archiveOption(entry));
    }
  }

  const persons = [...people.values()];
  const opaque = archives.filter((a) => !a.patients);
  const units = persons.length + opaque.length;
  const options = [
    ...persons.filter((p) => p.entries.length)
      .sort((a, b) => a.title.localeCompare(b.title, 'ru')),
    ...archives.sort((a, b) => a.id.localeCompare(b.id, 'ru')),
  ];

  let mode = 'empty';
  if (units >= 2) mode = 'choose';
  else if (units === 1 || unattributed > 0) mode = 'whole';

  return {
    mode,
    folder: commonFolder(entries),
    whole: pack(entries),
    core: pack(entries.filter((e) => e.kind !== 'other' && e.kind !== 'unsupported')),
    options,
    person: mode === 'whole' && persons.length === 1 ? persons[0] : null,
    unsupported: entries.filter((e) => e.kind === 'unsupported').map((e) => baseName(e.path)),
  };
}

/**
 * Влезает ли отправка в лимит сервера. Вся папка не влезла — уходят только снимки
 * и архивы (core): программы и картинки Vidi не нужны. → { entries, bytes, trimmed } | null
 */
export function fit(unit, maxBytes, core) {
  if (!maxBytes || unit.bytes <= maxBytes) return { entries: unit.entries, bytes: unit.bytes, trimmed: false };
  if (core && core.bytes && core.bytes <= maxBytes) return { entries: core.entries, bytes: core.bytes, trimmed: true };
  return null;
}

/**
 * Описание посылки для Vidi: кто на снимках (из файлов и из архивов), какие архивы,
 * сколько файлов и байт. Vidi сверяет файлы и байты с потоком.
 */
export function describe(entries) {
  const studies = new Map();
  for (const entry of entries) {
    if (entry.kind !== 'dicom') continue;
    const { info } = entry;
    // Номер исследования бывает одинаковым у разных людей — ключ с пациентом.
    const key = `${info.study}|${info.patient}|${info.study ? '' : info.date}`;
    if (!studies.has(key)) {
      studies.set(key, {
        patient: info.patient, date: info.date, modality: info.modality,
        description: info.description, files: 0, bytes: 0,
      });
    }
    const study = studies.get(key);
    study.files += 1;
    study.bytes += entry.size;
  }
  for (const entry of entries) {
    if (entry.kind !== 'zip') continue;
    for (const info of entry.infos) {
      const key = `${info.study}|${info.patient}|${info.study ? '' : info.date}`;
      if (studies.has(key)) continue;
      studies.set(key, {
        patient: info.patient, date: info.date, modality: info.modality,
        description: info.description, bytes: entry.size,
      });
    }
  }
  return {
    studies: [...studies.values()],
    archives: entries.filter((e) => e.kind === 'zip' || e.kind === 'opaque')
      .map((e) => ({ name: baseName(e.path), bytes: e.size })),
    files: entries.length,
    bytes: sum(entries),
  };
}
