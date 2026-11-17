'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { once } = require('node:events');
const { Command, InvalidArgumentError } = require('commander');

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
async function start() {
  // Тека кешу створюється ДО початку приймання запитів.
  // recursive: true -> немає помилки, якщо тека вже існує, і створюються батьківські теки.
  await fs.mkdir(CACHE_DIR, { recursive: true });

  const server = http.createServer(handleRequest);
  server.listen(options.port, options.host);

  // Чекаємо на подію 'listening' через проміс (без колбеків).
  // Якщо раніше прийде 'error' (наприклад, EADDRINUSE), проміс буде відхилено.
  await once(server, 'listening');
  console.log(`Сервер працює: http://${options.host}:${options.port}/`);
  console.log(`Тека кешу: ${CACHE_DIR}`);
}

start().catch((err) => {
  console.error(`Не вдалося запустити сервер: ${err.message}`);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// 3. Обробник запитів — єдиний дозволений колбек, async-функція
// ---------------------------------------------------------------------------
async function handleRequest(req, res) {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  sendText(res, 405, 'Ще не реалізовано\n');
}

// ---------------------------------------------------------------------------
// 4. Допоміжні функції
// ---------------------------------------------------------------------------
function sendText(res, status, text, extraHeaders = {}) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    ...extraHeaders,
  });
  res.end(body);
}
