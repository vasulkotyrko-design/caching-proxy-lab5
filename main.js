'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { once } = require('node:events');
const { Command, InvalidArgumentError } = require('commander');

// ---------------------------------------------------------------------------
// Константи
// ---------------------------------------------------------------------------
const ALLOWED_METHODS = ['GET', 'PUT', 'DELETE'];

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
// 4. Допоміжні функції
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
