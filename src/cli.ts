// Run the agents from the command line, e.g. `npm run find -- 200` or `npm run outreach -- 10`.
import { findRestaurants, seedDemoRestaurants } from "./agents/finder.js";
import { runOutreach } from "./agents/outreach.js";

const [command, arg] = process.argv.slice(2);
const limit = arg ? Number(arg) : undefined;

switch (command) {
  case "find":
    console.log(await findRestaurants({ limit }));
    break;
  case "seed":
    console.log({ added: seedDemoRestaurants() });
    break;
  case "outreach":
    console.log(JSON.stringify(await runOutreach({ limit }), null, 2));
    break;
  default:
    console.log("Usage: tsx src/cli.ts <find|seed|outreach> [limit]");
    process.exitCode = 1;
}
