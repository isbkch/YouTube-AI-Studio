/** Primary token positions affected by an independent recognition disagreement. */
export function differingWords(
  primary: string[],
  secondary: string[],
): Set<number> {
  const matrix = Array.from(
    { length: primary.length + 1 },
    () => new Uint32Array(secondary.length + 1),
  );
  for (let i = 0; i <= primary.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= secondary.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= primary.length; i++)
    for (let j = 1; j <= secondary.length; j++)
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + Number(primary[i - 1] !== secondary[j - 1]),
      );
  const changed = new Set<number>();
  let i = primary.length,
    j = secondary.length;
  while (i || j) {
    if (
      i &&
      j &&
      matrix[i][j] ===
        matrix[i - 1][j - 1] + Number(primary[i - 1] !== secondary[j - 1])
    ) {
      if (primary[i - 1] !== secondary[j - 1]) changed.add(i - 1);
      i--;
      j--;
    } else if (i && matrix[i][j] === matrix[i - 1][j] + 1) {
      changed.add(--i);
    } else {
      changed.add(Math.min(i, Math.max(0, primary.length - 1)));
      j--;
    }
  }
  return changed;
}
