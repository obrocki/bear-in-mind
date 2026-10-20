// Branch-name convention linking a branch to its work item, without reading
// any commit or pull request text:
//
//   prefix/AB123-slug  → Azure Boards work item 123
//   prefix/123-slug    → GitHub issue 123 in the same repository
//
// The work item is the first token after the last slash. hooks/commit-msg
// carries a self-contained copy of this parser; tests keep the two in step.

const MAX_BRANCH = 255;
const ID = '([1-9]\\d{0,8})';
const AZURE_BOARDS = new RegExp(`^AB#?${ID}(?:[-_.]|$)`, 'i');
const GITHUB_ISSUE = new RegExp(`^#?${ID}(?:[-_.]|$)`);

/** A displayable branch name, or null for anything that could not be a git ref. */
export function branchName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || name.length > MAX_BRANCH || /[\u0000-\u001f\u007f\s~^:?*[\\]/.test(name)) return null;
  return name;
}

/** @returns {{ provider: 'azure-boards' | 'github', id: number, reference: string } | null} */
export function parseBranchWorkItem(value) {
  const branch = branchName(value);
  if (!branch) return null;
  const leaf = branch.slice(branch.lastIndexOf('/') + 1);
  let match = AZURE_BOARDS.exec(leaf);
  if (match) return { provider: 'azure-boards', id: Number(match[1]), reference: `AB#${Number(match[1])}` };
  match = GITHUB_ISSUE.exec(leaf);
  if (match) return { provider: 'github', id: Number(match[1]), reference: `#${Number(match[1])}` };
  return null;
}

/** The commit trailer the hook adds for a work item. */
export function workItemTrailer(item) {
  return `Refs: ${item.reference}`;
}

/** Whether a commit message (comment lines excluded) already references the work item. */
export function referencesWorkItem(message, item, commentChar = '#') {
  const text = String(message ?? '')
    .split(/\r?\n/)
    .filter((line) => !line.startsWith(commentChar))
    .join('\n');
  const pattern =
    item.provider === 'azure-boards'
      ? new RegExp(`\\bAB#${item.id}(?!\\d)`, 'i')
      : new RegExp(`(?:^|[^\\w&/])(?:[\\w.-]+/[\\w.-]+)?#${item.id}(?!\\d)|\\bGH-${item.id}(?!\\d)`, 'i');
  return pattern.test(text);
}
