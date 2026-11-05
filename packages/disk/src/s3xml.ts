// A small XML reader for the S3 gateway's responses, which are compact element
// trees: no attributes we need, no mixed content. An element holding only text
// becomes its entity-decoded string, kept exactly (object keys can begin or end
// with spaces); one holding child elements becomes an object keyed by tag
// name, with repeated tags collected into arrays. `Contents` and
// `CommonPrefixes` are always arrays so a one-element listing parses the same
// shape as a many-element one.
//
// The input comes from the network, so the reader scans with indexOf and runs
// in time linear in its length. It expands only the five predefined entities
// and numeric references, rejects DOCTYPE (which could declare others), and
// stores every tag, including `__proto__`, as an own property.

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
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return code > 0x10ffff ? match : String.fromCodePoint(code);
    }
    return Object.hasOwn(NAMED_ENTITIES, ref) ? NAMED_ENTITIES[ref]! : match;
  });
}

interface Frame {
  name: string;
  children: XmlObject;
  hasChildren: boolean;
  text: string;
}

function setOwn(target: XmlObject, name: string, value: XmlValue): void {
  Object.defineProperty(target, name, { value, enumerable: true, writable: true, configurable: true });
}

function addChild(parent: Frame, name: string, value: XmlValue): void {
  parent.hasChildren = true;
  const existing = Object.hasOwn(parent.children, name) ? parent.children[name] : undefined;
  if (existing === undefined) {
    setOwn(parent.children, name, ALWAYS_ARRAY.has(name) ? [value] : value);
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    setOwn(parent.children, name, [existing, value]);
  }
}

/** Index just past `terminator`, searching from `from`; throws if it never appears. */
function skipPast(xml: string, terminator: string, from: number): number {
  const end = xml.indexOf(terminator, from);
  if (end === -1) throw new Error(`Malformed XML: missing '${terminator}'`);
  return end + terminator.length;
}

/** Parse an XML document into a plain object. Returns {} for empty/blank input. */
export function parseXml(xml: string): Record<string, unknown> {
  const root: Frame = { name: "", children: {}, hasChildren: false, text: "" };
  const stack: Frame[] = [root];
  let position = 0;

  while (position < xml.length) {
    const current = stack[stack.length - 1]!;
    const open = xml.indexOf("<", position);
    current.text += decodeEntities(xml.slice(position, open === -1 ? xml.length : open));
    if (open === -1) break;

    if (xml.startsWith("<!--", open)) {
      position = skipPast(xml, "-->", open + 4);
    } else if (xml.startsWith("<![CDATA[", open)) {
      position = skipPast(xml, "]]>", open + 9);
      current.text += xml.slice(open + 9, position - 3);
    } else if (xml.startsWith("<?", open)) {
      position = skipPast(xml, "?>", open + 2);
    } else if (xml.startsWith("<!", open)) {
      throw new Error("Malformed XML: DOCTYPE and other declarations are not supported");
    } else {
      position = skipPast(xml, ">", open + 1);
      const tag = xml.slice(open + 1, position - 1);
      const closing = tag.startsWith("/");
      const selfClosing = !closing && tag.endsWith("/");
      const name = /^[^\s/]+/.exec(closing ? tag.slice(1) : tag)?.[0];
      if (!name) throw new Error(`Malformed XML: invalid tag <${tag}>`);

      if (closing) {
        if (current.name !== name || stack.length === 1) throw new Error(`Malformed XML: unexpected </${name}>`);
        stack.pop();
        addChild(stack[stack.length - 1]!, name, current.hasChildren ? current.children : current.text);
      } else if (selfClosing) {
        addChild(current, name, "");
      } else {
        stack.push({ name, children: {}, hasChildren: false, text: "" });
      }
    }
  }

  if (stack.length !== 1) throw new Error(`Malformed XML: unclosed <${stack[stack.length - 1]!.name}>`);
  return root.children;
}
