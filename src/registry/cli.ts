/**
 * Registry CLI - the human sits between update and approve, by design (D12).
 *
 *   npm run registry -- update    fetch upstream, write candidate + diff report
 *   npm run registry -- approve   promote candidate to a versioned snapshot
 *   npm run registry -- show      print the approved snapshot version + counts
 */
import { PricingRegistry } from "./pricing.js";
import { CARBON_V1 } from "./carbon.js";

const dir = process.env.CIRCULARA_REGISTRY_DIR ?? "./registry-data";
const reg = new PricingRegistry(dir);
const cmd = process.argv[2];

switch (cmd) {
  case "update": {
    const diff = await reg.update();
    console.log(
      `candidate written to ${dir}/candidate.json\n` +
        `diff report: ${dir}/candidate.diff.md\n` +
        `added=${diff.added.length} removed=${diff.removed.length} changed=${diff.changed.length}\n` +
        `review the diff, then: npm run registry -- approve`,
    );
    break;
  }
  case "approve": {
    const snap = reg.approve();
    console.log(
      `approved pricing_version=${snap.pricing_version} (${Object.keys(snap.models).length} models)`,
    );
    break;
  }
  case "show": {
    const snap = reg.getApproved();
    if (!snap) {
      console.log("no approved snapshot yet - run: update, review, approve");
    } else {
      console.log(
        `pricing_version=${snap.pricing_version} models=${Object.keys(snap.models).length} fetched_at=${snap.fetched_at}`,
      );
    }
    console.log(
      `carbon coefficients_version=${CARBON_V1.coefficients_version} (static v1 feed, quarterly review)`,
    );
    break;
  }
  default:
    console.log("usage: registry {update|approve|show}");
    process.exit(1);
}
