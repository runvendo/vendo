/** @vendoai/bench — perf-budget gate and honest latency measurements (bench/README.md). */
export * from "./types.js";
export * from "./stats.js";
export * from "./budgets.js";
export * from "./report.js";
export * from "./trees.js";
export { SUITES, DETERMINISTIC_SUITES, LIVE_SUITES, suiteByName } from "./benches/index.js";
