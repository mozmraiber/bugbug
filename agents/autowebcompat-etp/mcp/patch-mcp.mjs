// Adds the ETP tools in etp-tools.js to the installed Firefox DevTools MCP
// bundle. Runs at image build time, after `npm ci`:
//
//   node mcp/patch-mcp.mjs <path to node_modules/@mozilla/firefox-devtools-mcp-moz>
//
// The bundle is a single esbuild output file with no plugin API, so the tools
// are inserted by exact text anchors. Every anchor must match exactly once:
// the build fails rather than shipping an MCP without the tools after a version
// bump changes the bundle.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_VERSION = "0.9.12";

const packageDir = process.argv[2];
if (!packageDir) {
  console.error(
    "usage: node patch-mcp.mjs <firefox-devtools-mcp-moz package dir>"
  );
  process.exit(1);
}

const { version } = JSON.parse(
  readFileSync(join(packageDir, "package.json"), "utf8")
);
if (version !== EXPECTED_VERSION) {
  console.error(
    `firefox-devtools-mcp-moz is ${version}, but the patch targets ${EXPECTED_VERSION}; ` +
      "check the anchors below against the new bundle and update EXPECTED_VERSION."
  );
  process.exit(1);
}

const bundlePath = join(packageDir, "dist.moz", "index.js");
let bundle = readFileSync(bundlePath, "utf8");
if (bundle.includes("async function etpRunChrome(")) {
  console.log("already patched");
  process.exit(0);
}

const tools = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "etp-tools.js"),
  "utf8"
);

function insert(anchor, text, { before = false } = {}) {
  const count = bundle.split(anchor).length - 1;
  if (count !== 1) {
    console.error(
      `anchor found ${count} times, expected once: ${JSON.stringify(anchor)}`
    );
    process.exit(1);
  }
  // A replacer function, so `$` sequences in the inserted code stay literal.
  bundle = bundle.replace(anchor, () =>
    before ? text + anchor : anchor + text
  );
}

// The tool code, at module scope next to the bundle's own prefs tools.
insert(
  "// src/tools/firefox-prefs.ts",
  `// etp-tools.js (autowebcompat-etp)\n${tools}\n`,
  {
    before: true,
  }
);
// Handlers, in the privileged block of the tool name -> handler map.
insert(
  '["get_firefox_prefs", handleGetFirefoxPrefs],',
  `
      ["set_etp_mode", handleSetEtpMode],
      ["get_content_blocking_log", handleGetContentBlockingLog],
      ["wait_for_page_load", handleWaitForPageLoad],`
);
// Definitions, in the privileged block of the advertised tool list.
insert(
  "getFirefoxPrefsTool,\n",
  `      setEtpModeTool,
      getContentBlockingLogTool,
      waitForPageLoadTool,
`
);

writeFileSync(bundlePath, bundle);
console.log(`added the ETP tools to ${bundlePath}`);
