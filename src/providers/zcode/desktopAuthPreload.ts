/** Loaded only for broker task execution; never changes installed vendor files. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { adaptDesktopAuthSource, ZCODE_DESKTOP_BUNDLE_SHA256, ZCODE_DESKTOP_INCOMPATIBLE } from "./desktopAuth.ts";

const bundleUrl = pathToFileURL(process.argv[1]!).href;
registerHooks({
  load(url, context, nextLoad) {
    if (url !== bundleUrl) return nextLoad(url, context);
    const bytes = readFileSync(fileURLToPath(url));
    if (createHash("sha256").update(bytes).digest("hex") !== ZCODE_DESKTOP_BUNDLE_SHA256) {
      throw new Error(ZCODE_DESKTOP_INCOMPATIBLE);
    }
    return { format: "commonjs", source: adaptDesktopAuthSource(bytes.toString("utf8")), shortCircuit: true };
  },
});
