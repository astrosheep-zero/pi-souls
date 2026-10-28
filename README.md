# pi-souls

Swap [Pi](https://github.com/earendil-works/pi)'s identity per session, per model, or by default. Only the identity changes; tools, rules, skills, and project context stay as they are.

```bash
pi install npm:@astrosheep/pi-souls
```

## Usage

```text
/soul          # current soul and list
/soul faye     # use faye for this session
/soul clear    # back to defaults
```

Names tab-complete.

```bash
pi --soulless
SOULLESS=1 pi
```

Skip settings souls for this process. `SOULLESS=1` or `true` enables it; `0`, `false`, or unset does not. A session `/soul <name>` still wins, including resumed selections; `/soul clear` returns to soulless.

## Souls

A soul is one Markdown file, or a directory holding `soul.md` beside whatever it keeps with it. The body becomes the identity; frontmatter is stripped, and edits apply on the next request. An optional nonempty `icon` string is shown alone in the footer; without one, the footer shows the soul's name.

```text
~/.agents/souls/
├── faye/
│   ├── soul.md
│   ├── parts/shared.md
│   └── voice.ts
├── reviewer.md
└── parts/
    └── shared.md
```

`<dir>/<name>/soul.md` wins when both forms exist. A directory soul renders templates from its own folder first and `soulsDir` second, so `parts/` next to it beats the shared one. `<name>/voice.ts` is optional; see [Voice](#voice).

```md
---
icon: 🦈
---
Faye's identity body
```

## Presence

The footer shows the effective soul, and is removed when no soul applies. Before the first request after startup, Pi does not expose the explicit system prompt to extensions, so a session `/soul` choice is shown but a settings or model soul waits until the first request confirms it applies. `/soul <name>` and `/soul clear` leave a compact durable divider in the transcript only when the effective identity actually changes: `── soul: faye ──`, or `── soulless ──` when nothing applies. `/soul clear` follows defaults, so it may land on another soul rather than soulless. Dividers keep the identity they recorded when replayed, and never enter model context. No divider appears for no-ops, failures, or a bare `/soul` status check.

### Templates (Pi)

Soul bodies support [Liquid](https://liquidjs.com/) without extra configuration:

```liquid
You are Faye.
{% if model.provider == "openai" %}
Instructions for GPT.
{% elsif model.provider == "anthropic" %}
Instructions for Claude.
{% endif %}
Working in {{ cwd }} with {{ model.id }}.

{% render 'parts/shared' %}
```

Available variables: `model.provider`, `model.id`, and `cwd` (the session working directory). Model fields are empty strings when no model is selected. Output is plain text, without HTML escaping. Undefined variables, unknown filters, invalid templates, and empty output use the normal warning/fallback behavior. `/soul <name>` validates the rendered result before saving the choice.

Put reusable Markdown fragments in `soulsDir/parts/`; both `{% include 'parts/shared' %}` and `{% render 'parts/shared' %}` load `parts/shared.md` and can access the host variables above. Fragments should have no frontmatter. Subdirectories don't appear in `/soul` completion. Soul files and fragments are read fresh on each request.

Template syntax is processed even inside Markdown code fences. Wrap literal examples in `{% raw %}...{% endraw %}`. The Claude Code mod below still reads souls as literal Markdown; Liquid rendering is Pi-only.

## Voice

A directory soul may answer lifecycle moments with code. `<soulsDir>/<name>/voice.ts` (or `voice.mjs`, `voice.js`) exports `voice(moment, world)`, by name or as the default:

```ts
export function voice(moment, world) {
  if (moment.kind === "human") return { text: "……", audience: "human" };
  if (moment.kind === "tool" && moment.phase === "after") return { text: `${moment.toolName} ${moment.ok ? "ok" : "failed"}` };
  return undefined; // silence is always allowed
}
```

Moments: `wake` (`source`: `startup`, `resume`, `fork`, `clear`, `compact`), `human` (`text`), and `tool` (`phase` `before`/`after`, `category` `reading`/`running`/`writing`/`other`, `toolName`, `filePath`, `input`, `output`, `ok`). `brain` and `soul` name the remaining beats.

`world` is `{ now, sessionId, cwd, absenceMs?, storeDir, facts }`. `facts` carries `hour`, `morning`, `afternoon`, `evening`, `night`, `weekday` (0 is Sunday) and `weekend`. `absenceMs` is the time since the human's previous message when that is known; `storeDir` defaults to `~/.local/share/pi-souls/<name>`.

`audience` decides delivery. `human` is a notification the model never reads, `both` is a visible transcript message, and `model` (the default) is a hidden one. A module that fails to import, throws, or returns no text is ignored: voice never interrupts the host. Pi loads it once, so restart after editing `voice.ts`; the mod starts fresh on every moment.

Pi imports the module in-process. The Claude Code mod runs it in a `node` child process (`--experimental-strip-types`), because its sandbox has no `import()` and no Node. `node` must be on the mod's `PATH`.

## Settings

```json
{
  "defaultSoul": "faye",
  "modelSouls": { "anthropic/claude-sonnet-5": "reviewer" },
  "soulsDir": "~/.agents/souls",
  "timeaware": true
}
```

Precedence: `/soul <name>` > `--soulless` / `SOULLESS` / explicit system prompt > `modelSouls` (exact `provider/modelId`) > `defaultSoul` > Pi default.

The session choice follows resume, fork, and tree navigation. `--system-prompt` and `SYSTEM.md` outrank a settings soul but not `/soul`. A bad entry only breaks the case that uses it. When another extension forces the whole prompt, souls warns but still replaces the latest preamble if its exact text remains in the forced prompt, preserving surrounding instructions. When a soul can't apply (a bad entry, a missing file, or no matching preamble), Pi's prompt is used and a warning shows once, not on every request. Time awareness is on by default (`timeaware: false` disables it). When a soul is active, user messages refresh a visible watch-style `<system-reminder>` on the first prompt and whenever at least 1 hour has passed since the previous time reminder. A gap of at least 1 hour since the previous user message adds the parenthetical; continuous conversation just refreshes the watch. This is checked when a user message arrives, not by a background timer.

## Transition reminders

When the model or effective soul changes between prompts, the next user prompt carries one hidden system reminder:

```text
new brain: gpt-5.4
new soul: faye
```

Only changed lines appear, brain first. The reminder is separate from clock/time messages and never written to the transcript, and the first prompt only records a baseline. With Pi the baseline lives on the active session branch; the reminder follows the final live prompt options, so resume, fork, tree navigation, and reload do not repeat it, and extension-triggered turns and commands do not consume it.

## Claude Code mod

From a checkout, with Claude Code 2.1.299 or later:

```bash
claude --plugin-dir /path/to/pi-souls/plugins/claude
```

Uses the same `~/.agents/souls/` souls (`<name>.md`, or `<name>/soul.md` with an optional `voice.ts`) and strips frontmatter. Configure the plugin's optional `userConfig` values in Claude's user `settings.json`:

```json
{
  "pluginConfigs": {
    "pi-souls@inline": {
      "options": {
        "defaultSoul": "faye",
        "modelSouls": ["claude-opus-5-5=reviewer"],
        "timeaware": true
      }
    }
  }
}
```

`pi-souls@inline` is the key for `--plugin-dir`; a marketplace installation uses `pi-souls@<marketplace>` instead. Values come directly from Claude's official plugin configuration, with no separate souls settings file. `modelSouls` is a string list of exact `model=soul` entries; malformed entries warn once per session and are ignored individually. If a model appears more than once, the last valid entry wins.

Precedence: `SOULLESS=1` / `true` > exact requested Claude model ID in `modelSouls` > `defaultSoul` > Claude default. Model IDs have no Pi provider prefix. Pi's own settings remain unchanged. File reads use the mods API, without a helper process or build step.

The mod sends the same hidden transition reminder through `prompt.submit` context, which the engine wraps, and keeps a transient per-session baseline. A soul line appears only after `prompt.compose` actually replaced the opening for that model; a frozen prompt, a skipped compose, or `--system-prompt` leaves the last evidenced soul in place. The brain line still reports. Command/meta prompts, dropped prompts, and downstream-stripped context do not consume it.

Only the first `You are…` paragraph of the normal or lean opening is replaced. Leading whitespace, the remaining text, and all other sections stay unchanged. A missing or unexpected opening leaves the prompt intact and warns once per session; unreadable souls also fall back to Claude's prompt. Time awareness (`timeaware`) is on by default (`false` disables it). When a soul is active, `prompt.submit` attaches the same watch-style time reminder on the first user prompt and when at least 1 hour has passed since the previous reminder. The parenthetical appears only after a gap of at least 1 hour between user prompts.

A directory soul's `voice.ts` answers `wake` on `SessionStart`, `human` on `prompt.submit`, and `tool` on `PreToolUse`/`PostToolUse`/`PostToolUseFailure`. Model-facing text joins the event's context; `human` (and `both`) also show a toast. `absenceMs` comes from `seconds_since_last_response` on resume/fork and from the session's previous prompt otherwise.

Limitations:
- The separate official identity, `You are Claude Code, Anthropic's official CLI…`, cannot be removed by this hook; it coexists with the soul.
- The default system-prompt snapshot freezes the first result; start a new session after changing soul files or configuration.
- `--system-prompt` overrides the soul. `--append-system-prompt` still appends normally.
- An organization's managed settings can prevent installed mods from handling prompt events. `--bare` doesn't load this mod.

Checks: `npm test`, `npm run typecheck`, and `claude plugin validate plugins/claude --strict --json`. The vendored `types/claude-code.d.ts` is the declaration generated by Claude Code 2.1.299.
