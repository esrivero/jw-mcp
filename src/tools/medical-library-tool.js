/**
 * JW.ORG Medical Library tool: https://www.jw.org/en/medical-library/
 *
 * The library is a tree of pages:
 *   root -> section (Medicine and Surgery, Pediatrics, Diseases and Conditions,
 *           Bioethics and Law, Cost-Effectiveness)
 *        -> specialty (for example Cardiothoracic and Vascular Surgery)
 *        -> strategy page with citations of peer-reviewed articles, grouped
 *           under subheadings (for example Antifibrinolytic Agents).
 * Other pages: recently featured articles, medical information packets
 * (downloads), videos, and Hospital Liaison Committee contacts.
 *
 * Each citation has a title, a link (usually PubMed), authors, and a journal
 * source line such as "N Engl J Med 2026;394(24):2419-28."
 */
import * as cheerio from 'cheerio';
import { fetchTextCached, mapLimit } from './fetch-cache.js';
import { errorToolResponse, formattedToolResponse } from './tool-response.js';

const ORIGIN = 'https://www.jw.org';
const ROOT_PATH = '/en/medical-library/';
// Library pages are updated a few times a year; an hour is plenty fresh.
const PAGE_TTL_MS = 60 * 60 * 1000;

function clean(value) {
  return String(value || '')
    .replace(/ /g, ' ')
    .replace(/[​‎‏]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function integer(value, name, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

/**
 * The library root for a page, for example "/en/medical-library/". Other
 * languages use their own slug, so take the first two path segments.
 */
function libraryRoot(url) {
  const [lang, slug] = new URL(url).pathname.split('/').filter(Boolean);
  return `/${lang}/${slug}/`;
}

/**
 * Resolve a link on a library page. Some pages write links without a leading
 * slash ("en/medical-library/..."), meaning site-root relative.
 */
export function resolveLibraryLink(href, pageUrl) {
  if (!href) return null;
  if (/^[a-z]{2,3}(?:-[a-z0-9]+)?\/[^/]+\//i.test(href) && !/^[a-z]+:/i.test(href)) {
    return new URL(`/${href}`, ORIGIN).toString();
  }
  try {
    return new URL(href, pageUrl).toString();
  } catch {
    return null;
  }
}

/** Turn the user's `path` or `url` into a validated library URL. */
export function libraryUrl(input) {
  if (!input) return new URL(ROOT_PATH, ORIGIN).toString();
  const raw = String(input).trim();
  let url;
  if (/^https?:\/\//i.test(raw)) {
    url = new URL(raw);
  } else {
    const path = raw.replace(/^\/+/, '');
    url = new URL(
      /^[a-z]{2,3}(?:-[a-z0-9]+)?\/[^/]+\//i.test(path) ? `/${path}` : `${ROOT_PATH}${path}`,
      ORIGIN,
    );
  }
  if (url.protocol !== 'https:' || !['www.jw.org', 'jw.org'].includes(url.hostname)) {
    throw new Error('Only https://www.jw.org Medical Library pages are allowed');
  }
  url.hostname = 'www.jw.org';
  url.hash = '';
  url.search = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  if (url.pathname.split('/').filter(Boolean).length < 2) {
    throw new Error('url must be a Medical Library page, for example https://www.jw.org/en/medical-library/');
  }
  return url.toString();
}

function parseCitation($, el, pageUrl) {
  const node = $(el);
  const titleLink = node.find('h3.title a[href], .title a[href]').first();
  const titleNode = (titleLink.length ? titleLink : node.find('h3.title, .title').first()).clone();
  titleNode.find('.srText').remove();
  const sourceP = node
    .find('p')
    .filter((_i, p) => !$(p).hasClass('author') && /source/i.test(clean($(p).find('span').first().text())))
    .first();
  let source = clean(sourceP.text()).replace(/^source\s*:\s*/i, '');
  if (!source) {
    // Fallback for pages that print "Source:" without the span.
    const raw = clean(node.text()).match(/Source\s*:\s*(.+)$/i);
    source = raw ? raw[1] : '';
  }
  const section = node.closest('.pageSectionContainer');
  const citation = {
    id: node.attr('id') || undefined,
    title: clean(titleNode.text()),
    url: titleLink.length ? resolveLibraryLink(titleLink.attr('href'), pageUrl) : null,
    authors: clean(node.find('p.author').first().text()),
    source,
  };
  const heading = clean(section.find('h2').first().text());
  if (heading) citation.section = heading;
  const anchor = section.attr('id');
  if (anchor) citation.section_url = `${pageUrl.split('#')[0]}#${anchor}`;
  return citation;
}

/** Parse any Medical Library page into its title, child pages, citations, and downloads. */
export function parseMedicalLibraryHtml(html, pageUrl) {
  const $ = cheerio.load(html);
  const article = $('#article').length ? $('#article') : $('main');
  if (!article.length) throw new Error('Medical Library page content was not found');
  const root = libraryRoot(pageUrl);
  const self = pageUrl.split('#')[0];

  const title = clean(article.find('h1').first().text()) || clean($('title').text());
  const firstH1 = article.find('h1').first();
  const parentLabel = firstH1.length ? clean(firstH1.prevAll('p').first().text()) : '';
  const description =
    clean(article.find('.bodyTxt p').first().text()) ||
    clean(
      article
        .find('p')
        .not('.author')
        .filter((_i, p) => clean($(p).text()).length > 40)
        .first()
        .text(),
    );

  const citations = article
    .find('.articleAbstract')
    .map((_i, el) => parseCitation($, el, pageUrl))
    .get()
    .filter((c) => c.title);

  // Child pages: links that stay inside this library and aren't the page itself.
  const pages = [];
  const seenPages = new Set();
  const downloads = [];
  const videos = [];
  const seenOther = new Set();
  article.find('a[href]').each((_i, a) => {
    const node = $(a);
    if (node.closest('.articleAbstract').length) return;
    const url = resolveLibraryLink(node.attr('href'), pageUrl);
    if (!url) return;
    const label = clean(node.clone().find('.srText').remove().end().text());
    const parsed = new URL(url);
    if (/GETPUBMEDIALINKS/i.test(url)) {
      if (!seenOther.has(url)) {
        seenOther.add(url);
        downloads.push({ label: label || 'Download', url });
      }
      return;
    }
    if (parsed.hostname !== 'www.jw.org') return;
    if (/\/news\//.test(parsed.pathname) || /\/videos\/.+/.test(parsed.pathname)) {
      if (label && !seenOther.has(url)) {
        seenOther.add(url);
        videos.push({ title: label, url });
      }
      return;
    }
    if (!parsed.pathname.startsWith(root)) return;
    if (!label || /^(see more|see all|view (downloads|videos)|contact)$/i.test(label)) return;
    const pageOnly = `${parsed.origin}${parsed.pathname}`;
    if (pageOnly === self && !parsed.hash) return;
    const key = url;
    if (seenPages.has(key)) return;
    seenPages.add(key);
    const entry = { title: label, url };
    if (parsed.hash) entry.parent_url = pageOnly;
    const desc = clean(node.closest('.syn-body').find('p.desc').first().text());
    if (desc) entry.description = desc;
    pages.push(entry);
  });

  return {
    title,
    parent: parentLabel || undefined,
    url: self,
    description: description || undefined,
    pages,
    citations,
    downloads,
    videos,
  };
}

function matchesQuery(citation, words) {
  if (!words.length) return true;
  const hay =
    `${citation.title} ${citation.authors} ${citation.source} ${citation.section || ''}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

function queryWords(query) {
  return String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}-]/gu, ''))
    .filter(Boolean);
}

/**
 * Walk the library breadth-first from `startUrl`, collecting citations that
 * match `words`. Bounded by `maxPages` so one call can't flood jw.org.
 */
async function crawl(startUrl, words, maxPages, maxResults) {
  const root = libraryRoot(startUrl);
  const queue = [startUrl];
  const visited = new Set();
  const results = [];
  const seenCitations = new Set();
  const failures = [];
  let firstMetadata = null;

  while (queue.length && visited.size < maxPages && results.length < maxResults) {
    const batch = [];
    while (queue.length && batch.length < 4 && visited.size + batch.length < maxPages) {
      const next = queue.shift();
      if (!visited.has(next) && !batch.includes(next)) batch.push(next);
    }
    if (!batch.length) break;
    batch.forEach((u) => visited.add(u));
    const parsed = await mapLimit(batch, 4, async (url) => {
      try {
        const fetched = await fetchTextCached(url, {}, false, PAGE_TTL_MS);
        firstMetadata ||= fetched.metadata;
        return parseMedicalLibraryHtml(fetched.value, url);
      } catch (error) {
        failures.push({ url, error: error instanceof Error ? error.message : String(error) });
        return null;
      }
    });
    for (const page of parsed) {
      if (!page) continue;
      for (const citation of page.citations) {
        const key = citation.url || `${citation.title}|${citation.source}`;
        if (seenCitations.has(key) || !matchesQuery(citation, words)) continue;
        seenCitations.add(key);
        results.push({ ...citation, page_title: page.title, page_url: page.url });
        if (results.length >= maxResults) break;
      }
      for (const child of page.pages) {
        const childUrl = child.parent_url || child.url.split('#')[0];
        if (!new URL(childUrl).pathname.startsWith(root)) continue;
        if (/hospital-liaison-committee|medical-information|videos/.test(childUrl)) continue;
        if (!visited.has(childUrl) && !queue.includes(childUrl)) queue.push(childUrl);
      }
    }
  }

  return {
    results,
    pages_scanned: visited.size,
    pages_remaining: queue.length,
    failures,
    metadata: firstMetadata,
  };
}

function citationMarkdown(c) {
  const title = c.url ? `[${c.title}](${c.url})` : c.title;
  const parts = [`- ${title}`];
  if (c.authors) parts.push(`  ${c.authors}`);
  if (c.source) parts.push(`  Source: ${c.source}`);
  return parts.join('\n');
}

function pageMarkdown(page, citations) {
  const lines = [`# [${page.title}](${page.url})`];
  if (page.parent) lines.push(`_${page.parent}_`);
  if (page.description) lines.push('', page.description);
  if (page.pages.length) {
    lines.push('', '## Pages');
    for (const p of page.pages) {
      lines.push(
        `${p.parent_url ? '  ' : ''}- [${p.title}](${p.url})${p.description ? `: ${p.description}` : ''}`,
      );
    }
  }
  if (citations.length) {
    let section = null;
    lines.push('', '## Citations');
    for (const c of citations) {
      if ((c.section || '') !== section) {
        section = c.section || '';
        if (section) lines.push('', `### ${section}`);
      }
      lines.push(citationMarkdown(c));
    }
  }
  if (page.downloads.length) {
    lines.push('', '## Downloads', ...page.downloads.map((d) => `- [${d.label}](${d.url})`));
  }
  if (page.videos.length) {
    lines.push('', '## Videos', ...page.videos.map((v) => `- [${v.title}](${v.url})`));
  }
  return lines.join('\n');
}

export const medicalLibraryTool = {
  name: 'get_medical_library',
  description:
    'Browse and search the JW.ORG Medical Library (https://www.jw.org/en/medical-library/), which lists citations of ' +
    'peer-reviewed medical journal articles on clinical strategies that avoid allogeneic blood transfusion. ' +
    'With no arguments it returns the home page: featured articles and the main sections (Medicine and Surgery, ' +
    'Pediatrics, Diseases and Conditions, Bioethics and Law, Cost-Effectiveness). Pass a path from a previous result to ' +
    'drill into a section, specialty, or strategy page. Each citation has title, link (usually PubMed), authors, and ' +
    'journal source. Add query to filter citations on that page. Add search: true to walk the pages below path and ' +
    'collect every matching citation. The library has hundreds of strategy pages, so start a search from a specialty ' +
    '(for example "bloodless-surgery-medicine/cardio/" or "neonatal-pediatric-medicine-bloodless/neonat/"), not the home page.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Library page to open. Either a full https://www.jw.org/... URL or a path under /en/medical-library/, ' +
          'for example "bloodless-surgery-medicine/cardio/cardio-Hemost/". Defaults to the library home page.',
      },
      query: {
        type: 'string',
        description:
          'Words that must all appear in a citation title, authors, journal, or subheading, for example "tranexamic acid"',
      },
      search: {
        type: 'boolean',
        default: false,
        description: 'Walk the pages below path and collect matching citations. Requires query.',
      },
      max_pages: {
        type: 'number',
        default: 40,
        maximum: 150,
        description: 'Pages to scan when search is true. A specialty is usually 20-35 pages.',
      },
      max_results: { type: 'number', default: 50, maximum: 200, description: 'Citations to return' },
      format: { type: 'string', enum: ['json', 'markdown'], default: 'json' },
    },
  },
};

export async function medicalLibraryImplementation(args = {}) {
  if (args.format !== undefined && !['json', 'markdown'].includes(args.format)) {
    throw new Error('format must be "json" or "markdown"');
  }
  const format = args.format === 'markdown' ? 'markdown' : 'json';
  const url = libraryUrl(args.path || args.url);
  const words = queryWords(args.query);
  const maxResults = integer(args.max_results, 'max_results', 1, 200, 50);

  if (args.search) {
    if (!words.length) throw new Error('search needs a query, for example "cell salvage"');
    const maxPages = integer(args.max_pages, 'max_pages', 1, 150, 40);
    const found = await crawl(url, words, maxPages, maxResults);
    const data = {
      start_url: url,
      query: args.query,
      pages_scanned: found.pages_scanned,
      pages_not_scanned: found.pages_remaining,
      result_count: found.results.length,
      citations: found.results,
    };
    if (found.failures.length) data.failures = found.failures;
    const lines = [
      `# Medical Library search: ${args.query}`,
      `Scanned ${found.pages_scanned} pages from ${url}`,
    ];
    if (found.pages_remaining) {
      lines.push(
        `_${found.pages_remaining} more pages were not scanned. Raise max_pages or start from a narrower path._`,
      );
    }
    let lastPage = null;
    for (const c of found.results) {
      if (c.page_url !== lastPage) {
        lastPage = c.page_url;
        lines.push('', `## [${c.page_title}](${c.page_url})`);
      }
      if (c.section) lines.push(`_${c.section}_`);
      lines.push(citationMarkdown(c));
    }
    if (!found.results.length) lines.push('', '_No matching citations._');
    return formattedToolResponse(
      data,
      found.metadata || { source_url: url, timestamp: new Date().toISOString(), cache_hit: false },
      format,
      lines.join('\n'),
    );
  }

  const fetched = await fetchTextCached(url, {}, false, PAGE_TTL_MS);
  const page = parseMedicalLibraryHtml(fetched.value, url);
  const matching = page.citations.filter((c) => matchesQuery(c, words));
  const citations = matching.slice(0, maxResults);
  const data = {
    ...page,
    citation_count: page.citations.length,
    citations,
    returned_count: citations.length,
  };
  if (words.length) data.query = args.query;
  if (matching.length > citations.length) data.truncated = true;
  return formattedToolResponse(data, fetched.metadata, format, pageMarkdown(page, citations));
}

export async function handleMedicalLibraryTool(request) {
  if (request.params.name !== medicalLibraryTool.name) return null;
  try {
    return await medicalLibraryImplementation(request.params.arguments || {});
  } catch (error) {
    return errorToolResponse(error);
  }
}
