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

One Markdown file per soul; the body becomes the identity. Frontmatter is stripped, and edits apply on the next request.

```text
~/.agents/souls/
├── faye.md
└── reviewer.md
```

## Settings

```json
{
  "defaultSoul": "faye",
  "modelSouls": { "anthropic/claude-sonnet-5": "reviewer" },
  "soulsDir": "~/.agents/souls"
}
```

Precedence: `/soul <name>` > `--soulless` / `SOULLESS` / explicit system prompt > `modelSouls` (exact `provider/modelId`) > `defaultSoul` > Pi default.

The session choice follows resume, fork, and tree navigation. `--system-prompt` and `SYSTEM.md` outrank a settings soul but not `/soul`. A bad entry only breaks the case that uses it. When another extension forces the whole prompt, souls warns but still replaces the latest preamble if its exact text remains in the forced prompt, preserving surrounding instructions. When a soul can't apply (a bad entry, a missing file, or no matching preamble), Pi's prompt is used and a warning shows once, not on every request.
