// ---------------------------------------------------------------------------
// check-browser-deps — find CommonJS files Vite is serving raw to the browser
//
//   npm run dev                      # in one terminal
//   npm run check:deps               # in another
//   npm run check:deps -- --port 5199 --entry /src/lib/x402-browser.js
//
// WHY THIS EXISTS
//   vite.config.js keeps @privy-io/react-auth and the @x402 SDK out of Vite's
//   dep pre-bundler (`optimizeDeps.exclude`) because pre-bundling their whole
//   tree OOM-kills esbuild on small machines. The cost is that Vite then serves
//   those packages' files RAW, with no CommonJS->ESM interop — and their trees
//   contain CJS-only files that a browser cannot evaluate as modules.
//
//   The browser stops at the FIRST one, so the console only ever shows a single
//   error and fixing it just reveals the next. A crawl of the served graph found
//   26 of them. Every one is listed in vite.config.js's CJS_INTEROP so esbuild
//   pre-bundles it individually, which is cheap.
//
//   This script re-runs that crawl. Run it after bumping @privy-io/* or @x402/*:
//   a new transitive CJS dependency will not be in CJS_INTEROP, and the app will
//   fail at runtime with
//     "The requested module ... does not provide an export named 'default'"
//   Exit code is 1 if any landmine is found, so it can gate CI.
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const get = (flag, fallback) => {
  const i = argv.indexOf(`--${flag}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const BASE = get("base", `http://127.0.0.1:${process.env.PORT || 5173}`);
const ENTRIES = get("entry", "/src/lib/PrivyLayer.jsx,/src/lib/x402-browser.js").split(",");
const MAX_REQ = Number(get("max", 8000));

const MODULE_EXT = /\.(?:js|mjs|cjs|jsx|ts|tsx|css)$/;

const seen = new Set();
const queue = [...ENTRIES];
const landmines = [];
const errors = [];
let rawEsm = 0;
let depChunks = 0;
let requests = 0;

/** Is this body CommonJS with no ESM export at all? */
function isRawCjs(body) {
  const hasEsm = /(^|\n)\s*export\s+(?:default|\{|\*|const|function|class|var|let|async)/.test(body);
  const hasCjs = body.includes("module.exports") || /(^|\n)\s*exports\.[A-Za-z_$]/.test(body);
  return hasCjs && !hasEsm;
}

while (queue.length && requests < MAX_REQ) {
  const path = queue.shift();
  const key = path.split("?")[0];
  if (seen.has(key)) continue;
  seen.add(key);

  let body, status;
  try {
    const res = await fetch(BASE + path, { headers: { Accept: "*/*" } });
    requests++;
    status = res.status;
    body = await res.text();
  } catch (e) {
    errors.push([key, `${e.name}: ${e.message}`]);
    continue;
  }
  if (status !== 200) {
    errors.push([key, `HTTP ${status}`]);
    continue;
  }

  // Pre-bundled by esbuild: interop already applied, and its internals were
  // bundled, so there is nothing raw left to inspect. Do not crawl in.
  if (key.includes("/.vite/deps/")) {
    depChunks++;
    continue;
  }

  if (key.startsWith("/node_modules/")) {
    if (isRawCjs(body)) landmines.push(key);
    else rawEsm++;
  }

  // Vite serves these files MINIFIED, e.g.
  //   export{x as A}from"/node_modules/pkg/chunk.mjs?v=abc"
  // with no whitespace, so statement-shaped regexes miss most edges. Take every
  // module-shaped quoted specifier instead.
  for (const m of body.matchAll(/["']([^"'\n]{1,300})["']/g)) {
    const spec = m[1];
    const pathOnly = spec.split("?")[0];
    if (!MODULE_EXT.test(pathOnly)) continue;
    if (spec.startsWith("/")) queue.push(spec);
    else if (spec.startsWith("./") || spec.startsWith("../")) queue.push(new URL(spec, `http://x${key}`).pathname);
  }
}

const report = {
  base: BASE,
  entries: ENTRIES,
  requests,
  modulesVisited: seen.size,
  preBundledDepChunks: depChunks,
  rawEsmOk: rawEsm,
  rawCjsLandmines: landmines,
  fetchErrors: errors.slice(0, 15),
  hitRequestCap: requests >= MAX_REQ,
};

console.log(JSON.stringify(report, null, 2));

if (landmines.length) {
  console.error(`\n❌ ${landmines.length} CommonJS file(s) are being served raw to the browser.`);
  console.error(`   Each one throws "does not provide an export named 'default'" at runtime,`);
  console.error(`   and the browser only reports the first. Add them to CJS_INTEROP in`);
  console.error(`   vite.config.js — use "parent > child" for copies nested under another`);
  console.error(`   package's node_modules — then restart the dev server.\n`);
  process.exit(1);
}
if (errors.length) {
  console.error(`\n⚠️  ${errors.length} module(s) could not be fetched (see fetchErrors).`);
}
console.log(`\n✅ No raw CommonJS in the served graph across ${seen.size} modules.\n`);
