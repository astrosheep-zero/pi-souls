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

Precedence: `/soul <name>` > `modelSouls` (exact `provider/modelId`) > `defaultSoul` > Pi default.

The session choice follows resume, fork, and tree navigation. A bad entry only breaks the case that uses it; that request falls back to Pi's prompt with an error. `--system-prompt` and `SYSTEM.md` outrank a settings soul but not `/soul`. If another extension forces the whole prompt, souls are skipped.
