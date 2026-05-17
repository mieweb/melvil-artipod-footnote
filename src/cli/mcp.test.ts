/**
 * MCP Server Integration Test
 *
 * Uses the MCP SDK's InMemoryTransport to connect a Client directly
 * to our server — no subprocess, no network, zero external cost.
 *
 * Run: node --import tsx --test src/cli/mcp.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createMcpServer } from './mcp.js';
import { SqliteStore } from '../storage/sqlite.js';
import { writeManifest, generateManifest } from '../storage/manifest.js';
import { createEmbedder } from '../embedder/embedder.js';

// ── Fixture: tiny footnote index with 2 docs, mock embeddings ──

let tmpDir: string;
let client: Client;

async function buildFixture(): Promise<string> {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
  const indexPath = path.join(tmpDir, 'index.sqlite');

  const dim = 8; // tiny mock dimension for speed
  const embedder = createEmbedder({ model: 'mock', dimension: dim });

  const store = new SqliteStore({ dbPath: indexPath, dimension: dim });
  store.init(true);

  // Two fake documents, 3 chunks total
  const texts = [
    'Patient registration requires entering demographics, insurance, and consent forms.',
    'The HL7 ADT^A04 message is used to register a patient in the system.',
    'Scheduling an appointment involves selecting a provider and time slot.'
  ];

  const vectors = await embedder.embed(texts);

  store.upsertChunks([
    {
      chunk_id: 'ch_reg_1', doc_id: 'doc_registration', path: 'patient-registration.md',
      url: '/functions/patient-registration/', title: 'Patient Registration',
      section: 'Overview', tags: ['registration'], date: '2025-01-01',
      headings: ['Patient Registration', 'Overview'], content: texts[0],
      content_hash: 'aaa', updated_at: Date.now(), vector: vectors[0]
    },
    {
      chunk_id: 'ch_reg_2', doc_id: 'doc_registration', path: 'patient-registration.md',
      url: '/functions/patient-registration/', title: 'Patient Registration',
      section: 'HL7 Interface', tags: ['registration', 'hl7'], date: '2025-01-01',
      headings: ['Patient Registration', 'HL7 Interface'], content: texts[1],
      content_hash: 'bbb', updated_at: Date.now(), vector: vectors[1]
    },
    {
      chunk_id: 'ch_sched_1', doc_id: 'doc_scheduling', path: 'scheduling.md',
      url: '/functions/scheduling/', title: 'Scheduling',
      section: 'Appointments', tags: ['scheduling'], date: '2025-01-02',
      headings: ['Scheduling', 'Appointments'], content: texts[2],
      content_hash: 'ccc', updated_at: Date.now(), vector: vectors[2]
    }
  ]);

  store.close();

  // Write manifest
  const manifestPath = path.join(tmpDir, 'manifest.json');
  const manifest = generateManifest({
    projectName: 'Test Docs',
    baseUrl: 'https://docs.example.com/',
    maxTokens: 500,
    overlap: 80,
    embeddingModel: 'mock',
    embeddingDim: dim,
    docCount: 2,
    chunkCount: 3
  });
  writeManifest(manifestPath, manifest);

  return tmpDir;
}

describe('MCP Server', async () => {
  before(async () => {
    const footnoteDir = await buildFixture();

    // Wire server ↔ client via in-memory transport
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const server = await createMcpServer(footnoteDir);
    await server.connect(serverTransport);

    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  after(async () => {
    await client.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists expected tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name).sort();

    // search_hybrid should be present (mock embedder always works)
    assert.ok(names.includes('search_hybrid'), `Expected search_hybrid, got: ${names}`);
    assert.ok(names.includes('search_fts'), `Expected search_fts`);
    assert.ok(names.includes('search_literal'), `Expected search_literal`);
    assert.ok(names.includes('read_document'), `Expected read_document`);
    assert.ok(names.includes('find_related'), `Expected find_related`);
    assert.ok(names.includes('list_documents'), `Expected list_documents`);
    assert.ok(names.includes('build_index'), `Expected build_index`);
    assert.ok(names.includes('rebuild_index'), `Expected rebuild_index`);
  });

  it('search_fts returns results for keyword query', async () => {
    const result = await client.callTool({ name: 'search_fts', arguments: { query: 'registration', k: 5 } });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;

    assert.ok(text.includes('Patient Registration'), `Expected title in results: ${text}`);
    assert.ok(!result.isError, 'Should not be an error');
  });

  it('search_literal finds exact string', async () => {
    const result = await client.callTool({ name: 'search_literal', arguments: { query: 'ADT^A04', k: 5 } });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;

    assert.ok(text.includes('ADT^A04'), `Expected literal match: ${text}`);
  });

  it('search_hybrid returns without error', async () => {
    const result = await client.callTool({ name: 'search_hybrid', arguments: { query: 'how to register a patient', k: 5 } });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;

    // Mock embeddings produce poor vector distances, so hybrid may return
    // few/no results. The important thing is it doesn't error.
    assert.ok(!result.isError, `Should not be an error: ${text}`);
    assert.ok(typeof text === 'string', 'Should return text');
  });

  it('read_document returns full document chunks', async () => {
    const result = await client.callTool({ name: 'read_document', arguments: { doc_id: 'doc_registration' } });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;

    assert.ok(text.includes('Patient Registration'), 'Should have title');
    assert.ok(text.includes('demographics'), 'Should have chunk 1 content');
    assert.ok(text.includes('ADT^A04'), 'Should have chunk 2 content');
    assert.ok(text.includes('Chunks: 2'), 'Should report 2 chunks');
  });

  it('list_documents returns all docs', async () => {
    const result = await client.callTool({ name: 'list_documents', arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;

    assert.ok(text.includes('2 documents indexed'), `Expected 2 docs: ${text}`);
    assert.ok(text.includes('Patient Registration'), 'Should list registration doc');
    assert.ok(text.includes('Scheduling'), 'Should list scheduling doc');
  });

  it('exposes manifest resource', async () => {
    const { resources } = await client.listResources();
    assert.ok(resources.some(r => r.uri === 'footnote://manifest'), 'Should have manifest resource');

    const { contents } = await client.readResource({ uri: 'footnote://manifest' });
    const manifest = JSON.parse((contents[0] as { text: string }).text);
    assert.equal(manifest.project_name, 'Test Docs');
    assert.equal(manifest.doc_count, 2);
    assert.equal(manifest.chunk_count, 3);
  });
});

// ── Stdio transport smoke test ──
// Spawns the real MCP server as a subprocess, exactly how VS Code / Claude Desktop would.

describe('MCP Server (stdio)', async () => {
  let stdioClient: Client;
  let footnoteDir: string;

  before(async () => {
    // Reuse buildFixture to create a temp footnote index
    footnoteDir = await buildFixture();

    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', path.resolve('src/cli/mcp.ts'), '--db', footnoteDir],
      stderr: 'pipe'
    });

    stdioClient = new Client({ name: 'stdio-test-client', version: '1.0.0' });
    await stdioClient.connect(transport);
  });

  after(async () => {
    await stdioClient.close();
    if (footnoteDir) fs.rmSync(footnoteDir, { recursive: true, force: true });
  });

  it('lists tools over stdio', async () => {
    const { tools } = await stdioClient.listTools();
    const names = tools.map(t => t.name);

    assert.ok(names.includes('search_fts'), `Expected search_fts in: ${names}`);
    assert.ok(names.includes('list_documents'), `Expected list_documents in: ${names}`);
    assert.ok(tools.length >= 7, `Expected at least 7 tools, got ${tools.length}`);
  });

  it('calls a tool over stdio', async () => {
    const result = await stdioClient.callTool({ name: 'search_fts', arguments: { query: 'registration', k: 3 } });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;

    assert.ok(text.includes('Patient Registration'), `Expected result over stdio: ${text}`);
  });

  it('reads manifest resource over stdio', async () => {
    const { contents } = await stdioClient.readResource({ uri: 'footnote://manifest' });
    const manifest = JSON.parse((contents[0] as { text: string }).text);

    assert.equal(manifest.project_name, 'Test Docs');
  });
});
