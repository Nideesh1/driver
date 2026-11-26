# A worked example: a messy app, end to end

The app: **Dispatch**, an internal React tool for a courier company. Three years old, no design system, written by
four people. This is the procedure in [authoring-verbs.md](authoring-verbs.md) run over it.

## What is in the repo

```
src/
  store/jobsStore.ts      createStore: filter, setFilter, page, next/prev, rows, selectedIds,
                          selectAll(), clear(), rev (already a counter, used for memo keys)
  lib/api.ts              listJobs(), assignDriver(jobId, driverId), cancelJob(jobId, reason),
                          bulkAssign({ filter, driverId }) -> { assigned: number }
  pages/JobsPage.tsx      the table; <button onClick={() => api.cancelJob(j.id, "ops")}> inline per row
                          <button onClick={exportCsv}> in the toolbar, no function anywhere else
  pages/MapPanel.tsx      a Mapbox canvas; markers drawn from the same rows
  components/DriverCombo.tsx  a native <select> of drivers
```

Sorting the piles: the store and `lib/api.ts` are already functions — **including `bulkAssign`, which takes a
filter and returns a count, which is the most valuable thing in the repo.** The per-row cancel button and the CSV
export are only click handlers (logic inline in JSX), so they need a marked button and a helper of their own. The map is nothing: a canvas is invisible to driverkit and to an agent, and the
markers are the same rows the table has, so it needs no verb at all.

## The draft

```ts
const driver = mount({
  app: "Dispatch",
  verbs: [
    // --- reads -----------------------------------------------------------
    { name: "filter-jobs", kind: "read",
      describe: "show only the jobs in one state, optionally for one city",
      args: { state: { type: "string", describe: "job state", oneOf: ["unassigned","assigned","late","done"] },
              city:  { type: "string", describe: "city name", optional: true } },
      run: ({ state, city }) => jobs.setFilter({ state, city }) },

    { name: "next-page", kind: "read", describe: "show the next page of jobs",
      refuses: ["at-last-page"],
      run: (_a, ctx) => jobs.hasNext() ? jobs.next() : ctx.refuse("at-last-page") },

    { name: "open-job", kind: "read", describe: "open one job's detail panel",
      args: { job: { type: "string", describe: "job reference, e.g. DX-4410" } },
      refuses: ["no-such-job"],
      run: ({ job }, ctx) => jobs.has(job) ? jobs.open(job)
             : ctx.refuse("no-such-job", `no job ${job}; references look like DX-4410`) },

    // --- describe: the predicate lives here, and it counts ---------------
    { name: "select-matching", kind: "describe",
      describe: "select every job matching the current filter plus an optional driver, across all pages, "
              + "replacing any existing selection, and report how many matched",
      args: { unassigned_only: { type: "boolean", describe: "only jobs with no driver", optional: true } },
      run: ({ unassigned_only }) => ({ count: jobs.selectAll({ unassignedOnly: unassigned_only }) }) },

    { name: "clear-selection", kind: "describe", describe: "deselect every job",
      run: () => { jobs.clear(); return { count: 0 }; } },

    // --- commits: no predicates, they act on the selection ---------------
    { name: "assign-selected", kind: "commit",
      describe: "assign every selected job to one driver",
      args: { driver: { type: "string", describe: "driver's short code", oneOf: [...DRIVER_CODES] } },
      refuses: ["nothing-selected", "driver-off-shift"],
      run: async ({ driver }, ctx) => {
        if (!jobs.selectedIds.size) return ctx.refuse("nothing-selected", "select jobs first and read the count");
        if (!roster.onShift(driver)) return ctx.refuse("driver-off-shift", `${driver} is not on shift today`);
        const { assigned } = await api.bulkAssign({ filter: jobs.filterForSelection(), driverId: driver });
        jobs.bump();
        return { count: assigned };
      } },

    { name: "cancel-job", kind: "commit",
      describe: "cancel one job, with a reason the customer sees",
      args: { job: { type: "string", describe: "job reference" },
              reason: { type: "string", describe: "why", oneOf: ["no-access","customer-request","damaged"] } },
      refuses: ["no-such-job", "already-delivered"],
      run: clickHandle("cancel-row") },     // a marked button — see below

    { name: "export-csv", kind: "read", describe: "download the current filtered list as a CSV",
      run: clickHandle("export") },
  ],
  visible: () => ({
    where: jobs.filterLabel(),                        // "late jobs in Leeds", in the user's words
    rev: jobs.rev,
    rows: jobs.onScreen().map(j => ({ id: j.ref, customer: j.customer, city: j.city,
                                     state: j.state, driver: j.driver ?? "—", due: j.dueLabel })),
    page: { index: jobs.page, size: 25, total: jobs.matchCount },
    selected: jobs.selectedOnScreen(),
    selectedCount: jobs.selectedIds.size,
  }),
});
```

## Why each `kind` is what it is

| verb | kind | why |
|---|---|---|
| `filter-jobs` | `read` | changes the view, writes nothing. It is not `describe` because it reports no count and selects nothing — a `describe` is specifically about **selection or filtering that a commit will then act on**. (Making it `describe` would not be wrong, merely useless: it has no count to give.) |
| `next-page`, `open-job` | `read` | navigation. Both refuse rather than clamp, so the agent learns the edge instead of silently re-reading the same page. |
| `select-matching` | `describe` | touches no data, and **returns the number the commit decision turns on**. This is the verb that makes the bulk path safe. |
| `clear-selection` | `describe` | changes the selection, so not `read`. Returns `{ count: 0 }` — a real answer, not an omitted field. |
| `assign-selected` | `commit` | calls `api.bulkAssign`. Takes **no predicate**: the filter comes from the app's own selection state, so an agent cannot widen it. One call for a thousand jobs, therefore one confirmation. |
| `cancel-job` | `commit` | a click, and the handler calls `api.cancelJob`. **No adapter could have inferred that** — somebody read the handler. Had it been left absent, the model would be told nothing and the widget's gate would not fire. |
| `export-csv` | `read` | the handler only serialises what is on screen. Worth checking: if the export were a server job that emailed somebody, it would be a `commit`. |

## What was deliberately left out, and why

- **`assign-one(job, driver)`.** Tempting and redundant: `select-matching` + `assign-selected` covers it, and a
  per-row verb invites a thousand-call loop. Add it later only if single assignment is genuinely common.
- **`setPage(n)`, `setSort(col)`, `toggleRow(id)`.** Chrome. `toggleRow` in particular is the `select(id)`-per-row
  shape the design exists to prevent.
- **Anything about the map.** A canvas carries no text; the rows already say where the jobs are.
- **`DriverCombo`.** A native `<select>`'s options are invisible to anything reading the DOM, and the driver codes
  are already an `oneOf`
  on `assign-selected`, which is better than driving a dropdown.
- **`bulkAssign({ filter, driverId })` exposed directly.** It takes a predicate *and* writes, which is exactly the
  verb that accepts fifty thousand rows because a filter was wider than anybody thought. It stays an
  implementation detail of `assign-selected`, which is fed the selection the agent already counted.

## The click-handler half, in full

```tsx
<button data-dk="cancel-row" onClick={() => api.cancelJob(j.id, "ops")}>Cancel</button>
<button data-dk="export"     onClick={exportCsv}>Export</button>
```

`clickHandle` is four lines you write yourself — the repo README's "Your actions only exist inside click handlers"
section has them; the library ships no helper, because a click is the one thing it cannot make any claim about.
Two honest costs: `cancel-job`'s `args` are **not** passed to the handler — a click runs whatever the handler
closes over, so this verb cancels *the open row* and its `describe` should say so (fix it by making the real verb
call `api.cancelJob` once `lib/` is reachable); and a rendered-but-disabled button is clicked, does nothing, and
reports `ok` unless you check `disabled` first. Both are reasons to end up calling the function — one verb at a
time, starting with `cancel-job`.
