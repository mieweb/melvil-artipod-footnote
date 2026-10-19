/**
 * Interactive assertion demo (issue #15).
 *
 * Type a clinical sentence; watch the engine tag each finding live, and see where a
 * naive keyword scanner would get it wrong. Great for a show-don't-tell walkthrough.
 *
 *   Interactive:  node --import tsx src/assertion/demo.ts
 *   One-shot:     node --import tsx src/assertion/demo.ts "denies chest pain but reports leg weakness"
 */
import * as readline from 'node:readline';
import { extractFindings } from './findings.js';

// Deliberately naive: any negation word anywhere → absent (the "before").
const NAIVE_NEG = /\b(no|not|denies|denied|negative|without|resolved|ruled out|absent)\b/i;
function naivePredict(sentence: string): 'absent' | 'present' {
  return NAIVE_NEG.test(sentence) ? 'absent' : 'present';
}

const MARK: Record<string, string> = { present: '✅', absent: '❌', possible: '❓', historical: '🕓', unspecified: '·' };

function analyze(sentence: string): void {
  const findings = extractFindings({ headingPath: ['Assessment'], content: sentence });
  if (findings.length === 0) {
    console.log('   (no high-risk clinical findings detected)');
    return;
  }
  const naive = naivePredict(sentence);
  for (const f of findings) {
    const mark = MARK[f.assertion] ?? '·';
    const ev = f.evidence === 'stated' ? 'no negation cue → present'
      : f.evidence === 'heading' ? 'from the section heading'
      : `cue: "${f.evidence}"`;
    let line = `   ${mark}  ${f.finding.padEnd(26)} ${f.assertion.toUpperCase().padEnd(10)} (${ev})`;
    if (naive !== f.assertion) {
      line += `   ← naive scanner says ${naive.toUpperCase()}`;
    }
    console.log(line);
  }
}

const args = process.argv.slice(2);
if (args.length > 0) {
  for (const s of args) {
    console.log(`\n› ${s}`);
    analyze(s);
  }
  console.log('');
} else {
  console.log('\nType a clinical sentence and see how the assertion engine tags each finding.');
  console.log('(Ctrl+C to quit.)\n');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'clinical sentence › ' });
  rl.prompt();
  rl.on('line', (line) => {
    if (line.trim()) analyze(line);
    rl.prompt();
  });
  rl.on('close', () => console.log('\n'));
}
