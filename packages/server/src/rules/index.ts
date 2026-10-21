// Glue between the rules evaluator and the Firestore engine.
import type { Authorizer, FirestoreEngine } from "../firestore/engine.js";
import { relPath } from "../firestore/query.js";
import { RulesEngine } from "./evaluator.js";

export { RulesEngine, OPEN_RULES } from "./evaluator.js";
export { parseRules, RulesSyntaxError } from "./parser.js";

export function rulesAuthorizer(engine: FirestoreEngine, rules: RulesEngine): Authorizer {
  return (op, name, ctx, existing, incoming) => {
    const database = name.split("/")[3] ?? "(default)";
    const root = name.slice(0, name.indexOf("/documents") + "/documents".length);
    const toRes = (d: typeof existing) => (d ? { id: d.name.split("/").pop()!, name: d.name, data: d.fields } : null);
    return rules.allows({
      method: op,
      path: relPath(name),
      database,
      auth: ctx.auth,
      resource: toRes(existing),
      incoming: toRes(incoming),
      getDocument: (rel) => engine.get(`${root}/${rel}`)?.fields,
    });
  };
}
