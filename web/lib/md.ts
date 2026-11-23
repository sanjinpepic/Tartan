/**
 * A deliberately small Markdown renderer for coach replies: paragraphs, **bold**, *italic*,
 * `code`, bullet and numbered lists, and ### headings. Built with text nodes only, so model
 * output can never inject HTML.
 */
import { el } from "./dom.ts";

function inline(text: string): Array<Node> {
  const out: Node[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(document.createTextNode(text.slice(last, m.index)));
    const tok = m[0];
    if (tok.startsWith("**")) out.push(el("strong", {}, tok.slice(2, -2)));
    else if (tok.startsWith("`")) out.push(el("code", {}, tok.slice(1, -1)));
    else out.push(el("em", {}, tok.slice(1, -1)));
    last = m.index! + tok.length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

export function renderMarkdown(src: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = src.replace(/\r/g, "").split("\n");
  let list: HTMLElement | null = null;
  let para: string[] = [];
  const flush = () => {
    if (para.length) frag.append(el("p", {}, ...inline(para.join(" "))));
    para = [];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flush();
      const tag = bullet ? "ul" : "ol";
      if (!list || list.tagName.toLowerCase() !== tag) {
        list = el(tag);
        frag.append(list);
      }
      list.append(el("li", {}, ...inline((bullet ?? numbered)![1]!)));
      continue;
    }
    list = null;
    if (heading) {
      flush();
      frag.append(el("h4", {}, ...inline(heading[1]!)));
    } else if (!line.trim()) flush();
    else para.push(line.trim());
  }
  flush();
  return frag;
}
