# AGENTS.md

## Project context

This repository contains a Node.js AI agent built with LangChain. Its purpose is
to answer questions using public data from the Ethereum Sepolia test network and
to call read-only functions on deployed smart contracts.

The project is intentionally read-only at this stage. Do not add transaction
signing, wallet management, token transfers, contract deployment, or calls that
change blockchain state unless the user explicitly expands the scope.

## Product goals

- Accept a natural-language request from a user.
- Decide which supported blockchain tool or contract read method to use.
- Query Sepolia through standard Ethereum JSON-RPC calls.
- Read public chain data such as balances, blocks, transactions, receipts, logs,
  bytecode, gas estimates, and network metadata when relevant.
- Call `view` and `pure` contract functions when an ABI and contract address are
  available.
- Return a concise answer with enough structured evidence to verify the result,
  including addresses, transaction hashes, block numbers, and raw values where
  useful.
- Keep normal development and supported runtime usage free of paid blockchain
  APIs. Public RPC endpoints may be used, but the endpoint must be configurable.

## Preferred stack

- Node.js on the current active LTS release.
- TypeScript with strict type checking.
- LangChain JS (`@langchain/*`) for agent and tool orchestration.
- `viem` for Ethereum JSON-RPC access, ABI typing, address validation, unit
  formatting, and contract reads. Use `ethers` only if an existing implementation
  already depends on it or there is a concrete compatibility need.
- A lightweight environment loader and schema validator for configuration.
- The repository's selected package manager and lockfile are authoritative once
  they exist; do not introduce a second package manager.

Do not assume these dependencies are already installed. Inspect `package.json`
and the lockfile before adding or invoking packages.

## Architecture guidelines

Keep blockchain access separate from agent reasoning:

1. Configuration validates environment variables and exposes typed settings.
2. A Sepolia client owns all JSON-RPC communication.
3. Small, explicit LangChain tools wrap supported read operations.
4. Contract utilities validate addresses, ABI fragments, function mutability,
   arguments, and returned values.
5. The agent selects tools and explains their results; it must not invent data
   when a tool fails or returns no result.

Prefer deterministic tools with narrow schemas over one unrestricted
"execute arbitrary RPC" tool. Use Zod schemas for tool inputs and produce
JSON-serializable outputs. Keep prompts separate from transport and chain logic.

## Sepolia and RPC rules

- The expected chain is Ethereum Sepolia, chain ID `11155111`.
- Read the RPC URL from an environment variable such as `SEPOLIA_RPC_URL`.
- Never hard-code API keys or provider credentials.
- Verify the connected chain ID and fail clearly if the endpoint is not Sepolia.
- Add reasonable request timeouts and actionable errors.
- Be mindful that free public RPC endpoints can rate-limit, lag, or reject large
  log ranges. Bound requests and paginate or split ranges when appropriate.
- Do not silently switch networks or providers.
- Avoid nondeterministic live-network calls in the default unit test suite.

## Contract read safety

- Validate every user-supplied Ethereum address before use.
- Permit contract calls only for ABI functions declared `view` or `pure`.
- Reject payable and nonpayable functions even if someone claims the call will be
  simulated.
- Handle overloaded function names explicitly by their full signature.
- Validate argument count and types against the selected ABI function.
- Never request, load, log, or expose private keys, seed phrases, or keystore
  contents for read-only features.
- Do not add a wallet client or signer for read operations.
- Preserve integer precision with `bigint`; convert it explicitly when returning
  JSON or displaying values.
- Treat token symbols, names, and decimals as untrusted contract output.
- Clearly distinguish wei from formatted ETH or token units.

## Reliability and agent behavior

- Blockchain tool output is authoritative over the language model's prior
  knowledge.
- Never fabricate a block, transaction, contract ABI, function result, or RPC
  response.
- If an ABI is missing, ask for it or use a verified source only when that source
  is explicitly supported and the lookup is transparent.
- Report RPC failures, reverts, rate limits, invalid inputs, and unsupported
  operations in user-friendly language while retaining the useful technical
  cause.
- For time-sensitive answers, include the observed block number when possible.
- Normalize addresses for display, but do not alter hashes or returned byte data.
- Put upper bounds on model-driven arrays, block ranges, log queries, and output
  sizes.

## Code conventions

- Prefer small modules and named exports.
- Keep TypeScript strict; avoid `any`. Use `unknown` plus validation at external
  boundaries.
- Use async/await and preserve original error causes when wrapping errors.
- Keep provider-specific code behind a small interface so public RPC endpoints
  can be changed without modifying agent tools.
- Do not log secrets, full environment objects, or unnecessarily large RPC
  payloads.
- Add comments only where they explain a non-obvious decision or blockchain
  constraint.
- Follow the formatter, linter, test runner, directory layout, and naming style
  already present in the repository. If none exist, establish them consistently
  as part of the initial scaffold.

## Testing expectations

- Unit-test input schemas, address validation, unit conversion, ABI selection,
  overloaded functions, and rejection of state-changing methods.
- Mock the JSON-RPC transport for deterministic success, revert, timeout,
  malformed-response, and rate-limit cases.
- Test LangChain tools independently from the full agent loop.
- Keep live Sepolia checks in a separate opt-in integration suite guarded by the
  presence of `SEPOLIA_RPC_URL`; they must not be required for ordinary tests.
- Never put real credentials in fixtures, snapshots, source files, or examples.
- Before finishing a change, run the available formatting, linting, type-checking,
  and test commands defined by `package.json`.

## Documentation and configuration

- Maintain `.env.example` with placeholder values only.
- Document setup, supported tools, required environment variables, limitations,
  and example questions in the README.
- Keep ABI examples minimal and record their network and contract address.
- When adding a new blockchain operation, document its input, output, RPC method,
  bounds, and failure modes.

## Scope discipline

Do not introduce databases, vector stores, web search, paid services, custodial
wallets, or write-capable blockchain features without a demonstrated requirement.
Favor the smallest implementation that makes the current read-only agent more
correct, testable, and understandable.

## Instructions for future agents

Before editing:

1. Read this file and the nearest nested `AGENTS.md`, if one exists.
2. Inspect `package.json`, lockfiles, TypeScript configuration, and existing tests.
3. Preserve user changes and avoid unrelated rewrites.

After editing:

1. Validate the smallest relevant unit first, then run the broader available
   checks.
2. State which checks ran and whether any live Sepolia call was made.
3. Call out assumptions, remaining risks, and any RPC-dependent behavior.
