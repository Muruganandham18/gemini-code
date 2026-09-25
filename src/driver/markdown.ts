/**
 * Turns a rendered Gemini reply back into markdown.
 *
 * The agent never needed this — it reads code blocks separately and only
 * cares whether a reply is a tool call. An API client does: the web UI
 * renders markdown into HTML, and innerText of that loses exactly the parts a
 * caller wants back (```fences and their language, headings, list markers,
 * tables). This walks the reply's DOM and rebuilds the markdown.
 *
 * Kept as a plain string, not a function we stringify: the TS toolchain can
 * inject helpers (`__name`) that don't exist in the page, and String.raw keeps
 * regex/newline escapes intact — an escaped newline inside an injected
 * template literal has already truncated one page script in this project.
 *
 * Markup it handles was taken from a live reply (see tests/fixtures).
 */
export const HTML_TO_MARKDOWN = String.raw`function toMarkdown(root) {
  var SKIP_CLASSES = ["code-block-decoration", "buttons", "copy-button", "export-button", "table-footer"];
  var SKIP = /^(BUTTON|MAT-ICON|GEM-ICON|GEM-ICON-BUTTON|SCRIPT|STYLE|SVG|TEMPLATE|SOURCES-LIST|SOURCE-FOOTNOTE|SOURCES-CAROUSEL-INLINE)$/;

  // Gemini appends ?utm_source=gemini to every link. Strip just that, by
  // text, so the URL otherwise stays exactly as written (URL() would add a
  // trailing slash and re-encode it).
  function cleanHref(href) {
    return href
      .replace(/([?&])utm_source=[^&#]*&/, "$1")
      .replace(/[?&]utm_source=[^&#]*/, "");
  }

  function skipped(el) {
    if (SKIP.test(el.tagName)) return true;
    if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return true;
    // Exact class tokens, not substrings: the table wrapper carries
    // "has-export-button", and a substring test skipped the whole table.
    var list = el.classList || [];
    for (var i = 0; i < list.length; i++) {
      if (SKIP_CLASSES.indexOf(list[i]) !== -1) return true;
    }
    return false;
  }

  function inline(node) {
    if (node.nodeType === 3) return node.textContent.replace(/\s+/g, " ");
    if (node.nodeType !== 1 || skipped(node)) return "";
    var tag = node.tagName;
    var inner = "";
    for (var i = 0; i < node.childNodes.length; i++) inner += inline(node.childNodes[i]);
    if (tag === "B" || tag === "STRONG") return inner.trim() ? "**" + inner.trim() + "**" : "";
    if (tag === "I" || tag === "EM") return inner.trim() ? "*" + inner.trim() + "*" : "";
    if (tag === "S" || tag === "DEL") return "~~" + inner + "~~";
    if (tag === "CODE") return "` + "`" + String.raw`" + node.textContent + "` + "`" + String.raw`";
    if (tag === "BR") return "\n";
    if (tag === "A") {
      var href = node.getAttribute("href");
      var text = inner.trim() || href;
      return href ? "[" + text + "](" + cleanHref(href) + ")" : text;
    }
    return inner;
  }

  function codeBlock(el) {
    var code = el.querySelector("pre code") || el.querySelector("code") || el;
    var langEl = el.querySelector(".code-block-decoration span");
    var lang = langEl ? langEl.textContent.trim().toLowerCase() : "";
    var body = code.textContent.replace(/\n$/, "");
    var fence = "` + "```" + String.raw`";
    return fence + lang + "\n" + body + "\n" + fence + "\n\n";
  }

  function table(el) {
    var rows = el.querySelectorAll("tr");
    var out = [];
    for (var r = 0; r < rows.length; r++) {
      var cells = rows[r].querySelectorAll("th, td");
      var vals = [];
      for (var c = 0; c < cells.length; c++) vals.push(inline(cells[c]).trim().replace(/\|/g, "\\|"));
      out.push("| " + vals.join(" | ") + " |");
      if (r === 0) {
        var sep = [];
        for (var k = 0; k < vals.length; k++) sep.push("---");
        out.push("| " + sep.join(" | ") + " |");
      }
    }
    return out.join("\n") + "\n\n";
  }

  function list(el, depth) {
    var ordered = el.tagName === "OL";
    var n = parseInt(el.getAttribute("start") || "1", 10);
    var pad = "";
    for (var d = 0; d < depth; d++) pad += "   ";
    var out = "";
    var items = el.children;
    for (var i = 0; i < items.length; i++) {
      if (items[i].tagName !== "LI") continue;
      var marker = ordered ? (n++) + ". " : "- ";
      var content = blocks(items[i], depth + 1).trim();
      var lines = content.split("\n");
      out += pad + marker + lines[0] + "\n";
      for (var j = 1; j < lines.length; j++) {
        out += (lines[j] ? pad + "   " + lines[j] : "") + "\n";
      }
    }
    return out + (depth === 0 ? "\n" : "");
  }

  function blocks(node, depth) {
    var out = "";
    for (var i = 0; i < node.childNodes.length; i++) {
      var ch = node.childNodes[i];
      if (ch.nodeType === 3) {
        out += ch.textContent.replace(/\s+/g, " ");
        continue;
      }
      if (ch.nodeType !== 1 || skipped(ch)) continue;
      var tag = ch.tagName;
      var m = /^H([1-6])$/.exec(tag);
      if (m) {
        out += "\n\n" + "######".slice(0, +m[1]) + " " + inline(ch).trim() + "\n\n";
      } else if (tag === "P") {
        out += "\n\n" + inline(ch).trim() + "\n\n";
      } else if (tag === "UL" || tag === "OL") {
        out += "\n\n" + list(ch, depth ? depth - 1 : 0);
      } else if (tag === "CODE-BLOCK" || tag === "PRE") {
        out += "\n\n" + codeBlock(ch);
      } else if (tag === "TABLE") {
        out += "\n\n" + table(ch);
      } else if (tag === "BLOCKQUOTE") {
        var q = blocks(ch, depth).trim().split("\n");
        for (var j = 0; j < q.length; j++) q[j] = "> " + q[j];
        out += "\n\n" + q.join("\n") + "\n\n";
      } else if (tag === "HR") {
        out += "\n\n---\n\n";
      } else if (/^(B|STRONG|I|EM|CODE|A|S|DEL|BR|SPAN)$/.test(tag)) {
        out += inline(ch);
      } else {
        out += blocks(ch, depth);
      }
    }
    return out;
  }

  var md = blocks(root, 0);
  return md.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}`;
