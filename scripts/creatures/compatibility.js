import { I18N } from "../constants.js";
import { compatibilityCode } from "./contract.js";

/** Local compatibility remains visible independently of enablement and premium access. */
export function compatibilityContext(current = game) {
  const code = compatibilityCode(current), prefix = `${I18N}.creatures.compatibility`;
  const unknown = current.i18n.localize(`${prefix}.unknown`);
  return { code, compatible: code === "compatible",
    icon: code === "compatible" ? "fa-circle-check" : "fa-triangle-exclamation",
    label: current.i18n.localize(`${prefix}.${code}`),
    current: current.i18n.format(`${prefix}.current`, {
      system: current.system?.title || current.system?.id || unknown,
      version: current.system?.id ? current.system?.version || unknown : "",
      core: current.release?.generation == null ? unknown : `V${current.release.generation}`,
    }) };
}
