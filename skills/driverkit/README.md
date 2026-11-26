# driverkit skill for Claude Code

A [Claude Code skill](https://code.claude.com/docs/en/skills) that knows how to use driverkit: **draft and review a
verb list over somebody's codebase** (the part that is a judgement call rather than an install), write `visible()`
honestly, add the widget and the `/api/chat` endpoint behind it, drive a tab from another process through the relay
and MCP, set up tab-token auth for a multi-user deployment, adopt an app with no store through
`@driverkit/adapters`, and troubleshoot. `SKILL.md` holds the decision tree, the rules and the common recipes;
[references/](references) holds the details, loaded only when needed.

Install it (SKILL.md + references) into your user skills, from a checkout:

```bash
d=~/.claude/skills/driverkit; src=/path/to/driverkit/skills/driverkit
mkdir -p "$d" && cp "$src/SKILL.md" "$d/" && cp -R "$src/references" "$d/"
```

Or from the repository, once it is public:

```bash
d=~/.claude/skills/driverkit; base=https://raw.githubusercontent.com/driverkit/driverkit/main/skills/driverkit
mkdir -p "$d/references" && curl -fsSL "$base/SKILL.md" -o "$d/SKILL.md"
for f in authoring-verbs worked-example snapshot widget relay-mcp auth adapters protocol packaging troubleshooting; do
  curl -fsSL "$base/references/$f.md" -o "$d/references/$f.md"
done
```

Then ask Claude "what verbs should this app expose to driverkit?", "add a driverkit panel to this page", "drive
this tab from an MCP client" or "why does every call come back stale?" (or type `/driverkit`). Unlike some skills
this one does **not** fall back to fetching a reference from GitHub when only `SKILL.md` is installed: driverkit is
unpublished, so copy the `references/` folder along with it. If `~/.claude/skills` did not exist when Claude Code
started, run `/reload-skills` first. Remove it with `rm -r ~/.claude/skills/driverkit`.

The skill is deliberately blunt about the state of the library — unpublished, never used on a real app, and one
module (`driverkit.fastmcp_server`) never executed — because a skill that oversold it would send somebody down a
path that does not work yet. Keep that section of `SKILL.md` current as the library moves: it is the first thing a
reader acts on.

Editing: `SKILL.md` carries only what is needed to choose a path and to not get the dangerous things wrong
(`kind`, keys, reserved slugs, `rev`); anything a reader needs *while writing code* belongs in a reference. The
heart of the skill is [references/authoring-verbs.md](references/authoring-verbs.md) and its worked example — if
only one file is kept accurate, keep those two.
