/** Wave 6 live smoke: real LLM classification on the org key (~$0.001). */
import { loadConfig, loadSecret } from "../src/config.js";
import { makeAnthropicClassifier } from "../src/engines/clearance/pipeline.js";
const cfg = loadConfig();
const key = loadSecret(cfg, "ANTHROPIC_API_KEY");
if (!key) { console.error("no key"); process.exit(1); }
const classify = makeAnthropicClassifier(key);
const a = await classify("Q3 salary adjustment bands for senior engineers: L5 $185k-$210k, L6 $220k-$260k");
console.log("hr-ish text ->", JSON.stringify(a));
const b = await classify("An openly licensed list of world capital cities and their populations.");
console.log("benign text ->", JSON.stringify(b));
if (a.risk_category === "none") throw new Error("expected sensitive classification for salary bands");
console.log("LIVE CLASSIFY SMOKE PASS (2 haiku calls, <$0.001)");
