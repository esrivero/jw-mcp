import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/mcp-server.js';

const EXPECTED = [
  // Original 9
  'get_jw_captions',
  'getWorkbookLinks',
  'getWorkbookContent',
  'getWatchtowerLinks',
  'getWatchtowerContent',
  'search_bible_books',
  'get_bible_verse',
  'get_verse_with_study',
  'get_bible_verse_url',
  // Ported from prreobby/jw-research-mcp
  'get_footnotes',
  'get_article_full',
  'get_article_media',
  'get_related_content',
  'get_book_content',
  'get_publication_toc',
  'search_wol_library',
  'search_wol_media',
  'get_cross_references',
  'get_daily_text',
  // New
  'search_research_guide',
  'get_medical_library',
];

async function connect() {
  const server = createMcpServer('test');
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

test('server lists all 21 tools with unique names and valid schemas', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.deepEqual([...names].sort(), [...EXPECTED].sort());
  assert.equal(new Set(names).size, names.length);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    assert.ok(tool.description.length > 20, tool.name);
  }
  await client.close();
});

test('each new tool is routed to its own handler', async () => {
  const client = await connect();
  // Validation errors come back before any network call, proving routing works.
  for (const [name, args, pattern] of [
    ['get_footnotes', {}, /book must be an integer/],
    ['get_daily_text', { date: 'tomorrow' }, /YYYY-MM-DD/],
    ['search_research_guide', {}, /topic is required/],
    ['get_medical_library', { search: true }, /search needs a query/],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name);
    assert.match(result.content[0].text, pattern, name);
  }
  await client.close();
});
