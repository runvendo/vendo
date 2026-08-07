// Fixture: the entry itself looks clean, but a module DEEP in its closure
// value-imports the umbrella server graph. The guard must catch it transitively.
import { helper } from "./mid.js";

export { helper };
