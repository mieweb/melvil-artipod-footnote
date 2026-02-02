// Ozwell FOOTNOTE - From Ozwell Only: Traceable Notes & Observations in Text Evidence

const input = document.getElementById('question');
const output = document.getElementById('output');
const askBtn = document.getElementById('askBtn');
const stats = document.getElementById('stats');

// Load stats on page load
async function loadStats() {
  try {
    const response = await fetch('/health');
    const data = await response.json();
    stats.textContent = `${data.docCount} docs, ${data.chunkCount} chunks | Model: ${data.model}`;
  } catch (e) {
    stats.textContent = 'Unable to connect to server';
  }
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
  output.innerHTML = '<div class="status">Thinking...</div>';
  
  let answer = '';
  let references = [];
  let thinkingItems = [];  // Collect thinking/tool events for collapsible section
  let allChunks = [];      // Collect all retrieved chunks
  
  try {
    const eventSource = new EventSource('/ask/stream?q=' + encodeURIComponent(question));
    
    eventSource.onmessage = (event) => {
      if (event.data === '[DONE]') {
        eventSource.close();
        askBtn.disabled = false;
        // Final render with collapsed thinking
        renderFinalOutput(answer, thinkingItems, allChunks, references);
        return;
      }
      
      try {
        const data = JSON.parse(event.data);
        
        switch (data.type) {
          case 'thinking':
            thinkingItems.push({ type: 'thinking', message: data.message });
            output.innerHTML = renderThinkingSection(thinkingItems, allChunks, true) + formatAnswer(answer);
            break;
          case 'tool_call':
            thinkingItems.push({ type: 'tool_call', tool: data.tool, query: data.query });
            output.innerHTML = renderThinkingSection(thinkingItems, allChunks, true) + formatAnswer(answer);
            break;
          case 'tool_result':
            // Store chunks from tool result
            if (data.chunks && data.chunks.length > 0) {
              allChunks.push(...data.chunks);
              thinkingItems.push({ type: 'tool_result', tool: data.tool, count: data.resultCount });
            }
            output.innerHTML = renderThinkingSection(thinkingItems, allChunks, true) + formatAnswer(answer);
            break;
          case 'token':
            answer += data.content;
            output.innerHTML = renderThinkingSection(thinkingItems, allChunks, true) + formatAnswer(answer);
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
      innerHtml += '<div class="chunk-item">';
      innerHtml += '<a href="' + chunk.url + '" target="_blank" class="chunk-title">' + escapeHtml(path) + '</a>';
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

function renderFinalOutput(answer, thinkingItems, allChunks, references) {
  // Thinking section collapsed after completion, with isComplete=true
  let html = renderThinkingSection(thinkingItems, allChunks, false, true);
  html += formatAnswer(answer);
  
  // Add references
  if (references && references.length > 0) {
    html += '<div class="references"><h3>📚 References</h3>';
    references.forEach((ref, i) => {
      const path = ref.headings.length > 0 
        ? ref.title + ' > ' + ref.headings.join(' > ')
        : ref.title;
      html += '<div class="ref-item">';
      html += '<span class="ref-title">[' + (i + 1) + '] ' + escapeHtml(path) + '</span><br>';
      html += '<span class="ref-path"><a href="' + ref.url + '" target="_blank">' + ref.url + '</a></span>';
      html += '</div>';
    });
    html += '</div>';
  }
  
  output.innerHTML = html;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatAnswer(text) {
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
  
  // Strip trailing code fence
  cleaned = cleaned.replace(/\n?```\s*$/i, '');
  
  cleaned = cleaned.trim();
  
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
