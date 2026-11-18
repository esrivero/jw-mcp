// WOL research tools, ported to plain JavaScript from prreobby/jw-research-mcp
// (src/tools/research-tools.ts, MIT). The Kimi-based analyze_research tool was left out.
import * as cheerio from 'cheerio';
import { fetchTextCached } from './fetch-cache.js';
import { errorToolResponse, formattedToolResponse } from './tool-response.js';
import { getWolLanguage, normalizeLangwritten, wolPath } from './wol-language.js';
import { getBookName } from './bible-books.js';
function text(value) {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function integer(value, name, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}
function outputFormat(value) {
  if (value === void 0) return 'json';
  if (value !== 'json' && value !== 'markdown') {
    throw new Error('format must be "json" or "markdown"');
  }
  return value;
}
function absoluteWolUrl(href) {
  return new URL(href, 'https://wol.jw.org').toString();
}
function absoluteArticleUrl(href, sourceUrl) {
  return new URL(href, sourceUrl).toString();
}
function sourceAnchor(sourceUrl, id) {
  const url = new URL(sourceUrl);
  url.hash = id;
  return url.toString();
}
function markdownLabel(value) {
  return value.replace(/[[\]]/g, '\\$&');
}
function validateWolUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('url is required');
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.hostname !== 'wol.jw.org') {
    throw new Error('Only https://wol.jw.org URLs are allowed');
  }
  return url.toString();
}
function validatePublicationCode(raw) {
  if (typeof raw !== 'string' || !/^[a-z0-9-]{1,40}$/i.test(raw)) {
    throw new Error('publication_code must contain only letters, numbers, and hyphens');
  }
  return raw.toLowerCase();
}
function verseSourceUrl(book, chapter, langwritten) {
  return `${wolPath('b', `nwtsty/${book}/${chapter}`, langwritten)}#study=discover`;
}
function markerAwareText($, element) {
  const clone = $(element).clone();
  clone.find('.pageNum, .parNum').remove();
  clone.find('a.fn').each((_index, marker) => {
    const id = $(marker).attr('data-fnid') || '*';
    $(marker).replaceWith(`[fn:${id}]`);
  });
  clone.find('a.b').each((_index, marker) => {
    const citation = text($(marker).text());
    $(marker).replaceWith(citation === '+' ? '[xref]' : `[xref:${citation}]`);
  });
  return text(clone.text());
}
function paragraphLinks($, element, sourceUrl) {
  return $(element)
    .find('a[href]')
    .map((_index, anchor) => {
      const href = $(anchor).attr('href');
      if (!href) return null;
      const isFootnote = $(anchor).hasClass('fn');
      const isCrossReference = $(anchor).hasClass('b');
      const id = $(anchor).attr('data-fnid');
      const anchorText = text($(anchor).text());
      return {
        label:
          anchorText ||
          (isFootnote ? `footnote ${id || '*'}` : isCrossReference ? 'cross-reference' : 'link'),
        url: absoluteArticleUrl(href, sourceUrl),
        type: isFootnote ? 'footnote' : isCrossReference ? 'cross_reference' : 'link',
      };
    })
    .get()
    .filter((item) => Boolean(item));
}
function markerAwareMarkdown($, element, sourceUrl) {
  const clone = $(element).clone();
  clone.find('.pageNum, .parNum').remove();
  clone.find('a[href]').each((_index, anchor) => {
    const href = $(anchor).attr('href');
    if (!href) return;
    const isFootnote = $(anchor).hasClass('fn');
    const isCrossReference = $(anchor).hasClass('b');
    const id = $(anchor).attr('data-fnid');
    const anchorText = text($(anchor).text());
    const label =
      anchorText || (isFootnote ? `fn:${id || '*'}` : isCrossReference ? 'xref' : 'source');
    $(anchor).replaceWith(`[${markdownLabel(label)}](${absoluteArticleUrl(href, sourceUrl)})`);
  });
  return text(clone.text());
}
function parseArticleMediaHtml(html, sourceUrl) {
  const $ = cheerio.load(html);
  const article = $('#article');
  if (!article.length) throw new Error('WOL article content was not found');
  const title =
    text(article.find('h1').first().text()) ||
    text($('#contentTitle').first().text()) ||
    text($('title').text());
  const images = article
    .find('figure')
    .map((_index, figure) => {
      const image = $(figure).find('img').first();
      const src = image.attr('src') || image.attr('data-src') || image.attr('data-img-src');
      if (!src) return null;
      const container = $(figure).closest('[id]');
      const id = container.attr('id') || void 0;
      const captionElement = $(figure).find('figcaption').first();
      const caption = text(captionElement.text());
      const captionId = captionElement.find('[id]').first().attr('id');
      const paragraphMatches = [
        ...caption.matchAll(/\bparagraphs?\s+(\d+(?:\s*[-–]\s*\d+)?)/gi),
      ].map((match) => match[1].replace(/\s+/g, ''));
      const width = Number(image.attr('width'));
      const height = Number(image.attr('height'));
      const item = {
        index: 0,
        image_url: absoluteArticleUrl(src, sourceUrl),
        article_url: sourceUrl,
        source_url: sourceAnchor(sourceUrl, captionId || id || 'article'),
        caption,
        alt_text: text(image.attr('alt') || ''),
        referenced_paragraphs: paragraphMatches,
      };
      if (id) item.id = id;
      const thumbnail = image.attr('data-img-small-src');
      if (thumbnail) item.thumbnail_url = absoluteArticleUrl(thumbnail, sourceUrl);
      if (Number.isFinite(width) && width > 0) item.width = width;
      if (Number.isFinite(height) && height > 0) item.height = height;
      return item;
    })
    .get()
    .filter((item) => Boolean(item))
    .map((item, index) => ({ ...item, index: index + 1 }));
  return { title, images };
}
function parseRelatedContentHtml(html, sourceUrl) {
  const $ = cheerio.load(html);
  const subheadings = $('#subheadings a[href]')
    .map((_index, anchor) => ({
      title: text($(anchor).text()),
      url: absoluteArticleUrl($(anchor).attr('href') || '', sourceUrl),
    }))
    .get()
    .filter((item) => item.title && item.url);
  const similar_material = $('#similarMaterial li.simDoc a[href]')
    .map((_index, anchor) => {
      const thumbnail = $(anchor).find('img[src]').first().attr('src');
      return {
        title: text($(anchor).find('.cardLine1').first().text()),
        publication: text($(anchor).find('.cardLine2').first().text()),
        url: absoluteArticleUrl($(anchor).attr('href') || '', sourceUrl),
        thumbnail_url: thumbnail ? absoluteArticleUrl(thumbnail, sourceUrl) : void 0,
      };
    })
    .get()
    .filter((item) => item.title && item.url);
  return { subheadings, similar_material };
}
function parseArticleHtml(html, sourceUrl) {
  const $ = cheerio.load(html);
  const article = $('#article');
  if (!article.length) throw new Error('WOL article content was not found');
  const title =
    text(article.find('h1').first().text()) ||
    text($('#contentTitle').first().text()) ||
    text($('title').text());
  const citation = text($('#documentCitationInformation').text());
  const paragraphs = [];
  const seen = new Set();
  article.find('[data-pid]').each((_index, element) => {
    const tag = element.tagName?.toLowerCase();
    if (!tag || !['h1', 'h2', 'h3', 'h4', 'h5', 'p', 'li'].includes(tag)) return;
    if ($(element).parents('[data-pid]').length > 0) return;
    const sourcePid = $(element).attr('data-pid') || String(paragraphs.length + 1);
    const body = markerAwareText($, element);
    if (!body) return;
    const dedupeKey = `${sourcePid}:${body}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    const elementId = $(element).attr('id') || `p${sourcePid}`;
    paragraphs.push({
      paragraph: paragraphs.length + 1,
      source_pid: sourcePid,
      source_url: sourceAnchor(sourceUrl, elementId),
      text: body,
      markdown: markerAwareMarkdown($, element, sourceUrl),
      links: paragraphLinks($, element, sourceUrl),
    });
  });
  const footnotes2 = article
    .find('li.item.footnote')
    .map((_index, item) => ({
      marker: text($(item).find('.marker').first().text()) || '*',
      text: text($(item).find('p').text() || $(item).text()),
    }))
    .get()
    .filter((item) => item.text);
  const media = parseArticleMediaHtml(html, sourceUrl);
  const related_content = parseRelatedContentHtml(html, sourceUrl);
  return {
    title,
    citation,
    source_url: sourceUrl,
    paragraphs,
    footnotes: footnotes2,
    images: media.images,
    image_count: media.images.length,
    related_content,
    paragraph_count: paragraphs.length,
    full_text: paragraphs
      .map((paragraph) => `\xB6${paragraph.paragraph} ${paragraph.text}`)
      .join('\n\n'),
    full_markdown: paragraphs
      .map(
        (paragraph) =>
          `\xB6${paragraph.paragraph} ${paragraph.markdown} ([source](${paragraph.source_url}))`,
      )
      .join('\n\n'),
  };
}
function parseFootnotesHtml(html, book, chapter, verse) {
  const $ = cheerio.load(html);
  const section = $(`div.section[data-key="${book}-${chapter}-${verse}"]`);
  return section
    .find('div.group.footnote li.item.footnote')
    .map((_index, item) => {
      const extractId = $(item).attr('data-extract-id') || '';
      return {
        marker: text($(item).find('.marker').first().text()) || '*',
        id: extractId.replace(/^verseFootnote-/, '') || void 0,
        text: text($(item).find('p').text() || $(item).text()),
      };
    })
    .get()
    .filter((item) => item.text);
}
function parseTocPage(html) {
  const $ = cheerio.load(html);
  const title =
    text($('.materialNav h1').first().text()) ||
    text($('#article h1').first().text()) ||
    text($('title').text());
  const pageLinks = $('#article ul.pageList a[href]')
    .map((_index, anchor) => ({
      title: text($(anchor).text()),
      url: absoluteWolUrl($(anchor).attr('href') || ''),
    }))
    .get();
  const entries = $('#article li.row.card.navCard a[href]')
    .map((_index, anchor) => {
      const card = $(anchor);
      const group = card.closest('li.group');
      const item = {
        title:
          text(card.find('.cardLine1').first().text()) ||
          text(card.attr('aria-label') || card.text()),
        url: absoluteWolUrl(card.attr('href') || ''),
      };
      const subtitle = text(card.find('.cardLine2').first().text());
      const section = text(group.children('div.title').first().text());
      if (subtitle) item.subtitle = subtitle;
      if (section) item.section = section;
      return item;
    })
    .get()
    .filter((item) => item.title && item.url);
  return { title, pageLinks, entries };
}
function parseSearchResults(html, limit) {
  const $ = cheerio.load(html);
  const results = [];
  $('#searchResultsForm ul.results').each((_index, list) => {
    if (results.length >= limit) return;
    const anchor = $(list).find('li.caption a.lnk[href]').first();
    if (!anchor.length) return;
    const occurrenceText = text($(list).find('li.caption .count').text());
    const result = {
      title: text(anchor.text()),
      url: absoluteWolUrl(anchor.attr('href') || ''),
      publication: text($(list).find('li.ref').first().text()),
      excerpt: text($(list).find('li.searchResult .document').first().text()),
    };
    if (occurrenceText) result.occurrences = occurrenceText;
    results.push(result);
  });
  return results;
}
async function articleFull(args) {
  const url = validateWolUrl(args.url);
  const format = outputFormat(args.format);
  const fetched = await fetchTextCached(url);
  const article = parseArticleHtml(fetched.value, url);
  return formattedToolResponse(
    article,
    fetched.metadata,
    format,
    `# [${article.title}](${article.source_url})

${article.full_markdown}`,
  );
}
function resultPage(args, count) {
  const page = args.page === void 0 ? 1 : integer(args.page, 'page');
  const pageSize = args.page_size === void 0 ? 10 : integer(args.page_size, 'page_size', 1, 25);
  const start = (page - 1) * pageSize;
  return { page, pageSize, start, end: Math.min(start + pageSize, count) };
}
function mediaMarkdown(images) {
  if (!images.length) return '_No publication images were found._';
  return images
    .map((image) => {
      const label = image.caption || image.alt_text || `Image ${image.index}`;
      return `## Image ${image.index}

![${markdownLabel(label)}](${image.image_url})

${image.caption || image.alt_text || '_No caption._'}

[Open image](${image.image_url}) \xB7 [Open article location](${image.source_url})`;
    })
    .join('\n\n---\n\n');
}
async function articleMedia(args) {
  const url = validateWolUrl(args.url);
  const format = outputFormat(args.format);
  const fetched = await fetchTextCached(url);
  const media = parseArticleMediaHtml(fetched.value, url);
  const slice = resultPage(args, media.images.length);
  const images = media.images.slice(slice.start, slice.end);
  const data = {
    article: media.title,
    article_url: url,
    page: slice.page,
    page_size: slice.pageSize,
    image_count: media.images.length,
    returned_count: images.length,
    images,
    has_more: slice.end < media.images.length,
    next_page: slice.end < media.images.length ? slice.page + 1 : null,
  };
  return formattedToolResponse(
    data,
    fetched.metadata,
    format,
    `# Images from [${media.title}](${url})

${mediaMarkdown(images)}`,
  );
}
async function relatedContent(args) {
  const url = validateWolUrl(args.url);
  const format = outputFormat(args.format);
  const fetched = await fetchTextCached(url);
  const related = parseRelatedContentHtml(fetched.value, url);
  const data = {
    article_url: url,
    subheadings: related.subheadings,
    similar_material: related.similar_material,
    similar_count: related.similar_material.length,
  };
  const markdown = [
    `# Research trail for [source article](${url})`,
    '',
    '## Subheadings',
    ...related.subheadings.map((item) => `- [${item.title}](${item.url})`),
    '',
    '## Similar material',
    ...related.similar_material.map(
      (item) => `- [${item.title}](${item.url}) \u2014 ${item.publication}`,
    ),
  ].join('\n');
  return formattedToolResponse(data, fetched.metadata, format, markdown);
}
async function footnotes(args) {
  const book = integer(args.book, 'book', 1, 66);
  const chapter = integer(args.chapter, 'chapter');
  const verse = integer(args.verse, 'verse');
  const langwritten = normalizeLangwritten(args.langwritten);
  const format = outputFormat(args.format);
  const url = verseSourceUrl(book, chapter, langwritten);
  const fetched = await fetchTextCached(url);
  const items = parseFootnotesHtml(fetched.value, book, chapter, verse);
  const reference = `${getBookName(book)} ${chapter}:${verse}`;
  return formattedToolResponse(
    { reference, book, chapter, verse, langwritten, footnotes: items, count: items.length },
    fetched.metadata,
    format,
    `# ${reference} \u2014 Footnotes

${items.length ? items.map((item) => `- ${item.marker} ${item.text}`).join('\n') : '_No footnotes for this verse._'}`,
  );
}
async function publicationToc(args) {
  const langwritten = normalizeLangwritten(args.langwritten);
  const format = outputFormat(args.format);
  const page = args.page === void 0 ? 1 : integer(args.page, 'page', 1, 500);
  let baseUrl;
  if (args.url) {
    baseUrl = validateWolUrl(args.url);
  } else {
    const code = validatePublicationCode(args.publication_code);
    baseUrl = wolPath('publication', code, langwritten);
  }
  const base = await fetchTextCached(baseUrl);
  const baseToc = parseTocPage(base.value);
  const pageLink = baseToc.pageLinks[page - 1];
  if (baseToc.pageLinks.length && !pageLink) {
    throw new Error(`page must be from 1 to ${baseToc.pageLinks.length}`);
  }
  const targetUrl = pageLink?.url || baseUrl;
  const fetched = targetUrl === baseUrl ? base : await fetchTextCached(targetUrl);
  const toc = targetUrl === baseUrl ? baseToc : parseTocPage(fetched.value);
  const entries = toc.entries.map((entry, index) => ({ ...entry, index: index + 1 }));
  const data = {
    publication: baseToc.title,
    langwritten,
    page,
    page_count: Math.max(baseToc.pageLinks.length, 1),
    page_title: pageLink?.title || baseToc.title,
    pages: baseToc.pageLinks,
    entries,
    entry_count: entries.length,
    next_page: page < Math.max(baseToc.pageLinks.length, 1) ? page + 1 : null,
  };
  const markdown = [
    `# ${data.publication}`,
    `TOC page ${data.page}/${data.page_count}: ${data.page_title}`,
    '',
    ...entries.map(
      (entry) =>
        `${entry.index}. [${entry.title}](${entry.url})${entry.section ? ` \u2014 ${entry.section}` : ''}`,
    ),
  ].join('\n');
  return formattedToolResponse(data, fetched.metadata, format, markdown);
}
async function collectTocEntries(baseUrl, requiredCount) {
  const base = await fetchTextCached(baseUrl);
  const baseToc = parseTocPage(base.value);
  const pageUrls = baseToc.pageLinks.length ? baseToc.pageLinks.map((page) => page.url) : [baseUrl];
  const entries = [];
  const seen = new Set();
  let lastMetadata = base.metadata;
  for (const pageUrl of pageUrls) {
    const fetched = pageUrl === baseUrl ? base : await fetchTextCached(pageUrl);
    lastMetadata = fetched.metadata;
    for (const entry of parseTocPage(fetched.value).entries) {
      if (seen.has(entry.url)) continue;
      seen.add(entry.url);
      entries.push({ ...entry, index: entries.length + 1 });
    }
    if (entries.length >= requiredCount) break;
  }
  return { title: baseToc.title, entries, metadata: lastMetadata };
}
function chapterRange(args) {
  if (args.chapter !== void 0) {
    const chapter = integer(args.chapter, 'chapter');
    return { start: chapter, end: chapter };
  }
  if (typeof args.chapter_range !== 'string') {
    throw new Error('chapter or chapter_range is required');
  }
  const match = args.chapter_range.match(/^(\d+)-(\d+)$/);
  if (!match) throw new Error('chapter_range must look like "1-3"');
  const start = integer(match[1], 'chapter_range start');
  const end = integer(match[2], 'chapter_range end');
  if (end < start) throw new Error('chapter_range end must not be before start');
  if (end - start + 1 > 3) {
    throw new Error('A maximum of 3 chapters can be requested per call');
  }
  return { start, end };
}
function paragraphSlice(args, paragraphCount) {
  if (args.paragraph_range !== void 0) {
    if (typeof args.paragraph_range !== 'string') {
      throw new Error('paragraph_range must look like "1-20"');
    }
    const match = args.paragraph_range.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) throw new Error('paragraph_range must look like "1-20"');
    const start2 = integer(match[1], 'paragraph_range start');
    const end = integer(match[2] || match[1], 'paragraph_range end');
    if (end < start2 || end - start2 + 1 > 50) {
      throw new Error('paragraph_range must be ascending and contain at most 50 paragraphs');
    }
    return {
      start: start2,
      end: Math.min(end, paragraphCount),
      page: 1,
      pageSize: end - start2 + 1,
    };
  }
  const page = args.page === void 0 ? 1 : integer(args.page, 'page');
  const pageSize = args.page_size === void 0 ? 15 : integer(args.page_size, 'page_size', 1, 25);
  const start = (page - 1) * pageSize + 1;
  return { start, end: Math.min(start + pageSize - 1, paragraphCount), page, pageSize };
}
async function bookContent(args) {
  const code = validatePublicationCode(args.publication_code);
  const langwritten = normalizeLangwritten(args.langwritten);
  const format = outputFormat(args.format);
  const range = chapterRange(args);
  const baseUrl = wolPath('publication', code, langwritten);
  const toc = await collectTocEntries(baseUrl, range.end);
  if (toc.entries.length < range.end) {
    throw new Error(
      `${toc.title} has only ${toc.entries.length} sequential TOC entries; chapter ${range.end} was not found`,
    );
  }
  const selected = toc.entries.slice(range.start - 1, range.end);
  const chapters = [];
  let anyMore = false;
  let allCacheHits = true;
  let timestamp = toc.metadata.timestamp;
  for (const entry of selected) {
    const fetched = await fetchTextCached(entry.url);
    const article = parseArticleHtml(fetched.value, entry.url);
    const slice = paragraphSlice(args, article.paragraph_count);
    const paragraphs =
      slice.start > article.paragraph_count
        ? []
        : article.paragraphs.slice(slice.start - 1, slice.end);
    anyMore ||= slice.end < article.paragraph_count;
    allCacheHits &&= fetched.metadata.cache_hit;
    timestamp = fetched.metadata.timestamp;
    chapters.push({
      chapter: entry.index,
      title: article.title || entry.title,
      source_url: entry.url,
      paragraph_start: slice.start,
      paragraph_end: slice.end,
      paragraph_count: article.paragraph_count,
      paragraphs,
    });
  }
  const page = args.page === void 0 ? 1 : integer(args.page, 'page');
  const metadata = {
    source_url: baseUrl,
    timestamp,
    cache_hit: allCacheHits,
  };
  const data = {
    publication_code: code,
    publication: toc.title,
    langwritten,
    requested_chapters:
      range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`,
    page,
    chapters,
    has_more: anyMore,
    next_page: anyMore && args.paragraph_range === void 0 ? page + 1 : null,
  };
  const markdown = chapters
    .map(
      (chapter) =>
        `# Chapter ${chapter.chapter}: [${chapter.title}](${chapter.source_url})

` +
        chapter.paragraphs
          .map(
            (paragraph) =>
              `\xB6${paragraph.paragraph} ${paragraph.markdown} ([source](${paragraph.source_url}))`,
          )
          .join('\n\n'),
    )
    .join('\n\n---\n\n');
  return formattedToolResponse(data, metadata, format, markdown);
}
async function wolSearch(args) {
  if (typeof args.query !== 'string' || !args.query.trim()) {
    throw new Error('query is required');
  }
  const langwritten = normalizeLangwritten(args.langwritten, args.language);
  const limit = args.limit === void 0 ? 10 : integer(args.limit, 'limit', 1, 50);
  const format = outputFormat(args.format);
  const language = getWolLanguage(langwritten);
  const url = new URL(
    `https://wol.jw.org/${language.locale}/wol/s/${language.region}/${language.library}`,
  );
  url.searchParams.set('q', args.query);
  url.searchParams.set('p', 'par');
  url.searchParams.set('r', 'occ');
  url.searchParams.set('st', 'e');
  const fetched = await fetchTextCached(url.toString());
  const results = parseSearchResults(fetched.value, limit);
  const data = {
    query: args.query,
    langwritten,
    result_count: results.length,
    results,
  };
  const markdown = [
    `# WOL search: ${args.query}`,
    '',
    ...results.map(
      (
        result,
        index,
      ) => `${index + 1}. [${result.title}](${result.url}) \u2014 ${result.publication}
   ${result.excerpt}`,
    ),
  ].join('\n');
  return formattedToolResponse(data, fetched.metadata, format, markdown);
}
async function wolMediaSearch(args) {
  if (typeof args.query !== 'string' || !args.query.trim()) {
    throw new Error('query is required');
  }
  const langwritten = normalizeLangwritten(args.langwritten, args.language);
  const articleLimit =
    args.article_limit === void 0 ? 5 : integer(args.article_limit, 'article_limit', 1, 10);
  const imageLimit =
    args.image_limit === void 0 ? 10 : integer(args.image_limit, 'image_limit', 1, 25);
  const format = outputFormat(args.format);
  const language = getWolLanguage(langwritten);
  const url = new URL(
    `https://wol.jw.org/${language.locale}/wol/s/${language.region}/${language.library}`,
  );
  url.searchParams.set('q', args.query);
  url.searchParams.set('p', 'par');
  url.searchParams.set('r', 'occ');
  url.searchParams.set('st', 'e');
  const searchPage = await fetchTextCached(url.toString());
  const results = parseSearchResults(searchPage.value, articleLimit);
  const images = [];
  const sourcesScanned = [];
  const seen = new Set();
  let allCacheHits = searchPage.metadata.cache_hit;
  for (const result of results) {
    try {
      const fetched = await fetchTextCached(result.url);
      allCacheHits &&= fetched.metadata.cache_hit;
      const media = parseArticleMediaHtml(fetched.value, result.url);
      sourcesScanned.push({
        title: result.title,
        publication: result.publication,
        url: result.url,
        image_count: media.images.length,
      });
      for (const image of media.images) {
        if (seen.has(image.image_url)) continue;
        seen.add(image.image_url);
        images.push({
          ...image,
          index: images.length + 1,
          article_title: result.title,
          publication: result.publication,
        });
        if (images.length >= imageLimit) break;
      }
    } catch (error) {
      sourcesScanned.push({
        title: result.title,
        publication: result.publication,
        url: result.url,
        image_count: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (images.length >= imageLimit) break;
  }
  const metadata = { ...searchPage.metadata, cache_hit: allCacheHits };
  const data = {
    query: args.query,
    langwritten,
    articles_scanned: sourcesScanned.length,
    sources_scanned: sourcesScanned,
    image_count: images.length,
    images,
  };
  const markdown = [
    `# WOL images for \u201C${args.query}\u201D`,
    '',
    ...images.map(
      (image) => `## [${image.article_title}](${image.article_url})

![${markdownLabel(image.caption || image.alt_text || image.article_title)}](${image.image_url})

${image.caption || image.alt_text || '_No caption._'}

[Open image](${image.image_url}) \xB7 [Open exact source](${image.source_url})`,
    ),
  ].join('\n');
  return formattedToolResponse(data, metadata, format, markdown);
}
function parseMarginalVerses(html, langwritten) {
  const $ = cheerio.load(html);
  return $('span.v')
    .map((_index, verseElement) => {
      const id = $(verseElement).attr('id') || '';
      const match = id.match(/^v(\d+)-(\d+)-(\d+)/);
      const clone = $(verseElement).clone();
      clone.find('a.vl').remove();
      clone.find('a.b').remove();
      clone.find('a.fn').replaceWith('[fn]');
      const verseText = text(clone.text());
      if (!match || !verseText) return null;
      const book = Number(match[1]);
      const chapter = Number(match[2]);
      const verse = Number(match[3]);
      return {
        reference: `${getBookName(book)} ${chapter}:${verse}`,
        book,
        chapter,
        verse,
        text: verseText,
        source_url: sourceAnchor(
          verseSourceUrl(book, chapter, langwritten),
          `v${book}-${chapter}-${verse}`,
        ),
      };
    })
    .get()
    .filter(Boolean);
}
async function crossReferences(args) {
  const book = integer(args.book, 'book', 1, 66);
  const chapter = integer(args.chapter, 'chapter');
  const verse = integer(args.verse, 'verse');
  const langwritten = normalizeLangwritten(args.langwritten);
  const format = outputFormat(args.format);
  const sourceUrl = verseSourceUrl(book, chapter, langwritten);
  const chapterPage = await fetchTextCached(sourceUrl);
  const $ = cheerio.load(chapterPage.value);
  const section = $(`div.section[data-key="${book}-${chapter}-${verse}"]`);
  const links = section
    .find('li.item.marginal[data-src]')
    .map((_index, item) => ({
      citation: text($(item).find('.marginal.title').text()),
      url: absoluteWolUrl($(item).attr('data-src') || ''),
    }))
    .get();
  const groups = [];
  let allCacheHits = chapterPage.metadata.cache_hit;
  for (const link of links) {
    const fetched = await fetchTextCached(link.url);
    allCacheHits &&= fetched.metadata.cache_hit;
    groups.push({
      citation: link.citation,
      source_url: link.url,
      verses: parseMarginalVerses(fetched.value, langwritten),
    });
  }
  const flattened = groups.flatMap((group) => group.verses);
  const reference = `${getBookName(book)} ${chapter}:${verse}`;
  const metadata = { ...chapterPage.metadata, cache_hit: allCacheHits };
  const data = {
    reference,
    book,
    chapter,
    verse,
    langwritten,
    cross_references: flattened,
    groups,
    count: flattened.length,
  };
  const markdown = [
    `# Cross-references for ${reference}`,
    '',
    ...flattened.map(
      (item) => `- [**${item?.reference}**](${item?.source_url}) \u2014 ${item?.text}`,
    ),
  ].join('\n');
  return formattedToolResponse(data, metadata, format, markdown);
}
async function dailyText(args) {
  const date = args.date === void 0 ? new Date().toISOString().slice(0, 10) : String(args.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('date must use YYYY-MM-DD');
  }
  const langwritten = normalizeLangwritten(args.langwritten);
  const format = outputFormat(args.format);
  const [year, month, day] = date.split('-').map(Number);
  const url = wolPath('h', `${year}/${month}/${day}`, langwritten);
  const fetched = await fetchTextCached(url);
  const $ = cheerio.load(fetched.value);
  const dayContainer = $(`#dailyText .tabContent[data-date^="${date}"]`).first();
  if (!dayContainer.length) throw new Error(`Daily text was not found for ${date}`);
  const heading = dayContainer.find('h2[data-pid]').first();
  const scriptureElement = dayContainer.find('p.themeScrp').first();
  const commentElement = dayContainer.find('.bodyTxt p.sb').first();
  const scripture = text(scriptureElement.text());
  const citation = text(scriptureElement.find('a.b').last().text());
  const citationHref = scriptureElement.find('a.b[href]').last().attr('href');
  const comment = text(commentElement.text());
  const sourceCitation = text(commentElement.find('a[href*="/pc/"]').last().text());
  const sourceCitationHref = commentElement.find('a[href*="/pc/"]').last().attr('href');
  if (!scripture || !citation || !comment) {
    throw new Error(
      `Daily text page for ${date} did not contain the expected scripture and comment`,
    );
  }
  const data = {
    date,
    display_date: text(heading.text()),
    langwritten,
    scripture,
    citation,
    citation_url: citationHref ? absoluteArticleUrl(citationHref, url) : void 0,
    comment,
    source_citation: sourceCitation,
    source_citation_url: sourceCitationHref ? absoluteArticleUrl(sourceCitationHref, url) : void 0,
  };
  const citationMarkdown = data.citation_url ? `[${citation}](${data.citation_url})` : citation;
  const sourceCitationMarkdown = data.source_citation_url
    ? `[${sourceCitation}](${data.source_citation_url})`
    : sourceCitation;
  const markdown = `# [${data.display_date}](${url})

> ${scripture} \u2014 ${citationMarkdown}

${comment}

_${sourceCitationMarkdown}_`;
  return formattedToolResponse(data, fetched.metadata, format, markdown);
}
const commonProperties = {
  langwritten: {
    type: 'string',
    description: 'JW language code. Defaults to DEFAULT_LANGUAGE or E.',
    default: 'E',
  },
  format: {
    type: 'string',
    enum: ['json', 'markdown'],
    default: 'json',
  },
};
const researchTools = [
  {
    name: 'get_footnotes',
    description:
      'Get full Study Bible footnote text for one verse. Footnotes are kept distinct from study notes and marginal cross-references.',
    inputSchema: {
      type: 'object',
      properties: {
        book: { type: 'number', description: 'Bible book number (1-66)' },
        chapter: { type: 'number' },
        verse: { type: 'number' },
        ...commonProperties,
      },
      required: ['book', 'chapter', 'verse'],
    },
  },
  {
    name: 'get_article_full',
    description:
      'Get a complete WOL article with numbered paragraphs, exact paragraph source URLs, clickable inline references, images, and related material.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'A https://wol.jw.org article URL' },
        ...commonProperties,
      },
      required: ['url'],
    },
  },
  {
    name: 'get_article_media',
    description:
      'Get paginated images from one WOL article with full-size and thumbnail URLs, captions, alt text, dimensions, paragraph references, and exact source links.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'A https://wol.jw.org article URL' },
        page: { type: 'number', default: 1 },
        page_size: { type: 'number', default: 10, maximum: 25 },
        ...commonProperties,
      },
      required: ['url'],
    },
  },
  {
    name: 'get_related_content',
    description:
      'Build a linked research trail from a WOL article, including exact subheading anchors and WOL similar-material recommendations.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'A https://wol.jw.org article URL' },
        ...commonProperties,
      },
      required: ['url'],
    },
  },
  {
    name: 'get_book_content',
    description:
      'Get a bounded, paginated slice of a publication. Chapter numbers are 1-based sequential TOC entries. At most 3 chapters and 25 paragraphs per chapter are returned per call.',
    inputSchema: {
      type: 'object',
      properties: {
        publication_code: { type: 'string', description: 'WOL publication code, such as it or rs' },
        chapter: { type: 'number', description: '1-based sequential TOC entry' },
        chapter_range: { type: 'string', description: 'At most 3 entries, for example "1-3"' },
        paragraph_range: {
          type: 'string',
          description: 'Optional explicit range, for example "1-20"',
        },
        page: { type: 'number', default: 1 },
        page_size: { type: 'number', default: 15, maximum: 25 },
        ...commonProperties,
      },
      required: ['publication_code'],
    },
  },
  {
    name: 'get_publication_toc',
    description:
      'Get a publication table of contents with direct article URLs. Large reference works expose natural TOC pages that can be walked with page/next_page.',
    inputSchema: {
      type: 'object',
      properties: {
        publication_code: { type: 'string' },
        url: { type: 'string', description: 'Alternative WOL publication URL' },
        page: { type: 'number', default: 1 },
        ...commonProperties,
      },
    },
  },
  {
    name: 'search_wol_library',
    description:
      'Search the Watchtower Online Library directly and return WOL article/topic results with excerpts and direct URLs.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        language: { type: 'string', description: 'Alias for langwritten' },
        limit: { type: 'number', default: 10, maximum: 50 },
        ...commonProperties,
      },
      required: ['query'],
    },
  },
  {
    name: 'search_wol_media',
    description:
      'Find relevant WOL publication images by topic. Searches WOL, scans matching articles, and returns bounded image results with captions and exact article/image links.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        language: { type: 'string', description: 'Alias for langwritten' },
        article_limit: {
          type: 'number',
          default: 5,
          maximum: 10,
          description: 'Maximum matching articles to inspect',
        },
        image_limit: {
          type: 'number',
          default: 10,
          maximum: 25,
          description: 'Maximum images to return',
        },
        ...commonProperties,
      },
      required: ['query'],
    },
  },
  {
    name: 'get_cross_references',
    description:
      'Get Study Bible marginal cross-references for one verse, including the complete text of each referenced verse.',
    inputSchema: {
      type: 'object',
      properties: {
        book: { type: 'number', description: 'Bible book number (1-66)' },
        chapter: { type: 'number' },
        verse: { type: 'number' },
        ...commonProperties,
      },
      required: ['book', 'chapter', 'verse'],
    },
  },
  {
    name: 'get_daily_text',
    description: 'Get the daily text scripture and comment for a date.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD; defaults to today' },
        ...commonProperties,
      },
    },
  },
];
async function handleResearchTools(request) {
  const args = request.params.arguments || {};
  try {
    switch (request.params.name) {
      case 'get_footnotes':
        return await footnotes(args);
      case 'get_article_full':
        return await articleFull(args);
      case 'get_article_media':
        return await articleMedia(args);
      case 'get_related_content':
        return await relatedContent(args);
      case 'get_book_content':
        return await bookContent(args);
      case 'get_publication_toc':
        return await publicationToc(args);
      case 'search_wol_library':
        return await wolSearch(args);
      case 'search_wol_media':
        return await wolMediaSearch(args);
      case 'get_cross_references':
        return await crossReferences(args);
      case 'get_daily_text':
        return await dailyText(args);
      default:
        return null;
    }
  } catch (error) {
    return errorToolResponse(error);
  }
}
export {
  handleResearchTools,
  paragraphSlice,
  parseArticleHtml,
  parseArticleMediaHtml,
  parseFootnotesHtml,
  parseRelatedContentHtml,
  researchTools,
};
