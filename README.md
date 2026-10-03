# dsh-plugin-jev-compaction

Jev-scored context compaction for DeepSeek Harness. Keep the messages that matter, compact the ones that do not.

## Why this exists

When a context window fills, the harness compacts by age. The oldest messages
go first, either summarized or dropped outright. That ordering is uncorrelated
with what the work needs.

A session that has been running for an hour looks like this.

```
turn  2  user       "do not change the public API of the parser"      <- dropped
turn  7  user       Traceback ... File "src/ingest/parser.py", line 118 <- dropped
turn 11  assistant  "the fix belongs in src/ingest/parser.py"          <- dropped
turn 31  user       "ok sounds good"
turn 32  assistant  "running the tests now"                            <- kept
```

Three messages that later steps depend on are gone, because they are old. The
small talk from a minute ago survives, because it is recent. Recovery costs a
re-read of the repository, or worse, a confident answer built on a constraint
that is no longer in context.

Age is a proxy for relevance that stops working the moment a session has a
long horizon. Jev scores the messages directly. TypeSafe System One answers a
typed question about a state in a single forward pass and generates no output
tokens, so a message can be scored for a fraction of the cost of a completion.
Age is left where it belongs, as a tiebreaker.

## Age-based compared with Jev-scored

| | Age-based (stock) | Jev-scored |
| --- | --- | --- |
| Ordering signal | position in the transcript | relevance to the current task |
| A constraint stated early | dropped once it is old enough | kept, and pinned when it reads as a constraint |
| The traceback behind the current failure | dropped before the failure is resolved | kept verbatim, and pinned |
| Small talk from the last turn | kept | dropped when the budget is tight |
| A message the endpoint is unsure about | no such state | kept by the confidence gate |
| Decision cost | zero | one typed question per message, no output tokens |
| When the endpoint is unreachable | not applicable | recency ordering, identical to stock |

## Install

```sh
dsh plugin --profile your-profile add dsh-plugin-jev-compaction
```

Or from npm:

```sh
npm install dsh-plugin-jev-compaction
```

The plugin needs `JEV_API_KEY` in the environment. Everything else has a
working default.

```sh
export JEV_API_KEY=...
```

## How it works

1. **Segment.** Each message is reduced to text, a byte count, and a SHA-256
   hash. Tool-call messages, content-part arrays, and plain strings all pass
   through the same extractor.
2. **Protect.** System messages, the last `keepRecent` messages, and anything
   matching a pin pattern are kept verbatim and are never scored.
3. **Score.** The remaining messages are packed into batches. One batch becomes
   one state block, and Jev is asked one `score` question per message, so a
   batch of eight costs one request rather than eight.
4. **Gate.** An answer below `minConfidence` means the endpoint is unsure, not
   that the message is disposable. Doubt resolves toward keeping the message.
5. **Select.** Messages are ranked by value, with recency breaking ties, and
   kept verbatim until the byte budget is spent.
6. **Digest.** What did not fit is replaced by one extractive digest placed
   where the first dropped message sat. The digest quotes the highest-value
   omitted messages in value order, and is sized at a quarter of the remaining
   budget, capped by `summaryBytes`.

Byte accounting uses UTF-8 bytes on the full message text, while the state sent
to Jev truncates each message to `stateMessageBytes`. Scoring sees a bounded
prefix of a long message, and the budget is still measured on the whole of it.

### Score reduction

The request body is `{state, question, type: 'score', levels}`. `question` is a
string for a single message and an array for a batch. A response carrying
`probabilities` over the levels reduces to the expected value over evenly
spaced ranks, and the confidence is the peak probability. A response carrying a
chosen `level` or a direct `score` is accepted as well. Anything that cannot be
reduced to a value in [0, 1] is treated as a failure.

### Pinning

Pins are deterministic and override the score. Five patterns ship by default.

| Pattern | Covers |
| --- | --- |
| File paths | `src/ingest/parser.py`, `C:\app\main.ts`, `configs/run.yaml` |
| Stack traces | Python tracebacks, `File "...", line N`, `at fn (file:1:2)` |
| Error codes | `HTTP 429 Too Many Requests`, `HTTP 500`, `status: 503`, `0x8007` |
| URLs | anything starting `http://` or `https://` |
| Constraints | `you must`, `do not`, `never`, `always`, `Important:`, `Note:` at the start of a line or sentence |

`pinPatterns` appends to these. `enablePinning: false` turns pinning off
entirely. Patterns are compiled with the `i` flag, and `pinFlags` changes that.
Errno-style constants such as `ENOENT` are uppercase-only matches, so they need
a case sensitive pattern and `pinFlags: ''`.

### Fallbacks

Compaction never throws and never leaves the message list unusable.

- A batch that fails is scored by recency instead, and the run is reported as degraded.
- If every batch fails, or the API key is missing, the run is age-based, which is the stock behavior.
- A failed or unwritable receipt path is reported in the stats and does not affect the result.
- Network errors, timeouts, non-200 responses, and unparseable bodies are all handled the same way.
- Protected messages are never dropped, so a run whose protected set alone exceeds `targetBytes` keeps them and reports the overage in `overBudgetBytes`.

### Receipts

Setting `receiptPath` writes one JSON line per message with the content hash,
the score, the confidence, the keep or drop decision, and the reason, followed
by a summary line for the run. Receipts are written when a run actually
compacts, so an under-budget turn writes nothing.

The recorded scores can be replayed through a different budget or confidence
threshold at zero inference cost.

```sh
jev-compact compact messages.jsonl --target-bytes 60000 --scores receipts.jsonl
```

Replay matches on content hash, so it survives a message list that has shifted
since the receipt was written.

### Harness integration

The plugin registers a policy section in the system prompt and publishes its
non-secret settings through the shell environment. It also probes for a
compaction service at `ctx.compaction` and `ctx.prune`, and registers a
`compact(messages, task)` hook when it finds one.

The core function is exported, so the harness, a test, or another plugin can
call it directly when no compaction service is present:

```ts
import { compactMessages } from 'dsh-plugin-jev-compaction'

const result = await compactMessages(messages, 'finish the parser fix', {
  targetBytes: 65536,
  keepRecent: 6,
})
```

## Configuration

```yaml
- id: jev-compaction
  name: dsh-plugin-jev-compaction
  inject: []
  config:
    targetBytes: 262144
    keepRecent: 4
    batchSize: 8
    minConfidence: 0.35
    summaryBytes: 1024
    enablePinning: true
    receiptPath: ~/.dsh/jev-compaction/receipts.jsonl
```

| Option | Default | Meaning |
| --- | --- | --- |
| `targetBytes` | `262144` | Output byte budget |
| `keepRecent` | `4` | Trailing messages kept verbatim whatever they score |
| `batchSize` | `8` | Messages per Jev request |
| `minConfidence` | `0.35` | Below this, a message is kept out of caution |
| `summaryBytes` | `1024` | Cap on the digest that replaces dropped messages |
| `summaryRole` | `system` | Role of the digest message |
| `stateMessageBytes` | `2000` | Bytes of each message included in the Jev state |
| `pinPatterns` | `[]` | Extra pin patterns, appended to the built-in five |
| `enablePinning` | `true` | Set false to disable pinning |
| `pinFlags` | `i` | Flags used to compile pin patterns |
| `endpoint` | `JEV_API_URL` | Jev endpoint |
| `apiKey` | `JEV_API_KEY` | Jev API key |
| `timeoutMs` | `15000` | Per-request timeout |
| `levels` | `none, low, medium, high, critical` | Ordered score labels sent to Jev |
| `pricePerMillionTokens` | `0.1` | Input price used for the cost estimate |
| `receiptPath` | disabled | JSONL decision receipt path, also read from `DSH_JEV_COMPACT_RECEIPT` |
| `task` | generic continuation prompt | Task description sent to Jev |
| `runId` | generated | Identifier written into receipts |

The API key is not published to the shell environment.

## CLI

```
jev-compact score <file.jsonl>     Score messages and print a value table
jev-compact compact <file.jsonl>   Compact a conversation, JSONL on stdout
jev-compact receipts <path>        Summarise a decision receipts file
jev-compact doctor                 Check endpoint, key and effective config
```

Input accepts a JSON array, an object with a `messages` array, or one JSON
object per line. `compact` writes the compacted conversation to stdout and its
stats to stderr, so it composes with a pipe. Messages that survive are the
original objects, unchanged.

```sh
jev-compact score session.jsonl --batch-size 8
jev-compact compact session.jsonl --target-bytes 64000 --receipt run.jsonl
jev-compact receipts run.jsonl
jev-compact doctor --probe
```

`doctor` masks the key, reports endpoint reachability, and with `--probe`
sends one live score request to confirm the wire format end to end.

## Cost

Scoring is input-only. System One generates no output tokens, so the cost of a
run is the size of the state blocks, at four bytes per token. The default
`pricePerMillionTokens` of `0.1` is a placeholder for whatever the endpoint
charges, and the estimate printed by the CLI and recorded in the stats uses it.
A 24 message conversation compacted in the tests above scored in two requests
and an estimated `$0.0003`.

The saving is not the point. The point is that a message which would have cost
a repository re-read to recover gets kept for a fraction of a cent.

## Related projects

- [metajev](https://github.com/YYTbit/metajev) -- the general form of the scoring this plugin does per message. Decisions are keyed by state, question, and model; thresholds live in a policy that reads the record, so a different keep/drop boundary costs no model calls.
- [dsh-plugin-jev-router](https://github.com/YYTbit/dsh-plugin-jev-router) -- the other end of the same context problem. That plugin decides which model serves a turn; this one decides which messages survive to reach it.
- [dsh-plugin-meta-memory](https://github.com/YYTbit/dsh-plugin-meta-memory) produces the brief and full memory pairs that this plugin then defends against compaction.
- TypeSafe System One, the model behind the scoring endpoint, answered at `https://api.typesafe.ai/v1/systemone`.

## License

MIT -- YYTbit
