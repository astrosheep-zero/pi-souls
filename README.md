# pi-souls

Give [Pi](https://github.com/earendil-works/pi) a different persona per session, per model, or by default. A soul replaces only the identity part of the system prompt; tools, rules, skills, and project context stay exactly as Pi renders them.

## Install

```bash
pi install npm:@astrosheep/pi-souls
# or from a local checkout
pi install ./pi-souls
```

## Usage

```text
/soul          # Show the current soul, where it comes from, and what's available
/soul faye     # Use faye for this session (kept across resume and fork)
/soul clear    # Drop the session choice and follow modelSouls / defaultSoul again
```

Soul names tab-complete after `/soul `.

## Writing a soul

A soul is one Markdown file. Its body takes the place of Pi's default "coding assistant" introduction:

```text
~/.agents/souls/
├── faye.md          # who the agent is and how it talks
└── reviewer.md
```

Frontmatter (such as `name:`) is optional and stripped before use. Edits apply on the next request, with no `/reload` needed.

File names may use letters, digits, `_`, `-`, and `.` (not as the first character). `clear` is reserved.

## Configuration

In `settings.json` (user or project level):

```json
{
  "defaultSoul": "faye",
  "modelSouls": {
    "anthropic/claude-sonnet-5": "reviewer"
  },
  "soulsDir": "~/.agents/souls"
}
```

| Key | Type | Default | Description |
|---|---|---|---|
| `defaultSoul` | string | none | Used when nothing more specific applies. |
| `modelSouls` | object | `{}` | Souls for specific models, keyed by exact `provider/modelId`. |
| `soulsDir` | string | `~/.agents/souls` | Folder of soul files. `~` means your home folder; other relative paths start from the project. |

Which soul wins: **`/soul <name>` for the session > `modelSouls` > `defaultSoul` > Pi's own prompt.**

The session choice is saved in the session itself, so resume, fork, and tree navigation each keep the soul of their branch. Without a session choice, switching models picks up that model's `modelSouls` entry.

## When something is wrong

- A broken setting only affects the case that uses it. A typo in one `modelSouls` entry won't take souls away from other models, and `/soul` lists keys that can never match a model.
- If a soul can't be applied (missing file, invalid name), Pi shows the error and sends that request with its own prompt.
- If the whole system prompt has been replaced (`SYSTEM.md` or `customPrompt`), there is no identity section left to swap, so pi-souls reports an error instead of mixing the two.

## How it works

Right before each request, pi-souls rewrites the `preamble` section of Pi's structured system prompt (via `context_with_system`). Tool declarations, tool rules, docs, skills, cwd, and project context are left alone, and the stored transcript is never modified.
