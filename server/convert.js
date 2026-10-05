import * as FRAGS from "@thatopen/fragments";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webIfcPath = path.join(__dirname, "..", "node_modules", "web-ifc") + path.sep;

/**
 * Converts a raw IFC file buffer into:
 *  - fragmentBytes: the compact binary geometry format the browser viewer loads
 *  - properties: a flat { [localId]: { category, name, propertySets: {...} } } map
 *    so the viewer can look up an element's data on click without re-parsing IFC.
 */
export async function convertIfc(ifcBuffer, { onProgress } = {}) {
  const serializer = new FRAGS.IfcImporter();
  serializer.wasm = { absolute: true, path: webIfcPath };
  serializer.addAllAttributes();
  serializer.addAllRelations();

  const fragmentBytes = await serializer.process({
    bytes: new Uint8Array(ifcBuffer),
    progressCallback: onProgress,
  });

  const properties = await extractProperties(fragmentBytes);

  return { fragmentBytes, properties };
}

async function extractProperties(fragmentBytes) {
  const model = new FRAGS.SingleThreadedFragmentsModel("convert-job", fragmentBytes);

  const localIds = model.getItemsIdsWithGeometry();

  const items = await model.getItemsData(localIds, {
    attributesDefault: true,
    relations: {
      IsDefinedBy: { attributes: true, relations: true },
    },
  });

  const properties = {};

  for (const item of items) {
    const localId = item._localId?.value ?? item._localId;
    if (localId === undefined) continue;

    const name = item.Name?.value ?? null;
    const category = item._category?.value ?? null;
    const propertySets = {};

    const definedBy = item.IsDefinedBy ?? [];
    for (const rel of definedBy) {
      const psetName = rel.Name?.value;
      const hasProperties = rel.HasProperties ?? [];
      if (!psetName || !Array.isArray(hasProperties)) continue;

      const props = {};
      for (const prop of hasProperties) {
        const propName = prop.Name?.value;
        const nominalValue = prop.NominalValue?.value;
        if (propName !== undefined) props[propName] = nominalValue ?? null;
      }
      propertySets[psetName] = props;
    }

    properties[localId] = { name, category, propertySets };
  }

  if (model.dispose) await model.dispose();

  return properties;
}
