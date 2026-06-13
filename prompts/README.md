# Agent System Prompts

This directory contains customizable system prompts for the docidx agent.

## Usage

During build, specify a custom prompt file:

```bash
./footnote.sh build --prompt-file prompts/webchart.txt
```

The prompt will be stored in the manifest and used when running `docidx ask`.

## Template Variables

Use `{{TOOLS}}` placeholder in your prompt - it will be replaced with the standard tool definitions:

```
{{TOOLS}}
```

This expands to the search tools available (search_hybrid, search_fts, search_literal).

## Default Prompt

If no custom prompt is specified, a generic documentation assistant prompt is used:

```
You are a helpful documentation assistant.
Your job is to answer questions by searching the documentation.

{{TOOLS}}

IMPORTANT SEARCH STRATEGY:
- For code, special characters, or exact strings: Use search_literal
- For short keyword queries (1-4 words): Use search_fts
- For longer "how to" or conceptual questions: Use search_hybrid
- When search returns no results, try a different tool or simpler query

After gathering enough information, synthesize a clear answer with citations like [1], [2].
```

## Prompt Files

- `webchart.txt` - WebChart EHR / Enterprise Health specific prompt with HL7 message examples
