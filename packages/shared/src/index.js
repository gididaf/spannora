// @spannora/shared — frontend modules consumed by both the in-server PWA
// (packages/server/public/app.js) and the hub PWA (packages/hub/).
// Vanilla ES modules, no build step.

export { streamSse } from "./sse.js";

export {
  escapeHtml,
  makeTextBubble,
  stringifyContent,
  summarizeToolInput,
  fileMeta,
  sectionLabel,
  resultList,
  errorPane,
  appendToTranscript,
  isNearBottom,
} from "./dom.js";

export { loadHljs, langForPath, highlightInto, EXT_LANG } from "./highlight.js";
export { lineDiff, diffBlock } from "./diff.js";

export {
  renderers,
  renderToolBody,
  renderGeneric,
  rawToggle,
} from "./toolRenderers.js";

export { makeAskQuestionForm } from "./askUserQuestion.js";
export { makeToolCard, setToolResult } from "./toolCard.js";
export { renderSdkMessage } from "./messageRenderer.js";
