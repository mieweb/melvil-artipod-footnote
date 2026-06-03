// Ozwell FOOTNOTE - From Ozwell Only: Traceable Notes & Observations in Text Evidence

const input = document.getElementById('question');
const output = document.getElementById('output');
const askBtn = document.getElementById('askBtn');
const stats = document.getElementById('stats');
const examplesEl = document.getElementById('examples');

// Base URL for document links (loaded from manifest via /health)
let baseUrl = '';

// Load stats on page load
async function loadStats() {
  try {
    const response = await fetch('/health');
    const data = await response.json();
    stats.innerHTML = `${data.docCount} docs, ${data.chunkCount} chunks | Model: ${data.model} | <a href="/browse">Browse</a>`;
    // Store baseUrl for constructing document links
    baseUrl = data.baseUrl || '';
    if (data.hasExamples) loadExamples();
  } catch (e) {
    stats.textContent = 'Unable to connect to server';
  }
}

// Load suggested questions (from --examples <yaml>) and render below the ask box.
async function loadExamples() {
  try {
    const response = await fetch('/examples');
    const data = await response.json();
    const items = (data && data.examples) || [];
    if (!items.length) return;

    examplesEl.innerHTML = '';
    const heading = document.createElement('div');
    heading.className = 'examples-heading';
    heading.textContent = 'Try one of these questions';
    examplesEl.appendChild(heading);

    for (const item of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'example-chip';
      if (item.topic) {
        const topic = document.createElement('span');
        topic.className = 'example-topic';
        topic.textContent = item.topic;
        btn.appendChild(topic);
      }
      const text = document.createElement('span');
      text.className = 'example-text';
      text.textContent = item.question;
      btn.appendChild(text);
      btn.addEventListener('click', () => {
        input.value = item.question;
        ask();
      });
      examplesEl.appendChild(btn);
    }
    examplesEl.hidden = false;
  } catch (e) {
    // Examples are optional; ignore load failures.
  }
}

/**
 * Convert heading text to an anchor slug
 * Lowercases and replaces spaces/special chars with hyphens
 * @param {string} heading - Heading text
 * @returns {string} URL-safe anchor slug
 */
function slugify(heading) {
  if (!heading) return '';
  return heading
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')  // Remove special chars except spaces and hyphens
    .replace(/\s+/g, '-')       // Replace spaces with hyphens
    .replace(/-+/g, '-')        // Collapse multiple hyphens
    .replace(/^-|-$/g, '');     // Trim leading/trailing hyphens
}

/**
 * Construct full URL for a document path with optional heading anchor
 * @param {string} urlPath - Relative URL path from the index
 * @param {string[]} [headings] - Optional array of heading path to append as anchor
 * @returns {string} Full URL with baseUrl prefix and heading anchor
 */
function getDocumentUrl(urlPath, headings) {
  let url = urlPath;
  
  // Add baseUrl prefix
  if (baseUrl) {
    const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    const path = urlPath.startsWith('/') ? urlPath.slice(1) : urlPath;
    url = base + path;
  }
  
  // Add heading anchor from the last heading in the path
  if (headings && headings.length > 0) {
    const anchor = slugify(headings[headings.length - 1]);
    if (anchor) {
      url += '#' + anchor;
    }
  }
  
  return url;
}

// Handle enter key
input.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') ask();
});

// Handle button click
askBtn.addEventListener('click', ask);

async function ask() {
  const question = input.value.trim();
  if (!question) return;
  
  askBtn.disabled = true;
  if (examplesEl) examplesEl.hidden = true;
  output.innerHTML = '<div class="status">Thinking...</div>';
  
  let answer = '';
  let references = [];
  let thinkingItems = [];  // Collect thinking/tool events for collapsible section
  let allChunks = [];      // Collect all retrieved chunks
  let sessionDebugFile = null;  // For debug correlation
  let sessionReportToken = null;  // Secret token for reporting
  let hasReceivedToken = false;  // Track if we've started receiving answer tokens
  
  try {
    const eventSource = new EventSource('/ask/stream?q=' + encodeURIComponent(question));
    
    eventSource.onmessage = (event) => {
      if (event.data === '[DONE]') {
        eventSource.close();
        askBtn.disabled = false;
        // Final render with collapsed thinking
        renderFinalOutput(answer, thinkingItems, allChunks, references, sessionDebugFile, sessionReportToken);
        return;
      }
      
      try {
        const data = JSON.parse(event.data);
        
        switch (data.type) {
          case 'start':
            sessionDebugFile = data.debugFile || data.timestamp;
            sessionReportToken = data.reportToken;  // Capture the secret token
            if (data.debugFile) {
              console.log('Debug file:', data.debugFile);
            }
            break;
          case 'thinking':
            thinkingItems.push({ type: 'thinking', message: data.message });
            output.innerHTML = renderThinkingSection(thinkingItems, allChunks, !hasReceivedToken) + formatAnswer(answer);
            break;
          case 'tool_call':
            thinkingItems.push({ type: 'tool_call', tool: data.tool, query: data.query });
            output.innerHTML = renderThinkingSection(thinkingItems, allChunks, !hasReceivedToken) + formatAnswer(answer);
            break;
          case 'tool_result':
            // Store chunks from tool result
            if (data.chunks && data.chunks.length > 0) {
              allChunks.push(...data.chunks);
              thinkingItems.push({ type: 'tool_result', tool: data.tool, count: data.resultCount });
            }
            output.innerHTML = renderThinkingSection(thinkingItems, allChunks, !hasReceivedToken) + formatAnswer(answer);
            break;
          case 'token':
            hasReceivedToken = true;  // Collapse thinking section now
            answer += data.content;
            output.innerHTML = renderThinkingSection(thinkingItems, allChunks, false) + formatAnswer(answer);
            break;
          case 'done':
            references = data.references || [];
            break;
          case 'error':
            output.innerHTML = '<div class="error">Error: ' + escapeHtml(data.message) + '</div>';
            eventSource.close();
            askBtn.disabled = false;
            break;
        }
      } catch (e) {
        console.error('Parse error:', e);
      }
    };
    
    eventSource.onerror = () => {
      eventSource.close();
      askBtn.disabled = false;
      if (!answer) {
        output.innerHTML = '<div class="error">Connection error. Is the server running?</div>';
      }
    };
  } catch (e) {
    output.innerHTML = '<div class="error">Error: ' + e.message + '</div>';
    askBtn.disabled = false;
  }
}

function renderThinkingSection(items, chunks, isOpen, isComplete = false) {
  if (items.length === 0 && chunks.length === 0) return '';
  
  // Count unique documents from chunks
  const uniqueDocs = new Set(chunks.map(c => c.url)).size;
  
  // Build inner content - show the full story
  let innerHtml = '<div class="thinking-story">';
  
  for (const item of items) {
    if (item.type === 'thinking') {
      innerHtml += '<div class="story-thinking">' + escapeHtml(item.message) + '</div>';
    } else if (item.type === 'tool_call') {
      innerHtml += '<div class="story-tool-call">→ ' + item.tool + '("<span class="query">' + escapeHtml(item.query) + '</span>")</div>';
    } else if (item.type === 'tool_result') {
      innerHtml += '<div class="story-tool-result">← ' + item.count + ' results</div>';
    }
  }
  
  // Add document links section
  if (chunks.length > 0) {
    innerHtml += '<div class="story-docs">';
    innerHtml += '<div class="story-docs-header">Documents retrieved:</div>';
    for (const chunk of chunks) {
      const path = chunk.headings && chunk.headings.length > 0 
        ? chunk.title + ' > ' + chunk.headings.join(' > ')
        : chunk.title;
      const fullUrl = getDocumentUrl(chunk.url, chunk.headings);
      innerHtml += '<div class="chunk-item">';
      innerHtml += '<a href="' + fullUrl + '" target="_blank" class="chunk-title">' + escapeHtml(path) + '</a>';
      innerHtml += '</div>';
    }
    innerHtml += '</div>';
  }
  
  innerHtml += '</div>';
  
  const openAttr = isOpen ? ' open' : '';
  // Show "searching..." during progress, final count when complete
  let label;
  if (isComplete) {
    label = uniqueDocs === 0 ? '0 documents consulted' :
            (uniqueDocs === 1 ? '1 document consulted' : uniqueDocs + ' documents consulted');
  } else {
    label = uniqueDocs === 0 ? 'searching...' : 
            (uniqueDocs === 1 ? '1 document consulted' : uniqueDocs + ' documents consulted');
  }
  return '<details class="thinking-section"' + openAttr + '>' +
         '<summary>' + label + '</summary>' +
         '<div class="thinking-content">' + innerHtml + '</div>' +
         '</details>';
}

function renderFinalOutput(answer, thinkingItems, allChunks, references, debugFile, reportToken) {
  // Thinking section collapsed after completion, with isComplete=true
  let html = renderThinkingSection(thinkingItems, allChunks, false, true);
  html += formatAnswer(answer, references);
  
  // Add references with IDs for citation links
  if (references && references.length > 0) {
    html += '<div class="references"><h3>📚 References</h3>';
    references.forEach((ref, i) => {
      const refNum = i + 1;
      const path = ref.headings.length > 0 
        ? ref.title + ' > ' + ref.headings.join(' > ')
        : ref.title;
      const fullUrl = getDocumentUrl(ref.url, ref.headings);
      html += '<div class="ref-item" id="ref-' + refNum + '">';
      html += '<a href="' + fullUrl + '" target="_blank" class="ref-link">[' + refNum + '] ' + escapeHtml(path) + '</a>';
      html += '</div>';
    });
    html += '</div>';
  }
  
  // Add footer with report button (debug info hidden in data attributes)
  if (debugFile) {
    html += '<div class="answer-footer">';
    html += '<span class="report-prompt">Problem with the answer?</span>';
    html += '<button class="report-btn" data-debug-file="' + debugFile + '" data-report-token="' + (reportToken || '') + '" onclick="reportBadOutcome(this)" title="Report bad answer">👎</button>';
    html += '</div>';
  }
  
  output.innerHTML = html;
}

// Report a bad outcome to preserve the debug file
async function reportBadOutcome(btn) {
  const debugFile = btn.dataset.debugFile;
  const reportToken = btn.dataset.reportToken;
  
  if (!debugFile || !reportToken) {
    alert('Unable to report: missing session data');
    return;
  }
  
  const comment = prompt('What was wrong with this answer? (optional)');
  
  // User cancelled the prompt
  if (comment === null) return;
  
  try {
    const response = await fetch('/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ debugFile, reportToken, comment: comment || undefined })
    });
    
    const result = await response.json();
    
    if (response.ok) {
      // Update the button to show it was reported
      btn.textContent = '✓ Reported';
      btn.disabled = true;
      btn.classList.add('reported');
      console.log('Reported:', result.reportedFile);
    } else {
      alert('Failed to report: ' + result.error);
    }
  } catch (e) {
    alert('Error reporting: ' + e.message);
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatAnswer(text, references) {
  // Remove fenced code blocks that are tool call artifacts (```tool...```)
  const toolBlockPattern = /```tool[\s\S]*?```/gi;
  let cleaned = text.replace(toolBlockPattern, '');
  
  // Strip ONLY literal ``` at very start (LLM often wraps entire response)
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.slice(3);
    // If there's a language hint like "markdown" or newline, skip it
    const firstNewline = cleaned.indexOf('\n');
    if (firstNewline !== -1 && firstNewline < 20) {
      const beforeNewline = cleaned.slice(0, firstNewline).trim();
      // Only skip if it looks like a language hint (letters only) or empty
      if (/^[a-z]*$/i.test(beforeNewline)) {
        cleaned = cleaned.slice(firstNewline + 1);
      }
    }
  }
  
  // Remove LLM-generated reference sections (we generate our own)
  // Match patterns like: "References:\n[1] ..." or "## References" etc.
  cleaned = cleaned.replace(/\n+(References:?|## References|### References)[\s\S]*$/i, '');
  
  // Strip trailing code fence
  cleaned = cleaned.replace(/\n?```\s*$/i, '');
  
  cleaned = cleaned.trim();
  
  // Make inline [N] citations clickable (before markdown parsing)
  // Match [1], [2], etc. but not [text](url) markdown links
  cleaned = cleaned.replace(/\[(\d+)\](?!\()/g, (match, num) => {
    return '<a href="#ref-' + num + '" class="citation-link" title="Jump to reference ' + num + '">[' + num + ']</a>';
  });
  
  // Use marked.js for markdown rendering
  if (typeof marked !== 'undefined') {
    // Configure marked for safe rendering
    marked.setOptions({
      breaks: true,  // Convert \n to <br>
      gfm: true,     // GitHub Flavored Markdown
      sanitize: false
    });
    return marked.parse(cleaned);
  }
  
  // Fallback if marked isn't loaded
  return escapeHtml(cleaned).replace(/\n/g, '<br>');
}

// Initialize
loadStats();

// Deep-link support: /?q=... pre-fills the box and runs the question.
// Enables single-click example/benchmark links from external pages.
const presetQuestion = new URLSearchParams(window.location.search).get('q');
if (presetQuestion) {
  input.value = presetQuestion;
  ask();
}
