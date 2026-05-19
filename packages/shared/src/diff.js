// Line-level LCS diff + DOM block renderer used by Edit / MultiEdit cards.

export function lineDiff(a, b) {
  const aLines = (a ?? "").split("\n");
  const bLines = (b ?? "").split("\n");
  const m = aLines.length;
  const n = bLines.length;
  const CAP = 4000;
  if (m > CAP || n > CAP) {
    return [
      ...aLines.map((t) => ({ type: "del", text: t })),
      ...bLines.map((t) => ({ type: "add", text: t })),
    ];
  }
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (aLines[i] === bLines[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const result = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (aLines[i] === bLines[j]) { result.push({ type: "eq", text: aLines[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { result.push({ type: "del", text: aLines[i] }); i++; }
    else { result.push({ type: "add", text: bLines[j] }); j++; }
  }
  while (i < m) result.push({ type: "del", text: aLines[i++] });
  while (j < n) result.push({ type: "add", text: bLines[j++] });
  return result;
}

export function diffBlock(oldStr, newStr) {
  const block = document.createElement("div");
  block.className = "diff-block";
  for (const ln of lineDiff(oldStr, newStr)) {
    const row = document.createElement("div");
    row.className = `diff-line ${ln.type}`;
    row.textContent = ln.text;
    block.appendChild(row);
  }
  if (!block.childNodes.length) {
    const empty = document.createElement("div");
    empty.className = "diff-line eq";
    empty.textContent = "(no changes)";
    block.appendChild(empty);
  }
  return block;
}
