const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });
}

// GET /?url=https://www.gov.uk/... — scrape GOV.UK page and return component classes in DOM order with grid context
async function scrape(request) {
  const pageUrl = new URL(request.url).searchParams.get('url');
  if (!pageUrl) return json({ error: 'Missing url parameter' }, 400);

  const GRID_COLUMNS = new Set([
    '.govuk-grid-column-full',
    '.govuk-grid-column-one-half',
    '.govuk-grid-column-one-third',
    '.govuk-grid-column-two-thirds',
    '.govuk-grid-column-one-quarter',
    '.govuk-grid-column-three-quarters',
    '.govuk-grid-column-two-thirds-from-desktop',
    '.govuk-grid-column-one-third-from-desktop'
  ]);

  const govukResp = await fetch(pageUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-GB,en;q=0.9'
    }
  });

  if (!govukResp.ok) {
    return json({ error: 'Failed to fetch page: HTTP ' + govukResp.status }, 502);
  }

  const contextStack = [];
  const spacingStack = [];
  const components = [];
  const seen = new Set();

  await new HTMLRewriter()
    .on('[class]', {
      element(el) {
        const classList = (el.getAttribute('class') || '').split(/\s+/);

        // Skip hidden elements
        const hiddenAttr = el.getAttribute('hidden');
        const isHidden =
          hiddenAttr !== null ||
          hiddenAttr === 'hidden' ||
          el.getAttribute('aria-hidden') === 'true' ||
          classList.includes('govuk-visually-hidden') ||
          classList.includes('js-hidden') ||
          classList.includes('hidden');
        if (isHidden) return;

        // Track grid column context via a stack
        const gridClass = classList.find(c => GRID_COLUMNS.has('.' + c));
        if (gridClass) {
          const dotClass = '.' + gridClass;
          contextStack.push(dotClass);
          el.onEndTag(() => {
            const idx = contextStack.lastIndexOf(dotClass);
            if (idx !== -1) contextStack.splice(idx, 1);
          });
        }

        // Track margin-bottom spacing context via a stack (handles parent wrappers)
        let ownMargin = null;
        classList.forEach(c => {
          let m = c.match(/^govuk-!-margin-bottom-(\d)$/);
          if (m) ownMargin = { scale: m[1], static: false };
          m = c.match(/^govuk-!-static-margin-bottom-(\d)$/);
          if (m) ownMargin = { scale: m[1], static: true };
        });
        if (ownMargin) {
          spacingStack.push(ownMargin);
          el.onEndTag(() => { spacingStack.pop(); });
        }

        // Collect candidates per element — gem-c-* first, then govuk-* as fallback
        // The plugin picks whichever candidate exists in its COMPONENT_MAP
        const gridColumn   = contextStack.length > 0 ? contextStack[contextStack.length - 1] : null;
        const marginBottom = ownMargin || (spacingStack.length > 0 ? spacingStack[spacingStack.length - 1] : null);
        const gemClasses   = classList.filter(c => c.startsWith('gem-c-') && !seen.has('.' + c));
        const govukClasses = classList.filter(c => c.startsWith('govuk-') && !seen.has('.' + c));
        const candidates   = [...gemClasses, ...govukClasses].map(c => '.' + c);
        if (candidates.length) {
          candidates.forEach(c => seen.add(c));
          components.push({ candidates, gridColumn, marginBottom });
        }
      }
    })
    .transform(govukResp)
    .text();

  return json({ components });
}

// POST / — Anthropic API proxy
async function anthropicProxy(request) {
  const apiKey = request.headers.get('x-api-key');
  if (!apiKey) return json({ error: 'Missing x-api-key header' }, 400);

  const body = await request.text();
  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body
  });

  const data = await upstream.text();
  return new Response(data, {
    status: upstream.status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method === 'GET') return scrape(request);
    if (request.method === 'POST') return anthropicProxy(request);
    return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
  }
};
