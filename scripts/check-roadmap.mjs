#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function parseMilestones(content) {
  const regex = /^###\s+(Майлстоун\s+\d+[^\n]*)\n([\s\S]*?)(?=^###\s+Майлстоун|\Z)/gm;
  const milestones = [];

  let match;
  while ((match = regex.exec(content)) !== null) {
    const heading = match[1].trim();
    const body = match[2];

    const numberMatch = heading.match(/Майлстоун\s+(\d+)/);
    const index = numberMatch ? Number(numberMatch[1]) : Number.POSITIVE_INFINITY;

    const statusMatches = Array.from(body.matchAll(/Статус:\s*([^\n]+)/g)).map(([, statusText]) => statusText);
    const hasOpenStatuses = statusMatches.some((text) => /⏳|🚧/.test(text));
    const hasCompletedStatuses = statusMatches.some((text) => /✅/.test(text));
    const headingHasCompletion = /✅/.test(heading) || /заверш[её]н/i.test(heading);

    const hasAnyCompletionMark = hasCompletedStatuses || headingHasCompletion;
    const isFullyDone = hasAnyCompletionMark && !hasOpenStatuses;

    milestones.push({
      name: heading,
      index,
      hasOpenStatuses,
      isFullyDone,
      hasAnyCompletionMark,
    });
  }

  return milestones;
}

function main() {
  const filePath = join(process.cwd(), 'RoadMap.md');
  let content;

  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error) {
    console.error(`Не удалось прочитать ${filePath}:`, error);
    process.exitCode = 1;
    return;
  }

  const milestones = parseMilestones(content);
  if (milestones.length === 0) {
    console.warn('В RoadMap.md не найдено ни одного майлстоуна.');
    return;
  }

  const currentIndex = milestones.findIndex((milestone) => milestone.hasOpenStatuses);
  if (currentIndex === -1) {
    return;
  }

  const current = milestones[currentIndex];
  const next = milestones[currentIndex + 1];

  if (!next) {
    return;
  }

  if (next.isFullyDone) {
    console.error(
      [
        'Нарушение gate-чека дорожной карты:',
        `- Текущий майлстоун «${current.name}» содержит статусы ⏳/🚧.`,
        `- Следующий майлстоун «${next.name}» помечен как завершён (✅).`,
        'Закройте открытые шаги текущего майлстоуна или переоткройте следующий перед продолжением.',
      ].join('\n'),
    );
    process.exitCode = 1;
  }
}

main();
