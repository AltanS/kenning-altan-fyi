/**
 * One explanation as plain text, for the clipboard.
 *
 * WHY A WHOLE MODULE FOR A JOIN. Two screens copy an explanation now, the card
 * under the question box and the saved-ask page, and a reader who copies the
 * same answer from both has to get the same text. Written at each call site,
 * the two would drift the first time a field was added to the document, and the
 * drift would be invisible: both would still produce something that looked like
 * an answer.
 *
 * IT IS PURE, AND IT CARRIES NO HEADINGS, WHICH IS THE ONE THING WORTH
 * EXPLAINING. There is no `t` here and there must not be: this runs from a click
 * handler and from the unit tier, and a translation function threaded in would
 * make the output depend on which screen asked. So the text names no section.
 * Printing "The words" or "How they differ" would put ENGLISH labels into a
 * German reader's clipboard, over prose the model wrote in German, which is
 * worse than a blank line. The shape carries the structure instead: a blank line
 * between sections, one term per paragraph, one contrast cell per line.
 *
 * NO IMPORTS BUT TYPES. The clipboard button is client code.
 */

import type { Explanation } from '#app/lib/llm/explain-schema';

/** What the text says about itself, beyond the answer document. */
export interface ExplanationTextContext {
  /** The question as the reader typed it. It leads the text, because a pasted answer with no question is half a note. */
  question: string;
  /** The language the terms are in. */
  from: string;
  /** The language the prose is in. */
  to: string;
}

/**
 * The language pair, as one line.
 *
 * IT IS THE ONE PIECE OF METADATA THAT SURVIVES THE COPY, and it is bare codes
 * rather than language names for the reason above: a name would have to come
 * from a catalogue in one particular language.
 */
function pairLine(context: ExplanationTextContext): string {
  return `${context.from} ${context.to}`;
}

/** One term, its meaning, and its examples, as a paragraph. */
function termBlock(term: Explanation['terms'][number]): string {
  const lines = [`${term.term} = ${term.meaning}`];
  for (const example of term.examples) {
    lines.push(`  ${example.text}`, `  ${example.translation}`);
  }
  return lines.join('\n');
}

/**
 * The comparison, as one line per cell.
 *
 * `Aspect: term = cell`, WHICH IS THE TABLE READ ALOUD. A pasted table made of
 * tabs or pipes lands in a mail client as a ruin, and the reader cannot repair
 * it because the column it lost was the header. One self-describing line per
 * cell says the same facts and survives every destination.
 */
function contrastLines(answer: Explanation): string[] {
  const headings = answer.terms.map((term) => term.term);
  return answer.contrasts.flatMap((row) =>
    row.byTerm.map((cell, index) => `${row.aspect}: ${headings[index] ?? ''} = ${cell}`),
  );
}

/** One reference, with its address when it has one. */
function referenceLine(item: Explanation['references'][number]): string {
  const named = `${item.title}, ${item.locator}`;
  return item.url === undefined ? named : `${named} ${item.url}`;
}

/**
 * The whole answer, as text somebody can paste into a note.
 *
 * EVERY EMPTY SECTION IS OMITTED, exactly as the card omits it. A run of blank
 * lines where a section would have been reads as something that failed to copy.
 *
 * @param answer The parsed document.
 * @param context The question it answers and the two languages.
 * @returns The text, with no trailing newline.
 */
export function explanationToText(answer: Explanation, context: ExplanationTextContext): string {
  const sections: string[] = [`${context.question}\n${pairLine(context)}`, answer.answer];

  if (answer.terms.length > 0) sections.push(answer.terms.map(termBlock).join('\n\n'));
  if (answer.contrasts.length > 0) sections.push(contrastLines(answer).join('\n'));
  if (answer.pitfalls.length > 0) sections.push(answer.pitfalls.map((pitfall) => `- ${pitfall}`).join('\n'));
  if (answer.related.length > 0) sections.push(answer.related.join(', '));

  const references = answer.references ?? [];
  if (references.length > 0) sections.push(references.map(referenceLine).join('\n'));

  return sections.join('\n\n');
}
