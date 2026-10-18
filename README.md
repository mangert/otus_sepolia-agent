# Sepolia read-only agent

CLI-агент на Node.js, LangChain и `viem` для чтения публичных данных Ethereum
Sepolia и вызова `view`/`pure` функций контрактов. Агент не подписывает и не
отправляет транзакции.

Описание доступных инструментов находится в [docs/tools.md](docs/tools.md).

## Запуск в Docker

Требуются Docker Engine и Docker Compose v2.

1. Создайте локальный файл окружения:

   ```bash
   cp .env.example .env
   ```

2. Укажите в `.env` как минимум:

   ```dotenv
   SEPOLIA_RPC_URL=https://your-sepolia-rpc.example
   GROQ_API_KEY=replace-with-your-groq-api-key
   ```

3. Соберите и запустите сервис:

   ```bash
   docker compose up --build
   ```

   Команда поднимает контейнер с интерактивным CLI. Compose показывает его
   вывод, но не во всех терминалах передаёт контейнеру пользовательский ввод.
   Для обычного диалога удобнее запустить отдельную интерактивную сессию:

   ```bash
   docker compose run --rm agent
   ```

   Один вопрос можно передать аргументом:

   ```bash
   docker compose run --rm agent "Какой последний блок в Sepolia?"
   ```

4. Остановите сервис:

   ```bash
   docker compose down
   ```

Файл `.env` исключён и из Git, и из контекста сборки Docker. В образ попадает
только скомпилированное приложение, production-зависимости и публичная
конфигурация LLM из каталога `config`.

## v2Ray/Xray на Kali Linux

Фиксированного порта v2Ray для Kali нет: он задаётся в `inbounds` конфигурации
конкретного клиента. Приложению нужен именно HTTP- или mixed-вход. SOCKS-вход
нельзя указывать в `HTTP_PROXY`/`HTTPS_PROXY`.

Посмотреть слушающие порты можно так:

```bash
sudo ss -lntp | grep -E 'v2ray|xray'
```

Также проверьте поля `port`, `protocol` и `listen` в конфигурации v2Ray/Xray.
Часто она находится в `/usr/local/etc/v2ray/config.json`,
`/etc/v2ray/config.json` или `/usr/local/etc/xray/config.json`, но путь зависит
от способа установки.

Контейнер не может обратиться к прокси хоста через `127.0.0.1`: внутри
контейнера это его собственный loopback. В `.env` для Docker укажите реальный
порт HTTP/mixed-входа, например:

```dotenv
HTTP_PROXY=http://host.docker.internal:10808
HTTPS_PROXY=http://host.docker.internal:10808
NO_PROXY=localhost,127.0.0.1,your-sepolia-rpc.example
```

Значение `10808` здесь только пример. В `compose.yaml` имя
`host.docker.internal` привязано к шлюзу хоста и поэтому работает в Linux.
Сам v2Ray/Xray должен слушать адрес, доступный из Docker-сети: например,
`0.0.0.0` или IP интерфейса Docker bridge, а не только `127.0.0.1`. Если
используется `0.0.0.0`, ограничьте доступ к порту локальным firewall.

Если Sepolia RPC должен идти напрямую, добавьте hostname RPC-провайдера в
`NO_PROXY`, как показано в примере.

## Запуск без Docker

Требуются Node.js 24 и npm 11:

```bash
npm ci
npm run build
npm start
```
