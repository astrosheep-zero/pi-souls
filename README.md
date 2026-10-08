# pi-souls

Persona ("soul") switching for [Pi](https://github.com/earendil-works/pi): swap the identity section of the system prompt per session, per model, or globally — without touching tools, rules, skills, or project context.

## Install

```bash
pi install npm:@astrosheep/pi-souls
# or a local checkout
pi install ./pi-souls
```

## Usage

```text
/soul          # Current soul, its source, and available souls
/soul faye     # Use faye.md for this session (persists across resume/fork)
/soul clear    # Back to model-specific / global defaults
```

A soul is a single Markdown file. Its body replaces Pi's default coding-assistant preamble; everything else in the system prompt stays exactly as Pi renders it.

```text
~/.agents/souls/
├── faye.md          # body = who you are, how you speak
└── reviewer.md
```

Optional frontmatter (e.g. `name:`) is stripped before injection.

## Configuration

In `settings.json` (user or project level):

```json
{
  "defaultSoul": "faye",
  "modelSouls": {
    "anthropic/claude-sonnet-4-5": "reviewer"
  },
  "soulsDir": "~/.agents/souls"
}
```

| Key | Type | Default | Description |
|---|---|---|---|
| `defaultSoul` | string | none | Soul used when nothing else applies. |
| `modelSouls` | object | `{}` | Per-model souls keyed by exact `provider/modelId`. |
| `soulsDir` | string | `~/.agents/souls` | Directory of soul `.md` files. Relative paths resolve from the project; `~` from home. |

Precedence: **session selection (`/soul <name>`) > `modelSouls` > `defaultSoul` > Pi default.**

The session selection is stored as a session entry, so resume, fork, and tree navigation keep the right soul for that branch. Switching models re-resolves from `modelSouls` only when the session has no explicit selection.

## How it works

- Souls replace only the `preamble` section of Pi's structured system prompt, via a request-time projection (`context_with_system`). Tool declarations, tool rules, docs, skills, cwd, and project context are untouched, and the transcript keeps its original sections.
- Soul files are re-read on every request, so edits apply immediately — no `/reload` needed.
- If Pi's system prompt is fully replaced by an opaque prompt (`SYSTEM.md` / `customPrompt`), pi-souls refuses to combine with it and reports an error instead of guessing.

`soul` names must match `[\p{L}\p{N}_-][\p{L}\p{N}_.-]*`; `clear` is reserved.
