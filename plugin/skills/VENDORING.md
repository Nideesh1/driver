# The skill is vendored here, not written here

`skills/driverkit/` in this plugin is **a copy** of `skills/driverkit/` at the repository root. The root copy is
the one to edit; this one exists because a plugin is installed on its own and cannot reach into the repository
it came from.

There is no `plugin/skills/driverkit/` in the tree yet. The root skill was being authored while this plugin was
built, so the copy has deliberately not been taken: vendoring a half-written skill is how a stale copy gets
shipped. A placeholder `SKILL.md` would be worse still — Claude Code loads every skill it finds, so a stub would
occupy the `driverkit` skill name with text that answers no question.

**Run the copy step below once the root skill is final.** Until then the plugin's commands stand alone; they
name the rules they need rather than relying on the skill being loaded.

## The copy step

Run this from the repository root after any edit to the root skill, and before tagging a release:

```sh
rm -rf plugin/skills/driverkit
mkdir -p plugin/skills/driverkit
cp skills/driverkit/SKILL.md plugin/skills/driverkit/
cp INTEGRATING.md plugin/skills/driverkit/
[ -d skills/driverkit/references ] && cp -R skills/driverkit/references plugin/skills/driverkit/
```

`INTEGRATING.md` is in that list because `references/authoring-verbs.md` defers to it instead of keeping a second
copy of the adoption procedure. A vendored skill without it loses the procedure. It is authored at the repo root
and only ever copied.

The commands are a separate matter and stay standalone: `commands/draft-verbs.md` restates the rules it needs
rather than reading a file, because a slash command runs in the **app's** repository, where neither the plugin's
skill directory nor `INTEGRATING.md` is on the path it would read. It links to `INTEGRATING.md` by URL instead.

## Why a copy and not a symlink

A symlink survives this checkout and nothing else. Plugins are fetched by Claude Code into its own cache — a
copy of the files, not of the repository — and a link pointing at `../../skills/driverkit` resolves to nothing
there. It would also break in a zip, in a container image and on Windows, and it would break silently: the
plugin loads, the skill is simply absent.

The cost of a copy is that the two can drift. AgentGlow's answer to that is a test that compares the files byte
for byte and fails the build when they differ; driverkit should do the same once the root skill exists
(`npm test` is where it belongs).
