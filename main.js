'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { once } = require('node:events');
const { Command, InvalidArgumentError } = require('commander');
const superagent = require('superagent');

// ---------------------------------------------------------------------------
// Константи
// ---------------------------------------------------------------------------
const ALLOWED_METHODS = ['GET', 'PUT', 'DELETE'];
const UPSTREAM_URL = 'https://http.cat';
// response — скільки чекати на перший байт відповіді, deadline — на всю відповідь
const UPSTREAM_TIMEOUT = { response: 5000, deadline: 15000 };
// Заголовок, з якого видно, звідки взято картинку
const SOURCE_HEADER = 'X-Image-Source';
// Максимальний розмір тіла PUT-запиту (захист від заповнення пам'яті й диска)
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 МБ

/** Помилка, яка вже "знає" свій код стану HTTP. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// 1. Аргументи командного рядка
// ---------------------------------------------------------------------------
const program = new Command();

program
  .name('caching-proxy')
  .description('Кешуючий проксі-сервер картинок з https://http.cat')
  // -h за замовчуванням зайнято довідкою commander, тому довідку лишаємо лише як --help
  .helpOption('--help', 'показати довідку')
  .requiredOption('-h, --host <address>', 'адреса, на якій працює сервер')
  .requiredOption('-p, --port <number>', 'порт сервера', parsePort)
  .requiredOption('-c, --cache <path>', 'шлях до теки з кешованими картинками')
  .parse(process.argv);

const options = program.opts();
const CACHE_DIR = path.resolve(options.cache);

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    // InvalidArgumentError -> commander виводить повідомлення і завершується з кодом 1
    throw new InvalidArgumentError('порт має бути цілим числом від 0 до 65535');
  }
  return port;
}

// ---------------------------------------------------------------------------
// 2. Запуск сервера
// ---------------------------------------------------------------------------
async function main() {
  try {
    // Тека кешу створюється ДО початку приймання запитів.
    // recursive: true -> немає помилки, якщо тека вже існує; батьківські теки теж створюються.
    await fs.mkdir(CACHE_DIR, { recursive: true });

    const server = http.createServer(handleRequest);
    server.listen(options.port, options.host);

    // Чекаємо на подію 'listening' через проміс (без колбеків).
    // Якщо раніше прийде 'error' (наприклад, EADDRINUSE), проміс буде відхилено.
    await once(server, 'listening');
    console.log(`Сервер працює: http://${options.host}:${options.port}/`);
    console.log(`Тека кешу: ${CACHE_DIR}`);
  } catch (err) {
    console.error(`Не вдалося запустити сервер: ${err.message}`);
    process.exit(1);
  }
}

main();

// ---------------------------------------------------------------------------
// 3. Обробник запитів — єдиний дозволений колбек, async-функція
// ---------------------------------------------------------------------------
async function handleRequest(req, res) {
  const startedAt = Date.now();
  try {
    // Спочатку метод: на недозволений метод відповідаємо 405 незалежно від шляху.
    if (!ALLOWED_METHODS.includes(req.method)) {
      throw new HttpError(405, `Метод ${req.method} не підтримується. Дозволені: ${ALLOWED_METHODS.join(', ')}`);
    }

    const code = parseStatusCode(req.url);
    const file = cacheFilePath(code);

    switch (req.method) {
      case 'GET':
        await handleGet(code, file, res);
        break;
      case 'PUT':
        await handlePut(req, code, file, res);
        break;
      default:
        throw new HttpError(405, `Метод ${req.method} ще не реалізовано`);
    }
  } catch (err) {
    sendError(res, err);
  } finally {
    console.log(`${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - startedAt} мс)`);
  }
}

// ---------------------------------------------------------------------------
// 4. Обробники методів
// ---------------------------------------------------------------------------

/** GET: віддати картинку з кешу, а якщо її немає — взяти з http.cat і закешувати. */
async function handleGet(code, file, res) {
  let image;
  let source;
  try {
    image = await fs.readFile(file);
    source = 'cache';
  } catch (err) {
    if (err.code !== 'ENOENT') throw err; // інша помилка диска -> 500
    image = await fetchFromUpstream(code); // помилка -> HttpError 404, у кеш нічого не пишемо
    await fs.writeFile(file, image); // 1) спочатку зберігаємо в кеш
    source = 'http.cat';
  }
  // 2) потім віддаємо клієнтові
  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': image.length,
    [SOURCE_HEADER]: source,
  });
  res.end(image);
}

/** PUT: записати картинку з тіла запиту в кеш (або замінити наявну). */
async function handlePut(req, code, file, res) {
  const body = await readBody(req, MAX_BODY_SIZE);
  if (body.length === 0) {
    throw new HttpError(400, 'Тіло запиту порожнє: передайте картинку в тілі PUT-запиту');
  }
  await fs.writeFile(file, body); // байти записуються без змін
  sendText(res, 201, `Картинку для коду ${code} збережено в кеш (${body.length} байт)
`);
}

// ---------------------------------------------------------------------------
// 5. Запит до http.cat
// ---------------------------------------------------------------------------

/** Повертає Buffer з картинкою або кидає HttpError(404). */
async function fetchFromUpstream(code) {
  const url = `${UPSTREAM_URL}/${code}`;
  let response;
  try {
    response = await superagent.get(url).timeout(UPSTREAM_TIMEOUT);
  } catch (err) {
    if (err.status) {
      // сервер відповів кодом 4xx/5xx — картинки для такого коду немає
      throw new HttpError(404, `Картинку для коду ${code} не знайдено ні в кеші, ні на http.cat (http.cat відповів ${err.status})`);
    }
    if (err.timeout) {
      throw new HttpError(404, `Картинку для коду ${code} не отримано: http.cat не відповів вчасно`);
    }
    // помилка мережі: ENOTFOUND, ECONNREFUSED, ECONNRESET ...
    throw new HttpError(404, `Картинку для коду ${code} не отримано: помилка з'єднання з http.cat (${err.code || err.message})`);
  }

  // superagent у Node.js для image/* сам збирає тіло в Buffer (response.body)
  if (!Buffer.isBuffer(response.body) || response.body.length === 0) {
    throw new HttpError(404, `http.cat повернув для коду ${code} не картинку (${response.type})`);
  }
  return response.body;
}

// ---------------------------------------------------------------------------
// 6. Допоміжні функції
// ---------------------------------------------------------------------------

/**
 * Перевіряє шлях і повертає код стану у вигляді рядка з 3 цифр.
 * Дозволено лише "/NNN" (можна з кінцевим "/" і query-рядком, він ігнорується).
 * Тому ні "..", ні "/", ні інші символи не можуть потрапити в ім'я файлу.
 */
function parseStatusCode(url) {
  const { pathname } = new URL(url, 'http://localhost');
  const match = /^\/(\d{3})\/?$/.exec(pathname);
  if (!match) {
    throw new HttpError(400, `Неправильний шлях "${pathname}". Очікується /<код стану з 3 цифр>, наприклад /404`);
  }
  return match[1];
}

/**
 * Читає все тіло запиту в один Buffer.
 * req — це потік (Readable), а потоки підтримують асинхронну ітерацію:
 * for await ... of отримує шматки (chunk) по мірі надходження, без колбеків.
 */
async function readBody(req, limit) {
  const declared = Number(req.headers['content-length']);
  if (declared > limit) {
    throw new HttpError(413, `Тіло запиту завелике: ${declared} байт, максимум ${limit}`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw new HttpError(413, `Тіло запиту завелике: більше ніж ${limit} байт`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

/** Шлях до файлу кешу: <тека кешу>/<код>.jpg */
function cacheFilePath(code) {
  return path.join(CACHE_DIR, `${code}.jpg`);
}

function sendText(res, status, text, extraHeaders = {}) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    ...extraHeaders,
  });
  res.end(body);
}

/** Перетворює будь-яку помилку на HTTP-відповідь; сервер після цього працює далі. */
function sendError(res, err) {
  const isHttpError = err instanceof HttpError;
  const status = isHttpError ? err.status : 500;
  const message = isHttpError ? err.message : 'Внутрішня помилка сервера';
  if (!isHttpError) console.error(err);

  // Якщо заголовки вже пішли клієнтові, правильну відповідь надіслати неможливо —
  // просто обриваємо з'єднання, щоб клієнт побачив, що відповідь неповна.
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const headers = status === 405 ? { Allow: ALLOWED_METHODS.join(', ') } : {};
  sendText(res, status, `${message}\n`, headers);
}
