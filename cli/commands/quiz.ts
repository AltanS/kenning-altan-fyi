/**
 * Quiz scaffold commands.
 *
 * `scaffold-delete` is the operator escape hatch for the shared, model-written
 * scaffold pool (M203/04, ADR-0012): there is no per-card edit and no
 * moderation queue, deliberately minimal. It deletes a pair's cards AND its
 * `quiz_scaffold_runs` row, so the pool can regenerate the next time a
 * reader's deck for that pair turns out thin, the same guard `claimScaffoldRun`
 * already enforces for a first-ever request.
 */

import { Command } from 'commander';

import { isServedLanguage, SERVED_LANGUAGES } from '#app/lib/dictionary/detect-language';
import { printError, printSuccess } from '../lib/output';
import { quizScaffoldDeleteSchema } from '../lib/schemas';
import { transport } from '../lib/transport';

export function registerQuizCommands(program: Command): void {
  const quiz = program.command('quiz').description('Manage the quiz scaffold pool');

  quiz
    .command('scaffold-delete <from> <to>')
    .description('Delete one language pair\'s scaffold cards and its run row, so the pool can regenerate')
    .action(async (from: string, to: string) => {
      await scaffoldDelete(from, to);
    });
}

async function scaffoldDelete(from: string, to: string): Promise<void> {
  if (!isServedLanguage(from) || !isServedLanguage(to)) {
    printError(`from and to must both be one of: ${SERVED_LANGUAGES.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const result = await transport.delete('/api/v1/quiz-scaffold', quizScaffoldDeleteSchema, { from, to });
  const runNote = result.runDeleted ? '' : ', no run row existed';
  printSuccess(`Deleted ${result.cardsDeleted} scaffold card(s) for ${from} to ${to}${runNote}`);
}
