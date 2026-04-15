// ============================================================
// GOV.UK Component Map Scanner
// Usage: node scanner.js <your-figma-token>
// Scans both Figma libraries, outputs component-map.json,
// and inlines the map into code.js automatically.
// Re-run whenever your Figma libraries are updated.
// ============================================================

const fs = require('fs');
const path = require('path');

const FILE_KEYS = [
  'LjCSVLWL3NesFoW4HFn0xH',  // GOV.UK Design System V2
  'KKuOwau8bmQ6DClgAytTbs'   // GOV.UK Publishing Components
];

// ── MANUAL OVERRIDES ─────────────────────────────────────────
// Components that can't be found via the Figma API (e.g. unpublished
// components that have no key in the REST API). Add entries here with
// the component key from Figma (right-click component → Copy link, then
// use GET /v1/files/{fileKey}/nodes?ids={nodeId} to find the key).
// Format: cssClass → { name, key, description, docsUrl }
const MANUAL_OVERRIDES = {
  // '.gem-c-feedback': {
  //   name: 'Feedback',
  //   key: 'PASTE_40_CHAR_COMPONENT_KEY_HERE',
  //   description: 'Feedback',
  //   docsUrl: 'https://components.publishing.service.gov.uk/component-guide/feedback'
  // }
};

// ── DOCUMENTATION SOURCES ────────────────────────────────────
// Each entry maps a Figma file key to its public component guide.
// The URL slug of each component page IS the CSS class suffix
// (e.g. /components/accordion/ → .govuk-accordion).
const DOC_SOURCES = {
  'LjCSVLWL3NesFoW4HFn0xH': {
    indexUrl:    'https://design-system.service.gov.uk/components/',
    baseUrl:     'https://design-system.service.gov.uk',
    // Matches both single and double quoted hrefs, optional trailing slash
    linkPattern: /href=["'](\/components\/([a-z0-9-]+)\/?)/g,
    prefix:      '.govuk-'
  },
  'KKuOwau8bmQ6DClgAytTbs': {
    indexUrl:    'https://components.publishing.service.gov.uk/component-guide',
    baseUrl:     'https://components.publishing.service.gov.uk',
    // Matches both single and double quoted hrefs, underscores and hyphens
    linkPattern: /href=["'](\/component-guide\/([a-z0-9_-]+))/g,
    prefix:      '.gem-c-'
  }
};

// ── BUILD DOCS LOOKUP ─────────────────────────────────────────
// Fetches the component index page for a file and returns a Map of
// normalised component name → { cssClass, docsUrl }.
// Key insight: the URL slug is exactly the CSS class suffix, so
// /components/summary-list/ → .govuk-summary-list (no guessing needed).
async function buildDocsLookup(fileKey) {
  const src = DOC_SOURCES[fileKey];
  if (!src) return new Map();

  let html;
  try {
    const resp = await fetch(src.indexUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    html = await resp.text();
  } catch (err) {
    console.warn(`  ⚠ Could not fetch docs for ${fileKey}: ${err.message}`);
    return new Map();
  }

  const lookup = new Map();
  let m;
  const re = new RegExp(src.linkPattern.source, 'g');
  while ((m = re.exec(html)) !== null) {
    const [, path, slug] = m;
    // Normalise the slug to a lookup key: hyphens/underscores → spaces, lowercase
    const key = slug.replace(/[-_]+/g, ' ').toLowerCase();
    const cssClass = src.prefix + slug.replace(/_/g, '-');
    const docsUrl  = src.baseUrl + path;
    if (!lookup.has(key)) lookup.set(key, { cssClass, docsUrl });
  }

  console.log(`  Docs lookup built: ${lookup.size} entries from ${src.indexUrl}`);
  if (DEBUG) {
    console.log('  Keys in lookup:');
    for (const [key, val] of lookup) console.log(`    "${key}" → ${val.cssClass}`);
  }
  return lookup;
}

// ── RESOLVE CLASS FROM DOCS ───────────────────────────────────
// Given a Figma component name and a pre-built docs lookup, tries
// to find a match against the documentation index.
// Only matches top-level component names — variant/state-only names
// (e.g. "State=Default", "Size=Large") are intentionally skipped.
function resolveFromDocs(componentName, docsLookup) {
  if (!docsLookup || docsLookup.size === 0) return null;

  // Strip variant suffixes like "type=Primary, State=Default" or "Size=Large"
  const baseName = componentName
    .split('/')[0]
    .replace(/\s*(type|size|state|variant|viewport|class|icon|weight)=.*/gi, '')
    // Remove "GOV.UK " prefix (e.g. "GOV.UK header" → "header")
    .replace(/^gov\.?uk\s+/i, '')
    .trim()
    .toLowerCase();

  // If nothing meaningful remains after stripping (e.g. "State=Default" → ""),
  // this is a sub-component/variant — don't match it.
  if (!baseName || baseName.length < 3) return null;

  // Exact match
  if (docsLookup.has(baseName)) return docsLookup.get(baseName);

  // Substring match — only when both sides are long enough to be unambiguous
  for (const [key, val] of docsLookup) {
    if (key.length >= 4 && baseName.startsWith(key)) return val;
    if (baseName.length >= 4 && key.startsWith(baseName)) return val;
  }

  return null;
}

const token = process.argv[2];
const DEBUG = process.argv.includes('--debug');
if (!token) {
  console.error('Usage: node scanner.js <your-figma-token> [--debug]');
  console.error('Get your token from: Figma → Account Settings → Personal access tokens');
  process.exit(1);
}

// ── DESCRIPTION PARSER ───────────────────────────────────────
function parseDescription(description, componentName) {
  const desc = (description || '').trim();

  // Extract first CSS class (e.g. .govuk-header or .gem-c-feedback)
  const classMatch = desc.match(/(\.[a-z][a-z0-9_-]*)/i);
  const cssClass = classMatch ? classMatch[1] : null;

  // Extract docs URL
  const urlMatch = desc.match(/(https?:\/\/[^\s]+)/);
  const docsUrl = urlMatch ? urlMatch[1] : null;

  // Clean description: strip class name, URL, and punctuation to get human text
  const cleanDesc = desc
    .replace(/\.[a-z][a-z0-9_-]*/gi, '')
    .replace(/https?:\/\/[^\s]+/g, '')
    .replace(/^[\s—–\-]+|[\s—–\-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    cssClass,
    docsUrl,
    description: cleanDesc || componentName
  };
}

// ── FETCH COMPONENT SETS (for components not in the component API) ──
// Some components (e.g. gem-c-feedback) aren't returned by /components but
// DO appear in the top-level `components` map of the file response.
// We iterate that map, match names against the docs lookup, and use the
// real 40-char key that Figma needs for importComponentByKeyAsync.
async function fetchMissingFromComponentSets(fileKey, alreadyMapped, docsLookup) {
  const extra = [];
  if (!docsLookup || docsLookup.size === 0) return extra;

  let json;
  try {
    // depth=3: document → pages → page children → component variants (with keys)
    const resp = await fetch(
      `https://api.figma.com/v1/files/${fileKey}?depth=3`,
      { headers: { 'X-Figma-Token': token } }
    );
    if (!resp.ok) return extra;
    json = await resp.json();
  } catch (_) { return extra; }

  // Walk the document tree to find COMPONENT nodes with proper 40-char keys.
  // depth=3 gives us: document → pages → page children (frames/sets) → their children (component variants).
  // COMPONENT nodes carry a `key` property that works with importComponentByKeyAsync.
  const seen = new Set(alreadyMapped);

  if (DEBUG) {
    const allNodes = [];
    (json.document?.children ?? []).forEach(page =>
      (page.children ?? []).forEach(node => allNodes.push(node))
    );
    console.log(`  Top-level page nodes (depth 2): ${allNodes.length}`);
    allNodes.forEach(n => {
      const hasFeedback = n.name.toLowerCase().includes('feedback');
      if (hasFeedback || !n.key) {
        console.log(`    [${n.type}] "${n.name}" key=${n.key || '(none)'}${hasFeedback ? ' ← FEEDBACK?' : ''}`);
      }
    });
  }

  function walkForComponents(node, depth) {
    if (depth > 5) return;
    if ((node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') && node.key) {
      const baseName = node.name.split('/')[0].trim();
      const resolved = resolveFromDocs(baseName, docsLookup);
      if (resolved && !seen.has(resolved.cssClass)) {
        extra.push({ name: baseName, key: node.key, resolved });
        seen.add(resolved.cssClass);
        if (DEBUG) console.log(`  ✦ Tree walk [depth ${depth}]: "${baseName}" → ${resolved.cssClass} (key: ${node.key})`);
      }
    }
    for (const child of (node.children || [])) {
      walkForComponents(child, depth + 1);
    }
  }

  const pages = json.document?.children ?? [];
  for (const page of pages) {
    for (const node of (page.children ?? [])) {
      walkForComponents(node, 2);
    }
  }

  return extra;
}

// ── FETCH ALL COMPONENTS (paginated with rate limit handling) ──
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchAllComponents(fileKey) {
  const all = [];
  let cursor = null;
  let page = 1;

  do {
    let url = `https://api.figma.com/v1/files/${fileKey}/components?page_size=100`;
    if (cursor) url += `&after=${encodeURIComponent(cursor)}`;

    let resp;
    let attempts = 0;
    while (true) {
      resp = await fetch(url, { headers: { 'X-Figma-Token': token } });
      if (resp.status === 429) {
        attempts++;
        const wait = attempts * 2000;
        console.log(`  Rate limited — waiting ${wait / 1000}s before retry...`);
        await sleep(wait);
        continue;
      }
      if (resp.status === 403) throw new Error(`Invalid token or no access to file ${fileKey}`);
      if (!resp.ok) throw new Error(`Figma API error ${resp.status} for file ${fileKey}`);
      break;
    }

    const json = await resp.json();
    const components = json.meta?.components ?? [];
    all.push(...components);

    console.log(`  Page ${page}: ${components.length} components (total so far: ${all.length})`);
    cursor = json.meta?.cursor ?? null;
    page++;

    // Polite delay between pages to avoid hitting rate limits
    if (cursor) await sleep(300);
  } while (cursor);

  return all;
}

// ── MAIN ─────────────────────────────────────────────────────
async function main() {
  const map = {};
  let totalComponents = 0;
  let totalMapped = 0;
  let totalDerived = 0;
  let totalSkipped = 0;

  // Pre-fetch docs lookups for both libraries
  console.log('Building documentation lookups…');
  const docsLookups = {};
  for (const fileKey of FILE_KEYS) {
    docsLookups[fileKey] = await buildDocsLookup(fileKey);
  }

  for (const fileKey of FILE_KEYS) {
    console.log(`\nScanning file: ${fileKey}`);
    const components = await fetchAllComponents(fileKey);
    totalComponents += components.length;
    console.log(`  Total components found: ${components.length}`);

    for (const comp of components) {
      const baseName = comp.name.split('/')[0].trim();
      let { cssClass, docsUrl, description } = parseDescription(comp.description, baseName);

      // Fallback: look up the component name in the docs index
      if (!cssClass) {
        const resolved = resolveFromDocs(baseName, docsLookups[fileKey]);
        if (resolved) {
          cssClass   = resolved.cssClass;
          docsUrl    = docsUrl || resolved.docsUrl;
          totalDerived++;
          console.log(`  ✦ Docs match: "${baseName}" → ${cssClass}`);
        } else {
          totalSkipped++;
          console.log(`  ⚠ Skipped: "${baseName}" — description: "${comp.description}"`);
          continue;
        }
      } else if (DEBUG) {
        console.log(`  ✓ Desc match: "${baseName}" → ${cssClass} (desc: "${comp.description}")`);
      }

      // First file (DS V2) takes priority — don't overwrite if already mapped
      if (!map[cssClass]) {
        map[cssClass] = {
          name: baseName,
          key: comp.key,
          description: description,
          docsUrl: docsUrl
        };
        totalMapped++;
      } else if (DEBUG) {
        console.log(`    ↳ Already mapped as "${map[cssClass].name}", skipping duplicate`);
      }
    }

    // Second pass: catch components missing from the /components API
    // by scanning top-level nodes in the file (e.g. gem-c-feedback)
    const alreadyMapped = new Set(Object.keys(map));
    const missing = await fetchMissingFromComponentSets(fileKey, alreadyMapped, docsLookups[fileKey]);
    for (const { name, key, resolved } of missing) {
      map[resolved.cssClass] = {
        name,
        key,
        description: name,
        docsUrl: resolved.docsUrl
      };
      totalMapped++;
      totalDerived++;
      console.log(`  ✦ File scan: "${name}" → ${resolved.cssClass}`);
    }
  }

  // Apply manual overrides last — these always win
  for (const [cssClass, entry] of Object.entries(MANUAL_OVERRIDES)) {
    if (!map[cssClass]) {
      map[cssClass] = entry;
      totalMapped++;
      console.log(`  ✎ Manual override: ${cssClass} → ${entry.name}`);
    }
  }

  console.log(`\n── Summary ──────────────────────────────────`);
  console.log(`Total components scanned:  ${totalComponents}`);
  console.log(`Mapped (have CSS class):   ${totalMapped}`);
  console.log(`  of which docs-matched:   ${totalDerived}`);
  console.log(`Skipped (no match found):  ${totalSkipped}`);
  console.log(`\nMapped classes:`);
  Object.keys(map).sort().forEach(cls => {
    console.log(`  ${cls.padEnd(50)} ${map[cls].name}`);
  });

  // ── Write component-map.json ─────────────────────────────
  const mapPath = path.join(__dirname, 'component-map.json');
  fs.writeFileSync(mapPath, JSON.stringify(map, null, 2));
  console.log(`\n✓ Written: component-map.json`);

  // ── Inline map into code.js ──────────────────────────────
  const codePath = path.join(__dirname, 'code.js');
  if (fs.existsSync(codePath)) {
    let code = fs.readFileSync(codePath, 'utf8');
    const marker = /\/\/ AUTO-GENERATED[\s\S]*?var COMPONENT_MAP = [\s\S]*?;\n/;
    const replacement = `// AUTO-GENERATED by scanner.js — do not edit manually\nvar COMPONENT_MAP = ${JSON.stringify(map, null, 2)};\n`;

    if (marker.test(code)) {
      code = code.replace(marker, replacement);
      fs.writeFileSync(codePath, code);
      console.log(`✓ Updated: code.js (COMPONENT_MAP inlined)`);
    } else {
      console.log(`⚠ Could not find AUTO-GENERATED marker in code.js — paste component-map.json manually`);
    }
  }

  console.log(`\nDone. Re-run this script whenever your Figma libraries change.\n`);
}

main().catch(err => {
  console.error('\nError:', err.message);
  process.exit(1);
});
