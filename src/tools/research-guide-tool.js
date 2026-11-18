/**
 * Topic research tool: looks a subject up in the Research Guide (rsg) and the
 * Watch Tower Publications Index 1986-present on wol.jw.org and returns the
 * listed references with links.
 *
 * Research Guide: https://wol.jw.org/en/wol/publication/r1/lp-e/rsg
 *   A table of contents with one page per letter. Each topic page groups
 *   article titles under subheadings, each followed by its citation.
 * Publications Index: .../all-publications/index/publications-index/index-1986-2026/subject-index/<letter>
 *   One page per letter. Each subject page lists subheadings with citations.
 */
import * as cheerio from 'cheerio';
import { fetchTextCached, mapLimit } from './fetch-cache.js';
import { errorToolResponse, formattedToolResponse } from './tool-response.js';
import { getWolLanguage, normalizeLangwritten, wolPath } from './wol-language.js';

// Topic lists change about once a year, so keep them for a day.
const TOC_TTL_MS = 24 * 60 * 60 * 1000;
const INDEX_BASE = 'https://wol.jw.org/en/wol/library/r1/lp-e/all-publications/index/publications-index';

function clean(value) {
  return String(value || '')
    .replace(/ /g, ' ')
    .replace(/[​‎‏]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function absolute(href) {
  return new URL(href, 'https://wol.jw.org').toString();
}

function integer(value, name, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export function normalizeTopic(value) {
  return clean(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[“”"‘’'`]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stem(word) {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('es') && /(s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function tokens(value) {
  return normalizeTopic(value).split(' ').filter(Boolean).map(stem);
}

/**
 * Score how well a topic title matches the query (0-100). Exact match wins,
 * then "title starts with the query", then the share of query words found in
 * the title. Plurals are folded so "baby" matches "Babies".
 */
export function scoreTopic(query, title) {
  const q = tokens(query);
  const t = tokens(title);
  if (!q.length || !t.length) return 0;
  const qs = q.join(' ');
  const ts = t.join(' ');
  if (qs === ts) return 100;
  // "Baasha (King of Israel)" should count as an exact hit for "Baasha".
  const head = tokens(title.replace(/\(.*?\)/g, '')).join(' ');
  if (head && qs === head) return 95;
  if (ts.startsWith(`${qs} `)) return 85;
  const titleWords = new Set(t);
  const hits = q.filter((word) => titleWords.has(word)).length;
  if (hits === q.length) return 60 + Math.min(20, Math.round((q.length / t.length) * 20));
  const partial = q.filter((word) => t.some((tw) => tw.startsWith(word) || word.startsWith(tw))).length;
  if (!partial) return 0;
  return Math.round((partial / q.length) * 50);
}

export function rankTopics(query, topics, limit) {
  return topics
    .map((topic) => ({ ...topic, score: scoreTopic(query, topic.title) }))
    .filter((topic) => topic.score >= 25)
    .sort((a, b) => b.score - a.score || a.title.length - b.title.length || a.title.localeCompare(b.title))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Parse a WOL topic list page (Research Guide letter page or Index letter page). */
export function parseTopicListHtml(html) {
  const $ = cheerio.load(html);
  const pageLinks = $('#article ul.pageList a[href]')
    .map((_i, a) => ({ title: clean($(a).text()), url: absolute($(a).attr('href')) }))
    .get()
    .filter((link) => link.title && link.url);
  const topics = $('#article li.row.card a[href]')
    .map((_i, a) => {
      const title = clean($(a).find('.cardLine1').first().text()) || clean($(a).text());
      return { title, url: absolute($(a).attr('href')) };
    })
    .get()
    .filter((topic) => topic.title && /\/wol\/d\//.test(topic.url));
  return { pageLinks, topics };
}

/**
 * Parse a Research Guide topic page into subheadings with article titles,
 * citations, and links.
 */
export function parseResearchGuideTopicHtml(html, sourceUrl) {
  const $ = cheerio.load(html);
  const article = $('#article');
  if (!article.length) throw new Error('Research Guide topic content was not found');
  const title = clean(article.find('h1').first().text()) || clean($('title').text());
  const sections = [];
  const seeAlso = [];
  let current = null;
  let summaryHeading = '';
  const section = (heading) => {
    current = { heading, entries: [] };
    sections.push(current);
    return current;
  };

  // Page layout, in document order:
  //   p.se "See:" then p.se links to related topics (before the first summary)
  //   <summary>Subheading</summary>
  //   p <strong>Sub-subheading</strong>   (optional)
  //   p <a href=".../pc/...">Article title</a>
  //   p <em>citation</em>
  article.find('summary, p[data-pid]').each((_i, el) => {
    const node = $(el);
    if (el.tagName === 'summary') {
      summaryHeading = clean(node.text());
      section(summaryHeading);
      return;
    }
    if (node.closest('header').length) return;
    const body = clean(node.text());
    if (!body) return;
    const link = node.find('a[href]').first();
    if (node.hasClass('se') || (!current && link.hasClass('it'))) {
      if (link.length) seeAlso.push({ topic: body, url: absolute(link.attr('href')) });
      return;
    }
    const strongOnly =
      !link.length && node.find('strong').length && clean(node.find('strong').text()) === body;
    if (strongOnly) {
      section(summaryHeading ? `${summaryHeading} › ${body}` : body);
      return;
    }
    const target = current || section('');
    const last = target.entries[target.entries.length - 1];
    if (link.length) {
      target.entries.push({ title: body, citation: '', url: absolute(link.attr('href')) });
    } else if (last && !last.citation) {
      last.citation = body;
    } else {
      target.entries.push({ title: body, citation: '', url: null });
    }
  });

  const filtered = sections.filter((s) => s.entries.length);
  return {
    title,
    source_url: sourceUrl,
    see_also: seeAlso,
    sections: filtered,
    entry_count: filtered.reduce((n, s) => n + s.entries.length, 0),
  };
}

const INDEX_LEVELS = { su: 1, sv: 2, sw: 3, sx: 4, sy: 5 };

/**
 * Parse a Publications Index subject page. Each line is a subheading (with an
 * indent level) followed by citations, for example
 *   "abandoned: g 1/07 15; w98 12/1 32"
 */
export function parseIndexTopicHtml(html, sourceUrl) {
  const $ = cheerio.load(html);
  const article = $('#article');
  if (!article.length) throw new Error('Index subject content was not found');
  let title = '';
  const seeAlso = [];
  const notes = [];
  const entries = [];
  const path = [];
  let group = '';

  article.find('p[data-pid]').each((_i, el) => {
    const node = $(el);
    const classes = (node.attr('class') || '').split(/\s+/);
    const body = clean(node.text());
    if (!body) return;
    if (classes.includes('st')) {
      title = body;
      return;
    }
    if (classes.includes('sa')) {
      const links = node.find('a[href]');
      // "(Note centered headings below: ...)" has no links; keep it as a note.
      if (!links.length) notes.push(body.replace(/^\(|\)$/g, ''));
      links.each((_j, a) => {
        seeAlso.push({ topic: clean($(a).text()), url: absolute($(a).attr('href')) });
      });
      return;
    }
    if (classes.includes('ss')) {
      // Centered heading, for example "Conditions" or "Methods" under MEDICAL TREATMENT.
      group = body;
      path.length = 0;
      return;
    }
    const levelClass = classes.find((c) => INDEX_LEVELS[c]);
    if (!levelClass) {
      notes.push(body);
      return;
    }
    const level = INDEX_LEVELS[levelClass];
    const references = node
      .find('a[href]')
      .map((_j, a) => ({
        citation: clean($(a).text()).replace(/[;,]$/, '').trim(),
        url: absolute($(a).attr('href')),
      }))
      .get()
      .filter((ref) => ref.citation);
    const clone = node.clone();
    clone.find('a').remove();
    const label = clean(clone.text())
      .replace(/[:—–-]+$/, '')
      .trim();
    path.length = level - 1;
    path[level - 1] = label;
    const entry = { level, label, path: path.filter(Boolean).join(' › '), references };
    if (group) entry.group = group;
    entries.push(entry);
  });

  return {
    title: title || clean(article.find('h1').first().text()),
    source_url: sourceUrl,
    see_also: seeAlso,
    notes,
    entries,
    entry_count: entries.length,
  };
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/** Every Research Guide topic, across all letter pages. */
export async function loadResearchGuideTopics(langwritten) {
  const baseUrl = wolPath('publication', 'rsg', langwritten);
  const base = await fetchTextCached(baseUrl, {}, false, TOC_TTL_MS);
  const first = parseTopicListHtml(base.value);
  const pageUrls = first.pageLinks.length ? first.pageLinks.map((p) => p.url) : [baseUrl];
  const pages = await mapLimit(pageUrls, 4, async (url) => {
    const fetched = url === baseUrl ? base : await fetchTextCached(url, {}, false, TOC_TTL_MS);
    return parseTopicListHtml(fetched.value).topics;
  });
  const seen = new Set();
  const topics = [];
  for (const topic of pages.flat()) {
    if (seen.has(topic.url)) continue;
    seen.add(topic.url);
    topics.push(topic);
  }
  return { topics, metadata: base.metadata, base_url: baseUrl };
}

function indexLetter(topic) {
  const first = normalizeTopic(topic).charAt(0);
  return /[a-z]/.test(first) ? first : '%23';
}

/**
 * The current edition's path, for example "index-1986-2026". It changes every
 * year, so read it from the Publications Index landing page.
 */
export function parseIndexEdition(html) {
  const $ = cheerio.load(html);
  const slugs = [];
  $('#article a[href]').each((_i, a) => {
    const match = ($(a).attr('href') || '').match(/\/(index-1986-\d{4})(?:\/|$)/);
    if (match) slugs.push(match[1]);
  });
  return slugs.sort().pop() || null;
}

async function currentIndexEdition() {
  const landing = await fetchTextCached(INDEX_BASE, {}, false, TOC_TTL_MS);
  const edition = parseIndexEdition(landing.value);
  if (!edition) throw new Error('Could not find the current Publications Index edition on wol.jw.org');
  return edition;
}

/** Publications Index subjects on the letter page that matches the topic. */
export async function loadIndexTopics(topic) {
  const edition = await currentIndexEdition();
  const url = `${INDEX_BASE}/${edition}/subject-index/${indexLetter(topic)}`;
  const fetched = await fetchTextCached(url, {}, false, TOC_TTL_MS);
  return { topics: parseTopicListHtml(fetched.value).topics, metadata: fetched.metadata, base_url: url };
}

function validateTopicUrl(raw) {
  const url = new URL(String(raw));
  if (url.protocol !== 'https:' || url.hostname !== 'wol.jw.org' || !/\/wol\/d\//.test(url.pathname)) {
    throw new Error('topic_url must be a https://wol.jw.org/.../wol/d/... topic page');
  }
  url.hash = '';
  return url.toString();
}

function pageOf(items, page, pageSize) {
  const start = (page - 1) * pageSize;
  const slice = items.slice(start, start + pageSize);
  const hasMore = start + pageSize < items.length;
  return { slice, hasMore, next: hasMore ? page + 1 : null };
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function guideMarkdown(topic) {
  const lines = [`## Research Guide: [${topic.title}](${topic.source_url})`];
  if (topic.see_also?.length) {
    lines.push('', `See: ${topic.see_also.map((s) => `[${s.topic}](${s.url})`).join(', ')}`);
  }
  for (const section of topic.sections) {
    if (section.heading) lines.push('', `### ${section.heading}`);
    for (const entry of section.entries) {
      const label = entry.url ? `[${entry.title}](${entry.url})` : entry.title;
      lines.push(`- ${label}${entry.citation ? ` (${entry.citation})` : ''}`);
    }
  }
  return lines.join('\n');
}

function indexMarkdown(topic) {
  const lines = [`## Publications Index: [${topic.title}](${topic.source_url})`];
  if (topic.see_also.length) {
    lines.push('', `See also: ${topic.see_also.map((s) => `[${s.topic}](${s.url})`).join(', ')}`);
  }
  lines.push('');
  let group = '';
  for (const entry of topic.entries) {
    if ((entry.group || '') !== group) {
      group = entry.group || '';
      if (group) lines.push('', `### ${group}`);
    }
    const indent = '  '.repeat(Math.max(0, entry.level - 1));
    const refs = entry.references.map((r) => `[${r.citation}](${r.url})`).join('; ');
    lines.push(`${indent}- ${entry.label}${refs ? `: ${refs}` : ''}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const researchGuideTool = {
  name: 'search_research_guide',
  description:
    'Look up a subject in the Research Guide and the Watch Tower Publications Index 1986-present on wol.jw.org. ' +
    'Returns the best-matching topics and, for the top match, every listed reference: article titles with citations ' +
    '(for example "w07 11/15 p. 13") and direct WOL links, grouped by subheading. ' +
    'Use topic_url to open a specific topic from an earlier result. ' +
    'The Publications Index is English only and matches topics by their first letter, so search for the main subject ' +
    '(for example "Blood Transfusions", not "why no transfusions").',
  inputSchema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: 'Subject to look up, for example "Baptism", "Babies", or "Medical Treatment"',
      },
      source: {
        type: 'string',
        enum: ['research_guide', 'index', 'both'],
        default: 'both',
        description: 'Which reference work to search. Defaults to both.',
      },
      topic_url: {
        type: 'string',
        description:
          'Open this exact topic page instead of searching (a wol.jw.org/.../wol/d/... URL from a previous result)',
      },
      include_references: {
        type: 'boolean',
        default: true,
        description: 'Fetch the references for the top match. Set false to only list matching topics.',
      },
      limit: {
        type: 'number',
        default: 5,
        maximum: 20,
        description: 'Maximum matching topics to list per source',
      },
      page: { type: 'number', default: 1, description: 'Page of references, for very long topics' },
      page_size: { type: 'number', default: 100, maximum: 300, description: 'References per page' },
      langwritten: {
        type: 'string',
        default: 'E',
        description:
          'JW language code for the Research Guide (E, S, F, X, I, T, J, KO, U). The Index is English only.',
      },
      format: { type: 'string', enum: ['json', 'markdown'], default: 'json' },
    },
  },
};

// Index subject pages start with a p.st heading; Research Guide pages don't.
function detectKind(html) {
  return cheerio.load(html)('#article p.st').length ? 'index' : 'research_guide';
}

async function openTopic(requestedKind, url, page, pageSize) {
  const fetched = await fetchTextCached(url);
  const kind = requestedKind || detectKind(fetched.value);
  if (kind === 'index') {
    const topic = parseIndexTopicHtml(fetched.value, url);
    const { slice, hasMore, next } = pageOf(topic.entries, page, pageSize);
    return {
      kind,
      topic: { ...topic, entries: slice, page, has_more: hasMore, next_page: next },
      metadata: fetched.metadata,
    };
  }
  const topic = parseResearchGuideTopicHtml(fetched.value, url);
  // Page across the flattened entries, keeping their subheadings.
  const flat = topic.sections.flatMap((s) => s.entries.map((e) => ({ heading: s.heading, ...e })));
  const { slice, hasMore, next } = pageOf(flat, page, pageSize);
  const sections = [];
  for (const { heading, ...entry } of slice) {
    if (!sections.length || sections[sections.length - 1].heading !== heading)
      sections.push({ heading, entries: [] });
    sections[sections.length - 1].entries.push(entry);
  }
  return {
    kind,
    topic: { ...topic, sections, page, has_more: hasMore, next_page: next },
    metadata: fetched.metadata,
  };
}

export async function researchGuideImplementation(args = {}) {
  const format = args.format === 'markdown' ? 'markdown' : 'json';
  if (args.format !== undefined && !['json', 'markdown'].includes(args.format)) {
    throw new Error('format must be "json" or "markdown"');
  }
  const page = integer(args.page, 'page', 1, 1000, 1);
  const pageSize = integer(args.page_size, 'page_size', 1, 300, 100);
  const limit = integer(args.limit, 'limit', 1, 20, 5);
  const langwritten = normalizeLangwritten(args.langwritten);
  getWolLanguage(langwritten); // validates the code

  if (args.topic_url) {
    const url = validateTopicUrl(args.topic_url);
    const requested = args.source === 'index' || args.source === 'research_guide' ? args.source : undefined;
    const opened = await openTopic(requested, url, page, pageSize);
    const data = { source: opened.kind, topic_url: url, result: opened.topic };
    const markdown = opened.kind === 'index' ? indexMarkdown(opened.topic) : guideMarkdown(opened.topic);
    return formattedToolResponse(data, opened.metadata, format, markdown);
  }

  if (typeof args.topic !== 'string' || !args.topic.trim()) {
    throw new Error('topic is required (or pass topic_url)');
  }
  const query = args.topic.trim();
  const source = args.source || 'both';
  if (!['research_guide', 'index', 'both'].includes(source)) {
    throw new Error('source must be "research_guide", "index", or "both"');
  }
  const includeReferences = args.include_references !== false;
  const wantGuide = source !== 'index';
  const wantIndex = source !== 'research_guide' && langwritten === 'E';

  const data = { topic: query, source, langwritten };
  const markdown = [`# Topic research: ${query}`];
  const notes = [];
  let metadata = null;

  const runs = [];
  if (wantGuide) runs.push(['research_guide', () => loadResearchGuideTopics(langwritten)]);
  if (wantIndex) runs.push(['index', () => loadIndexTopics(query)]);
  if (source !== 'research_guide' && langwritten !== 'E') {
    notes.push('The Publications Index is only searched in English (langwritten E).');
  }

  for (const [kind, loader] of runs) {
    const key = kind === 'index' ? 'publications_index' : 'research_guide';
    try {
      const list = await loader();
      metadata ||= list.metadata;
      const matches = rankTopics(query, list.topics, limit);
      const block = { searched: list.base_url, topic_count: list.topics.length, matches, result: null };
      const label = kind === 'index' ? 'Publications Index' : 'Research Guide';
      if (!matches.length) {
        markdown.push('', `_${label}: no topic matched "${query}"._`);
      } else {
        if (includeReferences) {
          const opened = await openTopic(kind, matches[0].url, page, pageSize);
          block.result = opened.topic;
          markdown.push('', kind === 'index' ? indexMarkdown(opened.topic) : guideMarkdown(opened.topic));
        }
        const others = includeReferences ? matches.slice(1) : matches;
        if (others.length) {
          markdown.push(
            '',
            `${label} topics${includeReferences ? ' also matching' : ''}: ${others
              .map((m) => `[${m.title}](${m.url})`)
              .join(', ')}`,
          );
        }
      }
      data[key] = block;
    } catch (error) {
      data[key] = { error: error instanceof Error ? error.message : String(error) };
      markdown.push(
        '',
        `_${kind === 'index' ? 'Publications Index' : 'Research Guide'} lookup failed: ${data[key].error}_`,
      );
    }
  }

  if (notes.length) {
    data.notes = notes;
    markdown.push('', ...notes.map((n) => `_${n}_`));
  }
  const failed = runs.every(
    ([kind]) => data[kind === 'index' ? 'publications_index' : 'research_guide']?.error,
  );
  if (runs.length && failed) {
    throw new Error(
      runs.map(([kind]) => data[kind === 'index' ? 'publications_index' : 'research_guide'].error).join('; '),
    );
  }
  return formattedToolResponse(
    data,
    metadata || { source_url: 'https://wol.jw.org', timestamp: new Date().toISOString(), cache_hit: false },
    format,
    markdown.join('\n'),
  );
}

export async function handleResearchGuideTool(request) {
  if (request.params.name !== researchGuideTool.name) return null;
  try {
    return await researchGuideImplementation(request.params.arguments || {});
  } catch (error) {
    return errorToolResponse(error);
  }
}
