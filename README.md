# gemini-code

A Claude-Code-style terminal coding agent that runs on the **Gemini web UI**, for
people who have a Gemini web subscription but no Gemini API or CLI access.

It drives a real, logged-in Chrome tab with Playwright: your prompt goes into the
composer, Gemini's reply is parsed back out, and any tools it asks for run
**locally on your machine**.

```
✻ gemini-code — Claude-Code-style agent on the Gemini web UI

  cwd     my-project
  model   Flash
  context project tree (41 lines), GEMINI.md, 1 doc (README.md)
  tools   read_file, write_file, run_bash, list_files, remember, fetch_url, delegate_tasks, update_plan
  workers up to 3 parallel Gemini tabs
  mode    orchestrator — main tab plans & validates, workers implement

› read package.json and tell me the version
⏺ read_file(package.json)
  ⎿ 26 lines (738 B)

The version is 0.1.0.
```

---

## Read this first

- **This automates a consumer web UI, not a sanctioned API.** Google's terms don't
  cover scripted use of the Gemini web app the way they cover the API/CLI. Keep it
  to low-volume personal use on your own logged-in session.
- **It does not bypass anything.** Google blocks sign-in from automated browsers on
  purpose. Rather than defeat that, this tool never automates the login: *you* open
  a normal Chrome window and sign in by hand, and it attaches afterwards (see
  [Why login is manual](#why-login-is-manual)). There is deliberately no stealth,
  fingerprint-spoofing or detection-evasion code here, and please don't add any.
- **It runs shell commands and writes files on your machine.** Every write, shell
  command and network request asks for a y/N first. Read them.
- **Expect selector drift.** It depends on Gemini's DOM. When Google redesigns,
  [`src/driver/selectors.ts`](src/driver/selectors.ts) is the one file to fix.

## Requirements

- macOS (the `open-chrome` helper is macOS-specific; everything else is portable)
- Node.js 20+
- Google Chrome installed
- A Gemini account you can sign into

## Install

```bash
git clone <this-repo>
cd gemini-code
npm install
npm run build
npm link          # puts `gemini-code` on your PATH
```

## Use

**1. Open Chrome and sign in (once):**

```bash
gemini-code open-chrome
```

Opens a normal Chrome window with a debug port, using a dedicated profile
(`~/.gemini-code/profile`, separate from your everyday browsing). Sign in to Gemini
by hand. Leave it open.

**2. Verify:**

```bash
gemini-code login
```

**3. Run the agent in any project:**

```bash
cd ~/code/my-project
gemini-code
```

Type a task. `/help` lists commands. `exit` quits.

### Commands

| Command | What it does |
| --- | --- |
| `/model` | show current model |
| `/model fastest\|fast\|pro` | switch model |
| `/thinking on\|off` | extended thinking |
| `/plan`, `/plan clear` | show / delete the progress journal |
| `/memory`, `/remember <note>` | show / append durable project memory |
| `/clear` | start a fresh Gemini thread |
| `/paste` | attach an image from the clipboard (macOS) |
| `/image <path>` | attach an image file — or just drag one into the terminal |
| `/tools` | list tools available to Gemini |
| `/exit` | quit |

Typing **while a task runs** steers it — your text is folded into the next turn as a
`USER UPDATE`, so you can redirect mid-flight instead of waiting.

### Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `GEMINI_CODE_MODEL` | `fast` | `fastest` \| `fast` \| `pro` |
| `GEMINI_CODE_ORCHESTRATOR` | `1` | `0` = one tab does everything |
| `GEMINI_CODE_MAX_WORKERS` | `3` | parallel worker tabs |
| `GEMINI_CODE_AUTO_APPROVE` | unset | `1` skips all y/N confirmations |
| `GEMINI_CODE_PROFILE` | `~/.gemini-code/profile` | Chrome profile dir |
| `GEMINI_CODE_RESPONSE_TIMEOUT_MS` | `300000` | how long to wait for a reply |
| `GEMINI_CODE_TURN_RETRIES` | `2` | re-sends before a turn fails |
| `GEMINI_CODE_WORKER_RETRIES` | `1` | worker retries in a fresh tab |
| `GEMINI_CODE_MAX_REPORT_CHARS` | `2000` | cap on what a worker reports back |

## How it works

### Tool use without function-calling

The web UI has no function-calling API, so tool use is prompted: Gemini is told to
emit a JSON code block, and this program parses it, runs the tool locally, and sends
the result back as the next message in the same thread. Gemini's own UI keeps the
conversation history — this tool never replays it.

One subtlety worth knowing: the UI renders markdown to HTML before we can read it,
so a ` ``` ` fence never survives as literal backticks — only the *content* of the
rendered code block does. Tool-call detection therefore looks for `{name, args}`
JSON inside rendered code blocks, not for fence characters.

### Master / worker

By default the main tab is an **orchestrator**, not a coder. It plans
(`update_plan`), delegates implementation to parallel worker tabs
(`delegate_tasks`), then **validates** the result — reading a key file, running the
build — and delegates a correction round if something's wrong.

This exists to protect the main thread's context. The web UI gives no
context-window control and silently truncates long threads, so if the main tab
writes the code itself its thread fills with file contents and it loses the plot on
the actual product. Workers return **short reports**, hard-truncated on the way back
so a worker that ignores its brief still can't flood the orchestrator. Workers can't
delegate further, so it can't nest.

Set `GEMINI_CODE_ORCHESTRATOR=0` for small one-off tasks where delegation is just
overhead.

### Images and screenshots

Gemini can see things, two ways:

- **You give it an image** — `/paste` pulls a screenshot straight off the
  clipboard (Cmd+Ctrl+Shift+4 then `/paste`), `/image <path>` takes a file, and
  dragging a file into the terminal attaches it too. A terminal can never receive
  pasted image *data* — Cmd+V only ever delivers text — so `/paste` reads the
  system pasteboard itself.
- **It takes its own** — the `screenshot_page` tool opens a URL in a throwaway tab
  of the same browser, captures it (optionally `fullPage`, or one `selector`), and
  attaches the image to its next message. It works against localhost dev servers,
  so the agent can look at the page it just built instead of reasoning about the
  HTML blind. Confirmed per-URL, because the page loads with your session cookies.

Files you supply are never deleted after sending; only images the agent generated
in its own temp directory are cleaned up.

### Context

- **Project tree** — built at startup so Gemini knows the layout without spending
  tool calls on `ls`.
- **Project docs** — every `.md` in the project (README, `docs/`) as initial
  knowledge about intent and conventions.
- **`GEMINI.md`** — durable memory replayed every session; Gemini appends to it via
  the `remember` tool.
- The tool-call rules always go **inline** (Gemini can't emit a valid call without
  them). Bulky knowledge is **uploaded as a file** when it outgrows the composer, as
  is any tool output over ~4,000 chars.

### Crash-resumable plan journal

Every task writes `GEMINI-PLAN.md` as it goes — the task, the model's checklist, and
a timestamped log of every tool call, flushed after each step:

```md
- **Status:** in_progress
## Plan
- [x] Create src/add.py
- [ ] Create src/sub.py
## Progress
- 15:40:01 write_file(src/add.py) -> ok
```

Because it's written during the work rather than at the end, a file left
`in_progress` (or `interrupted`, which Ctrl+C sets) is itself the signal that work
was cut short. The next run detects it and continues from the first incomplete step
instead of starting over.

### Why login is manual

Google's sign-in flow detects browsers driven over the DevTools protocol — which is
what Playwright always is, on any Chrome binary — and refuses to complete login on
them. That's an intentional anti-automation control, and this project does not try
to defeat it.

Instead `open-chrome` launches an ordinary Chrome window that you sign into by hand,
and the agent **attaches** to it afterwards over CDP. Verified: `navigator.webdriver`
is `false` on the attached page, because nothing automated it at launch time. Only
the security-sensitive step stays human.

### Tab marking

Worker tabs get a pinned title (`🤖 gemini-code · <name>`), a distinct favicon, and a
`beforeunload` guard so Chrome asks before you close one mid-task. Chrome tab
*groups* would be ideal but are only reachable from the `chrome.tabGroups`
**extension** API — the DevTools Protocol exposes nothing for them.

## Safety model

`write_file`, `run_bash`, `fetch_url` and `screenshot_page` each require a y/N confirmation showing
exactly what will happen (`fetch_url` shows the full URL, since a request can carry
local data off the machine). Prompts are serialized so parallel workers can't
interleave them. File tools refuse paths outside the project root.
`GEMINI_CODE_AUTO_APPROVE=1` disables all of this — don't, until you trust it.

Your Chrome profile (`~/.gemini-code/profile`) holds a live Google session. Treat it
like a password: never commit it, never copy it around. It's gitignored here.

## Development

```bash
npm test             # 39 tests: parser, tools, loop, workers, plan, context
npm run test:browser # headless Chromium: launch + logged-out detection
npm run test:e2e     # REAL Gemini round trip (needs open-chrome + sign-in)
npm run dev          # run from source without building
```

```
src/
  driver/     Playwright automation (selectors.ts is the DOM-coupled file)
  agent/      prompt contract, tool-call parsing, the agent loop, worker pool
  tools/      read/write/bash/fetch/list/remember/update_plan
  context/    project tree, docs, GEMINI.md memory, plan journal
  ui/         terminal formatting
  cli.ts      REPL, slash commands, orchestrator wiring
```

The non-obvious failures found while building this — the ones that cost real
debugging time, several of them traps anyone automating a chat web UI will hit — are
written up in [`docs/engineering-notes.md`](docs/engineering-notes.md).

## Licence

MIT
