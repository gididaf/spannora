// Lazy-loaded highlight.js (CDN), with a small extension→language table.

let hljsPromise = null;
export function loadHljs() {
  if (window.hljs) return Promise.resolve(window.hljs);
  if (hljsPromise) return hljsPromise;
  hljsPromise = new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css";
    document.head.appendChild(css);
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js";
    s.onload = () => resolve(window.hljs);
    s.onerror = (e) => { hljsPromise = null; reject(e); };
    document.head.appendChild(s);
  });
  return hljsPromise;
}

export const EXT_LANG = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  mjs: "javascript", cjs: "javascript",
  json: "json", html: "xml", htm: "xml", xml: "xml", svg: "xml",
  css: "css", scss: "scss", sass: "scss", less: "less",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp",
  swift: "swift", kt: "kotlin", php: "php",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", env: "ini",
  md: "markdown", markdown: "markdown",
  sql: "sql", lua: "lua", dart: "dart", vue: "xml",
  dockerfile: "dockerfile",
};

export function langForPath(filePath) {
  if (typeof filePath !== "string") return "";
  const base = filePath.split("/").pop() || "";
  if (/^Dockerfile/i.test(base)) return "dockerfile";
  const m = base.match(/\.([a-zA-Z0-9]+)$/);
  return m ? (EXT_LANG[m[1].toLowerCase()] || "") : "";
}

export function highlightInto(el, code, lang) {
  el.textContent = code;
  loadHljs().then((hljs) => {
    if (!hljs || !el.isConnected) return;
    try {
      const result = lang && hljs.getLanguage(lang)
        ? hljs.highlight(code, { language: lang, ignoreIllegals: true })
        : hljs.highlightAuto(code);
      el.innerHTML = result.value;
      el.classList.add("hljs");
    } catch {}
  }).catch(() => {});
}
