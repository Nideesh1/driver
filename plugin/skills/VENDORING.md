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
[ -d skills/driverkit/references ] && cp -R skills/driverkit/references plugin/skills/driverkit/
```

## Why a copy and not a symlink

A symlink survives this checkout and nothing else. Plugins are fetched by Claude Code into its own cache — a
copy of the files, not of the repository — and a link pointing at `../../skills/driverkit` resolves to nothing
there. It would also break in a zip, in a container image and on Windows, and it would break silently: the
plugin loads, the skill is simply absent.

The cost of a copy is that the two can drift. AgentGlow's answer to that is a test that compares the files byte
for byte and fails the build when they differ; driverkit should do the same once the root skill exists
(`npm test` is where it belongs).
