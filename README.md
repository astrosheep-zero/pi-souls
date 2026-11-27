# pi-souls

Swap [Pi](https://github.com/earendil-works/pi)'s identity per session, per model, or by default. Only the identity changes; tools, rules, skills, and project context stay as they are.

```bash
pi install npm:@astrosheep/pi-souls
```

## Usage

```text
/soul            # current soul and list
/soul @faye      # use faye for this session
/soul naked      # toggle naked mode (system prompt = soul only)
/soul naked on   # enable naked mode for this session
/soul naked off  # disable naked mode for this session
/soul clear      # disable souls for this session
/soul reset      # follow defaults again
/soul reload     # re-read the active SOUL and its perception
/notools         # toggle tool declarations (on/off)
/notools on      # strip all tool declarations for this session
/notools off     # restore tool declarations
```

Tab-complete offers `@name`, `naked` (plus `naked on` / `naked off`), `clear`, `reset`, and `reload`. Soul names matching commands are selected with `@`, such as `@naked`, `@clear`, or `@reset`.

`/soul clear` keeps souls off for this session, including model changes, resume, and fork. `/soul reset` removes that override, any manual soul selection, and any session naked override, restoring model, global, and CLI defaults. `/soul @<name>` selects a soul again after clearing.

`/soul reload` validates the active body and Liquid fragments, refreshes the footer, and reloads its perception on the next moment. It changes no selection and starts no model request; the next request uses the current soul body.

```bash
pi --soulless
SOULLESS=1 pi
pi --naked
```

`--soulless` (`SOULLESS=1` or `true`) skips settings souls for this process; `0`, `false`, or unset does not. A session `/soul @<name>` still wins, including resumed selections. `/soul clear` disables souls for the session; `/soul reset` follows defaults, which remain off while this flag is set.

`--naked` strips the request system prompt down to the active soul body only (dropping Pi's built-in sections, project context, skills, cwd, extension sections, and forced addenda while keeping tool declarations intact). When no soul is active, naked mode leaves Pi's prompt untouched. `/soul naked` (or `/soul naked on` / `/soul naked off`) overrides `--naked` for the active branch, including resume, fork, and tree navigation; `/soul reset` returns to the `--naked` default.

`/notools` strips every tool declaration from the request at request time, unconditionally, even when earlier turns in the history contain tool calls or tool results. It rewrites the leading `<tools>` section to an empty declaration, drops skill declarations and later tool/skill update deltas, and leaves durable history untouched. `/notools` toggles the per-session override, `/notools on` and `/notools off` set it explicitly, and branch navigation replays the choice. `/notools` is orthogonal to `/soul` and `/soul naked`: `/soul reset` leaves it alone, and it keeps stripping while no soul is active. Each request rebuilds the strip, so nothing durable is removed.

## Souls

A soul is one Markdown file, or a directory holding `SOUL.md` beside whatever it keeps with it. The body becomes the identity; frontmatter is stripped, and files are read fresh when composing a prompt. Pi observes edits on the next request; Claude's dynamic slot and snapshot exceptions are described below. An optional nonempty `icon` string is shown alone in Pi's footer; without one, the footer shows the soul's name. Claude's content helper returns the same normalized icon metadata for host integration.

```text
~/.agents/souls/
├── faye/
│   ├── SOUL.md
│   ├── parts/shared.md
│   └── perception.ts
├── reviewer.md
└── parts/
    └── shared.md
```

`<dir>/<name>/SOUL.md` wins when both forms exist. A directory soul renders templates from its own folder first and `soulsDir` second, so `parts/` next to it beats the shared one. `<name>/perception.ts` is optional; see [Perception](#perception).

```md
---
icon: 🦈
---
Faye's identity body
```

## Presence

The footer shows the effective soul, and is removed when no soul applies. Before the first request after startup, Pi does not expose the explicit system prompt to extensions, so a session `/soul` choice is shown but a settings or model soul waits until the first request confirms it applies. `/soul @<name>`, `/soul clear`, and `/soul reset` leave a compact durable divider in the transcript only when the effective identity actually changes: `── soul: faye ──`, or `── soulless ──` when nothing applies. Dividers keep the identity they recorded when replayed, and never enter model context. No divider appears for no-ops, failures, `/soul reload`, or a bare `/soul` status check.

### Templates

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

Available variables: `model.provider`, `model.id`, and `cwd` (the session working directory). Pi model fields are empty strings when no model is selected. Claude uses the requested model ID, but `model.provider` is always an empty string because its host API exposes no provider identity; it is not inferred from the model's name. Output is plain text, without HTML escaping. Undefined variables, unknown filters, invalid templates, and empty output use the normal warning/fallback behavior. Pi's `/soul @<name>` validates the rendered result before saving the choice.

Put reusable Markdown fragments in `soulsDir/parts/`; both `{% include 'parts/shared' %}` and `{% render 'parts/shared' %}` load `parts/shared.md` and can access the host variables above. Fragments should have no frontmatter. Subdirectories don't appear in Pi's `/soul` completion. Soul files and fragments are read fresh on each Pi request and each Claude prompt composition.

Template syntax is processed even inside Markdown code fences. Wrap literal examples in `{% raw %}...{% endraw %}`. Both hosts use the same content loader, Liquid engine, and frontmatter parser.

## Perception

A directory soul may answer lifecycle moments with code. `<soulsDir>/<name>/perception.ts` (or `perception.mjs`, `perception.js`) exports `perception(moment, world)`, by name or as the default:

```ts
export function perception(moment, world) {
  if (moment.kind === "human") return [
    { kind: "assistant", text: "I checked the notes.", ephemeral: true },
    { kind: "user", text: "What did you find?", ephemeral: true },
  ];
  if (moment.kind === "tool" && moment.phase === "after") return [
    { kind: "reminder", text: `${moment.toolName} ${moment.ok ? "ok" : "failed"}` },
  ];
  return [];
}
```

Moments: `wake` (`source`: `startup`, `resume`, `fork`, `clear`, `compact`), `human` (`text`), and `tool` (`phase` `before`/`after`, `category` `reading`/`running`/`writing`/`other`, `toolName`, `filePath`, `input`, `output`, `ok`).

`world` is `{ now, sessionId, cwd, absenceMs?, storeDir, facts }`. `facts` carries `hour`, `morning`, `afternoon`, `evening`, `night`, `weekday` (0 is Sunday) and `weekend`. `absenceMs` is the time since the human's previous message when that is known; `storeDir` defaults to `~/.local/share/pi-souls/<name>`.

Return an array (or a promise of one), and return `[]` for silence. Every item needs a supported `kind` and nonblank `text`. `reminder` wraps the text in `<system-reminder>`; `user` sends plain user text; `assistant` sends a synthetic text-only reply. An invalid item, including one with a `raw` field, rejects the entire array. Single objects and `undefined` are not valid returns.

On **Pi**, all three kinds work at every moment:

- Omit `ephemeral` or set it to `false` to persist. Pi stores a human batch in one custom message after the native prompt, so a failed prompt preparation cannot deliver it on a later turn. Wake and tool items use individual custom messages; tool items wait until the tool batch is kept. Pi maps each item to its requested role for model requests, but its default compaction reads the stored custom messages as user content.
- Set `ephemeral: true` to inject only into model requests. On `human` the default anchor is the user message that starts the run; on `wake` and `tool` it is the latest context-visible message at that moment. An insertion inside a tool batch goes after that batch’s results, or is skipped if the batch is incomplete. Items sharing an insertion point keep array order.
  - `sink` (non-negative integer or `-1`, default `0`) steps back that many context-visible messages; `-1`, stepping past the start, or having no anchor puts the item at the head of context.
  - `linger` (positive integer or `-1`, default `1`) counts settled runs, not requests; `-1` keeps the item for the rest of the session without expiring. The item keeps its anchor across tool steps and subsequent runs until it expires. Session changes, soul mismatch, or a missing or ambiguous anchor can drop it sooner.
  - `sink` and `linger` are invalid without `ephemeral: true`. Changes apply to new requests; idle cache refresh still replays the previous request unchanged.

Pi forwards a trailing `assistant` without adding a user message or delaying it. Some providers reject an assistant tail or treat it as prefill. If you need a user tail, return your own `[assistant, user]` pair, as above. Editing or expiring historical context can also affect later provider-managed reasoning and caching.

On **Claude**, persistent `reminder` and `user` become ordered plugin notes, not human-authored turns. The plugin supplies `user` text without its own wrapper, but Claude may still add a `<system-reminder>` attribution on the wire (observed on 2.1.329). Legal ephemeral items and persistent `assistant` items are skipped without affecting their supported siblings. A malformed item still invalidates the whole batch.

`timeaware` (⌚️) is a builtin persistent `reminder` for due human moments, for file and directory souls alike. Each human perception has two seconds to answer; failed or late answers aren't delivered. Both hosts retain the loaded entry; `/soul reload` drops the active cached entry so the next moment imports it again.

Pi imports the entry module in-process. Claude uses a persistent, isolated Node child reached over a private Unix socket; content loading remains a separate short-lived helper. Both use the shared `loadPerception` implementation, including Jiti's full TypeScript support and the loader's normal dependency caching. The installed Claude runtime bundles official `jiti/static`; no local dependencies or erase-only TypeScript restriction are needed. Node 22.18 or later must be on the mod's `PATH`.

Claude module memory belongs to the running session and soul directory, not durable history. Switching away and back retains other souls' entries; changing the discovered perception extension replaces that directory's entry. Reload resets the active entry, not unrelated souls. Process restart, session end, resume, or fork does not preserve module variables; `storeDir` remains the place for durable state. Startup and calls have a bounded timeout; a hung child is stopped and a later valid call can restart it. Identity changes, reload and end discard obsolete-generation utterances, including queued tool notes. Normal stop/timeout cleans the private socket; after forcible host shutdown its temporary files are best-effort cleanup.

## Settings

```json
{
  "defaultSoul": "faye",
  "modelSouls": { "*/claude-*": "reviewer" },
  "soulsDir": "~/.agents/souls",
  "timeaware": true
}
```

Precedence: session choice (`/soul @<name>` or `/soul clear`) > `--soulless` / `SOULLESS` / explicit system prompt > exact `modelSouls` entry > first matching `modelSouls` wildcard > `defaultSoul` > Pi default. `/soul reset` removes the session choice. Keys are `provider/modelId` patterns: `*` matches any text, including `/`; all other characters are literal. For example, `*/gemini-*` applies across providers, and `kimi-coding/*` applies to that provider. Exact entries always win; overlapping wildcard entries use JSON order.

The session choice follows resume, fork, and tree navigation. `--system-prompt` and `SYSTEM.md` outrank a settings soul but not `/soul`. A bad entry only breaks the case that uses it. When another extension forces the whole prompt, souls warns but still replaces the latest preamble if its exact text remains in the forced prompt, preserving surrounding instructions. When a soul can't apply (a bad entry, a missing file, or no matching preamble), Pi's prompt is used and a warning shows once, not on every request. Time awareness is on by default (`timeaware: false` disables it). When a soul is active, user messages refresh a visible watch-style `<system-reminder>` on the first prompt and whenever at least 1 hour has passed since the previous time reminder. A gap of at least 1 hour since the previous user message adds the parenthetical; continuous conversation just refreshes the watch. This is checked when a user message arrives, not by a background timer.

## Transition reminders

Native model changes and successfully applied soul changes append hidden system reminders to the transcript:

```text
new brain: gpt-5.4
new soul: faye
```

Only changed lines appear, brain first, each as its own persisted message. Reminders are separate from clock/time messages. A notice is written once, when it is observed: one that arrives during a run settles after that run's tool results, so later requests carry it unchanged in the same place. Earlier messages are never edited, reordered, or retroactively given a line they did not have; the initial model selection establishes a silent baseline.

Soul changes require evidence from a successful projection using the final live prompt options of a user run. A missing or failed soul is never announced, and a later success is announced at that later point rather than backdated to the earlier attempt. Switching souls still replaces the system preamble for the next request, so that switch remains a cache miss on its own; the notices around it are not.

## Claude Code mod

From a checkout, with Claude Code 2.1.323 or later:

```bash
claude --plugin-dir /path/to/pi-souls/plugins/claude
```

Uses the same souls and templates as Pi (`<name>.md`, or `<name>/SOUL.md` with an optional `perception.ts`). The default directory is `~/.agents/souls`; `soulsDir` also accepts absolute paths, `~`, and paths relative to the session working directory, for both content and perceptions. Configure the plugin's optional `userConfig` values in Claude's user `settings.json`:

```json
{
  "pluginConfigs": {
    "pi-souls@inline": {
      "options": {
        "defaultSoul": "faye",
        "soulsDir": "~/.agents/souls",
        "modelSouls": ["claude-opus-5-5=reviewer", "claude-*=faye"],
        "timeaware": true
      }
    }
  }
}
```

`pi-souls@inline` is the key for `--plugin-dir`; a marketplace installation uses `pi-souls@<marketplace>` instead. Values come directly from Claude's official plugin configuration, with no separate souls settings file. `modelSouls` is a string list of `model=soul` entries; malformed entries warn once per session and are ignored individually. Exact matches win over wildcards; otherwise the first matching wildcard in configuration order wins. Only `*` is special, as in Pi. A repeated key keeps its original position and its last valid soul value, preserving last-valid-wins behavior for duplicate exact entries.

Precedence: session choice (`/soul @name` or `/soul clear`) > `SOULLESS=1` / `true` > exact Claude model ID in `modelSouls` > first matching wildcard > `defaultSoul` > Claude default. `/soul reset` follows defaults again, so differs from `clear`. Claude keys are model IDs without Pi's provider prefix; Pi's settings are unchanged. An explicit `--system-prompt` bypasses the dynamic slot entirely.

The installed plugin is self-contained: it does not need the root checkout, `node_modules`, or an installation-time build. Its checked-in content helper bundles Liquid and the actual upstream frontmatter parser, not the Pi SDK barrel. Maintainers run `npm ci --ignore-scripts && npm run build:claude` after changing shared content or matching code; this also generates the sandbox entry from the shared matcher. Generated files must be committed, not edited by hand. The perception runtime additionally bundles official Jiti's static entry, with the unchanged native-import sidecar and Jiti license attribution. Content loading and perception execution remain separate processes.

`/soul` shows the requested choice, the actually evidenced active identity, and available names. `/soul @name` selects a soul; `/soul clear` restores the native identity; `/soul reset` follows configured defaults; `/soul reload` validates fresh content and evicts the active perception entry without changing the choice. Names and controls have native completion. These commands do not make model requests. Validation or a denied selection receipt leaves the old choice intact. Command output says “requested” until the native command echo and its selection receipt have actually been kept.

With default snapshots on, new sessions can switch souls or reload edits on the next request without restarting. When the shared opening is followed immediately by `pronouns`, the plugin folds the entire opening into that cache-breaking section, preserving order and separators and replacing only its first `You are…` paragraph. Disabling souls then produces the original wire `system` unchanged in the verified Sonnet 5.5 and Opus 5.5 lean layouts. Other layouts, and resumed snapshots already using the old layout, continue to use `session_guidance` for the identity paragraph alone. A missing opening warns and leaves the prompt alone. Status uses the normalized soul icon, or its name, only after the actual recorded prompt proves that identity is present—not merely after a detached composition.

Choices are concise human-only system notices (`Soul choice: @name`, `disabled`, or `defaults`). Effective identity changes get `── soul: name ──` or `── soulless ──`; no-op commands do not add receipts or dividers. These records never enter model context. Selection and clock/transition baselines are reconstructed from native branch ancestry, including rewind and compaction, rather than a global “latest session” setting. Compaction retains only the original native message carriers needed for these records, plus paired tool calls/results; it does not recreate old reminders or timestamps. Before a resumed branch has an authoritative head, status withholds active claims.

Time awareness (`timeaware`) is on by default. The clock first appears when a soul is active, then at most once an hour; the parenthetical requires an hour between human prompts. Human perceptions use the soul proposed by the prompt preview and append supported notes before submitting the prompt; the clock is attached as prompt context. Wake and tool perceptions use the proven identity and append for future requests. Tool perceptions queue until the whole tool batch is kept, preserving contiguous tool results. Delivered clock and identity reminders supply continuity after resume/fork; `absenceMs` uses native human-message timestamps on the current branch.

Limitations:
- Claude's separate official CLI/Agent SDK identity remains; this mod replaces only the movable opening paragraph.
- `--system-prompt` overrides the soul. Commands can record a choice, but status explicitly reports unconfirmed projection and suppresses soul/time perceptions. `--append-system-prompt` still appends normally.
- Snapshots created by the older compose-only mod retain their old identity until native `/compact` or a new session. Merely installing this version does not rewrite that historical prompt; status reports the migration boundary rather than claiming the new choice is active.
- **Claude 2.1.323 legacy guidance layout:** after compaction and fork, `/soul clear` can leave the inherited soul in the request even with a disabled-choice receipt. When an actual request proves it, the plugin logs a human-only warning; a new session or reset to a different configured soul can recover projection. The folded `pronouns` layout does not reproduce this defect in the same wire test.
- Controls, status and perception integration apply to the main conversation; the host does not expose sufficient agent-local identity for general subagent inheritance.
- An organization's managed settings can prevent installed mods from handling prompt events. `--bare` doesn't load this mod.

Checks: `npm run build:claude`, `npm test`, `npm run typecheck`, `claude plugin validate plugins/claude --strict --json`, and `npm run test:claude-wire`. The wire checks launch the installed Claude binary with isolated HOME/config against a loopback mock API, never external inference. Tests also execute the generated helper and hooks from a standalone plugin copy outside the checkout. The build resolves the installed Pi SDK entry to its adjacent frontmatter utility; a moved utility fails the build instead of falling back to a copied parser. The vendored `types/claude-code.d.ts` is the official declaration generated by Claude Code 2.1.323.
