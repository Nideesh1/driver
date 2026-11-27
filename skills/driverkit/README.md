# driverkit skill for Claude Code

A [Claude Code skill](https://code.claude.com/docs/en/skills) that knows how to use driverkit: **draft and review a
verb list over somebody's codebase** (the part that is a judgement call rather than an install), write `visible()`
honestly, add the widget and the `/api/chat` endpoint behind it, drive a tab from another process through the relay
and MCP, set up tab-token auth for a multi-user deployment, reach a button nobody wrote a verb for through
`driverkit/controls`, and troubleshoot. `SKILL.md` holds the decision tree, the rules and the common recipes;
[references/](references) holds the details, loaded only when needed.

Install it (SKILL.md + references + **`INTEGRATING.md`**) into your user skills, from a checkout:

```bash
d=~/.claude/skills/driverkit; repo=/path/to/driverkit
mkdir -p "$d" && cp "$repo/INTEGRATING.md" "$repo/skills/driverkit/SKILL.md" "$d/" \
  && cp -R "$repo/skills/driverkit/references" "$d/"
```

Or from the repository, once it is public:

```bash
d=~/.claude/skills/driverkit; root=https://raw.githubusercontent.com/Nideesh1/driver/main
mkdir -p "$d/references"
curl -fsSL "$root/INTEGRATING.md" -o "$d/INTEGRATING.md"
curl -fsSL "$root/skills/driverkit/SKILL.md" -o "$d/SKILL.md"
for f in authoring-verbs worked-example snapshot screens widget relay-mcp auth controls eval protocol packaging troubleshooting; do
  curl -fsSL "$root/skills/driverkit/references/$f.md" -o "$d/references/$f.md"
done
```

**`INTEGRATING.md` is not optional here.** It is the repository's single authoritative adoption procedure, and
`references/authoring-verbs.md` defers to it rather than keeping a second copy — so a skill installed without it
loses the procedure. It is authored at the repo root and copied, never edited in the skill directory.

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
procedure itself is edited at the repo root, in [`INTEGRATING.md`](../../INTEGRATING.md) — if only one file is kept
accurate, keep that one, and after it [references/worked-example.md](references/worked-example.md).
