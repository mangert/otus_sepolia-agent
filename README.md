# Sepolia read-only agent

Консольный AI-агент на Node.js, TypeScript, LangChain и `viem` для чтения
публичных данных Ethereum Sepolia. Пользователь задаёт вопрос на естественном
языке, агент выбирает подходящий инструмент, выполняет JSON-RPC-запрос и
возвращает краткий ответ с проверяемыми данными.

Проект работает только в сети Sepolia с chain ID `11155111`. Он не создаёт
кошельки, не запрашивает приватные ключи, не подписывает и не отправляет
транзакции.

## Возможности

- получение номера актуального блока и проверка сети;
- чтение нативного баланса Sepolia ETH;
- чтение баланса ERC-20 по адресу токен-контракта и адресу владельца;
- получение блока по номеру, хэшу или идентификатору `latest`;
- чтение транзакции и её receipt;
- проверка bytecode контракта;
- чтение логов контракта в ограниченном диапазоне блоков;
- вызов функций контрактов с mutability `view` или `pure` по предоставленному
  ABI;
- интерактивный диалог с краткой историей текущей CLI-сессии;
- запуск локально или в Docker.

Подробные схемы входов, результаты, RPC-методы и ограничения каждого
инструмента описаны в [docs/tools.md](docs/tools.md).

## Как устроен проект

```text
Пользователь
    ↓
CLI → LangChain-агент → read-only инструменты → viem → Sepolia JSON-RPC
             ↓
     OpenAI-compatible LLM
```

- `src/config` загружает и валидирует `.env` и JSON-конфигурацию LLM;
- `src/network` настраивает исходящий HTTP/HTTPS-прокси;
- `src/blockchain` создаёт read-only клиент Sepolia;
- `src/contracts` проверяет ABI, сигнатуры, mutability и аргументы;
- `src/tools` содержит детерминированные blockchain-операции и LangChain
  Structured Tools;
- `src/agent` создаёт модель, системный промпт и агентный цикл;
- `src/cli.ts` реализует однократный и интерактивный режимы;
- `tests` содержит opt-in live-тесты RPC и LLM.

## Требования

Для запуска в Docker:

- Docker Engine;
- Docker Compose v2.

Для локального запуска:

- Node.js 24;
- npm 11 или новее в пределах совместимости Node.js 24.

Также понадобятся:

- URL Ethereum Sepolia JSON-RPC;
- API-ключ Groq для конфигурации LLM по умолчанию;
- HTTP/mixed-прокси, если прямой доступ к LLM-провайдеру ограничен.

## Быстрый запуск в Docker

Клонируйте проект и создайте локальный файл окружения:

```bash
git clone https://github.com/mangert/otus_sepolia-agent.git
cd otus_sepolia-agent
cp .env.example .env
```

Заполните как минимум эти значения:

```dotenv
SEPOLIA_RPC_URL=https://your-sepolia-rpc.example
GROQ_API_KEY=replace-with-your-groq-api-key
```

Проверьте Compose-конфигурацию и соберите образ:

```bash
docker compose config --quiet
docker compose build
```

Для интерактивного CLI используйте:

```bash
docker compose run --rm agent
```

Пример сессии:

```text
Sepolia read-only agent. Type /exit to quit.
sepolia> What is the number of the latest block on the Sepolia network?
The latest block on Sepolia is ...
sepolia> /exit
Goodbye.
```

Один вопрос можно передать аргументом:

```bash
docker compose run --rm agent "Какой последний блок в Sepolia?"
```

Стандартный запуск сервиса через Compose:

```bash
docker compose up --build
```

`docker compose up` показывает вывод контейнера, но некоторые терминалы не
передают ввод интерактивному CLI. Для диалога надёжнее использовать
`docker compose run --rm agent`.

Остановка и удаление созданных Compose-контейнеров и сети:

```bash
docker compose down
```

Файл `.env` исключён из Git и из контекста Docker-сборки. В образ попадают
скомпилированное приложение, production-зависимости и публичная конфигурация из
каталога `config`.

## Настройка `.env`

| Переменная                 | Обязательность                       | Значение по умолчанию      | Назначение                                      |
| -------------------------- | ------------------------------------ | -------------------------- | ----------------------------------------------- |
| `SEPOLIA_RPC_URL`          | да                                   | —                          | HTTP/HTTPS endpoint Ethereum Sepolia JSON-RPC   |
| `GROQ_API_KEY`             | для провайдера `groq`                | —                          | API-ключ Groq                                   |
| `LLM_CONFIG_PATH`          | нет                                  | `config/llm.config.json`   | Путь к JSON-конфигурации LLM                    |
| `OPENCODE_LLM_PROXY_TOKEN` | для защищённого `opencode-llm-proxy` | —                          | Bearer token локального LLM-прокси              |
| `HTTP_PROXY`               | нет                                  | —                          | HTTP-прокси для исходящих HTTP-запросов         |
| `HTTPS_PROXY`              | нет                                  | —                          | HTTP-прокси для исходящих HTTPS-запросов        |
| `NO_PROXY`                 | нет                                  | —                          | Адреса, которые должны обходить прокси          |
| `TZ`                       | нет                                  | часовой пояс среды запуска | IANA timezone для ответов о текущей дате        |
| `RPC_TIMEOUT_MS`           | нет                                  | `10000`                    | Тайм-аут RPC-запроса, от 1000 до 120000 мс      |
| `RPC_MAX_RETRIES`          | нет                                  | `2`                        | Количество повторов RPC-запроса, от 0 до 5      |
| `RPC_MAX_LOG_BLOCK_RANGE`  | нет                                  | `2000`                     | Настройка предельного диапазона логов, до 10000 |
| `RPC_MAX_BATCH_SIZE`       | нет                                  | `20`                       | Резервный лимит batch-операций, от 1 до 100     |

Пример:

```dotenv
SEPOLIA_RPC_URL=https://your-sepolia-rpc.example
TZ=Europe/Amsterdam

LLM_CONFIG_PATH=config/llm.config.json
GROQ_API_KEY=replace-with-your-groq-api-key

RPC_TIMEOUT_MS=10000
RPC_MAX_RETRIES=2
RPC_MAX_LOG_BLOCK_RANGE=2000
RPC_MAX_BATCH_SIZE=20
```

Не добавляйте `.env` в Git и не вставляйте реальные ключи в `.env.example`,
исходный код, тесты или отчёты.

## Конфигурация LLM

По умолчанию используется `config/llm.config.json`:

```json
{
  "provider": "groq",
  "protocol": "openai-compatible",
  "baseUrl": "https://api.groq.com/openai/v1",
  "model": "qwen/qwen3.8-27b",
  "timeoutMs": 60000,
  "maxRetries": 2
}
```

Поддерживаются два значения `provider`:

- `groq` — требует `GROQ_API_KEY`;
- `opencode-llm-proxy` — локальный OpenAI-compatible endpoint; bearer token
  необязателен и читается из `OPENCODE_LLM_PROXY_TOKEN`.

Несекретные настройки модели хранятся отдельно от ключей. Доступность
конкретной бесплатной модели и её rate limits определяются LLM-провайдером и
могут изменяться.

## Прокси и v2RayN на Kali Linux

Внутри контейнера `127.0.0.1` указывает на сам контейнер, а не на Kali. Поэтому
контейнер обращается к v2RayN через `host.docker.internal`. В `compose.yaml` это
имя сопоставлено со шлюзом хоста с помощью `host-gateway`.

В v2RayN откройте `Settings → Option settings → Core: basic settings`:

1. Проверьте `Local mixed listening port`, например `10808`.
2. Включите `Allow connections from the LAN`.
3. Проверьте настройку `New port for LAN` и порт в статусе `LAN: [mixed:...]`.
4. Перезапустите core v2RayN.

Mixed-вход принимает и HTTP, и SOCKS5, но в `.env` приложение передаёт его как
HTTP-прокси. Если отдельный LAN-порт выключен, это может быть `10808`. Если он
включён, v2RayN обычно использует отдельный порт; при базовом `10808` это может
быть `10810`. Ориентируйтесь на статус v2RayN и вывод команды:

```bash
sudo ss -lntp | grep -E '10808|10810|v2ray|xray'
```

Прокси должен слушать `0.0.0.0`, `[::]` или другой адрес, доступный из
Docker-сети. Если он слушает только `127.0.0.1`, контейнер подключиться не
сможет.

Пример для LAN-порта `10810`:

```dotenv
HTTP_PROXY=http://host.docker.internal:10810
HTTPS_PROXY=http://host.docker.internal:10810
NO_PROXY=localhost,127.0.0.1,your-sepolia-rpc.example
```

В `HTTPS_PROXY` также используется схема `http://`: локальный HTTP-прокси
создаёт туннель к HTTPS-адресу. В `NO_PROXY` указываются hostname без схемы и
пути. Если Sepolia RPC тоже должен идти через прокси, не добавляйте его hostname
в `NO_PROXY`.

Проверка доступности LAN-порта `10810` из контейнера:

```bash
docker compose run --rm --entrypoint node agent \
  -e "const net=require('node:net');const s=net.connect(10810,'host.docker.internal',()=>{console.log('Proxy is reachable');s.end()});s.on('error',e=>{console.error(e.message);process.exit(1)})"
```

При публикации прокси на `0.0.0.0` ограничьте доступ к нему локальным firewall и
используйте эту настройку только в доверенной сети.

Если прокси не нужен, не задавайте `HTTP_PROXY`, `HTTPS_PROXY` и `NO_PROXY`.

## Запуск без Docker

Установите зависимости и создайте `.env`:

```bash
npm ci
cp .env.example .env
```

Интерактивный режим разработки:

```bash
npm run dev
```

Однократный запрос без предварительной сборки:

```bash
npm run dev -- "Какой последний блок в Sepolia?"
```

Production-сборка и запуск:

```bash
npm run build
npm start
```

Однократный запрос собранному приложению:

```bash
npm start -- "Проверь chain ID и актуальный блок Sepolia"
```

Справка CLI:

```bash
npm run dev -- --help
```

Команды `/exit`, `exit` и `quit` завершают интерактивную сессию.

## Инструменты агента

| Инструмент                | Назначение                                         |
| ------------------------- | -------------------------------------------------- |
| `get_chain_info`          | Chain ID, актуальный блок и состояние подключения  |
| `get_native_balance`      | Баланс Sepolia ETH в wei и ETH                     |
| `get_erc20_balance`       | ERC-20 баланс и доступные метаданные токена        |
| `get_block`               | Сводка блока по номеру, хэшу или `latest`          |
| `get_transaction`         | Основные данные транзакции по хэшу                 |
| `get_transaction_receipt` | Статус выполнения, gas usage и сводка логов        |
| `get_contract_code`       | Наличие, размер, hash и preview bytecode           |
| `get_logs`                | Логи одного контракта в ограниченном диапазоне     |
| `read_contract`           | Вызов одной ABI-функции с mutability `view`/`pure` |

Для ERC-20 необходимо передать адрес контракта токена и адрес владельца. Одного
символа вроде `USDC` недостаточно: в тестовой сети могут существовать разные
контракты с одинаковым символом. Стандартный ABI для `balanceOf(address)`,
`decimals()` и `symbol()` уже встроен в `get_erc20_balance`.

Для произвольного `read_contract` нужны адрес контракта, ABI и полная сигнатура
функции, например `balanceOf(address)`. Агент не ищет ABI в интернете.

## Примеры запросов

Общие данные сети:

```text
Какой номер последнего блока Sepolia?
Проверь, что RPC подключён к Sepolia, и покажи chain ID.
```

Балансы:

```text
Какой нативный баланс адреса 0x...?
Какой баланс ERC-20 токена с контрактом 0xTOKEN у кошелька 0xOWNER?
Покажи raw и форматированный баланс токена на блоке 11900000.
```

Блоки и транзакции:

```text
Покажи сводку блока 11900000.
Найди транзакцию 0xTRANSACTION_HASH.
Успешно ли выполнилась транзакция 0xTRANSACTION_HASH и сколько gas она использовала?
```

Контракты и логи:

```text
Есть ли bytecode у адреса 0xCONTRACT?
Покажи логи контракта 0xCONTRACT с блока 11900000 по 11900100.
Вызови symbol() у контракта 0xCONTRACT с ABI [вставьте ABI].
```

Адреса и хэши в примерах нужно заменить полными значениями Ethereum с префиксом
`0x`.

## Безопасность и read-only ограничения

- Каждый blockchain-инструмент проверяет chain ID и отклоняет endpoint другой
  сети.
- В приложении нет signer, wallet client и функций отправки транзакций.
- `read_contract` разрешает только ABI-функции `view` и `pure`; `payable` и
  `nonpayable` отклоняются до RPC-вызова.
- Все пользовательские адреса, хэши, ABI, сигнатуры и аргументы валидируются.
- Большие целые значения сохраняются как `bigint` и возвращаются строками без
  потери точности.
- Агент различает wei, ETH, raw token units и форматированные значения.
- RPC-результат считается авторитетнее знаний языковой модели.
- Ошибки RPC, revert, timeout, rate limit и неправильная сеть не скрываются.
- CLI очищает сообщения об ошибках от URL и похожих на секреты значений.

Не передавайте приложению приватные ключи, seed-фразы или keystore-файлы: они не
нужны ни для одной поддерживаемой функции.

## Ограничения

- Поддерживается только Ethereum Sepolia.
- Бесплатные RPC могут ограничивать частоту запросов, задерживать данные,
  отклонять большие диапазоны логов или временно быть недоступными.
- Запрос логов ограничен по диапазону и размеру результата; крупные диапазоны
  нужно разбивать на несколько запросов.
- Бесплатная модель Groq имеет собственные лимиты запросов и токенов. Ответ
  `429` означает исчерпание квоты или необходимость повторить запрос позже.
- Доступность и название бесплатной LLM могут измениться; модель задаётся в
  `config/llm.config.json`.
- Агент не ищет адреса токенов и ABI в интернете и не считает символ токена
  уникальным идентификатором.
- История хранится только в памяти текущей интерактивной CLI-сессии и
  ограничена последними сообщениями. После выхода она теряется.
- Данные `latest` меняются между запросами. Для воспроизводимого чтения следует
  указывать конкретный номер блока.

## Проверки и тесты

Основная проверка проекта:

```bash
npm run check
npm run build
```

`npm run check` последовательно запускает проверку форматирования, ESLint,
TypeScript и unit-тесты. Unit-тесты используют mock-клиенты и не зависят от
живой сети.

Доступные команды:

```bash
npm run format
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:watch
npm run build
```

Opt-in live-тесты используют значения из `.env`:

```bash
npm run test:integration
npm run test:integration:llm
```

- `test:integration` проверяет chain ID, актуальный блок, нативный баланс,
  ERC-20 баланс и `view`-вызов через настоящий Sepolia RPC;
- `test:integration:llm` проверяет реальный ответ Groq и tool call через
  LangChain.

Live-тесты не входят в обычный `npm test`, чтобы результат unit-тестов не
зависел от сети, квот LLM или состояния публичного RPC.
