import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import type { Root as MarkdownRoot, RootContent } from "mdast";
import type { Root as HtmlRoot, Element } from "hast";
import type { Construct, State } from "micromark-util-types";
import type { Plugin, PluggableList } from "unified";
import type {} from "micromark-extension-math";
import type {} from "remark-parse";

// Parse TeX delimiters before Markdown consumes their backslash escapes. A
// syntax extension leaves code, links, images and their source offsets intact.
const texDelimiters: Construct = {
  name: "texMath",
  tokenize(effects, ok, nok) {
    let closing: number;
    let length = 0;
    const start: State = code => {
      if (code !== 92) return nok(code);
      effects.enter("mathText");
      effects.enter("mathTextSequence");
      effects.consume(code);
      return open;
    };
    const open: State = code => {
      if (code !== 40 && code !== 91) return nok(code);
      closing = code === 40 ? 41 : 93;
      effects.consume(code);
      effects.exit("mathTextSequence");
      return content;
    };
    const close: State = code => {
      if (code !== closing) return nok(code);
      effects.consume(code);
      effects.exit("mathTextSequence");
      effects.exit("mathText");
      return ok;
    };
    const end: Construct = { partial: true, tokenize(endEffects, endOk, endNok) {
      return code => {
        if (code !== 92) return endNok(code);
        endEffects.enter("mathTextSequence");
        endEffects.consume(code);
        return next => {
          if (next !== closing) return endNok(next);
          endEffects.consume(next);
          endEffects.exit("mathTextSequence");
          return endOk;
        };
      };
    } };
    const finish: State = code => {
      effects.enter("mathTextSequence");
      effects.consume(code);
      return close;
    };
    const escaped: State = code => {
      // Nested TeX delimiters are invalid. Stop here so repeated unfinished
      // openers cannot each rescan the remainder of a streaming message.
      if (code === null || code === 40 || code === 91 || ++length > 4096) return nok(code);
      effects.consume(code);
      effects.exit("mathTextData");
      return content;
    };
    const data: State = code => {
      if (code === null || ++length > 4096) return nok(code);
      effects.enter("mathTextData");
      effects.consume(code);
      if (code === 92) return escaped;
      effects.exit("mathTextData");
      return content;
    };
    const content: State = code => code === 92 ? effects.check(end, finish, data)(code) : data(code);
    return start;
  },
};

const remarkTexDelimiters: Plugin<[], MarkdownRoot> = function () {
  const data = this.data();
  (data.micromarkExtensions ??= []).push({ text: { 92: texDelimiters } });
};

// Preserve common prices ($5 and $10), and use display layout for both forms
// of double-dollar math. Never rewrite the source string: images use offsets.
const remarkMathLayout: Plugin<[], MarkdownRoot> = () => (tree, file) => {
  const source = String(file);
  const visit = (parent: MarkdownRoot | RootContent) => {
    if (!("children" in parent)) return;
    for (let index = 0; index < parent.children.length; index++) {
      const node = parent.children[index]!;
      if (node.type === "inlineMath") {
        const start = node.position?.start.offset ?? 0;
        const end = node.position?.end.offset ?? start;
        const raw = source.slice(start, end);
        if (raw.startsWith("$") && !raw.startsWith("$$") && (/^\s|\s$/.test(raw.slice(1, -1)) || /\d/.test(source[end] ?? ""))) {
          parent.children[index] = { type: "text", value: raw, ...(node.position ? { position: node.position } : {}) };
        } else if (raw.startsWith("\\[") || raw.startsWith("$$")) {
          node.data = { ...node.data, hProperties: { className: ["language-math", "math-display"] } };
        }
      } else visit(node);
    }
  };
  visit(tree);
};

// Tool/code examples stay literal, including fenced `math` examples. Only
// explicitly delimited Markdown math reaches KaTeX. Limit each equation even
// inside an unusually large plan, in addition to the transcript's body budget.
const rehypeMathInput: Plugin<[], HtmlRoot> = () => tree => {
  const visit = (node: HtmlRoot | Element) => {
    for (const child of node.children) {
      if (child.type !== "element") continue;
      const classes = child.properties.className;
      if (Array.isArray(classes) && classes.includes("language-math")) {
        const length = child.children.reduce((total, item) => total + (item.type === "text" ? item.value.length : 0), 0);
        if ((!classes.includes("math-inline") && !classes.includes("math-display")) || length > 4096) {
          child.properties.className = classes.filter(name => !["language-math", "math-inline", "math-display"].includes(String(name)));
        }
      }
      visit(child);
    }
  };
  visit(tree);
};

const rehypeMathAccessibility: Plugin<[], HtmlRoot> = () => tree => {
  const dimensionsSafe = (node: Element): boolean => {
    const dimensions = String(node.properties.style ?? "").matchAll(/(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)(?:em|ex|px|pt|rem)\b/gi);
    if ([...dimensions].some(match => Math.abs(Number(match[1])) > 100)) return false;
    return node.children.every(child => child.type !== "element" || dimensionsSafe(child));
  };
  const sourceTex = (node: Element): string => {
    if (node.tagName === "annotation") return node.children.map(child => child.type === "text" ? child.value : "").join("");
    return node.children.map(child => child.type === "element" ? sourceTex(child) : "").join("");
  };
  const visit = (node: HtmlRoot | Element) => {
    for (const child of node.children) {
      if (child.type !== "element") continue;
      const classes = child.properties.className;
      // KaTeX maxSize clamps positive lengths only. Reject extreme generated
      // offsets too, before they can distort the transcript's row geometry.
      if (Array.isArray(classes) && classes.includes("katex") && !dimensionsSafe(child)) {
        const source = sourceTex(child);
        child.tagName = "code";
        child.properties = { className: ["math-fallback"] };
        child.children = [{ type: "text", value: source }];
        continue;
      }
      const inline = Array.isArray(classes) && classes.includes("katex") && !(node.type === "element" && Array.isArray(node.properties.className) && node.properties.className.includes("katex-display"));
      if (inline) child.properties.className = [...classes, "katex-inline"];
      if (Array.isArray(classes) && (classes.includes("katex-display") || inline)) {
        // Keyboard users can pan a wide equation without scrolling the page.
        child.properties.tabIndex = 0;
        child.properties.role = "group";
        child.properties.ariaLabel = "Equation";
      }
      visit(child);
    }
  };
  visit(tree);
};

export const markdownRemarkPlugins: PluggableList = [remarkMath, remarkTexDelimiters, remarkMathLayout];
export const markdownRehypePlugins: PluggableList = [rehypeMathInput, [rehypeKatex, {
  trust: false, strict: "ignore", output: "htmlAndMathml", maxExpand: 200, maxSize: 20, errorColor: "var(--text-secondary)",
}], rehypeMathAccessibility];
