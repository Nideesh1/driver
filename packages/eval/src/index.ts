/**
 * @driverkit/eval — measure whether an app's verb list actually works.
 *
 * The library tells an author how to declare verbs and says nothing about
 * whether the ones they declared are any good. This package answers that by
 * replaying plain-English asks against a mounted driver and a real model, and
 * reporting four numbers that are deliberately not one number: the verb
 * chosen, the arguments passed, the steps taken, and **commits that should not
 * have happened**. Only the last of those costs you anything you cannot get
 * back, which is why it is printed on its own and never averaged.
 *
 * Exports source rather than `dist`, unlike the five published packages. This
 * is a development tool run out of a checkout with `--experimental-strip-types`
 * against a suite of JSON files on the same disk; a build step would be
 * ceremony in front of a thing nobody installs.
 */

export { CaseError, cacheKey, caseKey, parseBound, parseCase } from "./case.ts";
export { dryRun } from "./dry.ts";
export type { DryOptions } from "./dry.ts";
export { fileCache, loadCases, readResult, writeResult } from "./files.ts";
export {
  failed,
  regressed,
  renderDiff,
  renderDry,
  renderPlan,
  renderReport,
} from "./report.ts";
export { runCase, runSuite, SetupError } from "./run.ts";
export type { RunCaseOptions } from "./run.ts";
export { ASK_VERB_GUESSES, askMechanism, expectedArgs, judge } from "./score.ts";
export type { JudgeOptions } from "./score.ts";
export { main } from "./cli.ts";
export type {
  CallRecord,
  CaseResult,
  DryResult,
  EvalCase,
  Expect,
  Judgement,
  LoadedCase,
  Mark,
  RunOptions,
  SetupCall,
  StepBound,
  SuiteResult,
  Transcript,
  TranscriptCache,
} from "./types.ts";
