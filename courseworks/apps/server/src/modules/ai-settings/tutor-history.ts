export type TutorHistoryTurn = {
  role: "user" | "assistant";
  content: string;
};

export const TUTOR_HISTORY_CHARACTER_BUDGET = 16_000;

export function recentTutorHistory<T extends TutorHistoryTurn>(
  history: T[],
  characterBudget = TUTOR_HISTORY_CHARACTER_BUDGET,
) {
  const retained: T[] = [];
  let used = 0;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const turn = history[index];
    if (used + turn.content.length > characterBudget) break;
    retained.push(turn);
    used += turn.content.length;
  }

  return retained.reverse();
}
