# Agentic core contract v1

This doc describes the frozen API in `agentic-core.d.ts`. Every pack
builds against that file unchanged. The code in `src/core.ts` carries
the same API, and `src/contract.test.ts` pins the two together.

## Brand config

`defineBrand` takes a name, a command, a description, keywords, and a
version. It returns a frozen copy. It throws when the name, the
command, or the version is empty. Each pack defines one brand and
reuses it in all three faces.

## Logger

`createLogger` takes a level, a quiet flag, and a sink. Levels run
from debug to error. The quiet flag silences all output. The sink
defaults to stderr, so logs never mix with result output on stdout.

## Guards

`createGuards` takes caps, quiet hours, a blocklist, and a clock.

- Caps set `maxDispatches`. The guard throws `GuardError` when the
  count reaches the cap.
- Quiet hours set a UTC window from `startHour` to `endHour`. The
  guard throws inside the window. A window past midnight wraps.
- The blocklist holds banned terms. The guard throws when the text
  contains one, without regard to case.
- The clock defaults to the real clock. Tests pass a fixed clock.

`checkDispatch` throws on the first failed rule. `recordDispatch`
counts one real dispatch. `dispatchCount` reads the count. Dry runs
never count.

## Router adapters

A `RouterAdapter` delivers one text and returns a receipt with the
adapter name, an id, a char count, and a timestamp.

Adapters throw `VendorError` on failure. They never swallow a
failure and return success. The local adapter delivers in memory
and needs no key. The HTTP adapter posts JSON to an endpoint and
throws on network errors and on non-2xx status codes.

## Dispatch entry

`dispatchText` takes a text and options for the adapter, the guards,
the logger, and dry run mode. It checks guards first, then routes,
then records cost. A denied guard or a failed adapter throws, and
no cost is recorded. `createDryRunResult` shapes the dry run reply.

## Dry run

Pass `dryRun: true` to preview a dispatch. Dry run checks guards,
calls no adapter, records no cost, and returns the preview. Use it
before any real dispatch in scripts and in agent loops.

## Cost report

`recordCost` adds one entry. `getCostReport` returns entries plus
dispatch and unit totals. `resetCosts` clears the store. Each real
dispatch records one entry with its adapter and char count.

## Summarize

`summarizeText` counts chars, words, and lines, and ranks the top
words by count, then by name. It is pure and takes no options
beyond `topN`.

## Errors

`GuardError` carries code `GUARD_DENIED`. `VendorError` carries
code `VENDOR_FAILED` and the HTTP status when one exists. Both
extend Error. The CLI and the MCP server report them and exit or
reply with failure. They never pass as success.

## Change rule

This contract is frozen at v1. To change it: raise the version,
write the migration note here, and update all packs in one pass.
No pack may extend the core API on its own.
