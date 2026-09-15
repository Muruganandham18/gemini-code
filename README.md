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

## Install

**One command. Nothing to clone, nothing to build.**

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/Muruganandham18/gemini-code/main/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/Muruganandham18/gemini-code/main/install.ps1 | iex
```

The installer checks your Node and Chrome, fetches the latest release (or builds
from source if none is published yet), installs to `~/.gemini-code/app`, and puts
`gemini-code` on your PATH. No sudo, no admin rights.

> Two files rather than one because `curl | bash` and `irm | iex` are different
> shells that can't read the same script — Claude Code splits them the same way.

> **Running a local copy of the script instead?** `irm` fetches a *URL*, so
> `irm .\install.ps1` fails with "Invalid URI". For a file already on disk just
> run it: `.\install.ps1` (PowerShell) or `bash install.sh`.

Then just run it in any project:

```bash
cd ~/code/my-project
gemini-code
```

### Requirements

| Requirement | Why | Check |
| --- | --- | --- |
| **macOS, Linux or Windows** | Chrome launching and clipboard paste are implemented per platform | — |
| **Node.js 20+** | ES modules, built-in `fetch` | `node -v` |
| **Google Chrome** | the agent drives a real Chrome | — |
| **A Gemini account** | you sign in once, by hand | — |

On an older Node, [nvm](https://github.com/nvm-sh/nvm) is the quickest fix:
`nvm install 20 && nvm use 20`.

> **No browser download.** Unlike most Playwright projects, this needs no
> `npx playwright install` — it drives the Chrome you already have, and the test
> suites do too. A clean install is ~55 MB.

### Other ways to install

```bash
npm install -g gemini-code          # from npm
```

From source, for hacking on it:

```bash
git clone https://github.com/Muruganandham18/gemini-code.git
cd gemini-code
npm install
npm run build
npm link            # symlinks the CLI to your checkout
```

`npm link` points at your checkout, so `git pull && npm run build` updates it in
place.

### Updating

```bash
curl -fsSL https://raw.githubusercontent.com/Muruganandham18/gemini-code/main/install.sh | bash
```

Re-running the installer replaces the installed copy.

### Uninstalling

```bash
rm -f ~/.local/bin/gemini-code   # the launcher (installer route)
npm unlink -g gemini-code        # if you installed from source
rm -rf ~/.gemini-code            # app + Chrome profile (this signs you out)
```

On Windows: delete `%USERPROFILE%\.gemini-code` and remove its `bin` folder from
your PATH.

### Where things live

| Path | What | Commit it? |
| --- | --- | --- |
| `~/.gemini-code/app` | the installed program | n/a |
| `~/.gemini-code/profile` | Chrome profile — **holds a live Google session** | **never** |
| `<project>/GEMINI.md` | durable project memory | yes, if useful |
| `<project>/GEMINI-PLAN.md` | in-flight task journal | usually not |
| `<project>/.gemini-code-tmp/` | attachments, screenshots, undo snapshots | no |

Add to the `.gitignore` of any project you run it in:

```gitignore
.gemini-code-tmp/
GEMINI-PLAN.md
```

### Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `command not found: gemini-code` | `~/.local/bin` isn't on your PATH — the installer prints the line to add |
| `Couldn't attach to Chrome on port 9222` | Chrome isn't up: `gemini-code open-chrome`, sign in, retry |
| `Your Gemini session is signed out` | Session expired: `gemini-code login` and sign in |
| "this browser or app may not be secure" | You tried signing in inside an automated browser — use `gemini-code open-chrome`, which opens a normal one |
| Nothing sends / `no new response ever appeared` | Gemini's markup changed; recalibrate [`src/driver/selectors.ts`](src/driver/selectors.ts) |
| Replies but takes no action | Protocol drift in a long thread — `/clear` starts a fresh one |

### Why there's no single-file binary

Tried it; it doesn't hold up. Playwright reads its own files at runtime — its
`package.json`, the browser registry, `launchApp` — so bundling it into one
executable fails with a different `MODULE_NOT_FOUND` each time you patch the last
one. A binary built that way would break in ways users couldn't diagnose, and again
on every Playwright upgrade.

The installer and the release tarball (`npm run package`, ~4 MB) are the honest
version of the same idea: one command, no build. They need Node on the machine,
which is a small ask next to Chrome, which is needed anyway.

## Versioning

Semantic versioning, reported by `gemini-code --version`.

| Version | Highlights |
| --- | --- |
| **0.2.1** | fixes confirmation prompts double-echoing and leaking answers into the task queue; cross-platform build fix |
| **0.2.0** | interactive browsing, image input, file-editing tools, parallel workers, orchestrator mode, plan journal, `/undo`, cross-platform installers |
| **0.1.0** | first working agent loop: prompted tool calls, read/write/bash, context and memory |

Because this drives a UI nobody versions for us, **patch releases are mostly
selector repairs**. If it suddenly stops sending or reading replies, update before
debugging.

## Use

Just run it:

```bash
cd ~/code/my-project
gemini-code
```

It starts Chrome itself if one isn't already running (a dedicated profile at
`~/.gemini-code/profile`, separate from your everyday browsing), attaches, and goes.

**The one manual step is signing in** — and only when you're actually signed out.
The profile keeps the session, so that's typically once, not once per run. When it
happens, the agent detects it, brings the Chrome window to the front, and waits
while you sign in, then carries on by itself. In a non-interactive shell it fails
immediately with instructions instead of blocking, since there's nobody there to
sign in.

Why signing in stays manual: Google deliberately blocks sign-in from
automation-driven browsers, and this project doesn't try to defeat that (see
[Why login is manual](#why-login-is-manual)). Nothing here ever touches your
credentials.

`gemini-code open-chrome` and `gemini-code login` still exist if you'd rather do
those steps explicitly.

Type a task. `/help` lists commands. `exit` quits.

### Commands

| Command | What it does |
| --- | --- |
| `/model` | show current model |
| `/model fastest\|fast\|pro` | switch model |
| `/thinking on\|off` | extended thinking |
| `/undo` | revert all file changes from the last task |
| `/plan`, `/plan clear` | show / delete the progress journal |
| `/memory`, `/remember <note>` | show / append durable project memory |
| `/clear` | start a fresh Gemini thread |
| `Ctrl+V` or `/paste` | attach an image from the clipboard (macOS) |
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
| `GEMINI_CODE_REMINDER_TURNS` | `5` | how often the tool-call contract is restated |
| `GEMINI_CODE_DRIFT_NUDGES` | `2` | nudges when a reply abandons the protocol |
| `GEMINI_CODE_BASH_TIMEOUT_MS` | `60000` | foreground command timeout |

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

- **You give it an image** — press **Ctrl+V** (not Cmd+V) to attach whatever
  screenshot is on your clipboard; `/paste` does the same, `/image <path>` takes a
  file, and dragging a file into the terminal works too.

  It has to be **Ctrl+V**: macOS terminals handle Cmd+V themselves and deliver only
  clipboard *text* to the process, so an image paste arrives as nothing at all and
  there's no keystroke to hook. Ctrl+V does reach the program, so that's the
  binding — same reason Claude Code uses it.
- **It browses interactively** — `browser_open` opens a live tab and returns the
  page text *plus a numbered list of its buttons, links and inputs*;
  `browser_do` clicks them, types into them, submits, scrolls, goes back or
  screenshots. The page stays open between calls, so it can click → look → type →
  click again, the way a person does. Refs are numbered rather than CSS selectors
  because asking a model to invent `div.css-1x7f2 > button:nth-child(3)` from a
  text dump is guesswork that silently clicks the wrong thing.

  Approval is **per origin**: this tab shares the browser's signed-in session, so
  approving `example.com` must not silently authorise a hop to `mail.google.com`.
  Each new origin is confirmed on arrival, and an action that navigates somewhere
  unapproved is reversed.
- **It takes its own** — the `screenshot_page` tool opens a URL in a throwaway tab
  of the same browser, captures it (optionally `fullPage`, or one `selector`), and
  attaches the image to its next message. It works against localhost dev servers,
  so the agent can look at the page it just built instead of reasoning about the
  HTML blind. Confirmed per-URL, because the page loads with your session cookies.

Files you supply are never deleted after sending; only images the agent generated
in its own temp directory are cleaned up.

### Protocol drift in long threads

Prompted tool-calling degrades as a thread grows: the primer falls out of a context
the web UI truncates without telling anyone, and Gemini reverts to chatting —
"Sure, I'll create that file:" followed by the contents in a code block, with no
tool call. To a parser that's indistinguishable from a finished answer, so the task
would end having done nothing, which looks like the app ignoring the reply.

Two mitigations: the tool-call contract is **restated every few turns**
(`GEMINI_CODE_REMINDER_TURNS`), and a reply that pasted code while *announcing* an
action gets **nudged back** to the protocol (`GEMINI_CODE_DRIFT_NUDGES`, default 2)
rather than accepted. The nudges are capped so a genuine answer that happens to
quote code can't cause a loop.

If a session has gone very long and quality is dropping, `/clear` starts a fresh
thread — the plan journal carries the work forward.

### Long-running commands

`npm run dev` and friends never exit, so running one in the foreground would block
the agent until a timeout, then kill the server anyway. Those are detected and
**started in the background** instead, returning a handle immediately:

```
⏺ run_bash(npm run dev)
  ⎿ Started in the background as "bg_mu1kcjgg"
⏺ check_output(id: bg_mu1kcjgg)
⏺ kill_process(id: bg_mu1kcjgg)
  ⎿ Stopped "bg_mu1kcjgg" and its children.
```

Set `background: true` explicitly for anything else that doesn't return.
Everything is spawned in its own **process group**, so killing takes the whole tree
down — otherwise `npm run dev` orphans the node server, which keeps holding its
port after the agent is gone. Anything still running is stopped when the CLI exits.

### Working in real code

The composer budget is the binding constraint, so the file tools are built to move
as little text through the thread as possible:

- **`edit_file`** replaces an exact piece of text, leaving the rest alone. Changing
  a constant in a 600-line file costs a few hundred bytes instead of regenerating
  6 KB — and regeneration silently loses anything the model doesn't reproduce
  exactly. An ambiguous match is **refused**, never guessed, so it can't quietly
  edit the wrong line.
- **`search_code`** finds things by regex (`file:line`) without reading files.
- **`read_file`** takes `offset`/`limit` and windows large files rather than
  dumping them. It returns text **verbatim, without line numbers** — deliberately,
  because the model copies from it straight into `edit_file`, and a `42 ` prefix
  would make every edit fail to match.
- **`git_status` / `git_diff`** let it review what it actually changed before
  calling a task done. Read-only, so no confirmation.
- **`/undo`** reverts every file change from the last task — restoring what was
  overwritten and deleting what was created. Snapshots are taken before each
  write, grouped per task, which matters most with `GEMINI_CODE_AUTO_APPROVE=1`
  where nobody is eyeballing each edit. Repeated edits to one file in a task
  still restore the *pre-task* version, not an intermediate one.

A real run against a 600-line file: `search_code` → `read_file` (9 lines) →
`edit_file` (1 replacement), with all 199 functions intact.

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
npm test             # 56 tests: parser, tools, loop, workers, plan, context
npm run test:browser # headless Chromium: launch, logged-out detection, interactive browsing
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
