// A small XML reader for the S3 gateway's responses, which are plain element
// trees: no attributes we need, no mixed content. An element holding only text
// becomes its trimmed, entity-decoded string; one holding child elements
// becomes an object keyed by tag name, with repeated tags collected into arrays.
// `Contents` and `CommonPrefixes` are always arrays so a one-element listing
// parses the same shape as a many-element one.

type XmlValue = string | XmlObject | XmlValue[];
interface XmlObject {
  [tag: string]: XmlValue;
}

const ALWAYS_ARRAY = new Set(["Contents", "CommonPrefixes"]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isNaN(code) || code > 0x10ffff ? match : String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[ref] ?? match;
  });
}

interface Frame {
  name: string;
  children: XmlObject;
  hasChildren: boolean;
  text: string;
}

function addChild(parent: Frame, name: string, value: XmlValue): void {
  parent.hasChildren = true;
  const existing = parent.children[name];
  if (existing === undefined) {
    parent.children[name] = ALWAYS_ARRAY.has(name) ? [value] : value;
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    parent.children[name] = [existing, value];
  }
}

/** Parse an XML document into a plain object. Returns {} for empty/blank input. */
export function parseXml(xml: string): Record<string, unknown> {
  const root: Frame = { name: "", children: {}, hasChildren: false, text: "" };
  const stack: Frame[] = [root];
  const tag = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<(\/?)([^\s/>]+)[^>]*?(\/?)>/g;
  let last = 0;

  for (let match = tag.exec(xml); match !== null; match = tag.exec(xml)) {
    const current = stack[stack.length - 1]!;
    current.text += decodeEntities(xml.slice(last, match.index));
    last = tag.lastIndex;

    const [token, cdata, closing, name, selfClosing] = match;
    if (cdata !== undefined) {
      current.text += cdata;
    } else if (name === undefined) {
      continue; // comment, declaration, processing instruction, or doctype
    } else if (closing) {
      if (current.name !== name || stack.length === 1) {
        throw new Error(`Malformed XML: unexpected ${token}`);
      }
      stack.pop();
      addChild(stack[stack.length - 1]!, name, current.hasChildren ? current.children : current.text.trim());
    } else if (selfClosing) {
      addChild(current, name, "");
    } else {
      stack.push({ name, children: {}, hasChildren: false, text: "" });
    }
  }

  if (stack.length !== 1) throw new Error(`Malformed XML: unclosed <${stack[stack.length - 1]!.name}>`);
  return root.children;
}
