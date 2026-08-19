/** One turn, in the terminal: `pnpm chat`. */
import { support } from "./agent.js";

const turn = await support.chat("Where is order A-1001?");

console.log(turn.text);
