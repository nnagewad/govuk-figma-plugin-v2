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

const token = process.argv[2];
if (!token) {
  console.error('Usage: node scanner.js <your-figma-token>');
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
  let totalSkipped = 0;

  for (const fileKey of FILE_KEYS) {
    console.log(`\nScanning file: ${fileKey}`);
    const components = await fetchAllComponents(fileKey);
    totalComponents += components.length;
    console.log(`  Total components found: ${components.length}`);

    for (const comp of components) {
      const baseName = comp.name.split('/')[0].trim();
      const { cssClass, docsUrl, description } = parseDescription(comp.description, baseName);

      if (!cssClass) {
        totalSkipped++;
        console.log(`  ⚠ Skipped: "${baseName}" — description: "${comp.description}"`);
        continue;
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
      }
    }
  }

  console.log(`\n── Summary ──────────────────────────────────`);
  console.log(`Total components scanned:  ${totalComponents}`);
  console.log(`Mapped (have CSS class):   ${totalMapped}`);
  console.log(`Skipped (no CSS class):    ${totalSkipped}`);
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
